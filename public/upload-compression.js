"use strict";
const uploadCompression = (() => {
  let worker = null,
    serial = 0;
  const pending = new Map();
  const abortError = () =>
    new DOMException("Chunk preparation canceled", "AbortError");
  function close() {
    const current = worker;
    worker = null;
    current?.terminate();
    for (const job of pending.values()) {
      job.cleanup();
      job.reject(abortError());
    }
    pending.clear();
  }
  function start() {
    if (worker) return;
    worker = new Worker("/upload-compression-worker.js");
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      job.cleanup();
      data.error ? job.reject(new Error(data.error)) : job.resolve(data);
    };
    worker.onerror = () => close();
  }
  async function prepareChunk(
    bytes,
    { mode = "adaptive", signal, estimatedMbps = 10 } = {},
  ) {
    if (signal?.aborted) throw abortError();
    if (bytes.byteLength > 16 * 1024 * 1024)
      throw new Error("Chunk exceeds preparation limit");
    if (typeof Worker === "function") {
      try {
        start();
        return await new Promise((resolve, reject) => {
          const id = ++serial,
            abort = () => close(),
            timer = setTimeout(abort, 30000);
          const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
          };
          signal?.addEventListener("abort", abort, { once: true });
          pending.set(id, { resolve, reject, cleanup });
          worker.postMessage({ id, bytes, mode, estimatedMbps });
        });
      } catch (error) {
        if (signal?.aborted) throw abortError();
      }
    }
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return {
      wireCodec: "none",
      wireBytes: bytes,
      logicalSize: bytes.byteLength,
      sha256: [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      processingMs: 0,
    };
  }
  return { prepareChunk, close };
})();
