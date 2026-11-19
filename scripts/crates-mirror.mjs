// crates-mirror.mjs — a local sparse-registry mirror for cargo.
//
// The sandbox's schannel TLS is broken for every native client (curl, cargo),
// but node's TLS works. This proxy lets cargo talk to a plain-HTTP
// sparse registry on 127.0.0.1 while we fetch the real HTTPS upstream:
//
//   GET /config.json                    → rewritten registry config (dl → this proxy)
//   GET /<sparse index path>            → https://index.crates.io/<path>
//   GET /crates/<name>/<file>.crate     → https://static.crates.io/crates/<...>
//
// Everything is cached under .cargo-mirror-cache/ so a restarted proxy never
// re-downloads. 404s propagate (missing index = absent crate for cargo).
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = 5189;
const INDEX = 'https://index.crates.io';
const DL = 'https://static.crates.io';
const CACHE = join(process.cwd(), '.cargo-mirror-cache');
const CONFIG = JSON.stringify({ dl: `http://127.0.0.1:${PORT}/crates`, api: `http://127.0.0.1:${PORT}` });

// serialize cache writes per path to avoid duplicate concurrent downloads
const inflight = new Map();

async function cachedFetch(url, cacheFile) {
  try {
    return { status: 200, body: await readFile(cacheFile) };
  } catch { /* not cached */ }
  let p = inflight.get(cacheFile);
  if (p) return p;
  p = (async () => {
    const res = await fetch(url);
    if (res.status !== 200) return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    const body = Buffer.from(await res.arrayBuffer());
    inflight.set(cacheFile, p);
    try {
      await mkdir(join(cacheFile, '..'), { recursive: true });
      await writeFile(cacheFile, body);
    } catch { /* cache write failures are non-fatal */ }
    return { status: 200, body };
  })();
  inflight.set(cacheFile, p);
  try { return await p; } finally { inflight.delete(cacheFile); }
}

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  void (async () => {
    try {
      if (url === '/config.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(CONFIG) });
        res.end(CONFIG);
        return;
      }
      const upstream = url.startsWith('/crates/')
        ? DL + url
        : INDEX + url;
      const cacheFile = join(CACHE, url.replace(/\.\./g, '__'));
      const { status, body } = await cachedFetch(upstream, cacheFile);
      res.writeHead(status, {
        'content-type': url.endsWith('.crate') ? 'application/octet-stream' : 'text/plain',
        'content-length': body.length,
      });
      res.end(body);
    } catch (err) {
      console.error('proxy error', url, err.message);
      res.writeHead(502);
      res.end('mirror failure: ' + err.message);
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cargo mirror listening on http://127.0.0.1:${PORT}/ (cache: ${CACHE})`);
});
