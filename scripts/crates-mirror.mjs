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
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = 5189;
const INDEX = 'https://index.crates.io';
const DL = 'https://static.crates.io';
const CACHE = join(process.cwd(), '.cargo-mirror-cache');
const CONFIG = JSON.stringify({ dl: `http://127.0.0.1:${PORT}/crates`, api: `http://127.0.0.1:${PORT}` });

// Only these two origins may ever be fetched. The upstream is derived from a
// client-supplied request path, so the allowlist is checked again at fetch time
// (code scanning: server-side request forgery).
const HOSTS = new Set([new URL(INDEX).host, new URL(DL).host]);

/** Map a request path to its upstream URL and a traversal-safe cache file. */
export function upstreamFor(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
    throw new Error('a mirror path must be a single leading-slash path');
  }
  // Reject every shape that could turn the path into an absolute URL, escape
  // the upstream host, or escape the cache directory.
  if (/[\\\u0000-\u001f]/.test(rawUrl) || rawUrl.includes('://') ||
      rawUrl.includes('..') || rawUrl.includes('@')) {
    throw new Error('unsafe characters in mirror path');
  }
  const base = rawUrl.startsWith('/crates/') ? DL : INDEX;
  const target = new URL(rawUrl, base);
  if (target.protocol !== 'https:' || target.origin !== base || !HOSTS.has(target.host)) {
    throw new Error('upstream origin is not on the allowlist');
  }
  const key = createHash('sha256').update(target.pathname + target.search).digest('hex');
  return { target, cacheFile: join(CACHE, key) };
}

// serialize cache writes per path to avoid duplicate concurrent downloads
const inflight = new Map();

async function cachedFetch(target, cacheFile) {
  // Defence in depth: never fetch anything but the two pinned HTTPS origins,
  // even if a future caller hands this helper a different URL object.
  if (!(target instanceof URL) || target.protocol !== 'https:' || !HOSTS.has(target.host)) {
    throw new Error('refusing an upstream outside the allowlist');
  }
  try {
    return { status: 200, body: await readFile(cacheFile) };
  } catch { /* not cached */ }
  let p = inflight.get(cacheFile);
  if (p) return p;
  p = (async () => {
    const res = await fetch(target);
    if (res.status !== 200) return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    const body = Buffer.from(await res.arrayBuffer());
    inflight.set(cacheFile, p);
    try {
      await mkdir(dirname(cacheFile), { recursive: true });
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
      const { target, cacheFile } = upstreamFor(url);
      const { status, body } = await cachedFetch(target, cacheFile);
      res.writeHead(status, {
        'content-type': url.endsWith('.crate') ? 'application/octet-stream' : 'text/plain; charset=utf-8',
        'content-length': body.length,
      });
      res.end(body);
    } catch (err) {
      // Log the detail locally, but never reflect an exception string into an
      // HTTP response: a browser could sniff it as HTML and execute it
      // (code scanning: exception text reinterpreted as HTML).
      console.error('proxy error', url, err);
      const message = 'mirror failure';
      res.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(message),
      });
      res.end(message);
    }
  })();
});

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`cargo mirror listening on http://127.0.0.1:${PORT}/ (cache: ${CACHE})`);
  });
}
