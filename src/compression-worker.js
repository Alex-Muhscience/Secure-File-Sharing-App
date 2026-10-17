const { parentPort } = require('node:worker_threads');
const { promisify } = require('node:util');
const zlib = require('node:zlib');
const { encodeSTP } = require('./stc-codec');
const brotli = promisify(zlib.brotliCompress), zstd = promisify(zlib.zstdCompress);
async function compress(bytes, codec, effort = 4) {
  if (codec === 'none') return bytes;
  if (codec === 'stp1') return encodeSTP(bytes);
  if (codec === 'br') return brotli(bytes, {params:{[zlib.constants.BROTLI_PARAM_QUALITY]:effort,[zlib.constants.BROTLI_PARAM_LGWIN]:22}});
  if (codec === 'zstd') return zstd(bytes, {params:{[zlib.constants.ZSTD_c_compressionLevel]:effort}});
  throw new Error('Unknown codec');
}
async function job({bytes:input, codec, mode}) {
  const bytes = Buffer.from(input);
  if (codec) return {codec,bytes:await compress(bytes,codec)};
  const codecs = mode === 'research' ? ['zstd','br','stp1'] : ['zstd','br'];
  const effort = mode === 'smallest' ? 9 : 3;
  if (mode === 'adaptive' && bytes.length > 196608) {
    const middle = Math.floor(bytes.length / 2);
    const sample = Buffer.concat([bytes.subarray(0,65536),bytes.subarray(middle-32768,middle+32768),bytes.subarray(-65536)]);
    if ((await compress(sample,'zstd',1)).length >= sample.length * .98) return {codec:'none',bytes};
  }
  let best = {codec:'none',bytes};
  for (const candidate of codecs) {
    const encoded = await compress(bytes,candidate,effort);
    if (encoded.length < best.bytes.length && encoded.length < bytes.length * .98) best = {codec:candidate,bytes:encoded};
  }
  return best;
}
parentPort.on('message', async message => {
  try { const result = await job(message); parentPort.postMessage({bytes:result.bytes,codec:result.codec}); }
  catch (error) { parentPort.postMessage({error:error.message}); }
});
