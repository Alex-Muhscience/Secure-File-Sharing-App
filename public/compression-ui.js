"use strict";
const compressionUI = (() => {
  let action = "download",
    step = -1,
    serial = 0,
    controller = null,
    resumeId = null,
    jobId = null,
    resultFile = null,
    refreshTimer = null,
    wireSent = 0,
    elapsed = null;
  const tips = {
    documents:
      "Documents stay byte-for-byte intact, including signatures and formatting.",
    data: "Tables and repeated records can compress well. Numeric formats are evaluated without changing values.",
    developer:
      "Source and logs often compress well. Executables and packaged builds may already be compressed.",
    images:
      "Pixels and metadata stay intact. JPEG and PNG often have limited additional lossless savings.",
    media:
      "No transcoding or quality loss. Encoded music and video may not shrink further.",
    archives:
      "Archives and encrypted files can have little remaining redundancy. We keep the original when compression is not useful.",
  };
  const category = () =>
    document.querySelector('input[name="compression-category"]:checked').value;
  const dialog = () => $("compression-dialog");
  const valid = (run) =>
    run === serial &&
    controller &&
    !controller.signal.aborted &&
    Boolean(token);
  function reset() {
    serial++;
    controller?.abort();
    controller = null;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    uploadCompression.close();
    document.getElementById("compression-form")?.removeAttribute("aria-busy");
  }
  function context() {
    reset();
    if (dialog().open) dialog().close();
  }
  function list(id, rows) {
    $(id).replaceChildren(
      ...rows.map(([label, value]) => {
        const row = node("div");
        row.append(node("dt", "", label), node("dd", "", String(value)));
        return row;
      }),
    );
  }
  function screen(next) {
    step = next;
    clearError("compression-error");
    $("compression-actions").hidden = next !== -1;
    $("compression-form").hidden = next === -1;
    $("compression-result").hidden = true;
    $("compression-working").hidden = true;
    $("compression-navigation").hidden = false;
    const saved = Boolean(resumeId || jobId);
    $("compression-back").disabled = saved;
    for (const input of $("compression-form").querySelectorAll("input,select"))
      input.disabled =
        saved && (input.id !== "compression-file" || Boolean(jobId));
    for (const pane of dialog().querySelectorAll("[data-compression-step]"))
      pane.hidden = Number(pane.dataset.compressionStep) !== next;
    const labels =
      action === "restore"
        ? [
            [1, "Archive"],
            [3, "Review"],
          ]
        : [
            [0, "File type"],
            [1, "File"],
            [2, "Options"],
            [3, "Review"],
          ];
    $("compression-steps").hidden = next < 0;
    $("compression-steps").replaceChildren(
      ...labels.map(([index, label], i) => {
        const item = node("li", "", `${i + 1} `);
        item.append(node("span", "", label));
        if (index === next) item.setAttribute("aria-current", "step");
        return item;
      }),
    );
    const headings = {
      0: "What are you working with?",
      1: action === "restore" ? "Choose your archive." : "Choose your file.",
      2: "Choose how to compress.",
      3:
        action === "restore"
          ? "Ready to restore?"
          : "Check your file and options.",
    };
    $("compression-title").textContent =
      headings[next] || "What would you like to do?";
    $("compression-description").textContent =
      next < 0
        ? "Keep every original byte. Choose where your file goes next."
        : action === "restore"
          ? "Restore a Secure Transfer .stc archive. The original is inspected before download."
          : `${action === "send" ? "Compress and send" : "Compress and download"} · Lossless, with measured results.`;
    $("compression-next").hidden = next === 3;
    $("compression-submit").hidden = next !== 3;
    $("compression-submit").textContent =
      action === "restore"
        ? "Restore original"
        : action === "send"
          ? "Compress and send"
          : "Start compression";
    $("compression-recipient-fields").hidden = action !== "send";
    $("compression-recipient").required = action === "send";
    if (next === 3) {
      const file = $("compression-file").files[0];
      list("compression-review", [
        [
          "Action",
          action === "restore"
            ? "Restore original"
            : action === "send"
              ? "Compress and send"
              : "Compress and download",
        ],
        ["File", file?.name || ""],
        ["Original size", bytes(file?.size || 0)],
        ...(action === "restore"
          ? []
          : [
              ["Preference", $("compression-mode").selectedOptions[0].text],
              ["Archive", $("compression-format").selectedOptions[0].text],
            ]),
        ...(action === "send"
          ? [["Recipient", $("compression-recipient").value]]
          : []),
      ]);
    }
    dialog().scrollTop = 0;
    $("compression-title").focus({ preventScroll: true });
  }
  function open(trigger, readOnly = false) {
    if ((!readOnly && !canSend()) || activeUpload) return;
    reset();
    controller = new AbortController();
    resumeId = jobId = resultFile = null;
    wireSent = 0;
    elapsed = null;
    $("compression-form").reset();
    for (const input of $("compression-form").querySelectorAll(
      "input,select,button",
    ))
      input.disabled = false;
    for (const button of $("compression-result").querySelectorAll("button"))
      button.disabled = false;
    $("compression-copy-link").textContent = "Copy link";
    $("compression-selection").hidden = true;
    $("compression-detection").textContent = "";
    $("compression-file").setCustomValidity("");
    $("compression-file").removeAttribute("accept");
    $("compression-file-hint").textContent =
      `Any file type, up to ${bytes(config.maxFileSize)}. One file per job.`;
    $("compression-guidance").textContent = tips.documents;
    action = "download";
    screen(-1);
    resumable.newSend();
    openDialog(dialog(), trigger);
  }
  function choose(value) {
    action = value;
    $("compression-file").accept = value === "restore" ? ".stc" : "";
    if (value === "restore")
      document.querySelector(
        'input[name="compression-category"][value="archives"]',
      ).checked = true;
    screen(value === "restore" ? 1 : 0);
  }
  async function selected() {
    const file = $("compression-file").files[0],
      run = serial;
    if (!file) return;
    $("compression-selection").hidden = false;
    $("compression-selection").textContent =
      `${file.name} · ${bytes(file.size)}`;
    $("compression-file").setCustomValidity(
      file.size > config.maxFileSize
        ? `Choose a file within ${bytes(config.maxFileSize)}.`
        : "",
    );
    const sample = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    if (run !== serial || $("compression-file").files[0] !== file) return;
    const prefix = String.fromCharCode(...sample),
      detected =
        sample[0] === 137 && prefix.slice(1, 4) === "PNG"
          ? ["images", "PNG image"]
          : sample[0] === 255 && sample[1] === 216
            ? ["images", "JPEG image"]
            : prefix.startsWith("PK")
              ? ["archives", "ZIP / Office container"]
              : sample[0] === 31 && sample[1] === 139
                ? ["archives", "Gzip archive"]
                : prefix.startsWith("RIFF")
                  ? ["media", "RIFF media"]
                  : prefix.startsWith("%PDF")
                    ? ["documents", "PDF document"]
                    : null;
    $("compression-detection").textContent =
      action === "restore"
        ? "The archive structure and reconstructed original will be checked."
        : detected
          ? `${detected[1]}. ${detected[0] !== category() ? "This differs from your selected category. " : ""}Lossless processing and inspection still apply.`
          : tips[category()];
  }
  const wait = (ms, signal) =>
    new Promise((resolve, reject) => {
      const done = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        timer = setTimeout(done, ms),
        abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Paused", "AbortError"));
        };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  const info = async (id) =>
    (
      await api(`/api/file/${id}/compression`, { signal: controller.signal })
    ).json();
  function metrics(file) {
    resultFile = file;
    $("compression-result-name").textContent = file.name;
    list("compression-metrics", [
      ["Original file", bytes(file.originalBytes)],
      ["Encrypted storage", bytes(file.storedBytes)],
      ...(elapsed !== null
        ? [["Ready time · this attempt", `${elapsed.toFixed(1)} seconds`]]
        : []),
      ...(Number.isSafeInteger(file.uploadPayloadBytes)
        ? [["Received upload payload", bytes(file.uploadPayloadBytes)]]
        : wireSent
          ? [["Observed upload payload", bytes(wireSent)]]
          : []),
    ]);
    const format = $("compression-format").value,
      exported = file.exports?.[format];
    $("compression-savings").textContent = exported
      ? `Archive: ${bytes(exported.completedBytes)}. ${file.originalBytes ? `${(exported.reduction * 100).toFixed(1)}% reduction · ${exported.targetMet ? "Target met" : "75% target not met"}.` : "Empty file: no reduction percentage."}`
      : "75% target not measured yet. The actual archive size is recorded after a complete export.";
    $("compression-codecs").textContent = file.codecCounts.length
      ? "Stored parts: " +
        file.codecCounts
          .map(
            (row) =>
              `${{ br: "Brotli", zstd: "Zstandard", stp1: "Custom STP1", none: "Original" }[row._id] || row._id} (${row.parts})`,
          )
          .join(", ") +
        "."
      : "Original storage format.";
  }
  async function showResult(file, run) {
    if (!valid(run)) return;
    if (file.purpose === "restore" && file.restoredFileId) {
      file = await info(file.restoredFileId);
      if (!valid(run)) return;
      if (file.status !== "active") {
        await wait(500, controller.signal);
        return showResult(await info(jobId), run);
      }
    }
    $("compression-format").value =
      file.exportFormat === "gzip" ? "gzip" : "stc";
    metrics(file);
    $("compression-form").hidden = true;
    $("compression-actions").hidden = true;
    $("compression-result").hidden = false;
    $("compression-steps").hidden = true;
    $("compression-title").textContent =
      action === "restore"
        ? "Your original is restored."
        : "Your file is ready.";
    $("compression-description").textContent =
      "Inspection passed. Choose an archive or the exact original.";
    $("compression-share").hidden = action !== "send";
    $("compression-share-link").value =
      `${location.origin}/?transfer=${file.fileId}`;
    $("compression-download").hidden = action === "restore";
    $("compression-original").textContent =
      action === "restore" ? "Download restored original" : "Download original";
    clearError("compression-result-error");
    $("compression-title").focus({ preventScroll: true });
    clearTimeout(refreshTimer);
    const refresh = async () => {
      if (!valid(run)) return;
      try {
        const update = await info(file.fileId);
        if (valid(run)) metrics(update);
      } catch (error) {
        if (error.expired) return;
      }
      if (valid(run)) refreshTimer = setTimeout(refresh, 2000);
    };
    refreshTimer = setTimeout(refresh, 2000);
  }
  async function runJob(event) {
    event.preventDefault();
    if ($("compression-form").getAttribute("aria-busy") === "true") return;
    const run = serial,
      started = revision,
      signal = controller.signal,
      file = $("compression-file").files[0];
    if (!file && !jobId) return;
    $("compression-form").setAttribute("aria-busy", "true");
    $("compression-navigation").hidden = true;
    $("compression-working").hidden = false;
    clearError("compression-error");
    for (const pane of dialog().querySelectorAll("[data-compression-step]"))
      pane.hidden = true;
    try {
      if (!jobId && resumeId) {
        try {
          const existing = await info(resumeId);
          if (existing.fileId) jobId = resumeId;
        } catch (error) {
          if (error.expired || signal.aborted) throw error;
        }
      }
      const began = performance.now();
      if (!jobId) {
        const settings = {
          purpose:
            action === "restore"
              ? "restore"
              : action === "send"
                ? "send"
                : "compress",
          profile: category(),
          compression:
            action === "restore" ? "none" : $("compression-mode").value,
          exportFormat: $("compression-format").value,
          expiryHours: Number($("compression-expiry").value),
          ...(action === "send"
            ? { recipient: $("compression-recipient").value.trim() }
            : {}),
          ...(resumeId ? { resumeId } : {}),
        };
        const result = await resumable.send(file, settings, signal, {
          session: (saved) => {
            if (valid(run)) resumeId = saved.uploadId;
          },
          progress: (state) => {
            if (!valid(run)) return;
            wireSent = state.wireSentBytes;
            $("compression-progress").value = Math.floor(
              (state.offset / Math.max(1, file.size)) * 100,
            );
            $("compression-status").textContent =
              `Uploading · ${bytes(state.offset)} of ${bytes(file.size)} durably saved. Keep the unmodified original to resume.`;
          },
        });
        if (!valid(run) || started !== revision) return;
        jobId = result.fileId;
        wireSent = result.wireSentBytes;
      }
      $("compression-progress").value = 100;
      $("compression-status").textContent =
        action === "restore"
          ? "Restoring and inspecting the original…"
          : "Upload saved. Inspecting your file…";
      for (;;) {
        const current = await info(jobId);
        if (!valid(run) || started !== revision) return;
        if (current.status === "active") {
          elapsed = (performance.now() - began) / 1000;
          await showResult(current, run);
          await refresh();
          break;
        }
        if (["blocked", "deleted", "deleting"].includes(current.status))
          throw new Error(
            current.restoreError ||
              "This file did not pass inspection and cannot be downloaded.",
          );
        $("compression-status").textContent =
          current.restoreError ||
          (action === "restore"
            ? "Restoring and inspecting the original…"
            : "Inspection is in progress. Your file remains locked.");
        await wait(800, signal);
      }
    } catch (error) {
      if (valid(run) && started === revision) {
        screen(3);
        formError(
          "compression-error",
          (error.message ||
            "The job paused. Retry with the same unmodified original.") +
            (resumeId || jobId
              ? " This saved job keeps its original settings. Retry here, or close and start a new job to change them."
              : ""),
        );
      }
    } finally {
      if (valid(run)) $("compression-form").removeAttribute("aria-busy");
    }
  }
  async function download(representation, button) {
    const run = serial;
    if (!resultFile || !valid(run)) return;
    button.disabled = true;
    clearError("compression-result-error");
    try {
      const response = await api(
        `/api/file/${resultFile.fileId}/download-ticket`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ representation }),
          signal: controller.signal,
        },
      );
      const ticket = await response.json();
      if (!valid(run)) return;
      if (!/^\/api\/download\/[a-f\d]{64}$/.test(ticket.url))
        throw new Error("Invalid download handoff");
      const link = node("a");
      link.href = ticket.url;
      link.download =
        resultFile.name +
        (representation === "stc"
          ? ".stc"
          : representation === "gzip"
            ? ".gz"
            : "");
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      if (valid(run)) formError("compression-result-error", error.message);
    } finally {
      if (valid(run)) button.disabled = false;
    }
  }
  async function show(id, trigger) {
    open(trigger, true);
    if (!controller) return;
    jobId = id;
    $("compression-actions").hidden = true;
    $("compression-title").textContent = "Loading file details…";
    const run = serial;
    try {
      const file = await info(id);
      if (!valid(run)) return;
      action =
        file.purpose === "restore"
          ? "restore"
          : file.purpose === "send"
            ? "send"
            : "download";
      if (file.status === "active") await showResult(file, run);
      else {
        screen(3);
        await runJob({ preventDefault() {} });
      }
    } catch (error) {
      if (valid(run)) formError("compression-error", error.message);
    }
  }
  function resume(upload, trigger) {
    open(trigger);
    if (!controller) return;
    resumeId = upload.uploadId;
    action =
      upload.purpose === "restore"
        ? "restore"
        : upload.purpose === "send"
          ? "send"
          : "download";
    document.querySelector(
      `input[name="compression-category"][value="${upload.profile || "documents"}"]`,
    ).checked = true;
    $("compression-mode").value = upload.compression;
    $("compression-format").value = upload.exportFormat || "stc";
    $("compression-recipient").value = upload.recipient || "";
    $("compression-expiry").value = String(upload.expiryHours);
    screen(1);
    $("compression-file-hint").textContent =
      `Reselect the same unmodified ${upload.name}. ${bytes(upload.offset)} is saved.`;
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("new-compression").addEventListener("click", (event) =>
      open(event.currentTarget),
    );
    dialog().addEventListener("close", () => {
      if (!dialog().open) reset();
    });
    for (const button of dialog().querySelectorAll("[data-compression-action]"))
      button.addEventListener("click", () =>
        choose(button.dataset.compressionAction),
      );
    $("compression-form").addEventListener("submit", runJob);
    $("compression-file").addEventListener("change", () =>
      selected().catch((error) =>
        formError("compression-error", error.message),
      ),
    );
    for (const radio of dialog().querySelectorAll(
      '[name="compression-category"]',
    ))
      radio.addEventListener("change", () => {
        $("compression-guidance").textContent = tips[category()];
      });
    $("compression-industry").addEventListener("change", () => {
      $("compression-guidance").textContent = {
        business: "Reports, client records and everyday business files.",
        finance:
          "Keep statements, signed contracts and ledgers unchanged. Industry selection does not add a compliance certification.",
        research:
          "Keep research datasets and file metadata intact. This workflow makes no medical interpretation or certification.",
        engineering:
          "Compare compression on structured measurements, CAD exports and binary records.",
        creative:
          "Keep originals intact; encoded images, music and video may have little additional compression.",
        education:
          "Keep assignments, research material and teaching resources in their original format.",
      }[$("compression-industry").value];
    });
    $("compression-next").addEventListener("click", () => {
      if (step === 1 && !$("compression-file").reportValidity()) return;
      if (
        step === 2 &&
        action === "send" &&
        !$("compression-recipient").reportValidity()
      )
        return;
      screen(action === "restore" ? 3 : Math.min(3, step + 1));
    });
    $("compression-back").addEventListener("click", () =>
      screen(
        step === 0 || (action === "restore" && step === 1)
          ? -1
          : action === "restore"
            ? 1
            : step - 1,
      ),
    );
    $("compression-done").addEventListener("click", () => dialog().close());
    $("compression-pause").addEventListener("click", () => dialog().close());
    $("compression-download").addEventListener("click", (event) =>
      download($("compression-format").value, event.currentTarget),
    );
    $("compression-original").addEventListener("click", (event) =>
      download("original", event.currentTarget),
    );
    $("compression-copy-link").addEventListener("click", async () => {
      const run = serial;
      try {
        await navigator.clipboard.writeText($("compression-share-link").value);
        if (valid(run)) $("compression-copy-link").textContent = "Copied";
      } catch {
        if (valid(run))
          formError(
            "compression-result-error",
            "Select and copy the recipient link.",
          );
      }
    });
  });
  return { open, reset, context, show, resume };
})();
