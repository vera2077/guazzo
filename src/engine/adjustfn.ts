/**
 * adjustfn.ts — adjustment layers as pure per-pixel functions.
 *
 * A normal pixel layer contributes its own colours to the stack. An
 * adjustment layer instead *transforms whatever is underneath it*, which
 * is exactly what a per-pixel function can express: for every pixel of
 * the accumulated backdrop we run `f(r, g, b)`. That keeps adjustment
 * layers cheap, invertible and independent of tiling geometry.
 *
 * LUT-friendly kinds compile to three 256-entry tables; the rest compile
 * to a small closure. Either way `compileAdjust` returns something
 * `document.ts` can run without knowing what the adjustment is.
 */

import { levelsLut, curveLut, buildLut, sampleMapStops, sortMapStops, type LevelsOptions, type CurvePoint, type MapStop } from "./tone.ts";

export type AdjustKind =
  | "brightness-contrast"
  | "levels"
  | "curves"
  | "exposure"
  | "vibrance"
  | "hue-sat"
  | "color-balance"
  | "black-white"
  | "photo-filter"
  | "invert"
  | "posterize"
  | "threshold"
  | "desaturate"
  | "gradient-map";

export interface BalanceTriple {
  r: number;
  g: number;
  b: number;
}

export interface AdjustSpec {
  kind: AdjustKind;
  /** brightness -100..100, contrast -100..100 */
  brightness?: number;
  contrast?: number;
  /** levels */
  levels?: LevelsOptions;
  /** curves (per channel; `rgb` applies to all three) */
  curves?: { rgb: CurvePoint[]; r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] };
  /** exposure in stops */
  stops?: number;
  /** vibrance -100..100 */
  amount?: number;
  /** hue -180..180, saturation -100..100, lightness -100..100 */
  hue?: number;
  saturation?: number;
  lightness?: number;
  colorBalance?: { shadows: BalanceTriple; midtones: BalanceTriple; highlights: BalanceTriple; preserveLuminosity: boolean };
  blackWhite?: { r: number; g: number; b: number; c: number; m: number; y: number };
  photoFilter?: { color: [number, number, number]; density: number; preserveLuminosity?: boolean };
  /** posterize levels 2..255 */
  posterizeLevels?: number;
  /** threshold 0..255 */
  thresholdLevel?: number;
  /**
   * gradient map: luminance (0..1) → colour, held at both ends. Same shape as
   * the destructive op's stops so one sanitiser serves both.
   */
  map?: MapStop[];
}

export interface CompiledAdjust {
  /** per-channel tables when the adjustment is a pure channel mapping */
  lr?: Uint8ClampedArray;
  lg?: Uint8ClampedArray;
  lb?: Uint8ClampedArray;
  /** otherwise a direct pixel transform. Float64, NOT Float32: the closure
   *  must see the raw doubles so the byte store rounds exactly like the
   *  destructive ops in tone.ts (float32 quantizes .49999 dust to .5). */
  rgb?: (r: number, g: number, b: number, out: Float64Array) => void;
}

/** Rec. 601 luma weights — identical to tone.ts (W_*) and adjust.ts (LR/LG/LB). */
const LUMA_R = 0.3, LUMA_G = 0.59, LUMA_B = 0.11;
/** Photoshop's Photo Filter ships with "Preserve Luminosity" ticked. */
const DEFAULT_PRESERVE_LUMA = true;
/** neutral Black & White band weight — a hue weighted below 60 darkens */
const NEUTRAL_BAND_WEIGHT = 60;
/** hue distance (degrees) between two neighbouring band centres */
const BAND_STEP_DEG = Math.PI / 60;

const clampCh = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** black → white, the ramp a fresh Gradient Map starts on (matches the
 *  destructive dialog's defaults: shadows black, highlights white). */
const DEFAULT_MAP_STOPS: readonly MapStop[] = [
  { pos: 0, color: [0, 0, 0] },
  { pos: 1, color: [255, 255, 255] },
];
const lumaOf = (r: number, g: number, b: number): number => (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;

/** rgb 0..255 → h 0..1, s 0..1, l 0..1 */
function hslFromRgb(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h, s, l];
}

function rgbFromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(clampCh(l * 255));
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(clampCh(hue(h + 1 / 3) * 255)),
    Math.round(clampCh(hue(h) * 255)),
    Math.round(clampCh(hue(h - 1 / 3) * 255)),
  ];
}

/** channel weight for the tone-range balancing in colour balance */
function rangeWeight(l: number, band: "shadows" | "midtones" | "highlights"): number {
  if (band === "shadows") return Math.max(0, 1 - l / 0.5);
  if (band === "highlights") return Math.max(0, (l - 0.5) / 0.5);
  return Math.max(0, 1 - Math.abs(l - 0.5) / 0.5);
}

/**
 * Compile a spec once per composite pass — `document.ts` calls this for
 * every tile, so it must stay allocation-light.
 */
export function compileAdjust(spec: AdjustSpec): CompiledAdjust {
  switch (spec.kind) {
    case "brightness-contrast": {
      // brightness is an offset, contrast a scale around the 128 pivot —
      // same maths as the destructive version in adjust.ts
      const shift = (spec.brightness ?? 0) * 2.55;
      const factor = 1 + (spec.contrast ?? 0) / 100;
      const lut = buildLut((v) => clampCh((v - 128) * factor + 128 + shift));
      return { lr: lut, lg: lut, lb: lut };
    }
    case "levels":
      return (() => {
        const lut = levelsLut(spec.levels ?? { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
        return { lr: lut, lg: lut, lb: lut };
      })();
    case "curves": {
      const c = spec.curves;
      if (!c) {
        const id = buildLut((v) => v);
        return { lr: id, lg: id, lb: id };
      }
      const all = curveLut(c.rgb);
      return {
        lr: c.r ? curveLut(c.r) : all,
        lg: c.g ? curveLut(c.g) : all,
        lb: c.b ? curveLut(c.b) : all,
      };
    }
    case "exposure": {
      // same ±4 EV clamp as tone.ts applyExposure
      const g = Math.pow(2, Math.min(4, Math.max(-4, spec.stops ?? 0)));
      const lut = buildLut((v) => clampCh(Math.pow(v / 255, 2.2) * g) ** (1 / 2.2) * 255);
      return { lr: lut, lg: lut, lb: lut };
    }
    case "invert": {
      const lut = buildLut((v) => 255 - v);
      return { lr: lut, lg: lut, lb: lut };
    }
    case "posterize": {
      const levels = Math.max(2, Math.round(spec.posterizeLevels ?? 4));
      const step = 255 / (levels - 1);
      const lut = buildLut((v) => Math.round(Math.round(v / step) * step));
      return { lr: lut, lg: lut, lb: lut };
    }
    case "threshold": {
      // luminance threshold (Photoshop): one decision for the whole pixel,
      // NOT an independent per-channel threshold — matches adjust.ts.
      const t = spec.thresholdLevel ?? 128;
      return {
        rgb: (r, g, b, out) => {
          const v = LUMA_R * r + LUMA_G * g + LUMA_B * b >= t ? 255 : 0;
          out[0] = v;
          out[1] = v;
          out[2] = v;
        },
      };
    }
    case "desaturate": {
      return {
        rgb: (r, g, b, out) => {
          const l = clampCh(0.3 * r + 0.59 * g + 0.11 * b);
          out[0] = l;
          out[1] = l;
          out[2] = l;
        },
      };
    }
    case "gradient-map": {
      // A 256-entry table indexed by luminance: the ramp is a pure function of
      // one byte, so the per-pixel cost is a lookup and three stores. Sampling
      // the stop list per pixel would be the same picture for ~8x the work.
      const stops = sortMapStops(spec.map ?? DEFAULT_MAP_STOPS);
      const lut = new Float64Array(256 * 3);
      for (let v = 0; v < 256; v++) {
        const c = sampleMapStops(stops, v / 255);
        lut[v * 3] = c[0]; lut[v * 3 + 1] = c[1]; lut[v * 3 + 2] = c[2];
      }
      return {
        rgb: (r, g, b, out) => {
          const l = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
          const at = (l < 0 ? 0 : l > 255 ? 255 : l) * 3;
          out[0] = lut[at]!;
          out[1] = lut[at + 1]!;
          out[2] = lut[at + 2]!;
        },
      };
    }
    case "vibrance": {
      const amt = (spec.amount ?? 0) / 100;
      return {
        rgb: (r, g, b, out) => {
          const l = 0.3 * r + 0.59 * g + 0.11 * b;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const k = amt * Math.max(0.2, 1 - sat);
          out[0] = clampCh(l + (r - l) * (1 + k));
          out[1] = clampCh(l + (g - l) * (1 + k));
          out[2] = clampCh(l + (b - l) * (1 + k));
        },
      };
    }
    case "hue-sat": {
      const dh = (spec.hue ?? 0) / 360;
      const ds = (spec.saturation ?? 0) / 100;
      const dl = (spec.lightness ?? 0) / 100;
      return {
        rgb: (r, g, b, out) => {
          const [h, s, l] = hslFromRgb(r, g, b);
          const nn = (h + dh + 1) % 1;
          const ns = Math.min(1, Math.max(0, s * (1 + ds)));
          const nl = Math.min(1, Math.max(0, dl >= 0 ? l + (1 - l) * dl : l * (1 + dl)));
          const [nr, ng, nb] = rgbFromHsl(nn, ns, nl);
          out[0] = nr;
          out[1] = ng;
          out[2] = nb;
        },
      };
    }
    case "color-balance": {
      // mirrors tone.ts applyColorBalance exactly: slider sum per band
      // (±100 → ±100 shift), luminosity preserved by adding the luma
      // delta to every channel equally.
      const cb = spec.colorBalance;
      return {
        rgb: (r, g, b, out) => {
          if (!cb) {
            out[0] = r;
            out[1] = g;
            out[2] = b;
            return;
          }
          const l = lumaOf(r, g, b);
          const ws = rangeWeight(l, "shadows");
          const wm = rangeWeight(l, "midtones");
          const wh = rangeWeight(l, "highlights");
          const dr = cb.shadows.r * ws + cb.midtones.r * wm + cb.highlights.r * wh;
          const dg = cb.shadows.g * ws + cb.midtones.g * wm + cb.highlights.g * wh;
          const db = cb.shadows.b * ws + cb.midtones.b * wm + cb.highlights.b * wh;
          let nr = clampCh(r + dr), ng = clampCh(g + dg), nb = clampCh(b + db);
          if (cb.preserveLuminosity) {
            const before = LUMA_R * r + LUMA_G * g + LUMA_B * b;
            const after = LUMA_R * nr + LUMA_G * ng + LUMA_B * nb;
            const d = before - after;
            nr = clampCh(nr + d);
            ng = clampCh(ng + d);
            nb = clampCh(nb + d);
          }
          out[0] = nr;
          out[1] = ng;
          out[2] = nb;
        },
      };
    }
    case "black-white": {
      // mirrors tone.ts applyBlackWhite exactly: each pixel's hue presence
      // (chroma scaled by value) votes for its band weight; the grey is the
      // presence-weighted average of the six sliders against the neutral 60.
      const bw = spec.blackWhite ?? { r: 40, g: 60, b: 40, c: 60, m: 40, y: 20 };
      return {
        rgb: (r, g, b, out) => {
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const c = mx - mn;
          const v = mx;
          if (c === 0) {
            // neutral grey has no hue: plain luminance
            const grey = clampCh(v);
            out[0] = grey;
            out[1] = grey;
            out[2] = grey;
            return;
          }
          const h = mx === r
            ? ((g - b) / c + (g < b ? 6 : 0)) * 60
            : mx === g ? ((b - r) / c + 2) * 60 : ((r - g) / c + 4) * 60;
          const sat = c / (mx || 1);
          const chroma = sat * (v / 255);
          let wsum = 0, wv = 0;
          const add = (weight: number, presence: number): void => {
            if (presence <= 0) return;
            wsum += presence;
            wv += presence * weight;
          };
          add(bw.r, chroma * Math.max(0, Math.cos((h - 0) * BAND_STEP_DEG)));
          add(bw.y, chroma * Math.max(0, Math.cos((h - 60) * BAND_STEP_DEG)));
          add(bw.g, chroma * Math.max(0, Math.cos((h - 120) * BAND_STEP_DEG)));
          add(bw.c, chroma * Math.max(0, Math.cos((h - 180) * BAND_STEP_DEG)));
          add(bw.b, chroma * Math.max(0, Math.cos((h - 240) * BAND_STEP_DEG)));
          add(bw.m, chroma * Math.max(0, Math.cos((h - 300) * BAND_STEP_DEG)));
          const weighted = wsum > 0 ? wv / wsum : NEUTRAL_BAND_WEIGHT;
          const grey = clampCh(v * (weighted / NEUTRAL_BAND_WEIGHT));
          out[0] = grey;
          out[1] = grey;
          out[2] = grey;
        },
      };
    }
    case "photo-filter": {
      // mirrors tone.ts applyPhotoFilter: plain lerp toward the filter
      // colour by density, luminosity preserved (on by default) by scaling
      // back toward the original luma.
      const pf = spec.photoFilter ?? { color: [236, 138, 0] as [number, number, number], density: 25 };
      const d = Math.min(1, Math.max(0, pf.density / 100));
      const preserve = spec.photoFilter?.preserveLuminosity ?? DEFAULT_PRESERVE_LUMA;
      return {
        rgb: (r, g, b, out) => {
          let nr = r * (1 - d) + pf.color[0] * d;
          let ng = g * (1 - d) + pf.color[1] * d;
          let nb = b * (1 - d) + pf.color[2] * d;
          if (preserve) {
            const before = LUMA_R * r + LUMA_G * g + LUMA_B * b;
            const after = LUMA_R * nr + LUMA_G * ng + LUMA_B * nb;
            const k = before / Math.max(1, after);
            nr = clampCh(nr * k);
            ng = clampCh(ng * k);
            nb = clampCh(nb * k);
          }
          out[0] = nr;
          out[1] = ng;
          out[2] = nb;
        },
      };
    }
    default: {
      const id = buildLut((v) => v);
      return { lr: id, lg: id, lb: id };
    }
  }
}

/** human-readable default spec per kind, used when the UI creates a layer */
export function defaultAdjustSpec(kind: AdjustKind): AdjustSpec {
  switch (kind) {
    case "levels":
      return { kind, levels: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 } };
    case "curves":
      return { kind, curves: { rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }] } };
    case "exposure":
      return { kind, stops: 0 };
    case "vibrance":
      return { kind, amount: 0 };
    case "hue-sat":
      return { kind, hue: 0, saturation: 0, lightness: 0 };
    case "color-balance":
      return {
        kind,
        colorBalance: {
          shadows: { r: 0, g: 0, b: 0 },
          midtones: { r: 0, g: 0, b: 0 },
          highlights: { r: 0, g: 0, b: 0 },
          preserveLuminosity: true,
        },
      };
    case "black-white":
      return { kind, blackWhite: { r: 40, g: 60, b: 40, c: 60, m: 40, y: 20 } };
    case "photo-filter":
      return { kind, photoFilter: { color: [236, 138, 0], density: 25 } };
    case "posterize":
      return { kind, posterizeLevels: 4 };
    case "threshold":
      return { kind, thresholdLevel: 128 };
    case "gradient-map":
      return { kind, map: DEFAULT_MAP_STOPS.map((stop) => ({ pos: stop.pos, color: [...stop.color] as [number, number, number] })) };
    default:
      return { kind };
  }
}

/** label shown in the layers panel */
export function adjustLabel(spec: AdjustSpec): string {
  switch (spec.kind) {
    case "brightness-contrast":
      return "Brightness/Contrast";
    case "levels":
      return "Levels";
    case "curves":
      return "Curves";
    case "exposure":
      return "Exposure";
    case "vibrance":
      return "Vibrance";
    case "hue-sat":
      return "Hue/Saturation";
    case "color-balance":
      return "Colour Balance";
    case "black-white":
      return "Black & White";
    case "photo-filter":
      return "Photo Filter";
    case "invert":
      return "Invert";
    case "posterize":
      return "Posterize";
    case "threshold":
      return "Threshold";
    case "desaturate":
      return "Desaturate";
    case "gradient-map":
      return "Gradient Map";
    default:
      return "Adjustment";
  }
}
