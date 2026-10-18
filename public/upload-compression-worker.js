importScripts("/stc-codec-core.js");
let tail = Promise.resolve();
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const gzip = async (bytes) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
async function prepare({ id, bytes: input, mode, estimatedMbps = 10 }) {
  const bytes = new Uint8Array(input),
    started = performance.now();
  if (bytes.length > 16 * 1024 * 1024)
    throw new Error("Chunk preparation exceeds its limit");
  const digest = await crypto.subtle.digest("SHA-256", bytes),
    sha256 = hex(digest);
  let wireBytes = bytes,
    wireCodec = "none";
  if (
    mode !== "none" &&
    bytes.length > 128 &&
    typeof CompressionStream === "function"
  ) {
    let sample = bytes;
    if (bytes.length > 196608) {
      const middle = Math.floor(bytes.length / 2);
      sample = new Uint8Array(196608);
      sample.set(bytes.subarray(0, 65536));
      sample.set(bytes.subarray(middle - 32768, middle + 32768), 65536);
      sample.set(bytes.subarray(-65536), 131072);
    }
    const trial = await gzip(sample);
    if (trial.length < sample.length * 0.95) {
      const packed = sample === bytes ? trial : await gzip(bytes);
      if (packed.length < wireBytes.length * 0.98) {
        wireBytes = packed;
        wireCodec = "gzip";
      }
    }
  }
  if (mode === "research" && bytes.length > 128) {
    const payload = STPCore.pack(bytes),
      encoded = new Uint8Array(4 + payload.length + 32);
    encoded.set([83, 84, 80, 49]);
    encoded.set(payload, 4);
    encoded.set(new Uint8Array(digest), 4 + payload.length);
    if (encoded.length < wireBytes.length * 0.98) {
      wireBytes = encoded;
      wireCodec = "stp1";
    }
  }
  const processingMs = performance.now() - started;
  if (
    mode === "adaptive" &&
    ((bytes.length - wireBytes.length) * 8) /
      (Math.max(1, estimatedMbps) * 1000) <
      processingMs
  ) {
    wireBytes = bytes;
    wireCodec = "none";
  }
  // Each output owns its full buffer; the caller's input was cloned on entry.
  const result = wireBytes.buffer;
  postMessage(
    {
      id,
      wireCodec,
      wireBytes: result,
      logicalSize: bytes.length,
      sha256,
      processingMs,
    },
    [result],
  );
}
onmessage = (event) => {
  tail = tail
    .then(() => prepare(event.data))
    .catch((error) => postMessage({ id: event.data.id, error: error.message }));
};
