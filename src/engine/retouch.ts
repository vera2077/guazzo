// Brush-style pixel operations that CHANGE EXISTING pixels instead of painting
// colour over them: dodge, burn, sponge, blur, sharpen, smudge, clone, red-eye.
// Kept separate from paint.ts because a dab here reads its neighbourhood.
import { TILE, type TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

/** Undo hook: a stroke session records each tile's before-image the first time
 *  a dab touches it, so one history entry can undo the whole stroke. */
export interface TileSession {
  noteTile(tx: number, ty: number, tile: { data: Uint8ClampedArray }): void;
}

export interface RetouchDab {
  x: number;
  y: number;
  radius: number;
  /** 0 = fully soft edge, 1 = hard edge */
  hardness: number;
  mask?: PixelMask | null;
  /** rectangular selection clip, document coords */
  clip?: { x: number; y: number; w: number; h: number } | null;
  session?: TileSession;
}

export interface Rect4 { x: number; y: number; w: number; h: number }

/** smoothstep falloff, identical to the paint dab so brush edges match */
function weightAt(dx: number, dy: number, radius: number, hardness: number): number {
  const d = Math.hypot(dx, dy);
  if (d > radius) return 0;
  const inner = radius * Math.max(0, Math.min(1, hardness));
  if (d <= inner) return 1;
  const t = 1 - (d - inner) / Math.max(1e-6, radius - inner);
  return t * t * (3 - 2 * t);
}

interface Bounds { x0: number; y0: number; x1: number; y1: number }

function dabBounds(grid: TileGrid, d: RetouchDab): Bounds | null {
  const r = Math.max(1, d.radius);
  const x0 = Math.max(0, Math.floor(d.x - r));
  const y0 = Math.max(0, Math.floor(d.y - r));
  const x1 = Math.min(grid.width, Math.ceil(d.x + r) + 1);
  const y1 = Math.min(grid.height, Math.ceil(d.y + r) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

function maskAlpha(mask: PixelMask | null | undefined, x: number, y: number): number {
  return mask ? mask.alphaAt(x, y) / 255 : 1;
}

/** selection-mask alpha × rectangular selection clip */
function coverage(o: RetouchDab, x: number, y: number): number {
  if (o.clip) {
    const c = o.clip;
    if (x < c.x || y < c.y || x >= c.x + c.w || y >= c.y + c.h) return 0;
  }
  return maskAlpha(o.mask, x, y);
}

/** Read a document rect into a private buffer (straight RGBA). */
function readInto(grid: TileGrid, b: Bounds): Uint8ClampedArray {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const buf = new Uint8ClampedArray(w * h * 4);
  grid.readRect(b.x0, b.y0, w, h, buf);
  return buf;
}

/** luminance 0..1 (blend.ts keeps a 0..255 variant named `lum`) */
function luma01(r: number, g: number, b: number): number {
  return (0.3 * r + 0.59 * g + 0.11 * b) / 255;
}

/** Photoshop's tonal ranges gate how strongly dodge/burn act on a pixel. */
function rangeGate(range: "shadows" | "midtones" | "highlights", l: number): number {
  if (range === "shadows") return Math.max(0, 1 - l / 0.5);
  if (range === "highlights") return Math.max(0, (l - 0.5) / 0.5);
  // midtones: a broad bell centred on 0.5
  return Math.max(0, 1 - Math.abs(l - 0.5) / 0.5);
}

export interface DodgeBurnOptions extends RetouchDab {
  /** 0..1 per dab */
  amount: number;
  mode: "dodge" | "burn";
  range: "shadows" | "midtones" | "highlights";
}

/** Lighten (dodge) or darken (burn) pixels, gated by tonal range. */
export function dodgeBurnDab(grid: TileGrid, o: DodgeBurnOptions): Rect4 | null {
  const b = dabBounds(grid, o);
  if (!b || o.amount <= 0 || o.radius <= 0) return null;
  let touched = false;
  grid.forEachTileInRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, (tile, cx, cy, cw, ch, bx, by) => {

    if (o.session) o.session.noteTile(bx / TILE, by / TILE, tile);
    for (let yy = 0; yy < ch; yy++) {
      const gy = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx;
        const w = weightAt(gx + 0.5 - o.x, gy + 0.5 - o.y, o.radius, o.hardness);
        if (w <= 0) continue;
        const ma = coverage(o, gx, gy);
        if (ma <= 0) continue;
        const o4 = ((cy + yy) * TILE + (cx + xx)) * 4;
        const a = tile.data[o4 + 3] ?? 0;
        if (a === 0) continue;
        const gate = rangeGate(o.range, luma01(tile.data[o4] ?? 0, tile.data[o4 + 1] ?? 0, tile.data[o4 + 2] ?? 0));
        const k = o.amount * w * ma * gate;
        if (k <= 0) continue;
        // 1/(1-k) lightens, (1-k) darkens: monotonic, never overshoots in one dab
        const f = o.mode === "dodge" ? 1 / Math.max(0.05, 1 - k) : 1 - k;
        for (let c = 0; c < 3; c++) tile.data[o4 + c] = Math.min(255, Math.max(0, (tile.data[o4 + c] ?? 0) * f));
        touched = true;
      }
    }
    if (touched) tile.version++;
  }, false);
  return touched ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : null;
}

export interface SpongeOptions extends RetouchDab {
  amount: number;
  mode: "saturate" | "desaturate";
  /** protect already-saturated pixels (Photoshop's Vibrance) */
  vibrance?: boolean;
}

/** Push colour away from / toward grey. */
export function spongeDab(grid: TileGrid, o: SpongeOptions): Rect4 | null {
  const b = dabBounds(grid, o);
  if (!b || o.amount <= 0) return null;
  let touched = false;
  grid.forEachTileInRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, (tile, cx, cy, cw, ch, bx, by) => {

    if (o.session) o.session.noteTile(bx / TILE, by / TILE, tile);
    for (let yy = 0; yy < ch; yy++) {
      const gy = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx;
        const w = weightAt(gx + 0.5 - o.x, gy + 0.5 - o.y, o.radius, o.hardness);
        if (w <= 0) continue;
        const ma = coverage(o, gx, gy);
        if (ma <= 0) continue;
        const o4 = ((cy + yy) * TILE + (cx + xx)) * 4;
        if ((tile.data[o4 + 3] ?? 0) === 0) continue;
        const r = tile.data[o4] ?? 0, g = tile.data[o4 + 1] ?? 0, bl = tile.data[o4 + 2] ?? 0;
        const l = 0.3 * r + 0.59 * g + 0.11 * bl;
        const maxc = Math.max(r, g, bl), minc = Math.min(r, g, bl);
        const sat = maxc === 0 ? 0 : (maxc - minc) / maxc;
        // vibrance: the more saturated a pixel already is, the less we touch it
        const protect = o.vibrance ? Math.max(0.15, 1 - sat) : 1;
        let k = o.amount * w * ma * protect;
        if (o.mode === "desaturate") k = -k;
        if (k === 0) continue;
        tile.data[o4] = l + (r - l) * (1 + k);
        tile.data[o4 + 1] = l + (g - l) * (1 + k);
        tile.data[o4 + 2] = l + (bl - l) * (1 + k);
        touched = true;
      }
    }
    if (touched) tile.version++;
  }, false);
  return touched ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : null;
}

export interface FocusOptions extends RetouchDab {
  /** 0..1 */
  strength: number;
  mode: "blur" | "sharpen";
}

/** Local 3x3 gaussian blur or unsharp-mask style sharpening. */
export function focusDab(grid: TileGrid, o: FocusOptions): Rect4 | null {
  const b = dabBounds(grid, o);
  if (!b || o.strength <= 0) return null;
  // read one pixel wider so the 3x3 kernel has neighbours inside the buffer
  const big: Bounds = {
    x0: Math.max(0, b.x0 - 1), y0: Math.max(0, b.y0 - 1),
    x1: Math.min(grid.width, b.x1 + 1), y1: Math.min(grid.height, b.y1 + 1),
  };
  const bw = big.x1 - big.x0, bh = big.y1 - big.y0;
  const src = readInto(grid, big);
  let touched = false;
  grid.forEachTileInRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, (tile, cx, cy, cw, ch, bx, by) => {

    if (o.session) o.session.noteTile(bx / TILE, by / TILE, tile);
    for (let yy = 0; yy < ch; yy++) {
      const gy = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx;
        const w = weightAt(gx + 0.5 - o.x, gy + 0.5 - o.y, o.radius, o.hardness);
        if (w <= 0) continue;
        const ma = coverage(o, gx, gy);
        if (ma <= 0) continue;
        const o4 = ((cy + yy) * TILE + (cx + xx)) * 4;
        if ((tile.data[o4 + 3] ?? 0) === 0) continue;
        const lx = gx - big.x0, ly = gy - big.y0;
        // 3x3 gaussian, weights sum to 1, accumulated PREMULTIPLIED: averaging
        // straight RGBA mixed the rgb=0 of transparent neighbours into opaque
        // pixels, painting dark halos around every stroke edge on a
        // transparent layer.
        let spr = 0, spg = 0, spb = 0, sa = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const qx = Math.min(bw - 1, Math.max(0, lx + kx));
            const qy = Math.min(bh - 1, Math.max(0, ly + ky));
            const kw = kx === 0 && ky === 0 ? 4 : (kx === 0 || ky === 0 ? 2 : 1);
            const q4 = (qy * bw + qx) * 4;
            const na = (src[q4 + 3] ?? 0) / 255;
            spr += (src[q4] ?? 0) * na * kw; spg += (src[q4 + 1] ?? 0) * na * kw;
            spb += (src[q4 + 2] ?? 0) * na * kw;
            sa += na * kw;
          }
        }
        // unpremultiply back to straight colour: premult avg ÷ avg alpha.
        // A fully transparent neighbourhood (sa = 0) keeps the original colour.
        const sr = sa > 0 ? spr / sa : (tile.data[o4] ?? 0);
        const sg = sa > 0 ? spg / sa : (tile.data[o4 + 1] ?? 0);
        const sb = sa > 0 ? spb / sa : (tile.data[o4 + 2] ?? 0);
        const k = o.strength * w * ma;
        if (o.mode === "blur") {
          tile.data[o4] = (tile.data[o4] ?? 0) + (sr - (tile.data[o4] ?? 0)) * k;
          tile.data[o4 + 1] = (tile.data[o4 + 1] ?? 0) + (sg - (tile.data[o4 + 1] ?? 0)) * k;
          tile.data[o4 + 2] = (tile.data[o4 + 2] ?? 0) + (sb - (tile.data[o4 + 2] ?? 0)) * k;
        } else {
          tile.data[o4] = (tile.data[o4] ?? 0) + ((tile.data[o4] ?? 0) - sr) * k;
          tile.data[o4 + 1] = (tile.data[o4 + 1] ?? 0) + ((tile.data[o4 + 1] ?? 0) - sg) * k;
          tile.data[o4 + 2] = (tile.data[o4 + 2] ?? 0) + ((tile.data[o4 + 2] ?? 0) - sb) * k;
        }
        touched = true;
      }
    }
    if (touched) tile.version++;
  }, false);
  return touched ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : null;
}

export interface SmudgeOptions extends RetouchDab {
  /** where the stroke came from — pixels are pulled along this vector */
  fromX: number;
  fromY: number;
  strength: number;
}

/** Drag wet pixels along the stroke, like a finger through paint. */
export function smudgeDab(grid: TileGrid, o: SmudgeOptions): Rect4 | null {
  const b = dabBounds(grid, o);
  if (!b || o.strength <= 0) return null;
  const dx = o.x - o.fromX, dy = o.y - o.fromY;
  if (dx === 0 && dy === 0) return null;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const src = readInto(grid, b);
  let touched = false;
  grid.forEachTileInRect(b.x0, b.y0, bw, bh, (tile, cx, cy, cw, ch, bx, by) => {

    if (o.session) o.session.noteTile(bx / TILE, by / TILE, tile);
    for (let yy = 0; yy < ch; yy++) {
      const gy = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx;
        const w = weightAt(gx + 0.5 - o.x, gy + 0.5 - o.y, o.radius, o.hardness);
        if (w <= 0) continue;
        const ma = coverage(o, gx, gy);
        if (ma <= 0) continue;
        // sample backwards along the stroke (bilinear-free: nearest is fine for a brush)
        const sx = Math.round(gx - dx), sy = Math.round(gy - dy);
        if (sx < b.x0 || sy < b.y0 || sx >= b.x1 || sy >= b.y1) continue;
        const q4 = ((sy - b.y0) * bw + (sx - b.x0)) * 4;
        const o4 = ((cy + yy) * TILE + (cx + xx)) * 4;
        if ((tile.data[o4 + 3] ?? 0) === 0 && (src[q4 + 3] ?? 0) === 0) continue;
        const k = o.strength * w * ma;
        for (let c = 0; c < 4; c++) {
          tile.data[o4 + c] = (tile.data[o4 + c] ?? 0) + ((src[q4 + c] ?? 0) - (tile.data[o4 + c] ?? 0)) * k;
        }
        touched = true;
      }
    }
    if (touched) tile.version++;
  }, true);
  return touched ? { x: b.x0, y: b.y0, w: bw, h: bh } : null;
}

export interface CloneOptions extends RetouchDab {
  /** offset from the painted pixel to its source pixel */
  offsetX: number;
  offsetY: number;
  alpha: number;
}

/** Clone Stamp: copy pixels from a sampled offset, straight (no colour blending). */
export function cloneDab(grid: TileGrid, o: CloneOptions): Rect4 | null {
  const b = dabBounds(grid, o);
  if (!b || o.alpha <= 0) return null;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const sx0 = b.x0 + o.offsetX, sy0 = b.y0 + o.offsetY;
  const src = new Uint8ClampedArray(bw * bh * 4);
  grid.readRect(sx0, sy0, bw, bh, src); // areas outside the doc read as transparent
  let touched = false;
  grid.forEachTileInRect(b.x0, b.y0, bw, bh, (tile, cx, cy, cw, ch, bx, by) => {

    if (o.session) o.session.noteTile(bx / TILE, by / TILE, tile);
    for (let yy = 0; yy < ch; yy++) {
      const gy = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx;
        const w = weightAt(gx + 0.5 - o.x, gy + 0.5 - o.y, o.radius, o.hardness);
        if (w <= 0) continue;
        const ma = coverage(o, gx, gy);
        if (ma <= 0) continue;
        const q4 = ((gy - b.y0) * bw + (gx - b.x0)) * 4;
        const a = (src[q4 + 3] ?? 0) / 255;
        if (a <= 0) continue;
        const k = o.alpha * w * ma * a;
        if (k <= 0) continue;
        const o4 = ((cy + yy) * TILE + (cx + xx)) * 4;
        for (let c = 0; c < 3; c++) {
          tile.data[o4 + c] = (tile.data[o4 + c] ?? 0) + ((src[q4 + c] ?? 0) - (tile.data[o4 + c] ?? 0)) * k;
        }
        tile.data[o4 + 3] = Math.max(tile.data[o4 + 3] ?? 0, Math.round(k * 255));
        touched = true;
      }
    }
    if (touched) tile.version++;
  }, true);
  return touched ? { x: b.x0, y: b.y0, w: bw, h: bh } : null;
}

export interface RedEyeOptions extends RetouchDab {
  /** 0..1 how far the pupil is darkened */
  darken: number;
}

/** Neutralise the red channel inside a pupil, keep the specular highlight. */
export function redEyeDab(grid: TileGrid, o: RedEyeOptions): Rect4 | null {
  const b = dabBounds(grid, o);
  if (!b) return null;
  let touched = false;
  grid.forEachTileInRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, (tile, cx, cy, cw, ch, bx, by) => {

    if (o.session) o.session.noteTile(bx / TILE, by / TILE, tile);
    for (let yy = 0; yy < ch; yy++) {
      const gy = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx;
        let w = weightAt(gx + 0.5 - o.x, gy + 0.5 - o.y, o.radius, o.hardness);
        if (w <= 0) continue;
        // every other dab multiplies by selection coverage; red-eye used to be
        // the one exception, so it edited pixels outside the selection
        w *= coverage(o, gx, gy);
        if (w <= 0) continue;
        const o4 = ((cy + yy) * TILE + (cx + xx)) * 4;
        const r = tile.data[o4] ?? 0, g = tile.data[o4 + 1] ?? 0, bl = tile.data[o4 + 2] ?? 0;
        // only act on pixels that are markedly red — that is what red-eye is
        if (r < 60 || r < (g + bl) * 0.6) continue;
        const neutral = (g + bl) / 2;
        const k = Math.max(0, Math.min(1, (1 - o.darken) * w));
        tile.data[o4] = r + (neutral - r) * w;
        tile.data[o4 + 1] = g * (1 - k * 0.35);
        tile.data[o4 + 2] = bl * (1 - k * 0.35);
        touched = true;
      }
    }
    if (touched) tile.version++;
  }, false);
  return touched ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : null;
}

/**
 * Average colour under the cursor (Eyedropper sample size 1 / 3 / 5 / 11 …).
 * Reads the merged composite when a composite buffer is supplied, so the
 * eyedropper sees what the user sees, not just the active layer.
 */
export function sampleColor(
  buf: Uint8ClampedArray | { width: number; height: number; data: Uint8ClampedArray },
  x: number, y: number, size = 1,
): { r: number; g: number; b: number; a: number } | null {
  const data = buf instanceof Uint8ClampedArray ? buf : buf.data;
  const w = buf instanceof Uint8ClampedArray ? 0 : buf.width;
  const h = buf instanceof Uint8ClampedArray ? 0 : buf.height;
  if (!data) return null;
  const half = Math.floor(Math.max(1, size) / 2);
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const px = x + dx, py = y + dy;
      if (w && h && (px < 0 || py < 0 || px >= w || py >= h)) continue;
      const i = (py * (w || 1) + px) * 4;
      if (i < 0 || i + 3 >= data.length) continue;
      const al = data[i + 3] ?? 0;
      if (al === 0) continue;
      r += (data[i] ?? 0); g += (data[i + 1] ?? 0); b += (data[i + 2] ?? 0); a += al;
      n++;
    }
  }
  if (!n) return null;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: Math.round(a / n) };
}
