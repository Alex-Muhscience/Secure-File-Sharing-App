function byteRange(header, size) {
  const invalid = () => { throw Object.assign(new Error('Requested range is unavailable'), { status: 416 }); };
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
  if (!header) return { start: 0, end: size - 1, length: size, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return invalid();
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return invalid();
    end = Math.min(size - 1, end);
  }
  return { start, end, length: end - start + 1, partial: true };
}
module.exports = { byteRange };
