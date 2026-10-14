const net = require('node:net');
class Scanner {
  constructor(config) { this.config = config; }
  async scan(bytes) {
    if (!this.config.scannerHost) throw new Error('Malware scanner is not configured');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.config.scannerHost, port: this.config.scannerPort });
      let response = '', settled = false;
      const done = (error, result) => {
        if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result);
      };
      socket.setTimeout(30000, () => done(new Error('Scanner timeout')));
      socket.on('error', error => done(error));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          const chunk = bytes.subarray(offset, offset + 65536), size = Buffer.alloc(4); size.writeUInt32BE(chunk.length);
          socket.write(size); socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on('data', chunk => {
        response += chunk.toString();
        if (response.length > 4096) return done(new Error('Invalid scanner response'));
        if (!response.includes('\0') && !response.includes('\n')) return;
        const reply = response.replace(/[\0\r\n]/g, '');
        if (reply === 'stream: OK') done(null, { clean: true });
        else if (/^stream: .+ FOUND$/.test(reply)) done(null, { clean: false, signature: reply.slice(8, -6) });
        else done(new Error('Scanner could not inspect the file'));
      });
      socket.on('end', () => { if (!settled) done(new Error('Incomplete scanner response')); });
    });
  }
}
module.exports = { Scanner };
