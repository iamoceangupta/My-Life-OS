// Local stand-in for the Supabase API gateway: one origin serving the app,
// /rest/v1 -> PostgREST (:3000) and /auth/v1 -> Supabase Auth (:9999).
const http = require('http'), fs = require('fs'), path = require('path');
const APP = process.env.APP || '/home/claude/work/my-life-os-standalone.html';
let down = false; // toggle via /__down and /__up to simulate an unreachable backend
http.createServer((req, res) => {
  if (req.url === '/__down') { down = true; return res.end('down'); }
  if (req.url === '/__up') { down = false; return res.end('up'); }
  const m = req.url.match(/^\/(rest|auth)\/v1(\/.*)?$/);
  if (m) {
    if (down) { req.socket.destroy(); return; }
    if (!req.headers.apikey) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"No API key found in request"}'); }
    const port = m[1] === 'rest' ? 3000 : 9999;
    const headers = { ...req.headers, host: '127.0.0.1:' + port };
    // Mimic Kong: when no user JWT is sent, PostgREST/Auth get the apikey as bearer
    if (!headers.authorization) headers.authorization = 'Bearer ' + req.headers.apikey;
    const p = http.request({ host: '127.0.0.1', port, path: m[2] || '/', method: req.method, headers }, pr => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
    p.on('error', e => { res.writeHead(502); res.end(String(e)); });
    req.pipe(p); return;
  }
  // Static files of the PWA folder (index.html, sw.js, manifest, icons)
  const DIR = process.env.DIR || '/home/claude/pwa';
  let rel = decodeURIComponent(req.url.split('?')[0]); if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (file.startsWith(DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(file));
  }
  res.writeHead(404); res.end();
}).listen(8000, () => console.log('gateway on :8000'));
