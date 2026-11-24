/**
 * filtergallery.ts — the "Filter Gallery" family engine.
 *
 * A small, deterministic, DOM-free set of pixel stylisers. Every entry point
 * works on a flat RGBA buffer and returns a *new* Uint8ClampedArray; the input
 * is only ever read, so callers keep their original pixels. Alpha is carried
 * through untouched (a selection edge must never erode). No randomness is
 * used anywhere — all grain/weave/edge decisions are pure functions of pixel
 * position and value, so a given input always produces byte-identical output.
 */

export type GalleryKind =
  | "poster-edges"
  | "colored-pencil"
  | "rough-pastel"
  | "canvas-texture"
  | "note-paper";

/** All supported gallery filters, in display order. */
export const GALLERY_KINDS: readonly GalleryKind[] = [
  "poster-edges",
  "colored-pencil",
  "rough-pastel",
  "canvas-texture",
  "note-paper",
];

/** Standard 4x4 ordered-dither (Bayer) threshold map, values 0..15. */
const BAYER_4X4: readonly number[] = [
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5,
];

function bayer(x: number, y: number): number {
  return BAYER_4X4[(y & 3) * 4 + (x & 3)]!;
}

function fgLuma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function fgClamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Map a channel value onto `levels` evenly spaced steps (e.g. 4 -> 0,85,170,255). */
function quantize(v: number, levels: number): number {
  const step = 255 / (levels - 1);
  return Math.round(Math.round(v / step) * step);
}

function buildLuma(src: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    out[i] = fgLuma(src[p]!, src[p + 1]!, src[p + 2]!);
  }
  return out;
}

function sampleLum(lum: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
  return lum[cy * w + cx]!;
}

/** Sobel fgLuma gradient magnitude at (x,y), normalised so the ceiling is ~255. */
function sobel(lum: Float32Array, w: number, h: number, x: number, y: number): number {
  const gx =
    -sampleLum(lum, w, h, x - 1, y - 1) -
    2 * sampleLum(lum, w, h, x - 1, y) -
    sampleLum(lum, w, h, x - 1, y + 1) +
    sampleLum(lum, w, h, x + 1, y - 1) +
    2 * sampleLum(lum, w, h, x + 1, y) +
    sampleLum(lum, w, h, x + 1, y + 1);
  const gy =
    -sampleLum(lum, w, h, x - 1, y - 1) -
    2 * sampleLum(lum, w, h, x, y - 1) -
    sampleLum(lum, w, h, x + 1, y - 1) +
    sampleLum(lum, w, h, x - 1, y + 1) +
    2 * sampleLum(lum, w, h, x, y + 1) +
    sampleLum(lum, w, h, x + 1, y + 1);
  return Math.sqrt(gx * gx + gy * gy) / 4;
}

/**
 * Apply a filter-gallery stylisation to an RGBA buffer.
 *
 * `amount` is a 0..100 strength: 0 yields a byte-identical copy of `src`,
 * 100 is the full stylisation. Non-finite amounts are treated as 0, and
 * finite ones are clamped into the 0..100 range. Unknown kinds are rejected
 * by returning a copy of `src` rather than throwing.
 */
export function galleryFilter(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  kind: GalleryKind,
  amount: number,
): Uint8ClampedArray {
  // Fresh buffer seeded with the source. This is the baseline copy returned
  // for amount 0 / non-finite amounts / unknown kinds, and it carries alpha
  // through unchanged for every path below.
  const out = new Uint8ClampedArray(src.length);
  out.set(src);

  if (!Number.isFinite(amount)) amount = 0;
  const t = Math.max(0, Math.min(100, amount)) / 100;
  if (t === 0) return out;

  if (!(GALLERY_KINDS as readonly string[]).includes(kind)) return out;

  const edgeStrength = (lum: Float32Array, x: number, y: number): number =>
    Math.min(1, sobel(lum, w, h, x, y) / 180);

  if (kind === "poster-edges") {
    const lum = buildLuma(src, w, h);
    const THRESHOLD = 32;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const p = i * 4;
        const dark = sobel(lum, w, h, x, y) > THRESHOLD ? 0.5 : 1;
        for (let c = 0; c < 3; c++) {
          const orig = src[p + c]!;
          const full = quantize(orig, 4) * dark;
          out[p + c] = orig + (full - orig) * t;
        }
      }
    }
    return out;
  }

  if (kind === "colored-pencil") {
    const lum = buildLuma(src, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const p = i * 4;
        const grey = quantize(lum[i]!, 4);
        const shade = 1 - 0.65 * edgeStrength(lum, x, y);
        const full = grey * shade;
        for (let c = 0; c < 3; c++) {
          const orig = src[p + c]!;
          out[p + c] = orig + (full - orig) * t;
        }
      }
    }
    return out;
  }

  if (kind === "rough-pastel") {
    const AMPLITUDE = 30;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const grain = (bayer(x, y) / 15 - 0.5) * AMPLITUDE;
        for (let c = 0; c < 3; c++) {
          const orig = src[p + c]!;
          const full = fgClamp255(quantize(orig, 5) + grain);
          out[p + c] = orig + (full - orig) * t;
        }
      }
    }
    return out;
  }

  if (kind === "canvas-texture") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const diag = (x + y) & 3;
        const warp = x & 3;
        let factor = 1;
        if (diag === 0) factor -= 0.10;
        else if (diag === 2) factor -= 0.05;
        if (warp === 0) factor -= 0.08;
        else if (warp === 2) factor -= 0.04;
        const scale = 1 - (1 - factor) * t;
        for (let c = 0; c < 3; c++) {
          out[p + c] = src[p + c]! * scale;
        }
      }
    }
    return out;
  }

  // note-paper: warm cream tint plus Bayer grain.
  {
    const AMPLITUDE = 16;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const grain = (bayer(x, y) / 15 - 0.5) * AMPLITUDE;
        const r = src[p]!, g = src[p + 1]!, b = src[p + 2]!;
        const fr = fgClamp255(r * 1.05 + 8 + grain);
        const fg = fgClamp255(g * 1.01 + 3 + grain);
        const fb = fgClamp255(b * 0.92 - 4 + grain);
        out[p] = r + (fr - r) * t;
        out[p + 1] = g + (fg - g) * t;
        out[p + 2] = b + (fb - b) * t;
      }
    }
    return out;
  }
}
