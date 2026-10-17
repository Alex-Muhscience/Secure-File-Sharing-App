const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { promisify } = require('node:util');
const zlib = require('node:zlib');
const { decodeSTP } = require('./stc-codec');
const MAX = 64 * 1024 * 1024, CODECS = Object.freeze(['none','br','zstd','stp1']);
const brotli = promisify(zlib.brotliDecompress), zstd = promisify(zlib.zstdDecompress);
let worker = null, active = null;
const queue = [];
const abortError = () => Object.assign(new Error('Compression canceled'), {name:'AbortError'});
function destroy(error) {
  const old = worker; worker = null;
  if (active) { const job=active;active=null;job.cleanup();job.reject(error); }
  old?.terminate().catch(()=>{});
  pump();
}
function pump() {
  if (active || !queue.length) return;
  active = queue.shift();
  if (!worker) {
    worker = new Worker(path.join(__dirname,'compression-worker.js'), {resourceLimits:{maxOldGenerationSizeMb:64}});
    const current = worker;
    worker.on('message', result => {
      if (worker !== current || !active) return;
      const job=active;active=null;job.cleanup();current.unref();
      result.error ? job.reject(new Error(result.error)) : job.resolve({codec:result.codec,bytes:Buffer.from(result.bytes)});
      pump();
    });
    worker.on('error', error => { if(worker===current) destroy(error); });
    worker.on('exit', () => { if(worker===current) destroy(new Error('Compression worker ended')); });
  }
  worker.ref(); worker.postMessage(active.message);
}
function run(message, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (queue.length >= 8) return Promise.reject(Object.assign(new Error('Compression capacity reached; retry later'),{status:503}));
  return new Promise((resolve,reject)=>{
    const job={message,resolve,reject,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
    const abort=()=>{if(active===job) destroy(abortError());else{const i=queue.indexOf(job);if(i>=0){queue.splice(i,1);job.cleanup();reject(abortError());}}};
    const timer=setTimeout(abort,60000);timer.unref();
    signal?.addEventListener('abort',abort,{once:true});queue.push(job);pump();
  });
}
function validate(bytes) { if(!Buffer.isBuffer(bytes)||bytes.length>MAX) throw new Error('Invalid compression input'); }
async function encode(bytes,{mode='adaptive',signal}={}) {
  validate(bytes);
  if(!['adaptive','smallest','research','none'].includes(mode))throw new Error('Unknown compression mode');
  if(signal?.aborted)throw abortError();
  return mode==='none'||!bytes.length?{codec:'none',bytes}:run({bytes,mode},signal);
}
async function encodeCodec(bytes,codec,signal) {
  validate(bytes);if(!CODECS.includes(codec))throw new Error('Unknown codec');
  return (await run({bytes,codec},signal)).bytes;
}
async function decode(bytes,codec,expectedSize) {
  if(!CODECS.includes(codec)||!Number.isSafeInteger(expectedSize)||expectedSize<0||expectedSize>MAX||!Buffer.isBuffer(bytes)||bytes.length>MAX+65536)throw new Error('Invalid encoded part');
  const options={maxOutputLength:Math.max(1,expectedSize)};
  const plain=codec==='none'?bytes:codec==='br'?await brotli(bytes,options):codec==='zstd'?await zstd(bytes,options):decodeSTP(bytes,expectedSize);
  if(plain.length!==expectedSize)throw new Error('Decoded length mismatch');
  return plain;
}
async function shutdown() {
  const error=new Error('Compression worker closed');
  while(queue.length){const job=queue.shift();job.cleanup();job.reject(error);}
  const old=worker;worker=null;if(active){const job=active;active=null;job.cleanup();job.reject(error);}await old?.terminate();
}
module.exports={encode,decode,encodeCodec,CODECS,shutdown};
