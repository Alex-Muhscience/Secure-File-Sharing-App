"use strict";
const resumable = (() => {
  let activeId = null,
    expectedResume = null,
    signature = "",
    contextRevision = -1;
  const digest = async (input) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", input))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const request = async (url, body, signal) =>
    (
      await api(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      })
    ).json();
  function chunkRequest(id, body, offset, checksum, signal, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(),
        requestToken = token;
      xhr.open("PUT", `/api/uploads/${id}/chunks`);
      xhr.timeout = 120000;
      xhr.setRequestHeader("Authorization", `Bearer ${requestToken}`);
      xhr.setRequestHeader("X-Organization-ID", organization);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Upload-Offset", String(offset));
      xhr.setRequestHeader("X-Chunk-SHA256", checksum);
      const abort = () => xhr.abort();
      const finish = (error, result) => {
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(result);
      };
      xhr.upload.onprogress = (event) => onProgress(event.loaded);
      xhr.onload = () => {
        if (xhr.status === 401 && requestToken === token)
          return finish(expiredSession());
        let result;
        try {
          result = JSON.parse(xhr.responseText);
        } catch {
          return finish(
            new Error(
              "Unreadable upload response. Your saved parts can be resumed.",
            ),
          );
        }
        if (xhr.status >= 200 && xhr.status < 300) finish(null, result);
        else
          finish(
            Object.assign(
              new Error(result.error || "Part could not be uploaded"),
              {
                retryable:
                  xhr.status >= 500 || xhr.status === 409 || xhr.status === 429,
              },
            ),
          );
      };
      xhr.onerror = xhr.ontimeout = () =>
        finish(
          Object.assign(
            new Error(
              "The upload lost its connection. Saved parts are kept for seven days.",
            ),
            { retryable: true },
          ),
        );
      xhr.onabort = () =>
        finish(new DOMException("Upload paused", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted)
        return finish(new DOMException("Upload paused", "AbortError"));
      xhr.send(body);
    });
  }
  const pause = (delay, signal) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Upload paused", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delay);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  async function send(file, settings, signal) {
    const started = revision;
    const check = () => {
      if (signal.aborted) throw new DOMException("Upload paused", "AbortError");
      if (started !== revision)
        throw Object.assign(new Error("Workspace changed"), { stale: true });
    };
    const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer()),
      tail = new Uint8Array(
        await file.slice(Math.max(0, file.size - 65536)).arrayBuffer(),
      ),
      meta = new TextEncoder().encode(
        JSON.stringify([file.name, file.size, file.lastModified]),
      );
    const sample = new Uint8Array(meta.length + head.length + tail.length);
    sample.set(meta);
    sample.set(head, meta.length);
    sample.set(tail, meta.length + head.length);
    const fingerprint = await digest(sample);
    check();
    let saved = await request(
      "/api/uploads",
      {
        name: file.name,
        size: file.size,
        fingerprint,
        ...settings,
        ...(expectedResume ? { resumeId: expectedResume } : {}),
      },
      signal,
    );
    check();
    activeId = saved.uploadId;
    $("discard-upload").hidden = false;
    let offset = saved.offset;
    while (offset < file.size) {
      check();
      const body = await file
          .slice(offset, offset + saved.chunkSize)
          .arrayBuffer(),
        checksum = await digest(body);
      check();
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await chunkRequest(
            activeId,
            body,
            offset,
            checksum,
            signal,
            (uploaded) => {
              if (started !== revision) return;
              const percent = Math.min(
                99,
                Math.floor(((offset + uploaded) / file.size) * 100),
              );
              $("upload-progress").value = percent;
              $("upload-label").textContent =
                `Uploading ${percent}% · ${bytes(offset + uploaded)} of ${bytes(file.size)}`;
            },
          );
          break;
        } catch (error) {
          if (attempt === 2 || !error.retryable) throw error;
          await pause(500 * 2 ** attempt, signal);
        }
      }
      check();
      if (
        !Number.isSafeInteger(result.offset) ||
        result.offset <= offset ||
        result.offset > file.size
      )
        throw new Error(
          "The saved upload offset is invalid. Refresh before retrying.",
        );
      offset = result.offset;
    }
    $("upload-label").textContent = "Verifying your saved transfer…";
    const result = await request(
      `/api/uploads/${activeId}/complete`,
      {},
      signal,
    );
    check();
    activeId = expectedResume = null;
    $("discard-upload").hidden = true;
    $("upload-progress").value = 100;
    return result;
  }
  async function refreshPending() {
    if (!config.resumable?.enabled) return;
    const started = revision,
      result = await (await api("/api/uploads")).json();
    if (started !== revision) return;
    const nextSignature = JSON.stringify(result.uploads);
    if (signature === nextSignature) return;
    signature = nextSignature;
    $("pending-uploads").hidden = !result.uploads.length;
    $("pending-upload-label").textContent =
      `${result.uploads.length} unfinished upload${result.uploads.length === 1 ? "" : "s"}`;
    $("pending-upload-list").replaceChildren(
      ...result.uploads.map((upload) => {
        const row = node("li", "client-row"),
          copy = node("div"),
          resume = node("button", "button button-secondary", "Resume"),
          discard = node("button", "text-button", "Discard"),
          actions = node("div", "pending-actions");
        copy.append(
          node("strong", "", upload.name),
          node(
            "span",
            "field-hint",
            `${bytes(upload.offset)} of ${bytes(upload.size)} saved · expires ${new Date(upload.expiresAt).toLocaleDateString()}`,
          ),
        );
        resume.type = discard.type = "button";
        resume.addEventListener("click", () => {
          newTransfer(resume);
          expectedResume = upload.uploadId;
          activeId = upload.uploadId;
          $("recipient").value = upload.recipient;
          $("expiry").value = String(upload.expiryHours);
          $("compression").value = upload.compression;
          $("resume-instructions").hidden = false;
          $("resume-instructions").textContent =
            `Choose the same, unmodified ${upload.name} to resume from ${bytes(upload.offset)}.`;
          $("discard-upload").hidden = false;
        });
        discard.addEventListener("click", () =>
          discardUpload(upload.uploadId, discard),
        );
        actions.append(resume, discard);
        row.append(copy, actions);
        return row;
      }),
    );
  }
  function discardUpload(id, trigger) {
    if (!id || activeUpload) return;
    confirmAction({
      title: "Discard this unfinished upload?",
      description:
        "Saved parts will be deleted and reserved storage released. Sending this file later will start again.",
      label: "Discard upload",
      trigger,
      action: async () => {
        await api(`/api/uploads/${id}`, { method: "DELETE" });
        if (activeId === id) {
          activeId = expectedResume = null;
          $("discard-upload").hidden = true;
          clearError("upload-error");
        }
        notify("Unfinished upload discarded.");
        await refresh();
      },
    });
  }
  function reset() {
    activeId = expectedResume = null;
    signature = "";
    $("pending-uploads").hidden = true;
    $("pending-upload-list").replaceChildren();
  }
  function context() {
    if (contextRevision !== revision) {
      contextRevision = revision;
      reset();
    }
  }
  function newSend() {
    activeId = expectedResume = null;
    $("discard-upload").hidden = true;
    $("resume-instructions").hidden = true;
  }
  document.addEventListener("DOMContentLoaded", () =>
    $("discard-upload").addEventListener("click", () =>
      discardUpload(activeId, $("discard-upload")),
    ),
  );
  return { send, refreshPending, reset, newSend, context };
})();
