// Guazzo dev server — tiny static file server, no dependencies, no child processes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const port = Number(process.argv[2]) || 5188;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    // separator-aware containment: a plain startsWith(root) would also let
    // sibling directories like <root>-evil through (handoff-3 T5)
    const inside = file.startsWith(root) &&
      (file.length === root.length || file[root.length] === '\\' || file[root.length] === '/');
    if (!inside) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    const code = e && e.code === 'EACCES' ? 403 : 404;
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(`${code}`);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Guazzo dev server: http://127.0.0.1:${port}/`);
});
