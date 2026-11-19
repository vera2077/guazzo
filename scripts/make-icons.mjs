// make-icons.mjs — generates src-tauri/icons/ (PNG 32/128/256 + icon.ico)
// with zero dependencies: raw PNG chunks + zlib + a table-based CRC32.
// Design: rounded blue tile with a lighter disc — a tiny guazzo palette mark.
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
  // Design: a soft-rounded tile with a blue gradient, a white brush stroke
  // and its trailing dab. Everything is analytic + 3x3 supersampled, so it
  // stays crisp from 16 px taskbar icons up to 256 px.
  const S = 3; // supersamples per axis
  const R = size * 0.22; // corner radius
  const m = size * 0.03; // margin so the tile does not touch the edge

  const sdRoundRect = (x, y) => {
    const qx = Math.abs(x - size / 2) - (size / 2 - m - R);
    const qy = Math.abs(y - size / 2) - (size / 2 - m - R);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
  };
  const sdSegment = (x, y, ax, ay, bx, by, r) => {
    const pa = [x - ax, y - ay];
    const ba = [bx - ax, by - ay];
    const h = Math.max(0, Math.min(1, (pa[0] * ba[0] + pa[1] * ba[1]) / (ba[0] * ba[0] + ba[1] * ba[1])));
    return Math.hypot(pa[0] - ba[0] * h, pa[1] - ba[1] * h) - r;
  };

  const sample = (x, y) => {
    const d = sdRoundRect(x, y);
    if (d > 0.6) return [0, 0, 0, 0];
    // rounded corners fade over one pixel
    const tileA = Math.max(0, Math.min(1, 0.5 - d));

    // gradient #7aa6ff (top-left) → #2440c9 (bottom-right)
    const t = Math.max(0, Math.min(1, (x + y) / (size * 2)));
    let r = 122 + (36 - 122) * t;
    let g = 166 + (64 - 166) * t;
    let b = 255 + (201 - 255) * t;

    // soft top highlight
    const hh = Math.max(0, 1 - y / (size * 0.55));
    r += 22 * hh; g += 26 * hh; b += 18 * hh;

    // brush stroke (white capsule) + trailing dab
    const stroke = sdSegment(x, y, size * 0.30, size * 0.72, size * 0.63, size * 0.33, size * 0.085);
    const dab = Math.hypot(x - size * 0.755, y - size * 0.255) - size * 0.062;
    const ink = Math.max(0, Math.min(1, 0.5 - stroke * 1.0));
    const dabA = Math.max(0, Math.min(1, 0.5 - dab * 1.0));
    const white = Math.max(ink, dabA);
    // a faint shadow under the stroke keeps it readable on light taskbars
    const shadow = Math.max(0, Math.min(1, 0.5 - (stroke - size * 0.02) * 1.0)) * 0.18;
    r = r * (1 - shadow) + 8 * shadow;
    g = g * (1 - shadow) + 14 * shadow;
    b = b * (1 - shadow) + 40 * shadow;
    r = r * (1 - white) + 255 * white;
    g = g * (1 - white) + 255 * white;
    b = b * (1 - white) + 255 * white;
    // Buffer byte assignment TRUNCATES (263 → 7, which turned the highlight
    // corner green), so clamp before rounding.
    const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return [cl(r), cl(g), cl(b), Math.round(255 * tileA)];
  };

  const px = (x, y) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const p = sample(x + (sx + 0.5) / S, y + (sy + 0.5) / S);
        r += p[0]; g += p[1]; b += p[2]; a += p[3];
      }
    }
    const n = S * S;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
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

const ICO_SIZES = [16, 32, 48, 256]; // small entries sharpen taskbar/alt-tab icons
const pngs = new Map(ICO_SIZES.map((s) => [s, makePng(s)]));
const png256 = pngs.get(256);
// ICO with PNG entries for 16/32/48/256 (Vista+ supports PNG-in-ICO)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(ICO_SIZES.length, 4);
const entries = [];
let offset = 6 + 16 * ICO_SIZES.length;
for (const s of ICO_SIZES) {
  const png = pngs.get(s);
  const entry = Buffer.alloc(16);
  entry[0] = s & 0xff; // width byte; 0 means 256
  entry[2] = s & 0xff; // height byte; 0 means 256
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12); // data offset
  offset += png.length;
  entries.push(entry);
}
const ico = Buffer.concat([header, ...entries, ...ICO_SIZES.map((s) => pngs.get(s))]);

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, '16x16.png'), pngs.get(16));
await writeFile(join(OUT, '32x32.png'), pngs.get(32));
await writeFile(join(OUT, '48x48.png'), pngs.get(48));
await writeFile(join(OUT, '128x128.png'), makePng(128));
await writeFile(join(OUT, 'icon.png'), png256);
await writeFile(join(OUT, 'icon.ico'), ico);
console.log('wrote 16x16.png, 32x32.png, 48x48.png, 128x128.png, icon.png, icon.ico (4-entry ICO)');
