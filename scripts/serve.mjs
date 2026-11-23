// Guazzo dev server — tiny static file server, no dependencies, no child processes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

// The dev server serves THIS repository, not "whatever directory you were in":
// launched from $HOME it exposed .git, dotfiles and keys to any local page.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOSTS = new Set([`localhost:${Number(process.argv[2]) || 5188}`, `127.0.0.1:${Number(process.argv[2]) || 5188}`]);
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
    if (!HOSTS.has(String(req.headers.host ?? ""))) {
      res.writeHead(403); res.end('forbidden host'); return;
    }
    let p = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    // Dotfiles are not part of the page: .git, .env and .secrets are all one
    // path segment away from a local web page otherwise.
    if (p.split(/[\\/]/).some((seg) => seg.startsWith('.'))) {
      res.writeHead(404); res.end('not found'); return;
    }
    // The page needs a handful of prefixes; ./release and ./node_modules are
    // not among them (sec-r15 #3).
    const clean = p.replace(/^\/+/, '');
    const allowed = ['index.html', 'app-single.html', 'dist/', 'vendor/', 'src/', 'docs/'];
    if (!allowed.some((prefix) => clean === prefix || clean.startsWith(prefix))) {
      res.writeHead(404); res.end('not found'); return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    // separator-aware containment: a plain startsWith(root) would also let
    // sibling directories like <root>-evil through (handoff-3 T5)
    const inside = file.startsWith(root) &&
      (file.length === root.length || file[root.length] === '\\' || file[root.length] === '/');
    if (!inside) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch (e) {
    const code = e && e.code === 'EACCES' ? 403 : 404;
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(`${code}`);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Guazzo dev server: http://127.0.0.1:${port}/`);
});
