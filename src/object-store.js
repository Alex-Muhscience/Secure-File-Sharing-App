const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
function validateId(id) {
  if (typeof id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(id)) throw new Error('Invalid object identifier');
  return id;
}
class FileStore {
  constructor(directory) { this.directory = directory; this.name = 'filesystem'; }
  objectPath(id) { return path.join(this.directory, `${validateId(id)}.enc`); }
  async init() { await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async ready() { await fsp.access(this.directory, fs.constants.R_OK | fs.constants.W_OK); }
  async write(id, stream, controller) {
    await pipeline(stream, fs.createWriteStream(this.objectPath(id), { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
  }
  async read(id, limit) {
    const handle = await fsp.open(this.objectPath(id), 'r');
    try {
      const stat = await handle.stat();
      if (stat.size > limit) throw new Error('Object exceeds size limit');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new Error('Incomplete object');
        offset += result.bytesRead;
      }
      return bytes;
    } finally { await handle.close(); }
  }
  async remove(id) { await fsp.rm(this.objectPath(id), { force: true }); }
  async *list() {
    for await (const entry of await fsp.opendir(this.directory)) {
      const name = entry.name;
      if (!/^[a-f\d-]{36}\.enc$/.test(name)) continue;
      const id = name.slice(0, -4);
      try { validateId(id); } catch { continue; }
      const stat = await fsp.stat(this.objectPath(id)).catch(() => null);
      if (stat) yield { id, modifiedAt: stat.mtime, backend: this.name };
    }
  }
  close() {}
}
class S3Store {
  constructor(config) {
    const { S3Client } = require('@aws-sdk/client-s3');
    this.commands = require('@aws-sdk/client-s3');
    this.config = config; this.name = 's3';
    this.client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 }, maxAttempts: 2 });
  }
  objectKey(id) { return `${this.config.prefix}${validateId(id)}.enc`; }
  async init() { await this.ready(); }
  async ready() { await this.client.send(new this.commands.HeadBucketCommand({ Bucket: this.config.bucket })); }
  async write(id, stream, controller) {
    const { Upload } = require('@aws-sdk/lib-storage');
    const upload = new Upload({ client: this.client, params: { Bucket: this.config.bucket, Key: this.objectKey(id), Body: stream, ContentType: 'application/octet-stream' },
      queueSize: 1, partSize: 5 * 1024 * 1024, leavePartsOnError: false, abortController: controller });
    await upload.done();
  }
  async read(id, limit) {
    const result = await this.client.send(new this.commands.GetObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(id) }));
    if (!result.Body) throw new Error('Missing object body');
    try {
      if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength > limit) throw new Error('Object exceeds size limit');
      const chunks = []; let size = 0;
      for await (const chunk of result.Body) {
        size += chunk.length;
        if (size > limit) throw new Error('Object exceeds size limit');
        chunks.push(Buffer.from(chunk));
      }
      if (size !== result.ContentLength) throw new Error('Incomplete object');
      return Buffer.concat(chunks, size);
    } finally { result.Body.destroy?.(); }
  }
  async remove(id) { await this.client.send(new this.commands.DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(id) })); }
  async *list() {
    let token;
    do {
      const result = await this.client.send(new this.commands.ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: this.config.prefix, ContinuationToken: token }));
      for (const item of result.Contents || []) {
        const tail = item.Key?.slice(this.config.prefix.length);
        if (!tail?.endsWith('.enc')) continue;
        const id = tail.slice(0, -4); try { validateId(id); } catch { continue; }
        if (item.LastModified) yield { id, modifiedAt: item.LastModified, backend: this.name };
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
  }
  async cleanupMultipart(before) {
    let keyMarker, uploadIdMarker;
    do {
      const result = await this.client.send(new this.commands.ListMultipartUploadsCommand({ Bucket: this.config.bucket, Prefix: this.config.prefix, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }));
      for (const upload of result.Uploads || []) {
        if (upload.Initiated && upload.Initiated < before) await this.client.send(new this.commands.AbortMultipartUploadCommand({ Bucket: this.config.bucket, Key: upload.Key, UploadId: upload.UploadId }));
      }
      keyMarker = result.IsTruncated ? result.NextKeyMarker : undefined;
      uploadIdMarker = result.IsTruncated ? result.NextUploadIdMarker : undefined;
    } while (keyMarker);
  }
  close() { this.client.destroy(); }
}
module.exports = { FileStore, S3Store, validateId };
