# Compression engine and portable formats

Implementation is underway for v0.6.0. The default pilot still accepts 10 MiB, and full-scale terabyte validation is separate.

## STP1 custom predictive codec

STP1 is our independently implemented lossless byte predictor and block packer. It is not an invention claim about prediction/bit packing and is not a renamed Brotli/Zstandard stream. It uses these established techniques in a documented versioned format; comparative strength must be measured.

An STP1 stream consists of ASCII `STP1`, a core payload and a 32-byte SHA-256 of the exact original. The core begins with one predictor stride byte and a little-endian uint32 original length. Stride zero stores literal original bytes. Other valid strides are 1, 2, 4, 8 and 16. Prediction is the previous original byte at that stride, or zero before enough history exists. The residual is the difference modulo 256.

For a predictive payload, each block of at most 256 original bytes begins with its minimal residual bit width (0–8). Residuals follow least-significant bit first; unused bits in the final byte must be zero. Blocks share prediction history within the part. The encoder chooses the shortest complete core among the six allowed choices, retaining literal bytes on ties. Golden core example: original `00010203` encodes as `0104000000010e`.

Both encoders and decoders cap an original part at 64 MiB. A decoder validates expected size, stride, input bounds, minimal widths, padding, complete consumption and SHA-256; it does not allocate based on an unconstrained file header. The portable core uses `Uint8Array`; Node/browser wrappers supply platform SHA-256. Checksums detect corruption, not hostile rewriting: stored parts remain authenticated with AES-256-GCM and the ordered keyed manifest. No new encryption algorithm is introduced.

This codec targets correlated byte streams and may lose badly to established codecs on text, compressed media and random bytes. It is evaluated as an explicit research candidate. Reaching 75% reduction for one fixture does not establish a universal lossless guarantee.
