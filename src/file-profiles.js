const PROFILES = Object.freeze([
  "documents",
  "data",
  "developer",
  "images",
  "media",
  "archives",
]);
function profileFor(name, sample, selected = "documents") {
  if (
    !PROFILES.includes(selected) ||
    typeof name !== "string" ||
    !(sample instanceof Uint8Array) ||
    sample.length > 196608
  )
    throw new Error("Invalid file profile");
  const bytes = Buffer.from(sample),
    text = bytes.subarray(0, 32).toString("latin1"),
    extension = name.toLowerCase().split(".").at(-1);
  let detected = "Generic file",
    category = selected,
    likelyCompressed = false;
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    detected = "PNG image";
    category = "images";
    likelyCompressed = true;
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    detected = "JPEG image";
    category = "images";
    likelyCompressed = true;
  } else if (text.startsWith("PK\x03\x04")) {
    detected = "ZIP / Office container";
    category = ["docx", "xlsx", "pptx"].includes(extension)
      ? "documents"
      : "archives";
    likelyCompressed = true;
  } else if (bytes[0] === 31 && bytes[1] === 139) {
    detected = "Gzip archive";
    category = "archives";
    likelyCompressed = true;
  } else if (text.startsWith("%PDF")) {
    detected = "PDF document";
    category = "documents";
    likelyCompressed = true;
  } else if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") {
    detected = "WAV audio";
    category = "media";
  } else if (
    text.slice(4, 8) === "ftyp" ||
    text.startsWith("fLaC") ||
    text.startsWith("ID3")
  ) {
    detected = "Encoded media";
    category = "media";
    likelyCompressed = true;
  }
  return {
    id: selected,
    detected,
    likelyCompressed,
    warning:
      category !== selected
        ? "The file signature differs from this category. It will still be processed losslessly and inspected."
        : likelyCompressed
          ? "This format may already be compressed; additional savings can be small."
          : null,
  };
}
module.exports = { PROFILES, profileFor };
