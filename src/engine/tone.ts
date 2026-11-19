/**
 * tone.ts — the tonal half of Image > Adjustments: levels, curves, exposure,
 * vibrance, colour balance, black & white, photo filter, channel mixer,
 * gradient map, desaturate, auto tone/contrast/colour and equalize — plus the
 * histogram the panels read.
 *
 * Conventions match adjust.ts: 8-bit sRGB, in place, alpha preserved, rect
 * clipped to the grid, never allocates new tiles. Every op is a pure function
 * of the pixel, so `applyTone` can drive them all from one tile walk.
 */
import { TILE, type TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export interface Rect4 { x: number; y: number; w: number; h: number }

// luminance weights (same values as blend.ts/adjust.ts, different names so the
// single-file bundle has no top-level collisions)
const W_R = 0.3, W_G = 0.59, W_B = 0.11;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** clip a rect to the grid; null when nothing is left */
function clipRect(grid: TileGrid, x: number, y: number, w: number, h: number): Rect4 | null {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(grid.width, Math.ceil(x + w));
  const y1 = Math.min(grid.height, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Walk every allocated pixel of the rect and let `fn` rewrite rgb in place.
 * `fn` receives channel values and writes its result through the out array,
 * which keeps the hot loop free of allocations.
 */
export function walkPixels(
  grid: TileGrid,
  rect: Rect4,
  fn: (r: number, g: number, b: number, out: Uint8ClampedArray) => void,
  mask?: PixelMask | null,
): void {
  const out = new Uint8ClampedArray(3);
  grid.forEachTileInRect(rect.x, rect.y, rect.w, rect.h, (tile, cx, cy, cw, ch, bx, by) => {
    let touched = false;
    for (let yy = 0; yy < ch; yy++) {
      const gy = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx;
        // Continuous coverage: a feathered selection must fade the effect, not
        // snap it on at 50%. Matches compositing, f2Write and the retouch dabs.
        const m = mask ? mask.alphaAt(gx, gy) / 255 : 1;
        if (m <= 0) continue;
        const i = ((cy + yy) * TILE + (cx + xx)) * 4;
        const a = tile.data[i + 3] ?? 0;
        if (a === 0) continue;
        const r0 = tile.data[i] ?? 0, g0 = tile.data[i + 1] ?? 0, b0 = tile.data[i + 2] ?? 0;
        fn(r0, g0, b0, out);
        if (m >= 1) {
          tile.data[i] = out[0]!;
          tile.data[i + 1] = out[1]!;
          tile.data[i + 2] = out[2]!;
        } else {
          tile.data[i] = r0 + (out[0]! - r0) * m;
          tile.data[i + 1] = g0 + (out[1]! - g0) * m;
          tile.data[i + 2] = b0 + (out[2]! - b0) * m;
        }
        touched = true;
      }
    }
    if (touched) tile.version++;
  });
}

/** A 256-entry channel lookup table. */
export type Lut = Uint8ClampedArray;

export function buildLut(fn: (v: number) => number): Lut {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = clampByte(fn(i));
  return lut;
}

export function applyLutToPixels(grid: TileGrid, rect: Rect4, lr: Lut, lg: Lut, lb: Lut,
  mask?: PixelMask | null): void {
  walkPixels(grid, rect, (r, g, b, out) => {
    out[0] = lr[r]!; out[1] = lg[g]!; out[2] = lb[b]!;
  }, mask);
}

// ---- levels ---------------------------------------------------------------

export interface LevelsOptions {
  /** input black/white points, 0..255 */
  inBlack: number;
  inWhite: number;
  /** midtone gamma, 0.1..9 (1 = untouched) */
  gamma: number;
  /** output black/white points, 0..255 */
  outBlack: number;
  outWhite: number;
}

export const IDENTITY_LEVELS: LevelsOptions = {
  inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255,
};

/** Build the levels curve as a LUT (shared by the dialog preview and apply). */
export function levelsLut(o: LevelsOptions): Lut {
  const inB = clamp(o.inBlack, 0, 255);
  const inW = clamp(o.inWhite, inB + 1, 255);
  const g = clamp(o.gamma, 0.1, 9);
  const outB = clamp(o.outBlack, 0, 255);
  const outW = clamp(o.outWhite, outB, 255);
  const invG = 1 / g;
  return buildLut((v) => {
    let t = (v - inB) / (inW - inB);
    t = clamp(t, 0, 1);
    t = Math.pow(t, invG);
    return outB + t * (outW - outB);
  });
}

export function applyLevels(grid: TileGrid, rect: Rect4, o: LevelsOptions,
  mask?: PixelMask | null): void {
  const lut = levelsLut(o);
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  applyLutToPixels(grid, r, lut, lut, lut, mask);
}

// ---- curves ---------------------------------------------------------------

export interface CurvePoint { x: number; y: number }

/**
 * Monotone-ish Catmull-Rom through the control points, sampled to a LUT.
 * Photoshop's curve editor behaves like this: dragging a point bends the
 * whole curve, and the ends stay pinned at x=0 and x=255.
 */
export function curveLut(points: readonly CurvePoint[]): Lut {
  const pts = points
    .map((p) => ({ x: clamp(p.x, 0, 255), y: clamp(p.y, 0, 255) }))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0) return buildLut((v) => v);
  if (pts.length === 1) {
    const y = pts[0]!.y;
    return buildLut(() => y);
  }
  // Fritsch–Carlson monotone cubic Hermite: passes through every point, never
  // overshoots (Catmull-Rom rings on a two-point identity curve), and is exact
  // for a straight line.
  const n = pts.length;
  const dx: number[] = [], slope: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const d = pts[i + 1]!.x - pts[i]!.x;
    dx.push(d);
    slope.push(d === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / d);
  }
  m.push(slope[0] ?? 0);
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1]!, s1 = slope[i]!;
    m.push(s0 * s1 <= 0 ? 0 : (s0 + s1) / 2);
  }
  m.push(slope[n - 2] ?? 0);
  // limit the tangents so each segment stays monotone
  for (let i = 0; i < n - 1; i++) {
    const s = slope[i]!;
    if (s === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i]! / s, b = m[i + 1]! / s;
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      m[i] = t * a * s;
      m[i + 1] = t * b * s;
    }
  }
  return buildLut((v) => {
    if (v <= pts[0]!.x) return pts[0]!.y;
    const last = pts[n - 1]!;
    if (v >= last.x) return last.y;
    let i = 0;
    while (i < n - 2 && v > pts[i + 1]!.x) i++;
    const h = dx[i]!;
    const t = (v - pts[i]!.x) / Math.max(1e-6, h);
    const t2 = t * t, t3 = t2 * t;
    const y0 = pts[i]!.y, y1 = pts[i + 1]!.y;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[i]! +
      (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[i + 1]!;
  });
}

export function applyCurve(grid: TileGrid, rect: Rect4, points: readonly CurvePoint[],
  channel: "rgb" | "r" | "g" | "b" = "rgb", mask?: PixelMask | null): void {
  const lut = curveLut(points);
  const identity = buildLut((v) => v);
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  applyLutToPixels(grid, r,
    channel === "g" || channel === "b" ? identity : lut,
    channel === "r" || channel === "b" ? identity : lut,
    channel === "r" || channel === "g" ? identity : lut,
    mask);
}

// ---- exposure / vibrance --------------------------------------------------

/** stops: -4..4 EV. Applied in linear light (2^stops), like a camera. */
export function applyExposure(grid: TileGrid, rect: Rect4, stops: number,
  mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const f = Math.pow(2, clamp(stops, -4, 4));
  walkPixels(grid, r, (rr, g, b, out) => {
    // approximate sRGB → linear → scale → sRGB with a 2.2 gamma
    out[0] = Math.pow(Math.pow(rr / 255, 2.2) * f, 1 / 2.2) * 255;
    out[1] = Math.pow(Math.pow(g / 255, 2.2) * f, 1 / 2.2) * 255;
    out[2] = Math.pow(Math.pow(b / 255, 2.2) * f, 1 / 2.2) * 255;
  }, mask);
}

/** amount -100..100; protects already-saturated pixels (Photoshop's behaviour) */
export function applyVibrance(grid: TileGrid, rect: Rect4, amount: number,
  mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r || amount === 0) return;
  const k = clamp(amount, -100, 100) / 100;
  walkPixels(grid, r, (rr, g, b, out) => {
    const l = W_R * rr + W_G * g + W_B * b;
    const max = Math.max(rr, g, b), min = Math.min(rr, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const boost = k * Math.max(0.2, 1 - sat); // saturated colours move less
    out[0] = l + (rr - l) * (1 + boost);
    out[1] = l + (g - l) * (1 + boost);
    out[2] = l + (b - l) * (1 + boost);
  }, mask);
}

// ---- colour balance -------------------------------------------------------

export interface BalanceShift { r: number; g: number; b: number }

export interface ColorBalanceOptions {
  shadows: BalanceShift;
  midtones: BalanceShift;
  highlights: BalanceShift;
  preserveLuminosity: boolean;
}

/** Each shift is -100..100 and weighted by where the pixel sits tonally. */
export function applyColorBalance(grid: TileGrid, rect: Rect4, o: ColorBalanceOptions,
  mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const w = (l: number): [number, number, number] => {
    const sh = Math.max(0, 1 - l / 0.5);
    const hi = Math.max(0, (l - 0.5) / 0.5);
    const mid = Math.max(0, 1 - Math.abs(l - 0.5) / 0.5);
    return [sh, mid, hi];
  };
  walkPixels(grid, r, (rr, g, b, out) => {
    const l = (W_R * rr + W_G * g + W_B * b) / 255;
    const [ws, wm, wh] = w(l);
    const dr = (o.shadows.r * ws + o.midtones.r * wm + o.highlights.r * wh) * 0.01;
    const dg = (o.shadows.g * ws + o.midtones.g * wm + o.highlights.g * wh) * 0.01;
    const db = (o.shadows.b * ws + o.midtones.b * wm + o.highlights.b * wh) * 0.01;
    let nr = clampByte(rr + dr * 100);
    let ng = clampByte(g + dg * 100);
    let nb = clampByte(b + db * 100);
    if (o.preserveLuminosity) {
      const before = W_R * rr + W_G * g + W_B * b;
      const after = W_R * nr + W_G * ng + W_B * nb;
      const d = before - after;
      nr = clampByte(nr + d); ng = clampByte(ng + d); nb = clampByte(nb + d);
    }
    out[0] = nr; out[1] = ng; out[2] = nb;
  }, mask);
}

// ---- black & white --------------------------------------------------------

/** Photoshop's default channel weights; the sliders scale them. */
export interface BlackWhiteOptions {
  red: number; yellow: number; green: number; cyan: number; blue: number; magenta: number;
}

export function applyBlackWhite(grid: TileGrid, rect: Rect4, o: BlackWhiteOptions,
  mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  walkPixels(grid, r, (rr, g, b, out) => {
    // weight each pixel by how much of that hue it carries
    const mx = Math.max(rr, g, b), mn = Math.min(rr, g, b);
    const c = mx - mn;
    const v = mx;
    let wsum = 0, wv = 0;
    const add = (weight: number, presence: number): void => {
      if (presence <= 0) return;
      wsum += presence; wv += presence * weight;
    };
    if (c === 0) {
      // neutral grey has no hue: plain luminance
      out[0] = out[1] = out[2] = clampByte(v * 1);
      return;
    }
    const h = mx === rr
      ? ((g - b) / c + (g < b ? 6 : 0)) * 60
      : mx === g ? ((b - rr) / c + 2) * 60 : ((rr - g) / c + 4) * 60;
    const sat = c / (mx || 1);
    const chroma = sat * (v / 255);
    add(o.red, chroma * Math.max(0, Math.cos(((h - 0) * Math.PI) / 180 * 3)));
    add(o.yellow, chroma * Math.max(0, Math.cos(((h - 60) * Math.PI) / 180 * 3)));
    add(o.green, chroma * Math.max(0, Math.cos(((h - 120) * Math.PI) / 180 * 3)));
    add(o.cyan, chroma * Math.max(0, Math.cos(((h - 180) * Math.PI) / 180 * 3)));
    add(o.blue, chroma * Math.max(0, Math.cos(((h - 240) * Math.PI) / 180 * 3)));
    add(o.magenta, chroma * Math.max(0, Math.cos(((h - 300) * Math.PI) / 180 * 3)));
    // weights are Photoshop-style percentages; a neutral grey uses 60, so a
    // hue weighted below that darkens and above it lightens
    const weighted = wsum > 0 ? wv / wsum : 60;
    const grey = clampByte(v * (weighted / 60));
    out[0] = out[1] = out[2] = grey;
  }, mask);
}

// ---- photo filter ---------------------------------------------------------

export interface PhotoFilterOptions {
  /** tint colour, 0..255 */
  color: [number, number, number];
  /** 0..100 % */
  density: number;
  preserveLuminosity: boolean;
}

export function applyPhotoFilter(grid: TileGrid, rect: Rect4, o: PhotoFilterOptions,
  mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const d = clamp(o.density, 0, 100) / 100;
  walkPixels(grid, r, (rr, g, b, out) => {
    let nr = rr * (1 - d) + o.color[0] * d;
    let ng = g * (1 - d) + o.color[1] * d;
    let nb = b * (1 - d) + o.color[2] * d;
    if (o.preserveLuminosity) {
      const before = W_R * rr + W_G * g + W_B * b;
      const after = W_R * nr + W_G * ng + W_B * nb;
      const k = before / Math.max(1, after);
      nr = clampByte(nr * k); ng = clampByte(ng * k); nb = clampByte(nb * k);
    }
    out[0] = nr; out[1] = ng; out[2] = nb;
  }, mask);
}

// ---- channel mixer --------------------------------------------------------

/** Each output channel is a weighted sum of the input channels (percent). */
export interface ChannelMixerOptions {
  red: [number, number, number];
  green: [number, number, number];
  blue: [number, number, number];
  monochrome: boolean;
  constant: number;
}

export function applyChannelMixer(grid: TileGrid, rect: Rect4, o: ChannelMixerOptions,
  mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const k = 0.01;
  walkPixels(grid, r, (rr, g, b, out) => {
    const nr = clampByte((o.red[0] * rr + o.red[1] * g + o.red[2] * b) * k + o.constant);
    const ng = clampByte((o.green[0] * rr + o.green[1] * g + o.green[2] * b) * k + o.constant);
    const nb = clampByte((o.blue[0] * rr + o.blue[1] * g + o.blue[2] * b) * k + o.constant);
    if (o.monochrome) {
      const grey = clampByte((o.red[0] * rr + o.red[1] * g + o.red[2] * b) * k + o.constant);
      out[0] = out[1] = out[2] = grey;
    } else {
      out[0] = nr; out[1] = ng; out[2] = nb;
    }
  }, mask);
}

// ---- gradient map ---------------------------------------------------------

export interface MapStop { pos: number; color: [number, number, number] }

/** Map luminance through a gradient — Photoshop's Gradient Map. */
export function applyGradientMap(grid: TileGrid, rect: Rect4, stops: readonly MapStop[],
  mask?: PixelMask | null): void {
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  if (s.length === 0) return;
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const sample = (t: number): [number, number, number] => {
    if (t <= s[0]!.pos) return s[0]!.color;
    const last = s[s.length - 1]!;
    if (t >= last.pos) return last.color;
    let i = 0;
    while (i < s.length - 2 && t > s[i + 1]!.pos) i++;
    const a = s[i]!, b = s[i + 1]!;
    const u = (t - a.pos) / Math.max(1e-6, b.pos - a.pos);
    return [
      a.color[0] + (b.color[0] - a.color[0]) * u,
      a.color[1] + (b.color[1] - a.color[1]) * u,
      a.color[2] + (b.color[2] - a.color[2]) * u,
    ];
  };
  walkPixels(grid, r, (rr, g, b, out) => {
    const l = (W_R * rr + W_G * g + W_B * b) / 255;
    const c = sample(l);
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  }, mask);
}

// ---- desaturate / equalize / auto ----------------------------------------

export function applyDesaturate(grid: TileGrid, rect: Rect4, mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  walkPixels(grid, r, (rr, g, b, out) => {
    const l = W_R * rr + W_G * g + W_B * b;
    out[0] = out[1] = out[2] = l;
  }, mask);
}

export interface Histogram { r: Uint32Array; g: Uint32Array; b: Uint32Array; lum: Uint32Array; total: number }

/** 256-bin histogram over the rect's opaque pixels. */
export function histogram(grid: TileGrid, rect: Rect4): Histogram {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  const h: Histogram = {
    r: new Uint32Array(256), g: new Uint32Array(256),
    b: new Uint32Array(256), lum: new Uint32Array(256), total: 0,
  };
  if (!r) return h;
  grid.forEachTileInRect(r.x, r.y, r.w, r.h, (tile, cx, cy, cw, ch) => {
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const i = ((cy + yy) * TILE + (cx + xx)) * 4;
        if ((tile.data[i + 3] ?? 0) === 0) continue;
        const rr = tile.data[i] ?? 0, g = tile.data[i + 1] ?? 0, b = tile.data[i + 2] ?? 0;
        h.r[rr]!++; h.g[g]!++; h.b[b]!++;
        h.lum[Math.round(W_R * rr + W_G * g + W_B * b)]!++;
        h.total++;
      }
    }
  });
  return h;
}

/** First and last bin holding at least `cut` pixels — the auto-levels span. */
function spanOf(counts: Uint32Array, total: number, cutFraction: number): [number, number] {
  const cut = Math.max(1, Math.floor(total * cutFraction));
  let lo = 0, hi = 255;
  while (lo < 255 && (counts[lo] ?? 0) < cut) lo++;
  while (hi > 0 && (counts[hi] ?? 0) < cut) hi--;
  if (hi <= lo) return [0, 255];
  return [lo, hi];
}

export function autoTone(grid: TileGrid, rect: Rect4, clipPercent = 0.5,
  mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const h = histogram(grid, r);
  if (h.total === 0) return;
  const [lo, hi] = spanOf(h.lum, h.total, clipPercent / 100);
  applyLevels(grid, r, { inBlack: lo, inWhite: hi, gamma: 1, outBlack: 0, outWhite: 255 }, mask);
}

export function autoContrast(grid: TileGrid, rect: Rect4, mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const h = histogram(grid, r);
  if (h.total === 0) return;
  const [rl, rh] = spanOf(h.r, h.total, 0);
  const [gl, gh] = spanOf(h.g, h.total, 0);
  const [bl, bh] = spanOf(h.b, h.total, 0);
  const rl_lut = levelsLut({ inBlack: rl, inWhite: rh, gamma: 1, outBlack: 0, outWhite: 255 });
  const gl_lut = levelsLut({ inBlack: gl, inWhite: gh, gamma: 1, outBlack: 0, outWhite: 255 });
  const bl_lut = levelsLut({ inBlack: bl, inWhite: bh, gamma: 1, outBlack: 0, outWhite: 255 });
  applyLutToPixels(grid, r, rl_lut, gl_lut, bl_lut, mask);
}

/** Grey-world colour correction: balance the channel means, then auto levels. */
export function autoColor(grid: TileGrid, rect: Rect4, mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const h = histogram(grid, r);
  if (h.total === 0) return;
  const mean = (c: Uint32Array): number => {
    let s = 0;
    for (let i = 0; i < 256; i++) s += i * (c[i] ?? 0);
    return s / h.total;
  };
  const mr = mean(h.r), mg = mean(h.g), mb = mean(h.b);
  const target = (mr + mg + mb) / 3;
  const gain = (m: number): number => (m > 0 ? clamp(target / m, 0.5, 2) : 1);
  const gr = gain(mr), gg = gain(mg), gb = gain(mb);
  applyLutToPixels(grid, r,
    buildLut((v) => v * gr), buildLut((v) => v * gg), buildLut((v) => v * gb), mask);
  autoContrast(grid, r, mask);
}

/** Equalize: remap each channel through its cumulative histogram. */
export function applyEqualize(grid: TileGrid, rect: Rect4, mask?: PixelMask | null): void {
  const r = clipRect(grid, rect.x, rect.y, rect.w, rect.h);
  if (!r) return;
  const h = histogram(grid, r);
  if (h.total === 0) return;
  // a histogram with a single populated bin has nothing to spread out
  const distinct = (counts: Uint32Array): number => counts.reduce((n, c) => n + (c > 0 ? 1 : 0), 0);
  if (distinct(h.r) <= 1 && distinct(h.g) <= 1 && distinct(h.b) <= 1) return;
  const cdfLut = (counts: Uint32Array): Lut => {
    let acc = 0;
    const cdf = new Float64Array(256);
    for (let i = 0; i < 256; i++) { acc += counts[i] ?? 0; cdf[i] = acc; }
    const lo = cdf[0] ?? 0, hi = cdf[255] ?? 0;
    return buildLut((v) => {
      const t = (cdf[v]! - lo) / Math.max(1e-6, hi - lo);
      return t * 255;
    });
  };
  applyLutToPixels(grid, r, cdfLut(h.r), cdfLut(h.g), cdfLut(h.b), mask);
}
