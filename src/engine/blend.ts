/**
 * blend.ts — the complete Photoshop blend-mode math (straight alpha, 8-bit RGBA).
 *
 * Channel math follows the W3C Compositing spec, extended with the
 * Photoshop-only modes (Linear Burn, Darker/Lighter Color, Vivid/Linear/
 * Pin Light, Hard Mix, Subtract, Divide, Dissolve) verified against
 * psd-tools' blend implementations.
 */

export const BLEND_MODES = [
  "normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn", "darker-color",
  "lighten", "screen", "color-dodge", "linear-dodge", "lighter-color",
  "overlay", "soft-light", "hard-light", "vivid-light", "linear-light", "pin-light", "hard-mix",
  "difference", "exclusion", "subtract", "divide",
  "hue", "saturation", "color", "luminosity",
  // paint-only (brush/eraser semantics, not valid for layers)
  "behind", "clear",
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];
/** modes valid on a layer (everything except behind/clear) */
export const LAYER_BLEND_MODES = BLEND_MODES.filter((m) => m !== "behind" && m !== "clear") as unknown as readonly BlendMode[];

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** separable channel blend B(Cb, Cs) — both inputs normalized 0..1 */
function channelBlend(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case "normal": return cs;
    case "multiply": return cb * cs;
    case "screen": return cb + cs - cb * cs;
    case "darken": return cb < cs ? cb : cs;
    case "lighten": return cb > cs ? cb : cs;
    case "color-dodge": return cs >= 1 ? 1 : Math.min(1, cb / (1 - cs));
    case "color-burn": return cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
    case "linear-burn": return clamp01(cb + cs - 1);
    case "linear-dodge": return clamp01(cb + cs);
    case "overlay": return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case "hard-light": return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case "soft-light": {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    case "vivid-light":
      return cs <= 0.5
        ? (cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / (2 * cs)))
        : (cs >= 1 ? 1 : Math.min(1, cb / (1 - (2 * cs - 1))));
    case "linear-light": return clamp01(cb + 2 * cs - 1);
    case "pin-light": return cs <= 0.5 ? Math.min(2 * cs, cb) : Math.max(2 * cs - 1, cb);
    case "hard-mix": {
      const v = cs <= 0.5
        ? (cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / (2 * cs)))
        : (cs >= 1 ? 1 : Math.min(1, cb / (1 - (2 * cs - 1))));
      return v >= 0.5 ? 1 : 0;
    }
    case "difference": return Math.abs(cb - cs);
    case "exclusion": return cb + cs - 2 * cb * cs;
    case "subtract": return clamp01(cb - cs);
    case "divide": return cs <= 0 ? 1 : Math.min(1, cb / cs);
    // darker/lighter color are decided on luminance, not per-channel,
    // but per-channel passthrough of the winning color is what Photoshop
    // computes; handled in compositePixel, this line is unreachable.
    default: return cs;
  }
}

// non-separable helpers (W3C spec) — SCALAR form: compositePixel calls these
// per painted pixel, and the old array-based B_ allocated 3-4 short arrays
// per pixel (handoff-2 N). Math is identical, including tie handling: strict
// comparisons keep the lowest index for min and the lowest already-seen index
// for max, matching the old stable sort's order for equal components.
const lumS = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b;
function clipS(c: Float64Array): void {
  const l = lumS(c[0]!, c[1]!, c[2]!);
  const n = Math.min(c[0]!, c[1]!, c[2]!);
  const x = Math.max(c[0]!, c[1]!, c[2]!);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i]! - l) * l) / (l - n);
  if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + ((c[i]! - l) * (1 - l)) / (x - l);
}
function setLumS(c: Float64Array, l: number): void {
  const d = l - lumS(c[0]!, c[1]!, c[2]!);
  c[0]! += d; c[1]! += d; c[2]! += d;
  clipS(c);
}
const satS = (r: number, g: number, b: number): number => Math.max(r, g, b) - Math.min(r, g, b);
/** W3C setSat into scratch `o` (o[3] untouched); min component becomes 0. */
function setSatS(o: Float64Array, r: number, g: number, b: number, s: number): void {
  let lo = r, lo_i = 0, hi = r, hi_i = 0;
  if (g < lo) { lo = g; lo_i = 1; } else if (g > hi) { hi = g; hi_i = 1; }
  if (b < lo) { lo = b; lo_i = 2; } else if (b > hi) { hi = b; hi_i = 2; }
  o[0] = 0; o[1] = 0; o[2] = 0;
  if (hi > lo) {
    // lo_i === hi_i only when all three are equal (guarded away above)
    const mid_i = 3 - lo_i - hi_i;
    const mid = mid_i === 0 ? r : mid_i === 1 ? g : b;
    o[mid_i] = ((mid - lo) * s) / (hi - lo);
    o[hi_i] = s;
  }
}
// module scratch buffers — compositePixel is synchronous and single-threaded
const _bc = new Float64Array(3);
const _cs = new Float64Array(3);

/**
 * Composite one straight-alpha RGBA pixel of source OVER destination.
 * Writes premultiplied-independent straight RGBA into out[0..3].
 * out may alias dst. x,y are doc coords (needed for dissolve's per-pixel dither).
 */
export function compositePixel(
  mode: BlendMode,
  sr: number, sg: number, sb: number, sa: number, // 0..255
  dr: number, dg: number, db: number, da: number, // 0..255
  out: Uint8ClampedArray | number[], outPos: number,
  x = 0, y = 0,
): void {
  // paint-only modes
  if (mode === "behind") {
    // "behind" = the existing dst composited OVER the incoming src
    compositePixel("normal", dr, dg, db, da, sr, sg, sb, sa, out, outPos, x, y);
    return;
  }
  if (mode === "clear") {
    // destination-out: keep the destination COLOR, cut its alpha by the
    // dab's coverage. Zeroing rgb (the old behavior) blackened every
    // partially-erased pixel at the dab's soft rim → visible black outline.
    out[outPos] = dr; out[outPos + 1] = dg; out[outPos + 2] = db;
    out[outPos + 3] = da * (1 - sa / 255);
    return;
  }

  let as = sa / 255;
  if (mode === "dissolve") {
    // deterministic dither: fully src or fully dst per pixel
    const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const frac = h - Math.floor(h);
    as = frac < as ? 1 : 0;
  }

  const ab = da / 255;
  const ao = as + ab * (1 - as);
  if (ao === 0) { out[outPos] = 0; out[outPos + 1] = 0; out[outPos + 2] = 0; out[outPos + 3] = 0; return; }

  // scalars, not arrays: this runs per painted pixel (hot path, no allocation)
  const cb0 = dr / 255, cb1 = dg / 255, cb2 = db / 255;
  const cs0 = sr / 255, cs1 = sg / 255, cs2 = sb / 255;

  let br: number, bg: number, bb: number;
  if (mode === "darker-color" || mode === "lighter-color") {
    const pickCs = mode === "darker-color" ? lumS(cs0, cs1, cs2) < lumS(cb0, cb1, cb2) : lumS(cs0, cs1, cs2) > lumS(cb0, cb1, cb2);
    br = pickCs ? cs0 : cb0; bg = pickCs ? cs1 : cb1; bb = pickCs ? cs2 : cb2;
  } else if (mode === "hue" || mode === "saturation" || mode === "color" || mode === "luminosity") {
    // scalar W3C pipeline through module scratches (no per-pixel allocation)
    const lcb = lumS(cb0, cb1, cb2);
    _bc[0] = cb0; _bc[1] = cb1; _bc[2] = cb2;
    if (mode === "hue") {
      setSatS(_cs, cs0, cs1, cs2, satS(cb0, cb1, cb2));
      setLumS(_cs, lcb);
      br = _cs[0]!; bg = _cs[1]!; bb = _cs[2]!;
    } else if (mode === "saturation") {
      setSatS(_bc, cb0, cb1, cb2, satS(cs0, cs1, cs2));
      setLumS(_bc, lcb);
      br = _bc[0]!; bg = _bc[1]!; bb = _bc[2]!;
    } else if (mode === "color") {
      _cs[0] = cs0; _cs[1] = cs1; _cs[2] = cs2;
      setLumS(_cs, lcb);
      br = _cs[0]!; bg = _cs[1]!; bb = _cs[2]!;
    } else {
      // luminosity: backdrop hue/sat, source lightness
      setLumS(_bc, lumS(cs0, cs1, cs2));
      br = _bc[0]!; bg = _bc[1]!; bb = _bc[2]!;
    }
  } else {
    br = channelBlend(mode, cb0, cs0);
    bg = channelBlend(mode, cb1, cs1);
    bb = channelBlend(mode, cb2, cs2);
  }

  // W3C: Co = (1-αb)·αs·Cs + αb·αs·B(Cb,Cs) + (1-αs)·αb·Cb, then /αo
  const k = 255 / ao;
  out[outPos] = k * ((1 - ab) * as * cs0 + ab * as * br + (1 - as) * ab * cb0);
  out[outPos + 1] = k * ((1 - ab) * as * cs1 + ab * as * bg + (1 - as) * ab * cb1);
  out[outPos + 2] = k * ((1 - ab) * as * cs2 + ab * as * bb + (1 - as) * ab * cb2);
  out[outPos + 3] = ao * 255;
}

/** convenience for tests: composite and return [r,g,b,a] */
export function blendPixel(
  mode: BlendMode, src: readonly number[], dst: readonly number[], x = 0, y = 0,
): [number, number, number, number] {
  const out = new Uint8ClampedArray(4);
  compositePixel(mode, src[0]!, src[1]!, src[2]!, src[3]!, dst[0]!, dst[1]!, dst[2]!, dst[3]!, out, 0, x, y);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/**
 * Source-over for a single pixel in the byte units the tile buffers use.
 *
 * The compositor carried three verbatim copies of this (pixel layers, fill
 * layers, `mergeLayerInto`) and `fillPlane` had a fourth through
 * `compositePixel`. They agreed byte-for-byte, which is exactly the problem:
 * a fix to one is a bug in the other three, and only one of them had tests.
 *
 * `sa` is the source alpha AFTER opacity, mask multiply and clipping — 0..255,
 * because that is what the callers have already computed. `out[o + 3]` is the
 * destination alpha; this reads it, so call it before writing.
 * `ao === 0` (fully transparent over fully transparent) writes zeros rather
 * than leaving stale colour behind.
 */
export function overNormal(
  sr: number, sg: number, sb: number, sa: number,
  out: { [i: number]: number }, o: number,
): void {
  const as = sa / 255;
  const da = out[o + 3]!;
  const ab = da / 255;
  const ao = as + ab * (1 - as);
  if (ao <= 0) {
    out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
    return;
  }
  const wS = (1 - as) * ab;
  out[o] = (as * sr + wS * out[o]!) / ao;
  out[o + 1] = (as * sg + wS * out[o + 1]!) / ao;
  out[o + 2] = (as * sb + wS * out[o + 2]!) / ao;
  out[o + 3] = ao * 255;
}
