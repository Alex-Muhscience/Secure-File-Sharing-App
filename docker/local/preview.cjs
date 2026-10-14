// Audit preview only: the application backend is missing from this checkout.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8')
  .replace('<h1>', '<p role="alert"><strong>Local interface preview only.</strong> File transfers and email verification are unavailable while the backend is restored.</p><h1>')
  .replace(/<input /g, '<input disabled ')
  .replace(/<button /g, '<button disabled ')
  .replace(/<div class="security-note">[\s\S]*?<\/div>/, '')
  .replace('<script src="script.js"></script>', '');
const css = fs.readFileSync(path.join(__dirname, 'public/styles.css'));
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const url = req.url.split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', mode: 'interface-preview', transferBackend: 'unavailable' }));
  }
  if (url === '/ready' || url.startsWith('/api/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Transfer backend is missing. This deployment is an interface preview only.' }));
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  const asset = url === '/' || url === '/index.html' ? [page, 'text/html; charset=utf-8']
    : url === '/styles.css' ? [css, 'text/css; charset=utf-8'] : null;
  if (!asset) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': asset[1] });
  res.end(req.method === 'HEAD' ? undefined : asset[0]);
});
server.listen(3000, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
