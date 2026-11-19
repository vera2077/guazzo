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

// non-separable helpers (W3C spec)
const lum = (c: readonly number[]): number => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
function clipColor(c: number[]): void {
  const l = lum(c);
  const n = Math.min(c[0]!, c[1]!, c[2]!);
  const x = Math.max(c[0]!, c[1]!, c[2]!);
  if (n < 0) for (const i of [0, 1, 2] as const) c[i] = l + ((c[i]! - l) * l) / (l - n);
  if (x > 1) for (const i of [0, 1, 2] as const) c[i] = l + ((c[i]! - l) * (1 - l)) / (x - l);
}
function setLum(c: readonly number[], l: number): number[] {
  const r = [c[0]!, c[1]!, c[2]!];
  const d = l - lum(r);
  r[0]! += d; r[1]! += d; r[2]! += d;
  clipColor(r);
  return r;
}
function sat(c: readonly number[]): number {
  return Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!);
}
function setSat(c: readonly number[], s: number): number[] {
  const idx = [0, 1, 2].sort((a, b) => c[a]! - c[b]!) as [number, number, number]; // min, mid, max idx
  const r = [0, 0, 0];
  if (c[idx[2]]! > c[idx[0]]!) {
    r[idx[1]] = ((c[idx[1]]! - c[idx[0]]!) * s) / (c[idx[2]]! - c[idx[0]]!);
    r[idx[2]] = s;
  }
  return r; // min component = 0
}

const B_ = (mode: BlendMode, cb: readonly number[], cs: readonly number[]): number[] => {
  switch (mode) {
    case "hue": return setLum(setSat(cs, sat(cb)), lum(cb));
    case "saturation": return setLum(setSat(cb, sat(cs)), lum(cb));
    case "color": return setLum(cs, lum(cb));
    case "luminosity": return setLum(cb, lum(cs));
    case "darker-color": return lum(cs) < lum(cb) ? [cs[0]!, cs[1]!, cs[2]!] : [cb[0]!, cb[1]!, cb[2]!];
    case "lighter-color": return lum(cs) > lum(cb) ? [cs[0]!, cs[1]!, cs[2]!] : [cb[0]!, cb[1]!, cb[2]!];
    default: return [0, 0, 0];
  }
};

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
  if (mode === "darker-color" || mode === "lighter-color" || mode === "hue" || mode === "saturation" || mode === "color" || mode === "luminosity") {
    const bc = B_(mode, [cb0, cb1, cb2], [cs0, cs1, cs2]);
    br = bc[0]!; bg = bc[1]!; bb = bc[2]!;
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
