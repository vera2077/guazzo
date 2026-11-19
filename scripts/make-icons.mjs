// make-icons.mjs — generates src-tauri/icons/ (PNG 32/128/256 + icon.ico)
// with zero dependencies: raw PNG chunks + zlib + a table-based CRC32.
// Design: rounded blue tile with a lighter disc — a tiny pigment palette mark.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'src-tauri', 'icons');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  const px = (x, y) => {
    // rounded-rect mask
    const r = size * 0.18;
    const inRect = (v, lo, hi) => v >= lo && v < hi;
    const cx = Math.max(r, Math.min(size - r, x + 0.5));
    const cy = Math.max(r, Math.min(size - r, y + 0.5));
    const distCorner = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const inside = inRect(x + 0.5, r, size - r) && inRect(y + 0.5, 0, size) && inRect(y + 0.5, r, size - r) ? true : distCorner <= r;
    if (!inside) return [0, 0, 0, 0];
    // base tile #094fd1
    const base = [9, 79, 209, 255];
    // inner disc #7fb2ff at 62% size
    const c = size / 2;
    if (Math.hypot(x + 0.5 - c, y + 0.5 - c) <= size * 0.31) return [127, 178, 255, 255];
    // small white highlight dot on the disc
    if (Math.hypot(x + 0.5 - (c - size * 0.1), y + 0.5 - (c - size * 0.1)) <= size * 0.06) return [255, 255, 255, 255];
    return base;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png256 = makePng(256);
// ICO with a single 256x256 PNG entry (Vista+ supports PNG-in-ICO)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; // 0 means 256
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png256.length, 8);
entry.writeUInt32LE(22, 12); // data offset
const ico = Buffer.concat([header, entry, png256]);

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, '32x32.png'), makePng(32));
await writeFile(join(OUT, '128x128.png'), makePng(128));
await writeFile(join(OUT, 'icon.png'), png256);
await writeFile(join(OUT, 'icon.ico'), ico);
console.log('wrote 32x32.png, 128x128.png, icon.png, icon.ico');
