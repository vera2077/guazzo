// PSD export — the reverse of engine/psd.ts.
//
// We only ever write 8-bit RGB, which is exactly what ag-psd supports writing, and
// we keep layers, names, opacity, visibility and blend modes so a file round-trips
// through Photoshop without being flattened. Layer masks are baked into the
// exported alpha (the import side bakes the same way — symmetric fidelity);
// clipToBelow is exported as a real PSD clipping layer.
//
// Adjustment layers are written as real Photoshop adjustment records when the
// model has an exact record for them: invert, posterize, threshold, curves,
// brightness/contrast, photo filter, colour balance, black & white, levels
// (composite and per-channel), exposure, vibrance and hue/saturation
// (including colorize and the six per-range bands). Fields the model cannot
// express are named on import rather than invented here.
//
// Solid and linear/radial gradient fills are written as Photoshop colour-content
// layers, using the same `vectorFill` record the importer reads. A pattern fill,
// or a fill with a mask, is not representable: a live record would lose the
// pattern or the mask, so it falls back to the whole-document composite like
// every other backdrop-dependent layer.
//
// Layer styles travel as the `effects` recipe on the layer record instead of
// being painted into the pixels, so the recipient can still switch them off.
//
// The product entry point is buildPsdForExport(): it writes a layer tree only
// when every layer in the tree is representable (a pixel layer, a fill, an
// adjustment with an exact record, or a group whose children all are). Otherwise
// it writes the whole-document composite, because a non-representable layer
// cannot be rasterised in isolation without changing the picture — clipped,
// pass-through and unmapped adjustment layers all depend on the backdrop. The
// single-layer flat path is the honest fallback.
//
// This module is deliberately free of ag-psd imports: it builds the plain object
// shape ag-psd's writePsd() expects, so it is unit-testable in Node and the actual
// serialisation stays in the UI layer where the vendored bundle lives.

import { gridBBox } from "./transform.ts";
import type { BlendMode } from "./blend.ts";
import { maskAt, type Document, type Layer, type TextLayerMeta, type TextSeg } from "./document.ts";
import type { AdjustSpec, BalanceTriple } from "./adjustfn.ts";
import { curveLut, sortMapStops, type CurvePoint } from "./tone.ts";
import { normalizeSelective, SELECTIVE_RANGES } from "./selective.ts";
import { cubeText } from "./lookuptable.ts";
import { runColour, runFontSize } from "./textruns.ts";
import { toAgEffects, type LayerEffects } from "./effects.ts";

/** ag-psd expresses blend modes as Photoshop writes them: "color burn". */
export function psdBlendName(mode: BlendMode): string {
  return mode.replace(/-/g, " ");
}

export interface PsdLayerOut {
  name: string;
  opacity: number;
  blendMode: string;
  hidden: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  imageData?: { width: number; height: number; data: Uint8ClampedArray };
  /** PSD clipping layer — shows through the alpha of the layer below */
  clipping?: boolean;
  /** a live Photoshop adjustment record; absent when the layer was flattened */
  adjustment?: PsdAdjustmentOut;
  /** a live Photoshop solid-colour or gradient fill content layer */
  vectorFill?: PsdFillRecord;
  /** a live Photoshop type layer; the imageData beside it remains the raster */
  text?: PsdTextOut;
  children?: PsdLayerOut[];
  /** Photoshop layer styles, kept as a recipe rather than baked pixels */
  effects?: LayerEffects;
  /** Marks a divider produced by an adjustment/fill layer we must flatten. */
  __flattened?: boolean;
}

/** Photoshop's colour-content record for a Solid Colour fill layer. */
export interface PsdFillOut {
  type: "color";
  color: { r: number; g: number; b: number };
}

/** Photoshop's gradient-content record for a Gradient fill layer. */
export interface PsdGradientFillOut {
  type: "solid";
  name: string;
  style: "linear" | "radial";
  angle: number;
  reverse: boolean;
  colorStops: Array<{ color: { r: number; g: number; b: number }; location: number; midpoint: number }>;
  opacityStops: Array<{ opacity: number; location: number }>;
}

export type PsdFillRecord = PsdFillOut | PsdGradientFillOut;

/** The subset of ag-psd's text style the model can express. */
export interface PsdTextStyleOut {
  font: { name: string };
  fontSize: number;
  fauxBold?: boolean;
  fauxItalic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fillColor: { r: number; g: number; b: number };
}

/** A live Photoshop type layer. The raster imageData stays alongside it so a
 *  reader that ignores text still sees the picture. */
export interface PsdTextOut {
  text: string;
  style: PsdTextStyleOut;
  styleRuns: Array<{ length: number; style: PsdTextStyleOut }>;
  paragraphStyle: { justification: string };
  transform: [number, number, number, number, number, number];
  orientation: "horizontal";
  shapeType: "point" | "box";
  boxBounds?: [number, number, number, number];
  bounds: {
    top: { units: "Pixels"; value: number };
    left: { units: "Pixels"; value: number };
    right: { units: "Pixels"; value: number };
    bottom: { units: "Pixels"; value: number };
  };
}

/** One Photoshop curve knot. The record stores input/output in 0–255 bytes. */
export interface PsdCurvePoint {
  input: number;
  output: number;
}

/** Photoshop's color-balance triple, in the record's channel names. */
export interface PsdColorBalance {
  cyanRed: number;
  magentaGreen: number;
  yellowBlue: number;
}

/** The adjustment records slice 1 can write without losing a model field. */
/** One output channel of a channel-mixer record, in percent. */
export interface PsdCmyk { c: number; m: number; y: number; k: number }

/** One of Photoshop's six Hue/Saturation range bands, in degrees. */
export interface PsdHueChannel {
  a: number;
  b: number;
  c: number;
  d: number;
  hue: number;
  saturation: number;
  lightness: number;
}

export interface PsdMixChannel {
  red: number;
  green: number;
  blue: number;
  constant: number;
}

export type PsdAdjustmentOut =
  | { type: "invert" }
  | { type: "posterize"; levels: number }
  | { type: "threshold"; level: number }
  | { type: "curves"; channels: PsdCurvePoint[][] }
  | { type: "curves"; values: number[][] }
  | {
      type: "levels";
      channels: Array<{
        shadowInput: number;
        highlightInput: number;
        shadowOutput: number;
        highlightOutput: number;
        midtoneInput: number;
      }>;
    }
  | { type: "exposure"; exposure: number; offset: number; gamma: number }
  | { type: "vibrance"; vibrance: number; saturation: number }
  | {
      type: "hue/saturation";
      colorize?: boolean;
      colorization?: { hue: number; saturation: number; lightness: number };
      master: { hue: number; saturation: number; lightness: number };
      reds?: PsdHueChannel;
      yellows?: PsdHueChannel;
      greens?: PsdHueChannel;
      cyans?: PsdHueChannel;
      blues?: PsdHueChannel;
      magentas?: PsdHueChannel;
    }
  | { type: "brightness/contrast"; brightness: number; contrast: number; useLegacy: false }
  | {
      type: "photo filter";
      color: { r: number; g: number; b: number };
      density: number;
      preserveLuminosity: boolean;
    }
  | {
      type: "color balance";
      shadows: PsdColorBalance;
      midtones: PsdColorBalance;
      highlights: PsdColorBalance;
      preserveLuminosity: boolean;
    }
  | {
      type: "black & white";
      reds: number;
      yellows: number;
      greens: number;
      cyans: number;
      blues: number;
      magentas: number;
      useTint: boolean;
      tintColor?: { r: number; g: number; b: number };
    }
  | {
      type: "channel mixer";
      monochrome?: boolean;
      red: PsdMixChannel;
      green: PsdMixChannel;
      blue: PsdMixChannel;
      gray?: PsdMixChannel;
    }
  | {
      type: "color lookup";
      lookupType: "3dlut";
      name: string;
      lutFormat: "cube";
      dataOrder: "rgb";
      tableOrder: "rgb";
      lut3DFileData: Uint8Array;
      lut3DFileName: string;
    }
  | {
      type: "selective color";
      mode?: "relative" | "absolute";
      reds?: PsdCmyk;
      yellows?: PsdCmyk;
      greens?: PsdCmyk;
      cyans?: PsdCmyk;
      blues?: PsdCmyk;
      magentas?: PsdCmyk;
      whites?: PsdCmyk;
      neutrals?: PsdCmyk;
      blacks?: PsdCmyk;
    }
  | {
      type: "gradient map";
      gradientType: "solid";
      colorStops: Array<{
        color: { r: number; g: number; b: number };
        location: number;
        midpoint: number;
      }>;
    };

/**
 * Turn a Guazzo curve channel into PSD knots. The probe showed ag-psd writes
 * and reads 0–255 input/output pairs directly, so this is a clamp/round/sort,
 * not a rescale. Fewer than two knots is not a curve record Photoshop will
 * accept: return null so the layer falls back to flattening instead of being
 * written as a malformed record. Two knots at the same input cannot describe a
 * function; keep the last one, then apply the same two-knot floor.
 */
function curveChannel(points: readonly CurvePoint[] | undefined): PsdCurvePoint[] | null {
  if (!points || points.length < 2) return null;
  const sorted = points
    .map((p) => ({
      input: Math.max(0, Math.min(255, Math.round(p.x))),
      output: Math.max(0, Math.min(255, Math.round(p.y))),
    }))
    .sort((a, b) => a.input - b.input);
  const out: PsdCurvePoint[] = [];
  for (const point of sorted) {
    if (out.length > 0 && out[out.length - 1]!.input === point.input) out[out.length - 1] = point;
    else out.push(point);
  }
  return out.length >= 2 ? out : null;
}

/** Above this many knots, write the record's pencil table instead. Photoshop's
 *  Curves UI is built for a dozen-odd points; a channel table is exact and has
 *  no knot-count bet. Sixteen is the editor's comfort limit, not a format one. */
const DENSE_CURVE_KNOTS = 16;

const IDENTITY_CHANNEL: PsdCurvePoint[] = [
  { input: 0, output: 0 },
  { input: 255, output: 255 },
];

function curveTable(points: PsdCurvePoint[]): number[] {
  return Array.from(curveLut(points.map((p) => ({ x: p.input, y: p.output }))));
}

function colorBalanceOut(triple: BalanceTriple): PsdColorBalance {
  return {
    cyanRed: Math.round(triple.r),
    magentaGreen: Math.round(triple.g),
    yellowBlue: Math.round(triple.b),
  };
}

/**
 * Map an adjustment spec to a Photoshop record, or null when the model has
 * fields the record cannot carry. Null means the caller must flatten, not that
 * the layer can be dropped.
 */
/** Channel-mixer weights are percentages; Photoshop clamps at ±200. */
function clampPsdPercent(v: number): number {
  return Math.max(-100, Math.min(100, Math.round(v * 10) / 10));
}

function clampMix(v: number): number {
  return Math.max(-200, Math.min(200, Math.round(v)));
}

export function psdAdjustmentRecord(spec: AdjustSpec | undefined): PsdAdjustmentOut | null {
  if (!spec) return null;
  switch (spec.kind) {
    case "invert":
      return { type: "invert" };
    case "posterize":
      return { type: "posterize", levels: Math.max(2, Math.min(255, Math.round(spec.posterizeLevels ?? 4))) };
    case "threshold":
      // Photoshop's slider and record are 1–255; our dialog is 1–254. Clamp
      // rather than write a value Photoshop may reject.
      return { type: "threshold", level: Math.max(1, Math.min(255, Math.round(spec.thresholdLevel ?? 128))) };
    case "curves": {
      const c = spec.curves;
      if (!c) return null;
      const rgb = curveChannel(c.rgb);
      if (!rgb) return null;
      // PSD channel 0 is the composite curve. Guazzo's rgb curve is the
      // fallback for each channel, not an extra pass on top of per-channel
      // curves, so use it as channel 0 only when no per-channel override
      // exists. Otherwise write an identity composite and the three effective
      // channel curves, or Photoshop would apply rgb twice.
      if (!c.r && !c.g && !c.b) {
        if (rgb.length <= DENSE_CURVE_KNOTS) return { type: "curves", channels: [rgb] };
        return {
          type: "curves",
          values: [curveTable(rgb), curveTable(IDENTITY_CHANNEL), curveTable(IDENTITY_CHANNEL), curveTable(IDENTITY_CHANNEL)],
        };
      }
      const r = curveChannel(c.r ?? c.rgb);
      const g = curveChannel(c.g ?? c.rgb);
      const b = curveChannel(c.b ?? c.rgb);
      if (!r || !g || !b) return null;
      if ([r, g, b].every((channel) => channel.length <= DENSE_CURVE_KNOTS)) {
        return { type: "curves", channels: [IDENTITY_CHANNEL, r, g, b] };
      }
      return {
        type: "curves",
        values: [curveTable(IDENTITY_CHANNEL), curveTable(r), curveTable(g), curveTable(b)],
      };
    }
    case "levels": {
      const lv = spec.levels ?? { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
      const byte = (v: number | undefined, fallback: number): number =>
        Math.max(0, Math.min(255, Math.round(v ?? fallback)));
      const row = (o: typeof lv) => ({
        shadowInput: byte(o.inBlack, 0),
        highlightInput: byte(o.inWhite, 255),
        midtoneInput: Math.round(Math.max(0.1, Math.min(9.99, o.gamma ?? 1)) * 100) / 100,
        shadowOutput: byte(o.outBlack, 0),
        highlightOutput: byte(o.outWhite, 255),
      });
      // A channel row that was not present is written as the composite row:
      // Photoshop's record has four rows and a reader that expects four would
      // otherwise treat a missing row as "identity", which is not the same
      // picture as "same as composite".
      const ch = spec.levelsChannels;
      return {
        type: "levels",
        channels: [row(lv), row(ch?.r ?? lv), row(ch?.g ?? lv), row(ch?.b ?? lv)],
      };
    }
    case "exposure":
      return {
        type: "exposure",
        exposure: Number.isFinite(spec.stops) ? spec.stops! : 0,
        // ag-psd calls the third float `gamma`; this is Photoshop's
        // gamma-correction field, not a second exposure control. Both extra
        // fields act in linear light, which is why they are written as numbers
        // rather than folded into the exposure value.
        offset: Math.min(0.5, Math.max(-0.5, spec.exposureOffset ?? 0)),
        gamma: Math.min(9.99, Math.max(0.01, spec.exposureGamma ?? 1)),
      };
    case "vibrance":
      return {
        type: "vibrance",
        vibrance: Math.max(-100, Math.min(100, Math.round(spec.amount ?? 0))),
        saturation: Math.max(-100, Math.min(100, Math.round(spec.vibranceSaturation ?? 0))),
      };
    case "hue-sat": {
      // Colorize lives in its own colorization block; the master triple is
      // zeroed there so a re-import cannot apply the same hue twice.
      const hueValue = (v: number | undefined, min: number, max: number): number =>
        Math.max(min, Math.min(max, Math.round(v ?? 0)));
      const band = (key: "reds" | "yellows" | "greens" | "cyans" | "blues" | "magentas"): PsdHueChannel | undefined => {
        const r = spec.hueRanges?.[key];
        if (!r) return undefined;
        return {
          a: hueValue(r.a, 0, 360),
          b: hueValue(r.b, 0, 360),
          c: hueValue(r.c, 0, 360),
          d: hueValue(r.d, 0, 360),
          hue: hueValue(r.hue, -180, 180),
          saturation: hueValue(r.saturation, -100, 100),
          lightness: hueValue(r.lightness, -100, 100),
        };
      };
      const colorize = spec.colorize === true;
      const masterHue = colorize
        ? (((Math.round(spec.hue ?? 0) % 360) + 360) % 360)
        : hueValue(spec.hue, -180, 180);
      const colour = {
        hue: masterHue,
        saturation: hueValue(spec.saturation, -100, 100),
        lightness: hueValue(spec.lightness, -100, 100),
      };
      const reds = band("reds");
      const yellows = band("yellows");
      const greens = band("greens");
      const cyans = band("cyans");
      const blues = band("blues");
      const magentas = band("magentas");
      return {
        type: "hue/saturation",
        ...(colorize ? { colorize: true, colorization: colour } : {}),
        master: colorize ? { hue: 0, saturation: 0, lightness: 0 } : colour,
        ...(reds ? { reds } : {}),
        ...(yellows ? { yellows } : {}),
        ...(greens ? { greens } : {}),
        ...(cyans ? { cyans } : {}),
        ...(blues ? { blues } : {}),
        ...(magentas ? { magentas } : {}),
      };
    }
    case "brightness-contrast":
      return {
        type: "brightness/contrast",
        brightness: Math.round(spec.brightness ?? 0),
        // Photoshop clamps contrast at -50; our model allows -100. Clamp at the
        // record boundary so we never write a value Photoshop will clip. The
        // rendered result still differs: our brightness is a 2.55x offset,
        // Photoshop's is not. That difference is documented, not fixable here.
        contrast: Math.max(-50, Math.min(100, Math.round(spec.contrast ?? 0))),
        // The modern CgEd block is the one that carries the same numbers back;
        // the legacy 'brit' block is still written for older readers.
        useLegacy: false,
      };
    case "photo-filter": {
      const pf = spec.photoFilter ?? { color: [236, 138, 0] as [number, number, number], density: 25 };
      return {
        type: "photo filter",
        color: {
          r: Math.max(0, Math.min(255, Math.round(pf.color[0]))),
          g: Math.max(0, Math.min(255, Math.round(pf.color[1]))),
          b: Math.max(0, Math.min(255, Math.round(pf.color[2]))),
        },
        density: Math.max(0, Math.min(100, pf.density)),
        preserveLuminosity: pf.preserveLuminosity ?? true,
      };
    }
    case "color-balance": {
      const cb = spec.colorBalance;
      return {
        type: "color balance",
        shadows: colorBalanceOut(cb?.shadows ?? { r: 0, g: 0, b: 0 }),
        midtones: colorBalanceOut(cb?.midtones ?? { r: 0, g: 0, b: 0 }),
        highlights: colorBalanceOut(cb?.highlights ?? { r: 0, g: 0, b: 0 }),
        preserveLuminosity: cb?.preserveLuminosity ?? true,
      };
    }
    case "black-white": {
      const bw = spec.blackWhite ?? { r: 40, g: 60, b: 40, c: 60, m: 40, y: 20 };
      return {
        type: "black & white",
        reds: Math.round(bw.r),
        yellows: Math.round(bw.y),
        greens: Math.round(bw.g),
        cyans: Math.round(bw.c),
        blues: Math.round(bw.b),
        magentas: Math.round(bw.m),
        useTint: spec.blackWhiteTint !== undefined,
        ...(spec.blackWhiteTint
          ? {
              tintColor: {
                r: Math.max(0, Math.min(255, Math.round(spec.blackWhiteTint[0]))),
                g: Math.max(0, Math.min(255, Math.round(spec.blackWhiteTint[1]))),
                b: Math.max(0, Math.min(255, Math.round(spec.blackWhiteTint[2]))),
              },
            }
          : {}),
      };
    }
    case "channel-mixer": {
      const m: NonNullable<AdjustSpec["mixer"]> = spec.mixer ?? {
        red: { r: 100, g: 0, b: 0, constant: 0 },
        green: { r: 0, g: 100, b: 0, constant: 0 },
        blue: { r: 0, g: 0, b: 100, constant: 0 },
      };
      const ch = (c: { r: number; g: number; b: number; constant: number }): PsdMixChannel => ({
        red: clampMix(c.r),
        green: clampMix(c.g),
        blue: clampMix(c.b),
        constant: clampMix(c.constant),
      });
      const out: Extract<PsdAdjustmentOut, { type: "channel mixer" }> = {
        type: "channel mixer",
        red: ch(m.red),
        green: ch(m.green),
        blue: ch(m.blue),
      };
      if (m.gray) {
        out.monochrome = true;
        out.gray = ch(m.gray);
      }
      return out;
    }
    case "color-lookup": {
      const table = spec.lookup;
      // A lookup layer with no table yet is a placeholder, not a recipe: it
      // changes nothing, so exporting a record for it would claim an effect
      // that does not exist. The caller's flatten fallback handles it.
      if (!table || table.size < 2) return null;
      return {
        type: "color lookup",
        lookupType: "3dlut",
        name: table.name,
        lutFormat: "cube",
        dataOrder: "rgb",
        tableOrder: "rgb",
        lut3DFileData: new TextEncoder().encode(cubeText(table)),
        lut3DFileName: `${table.name}.cube`,
      };
    }
    case "selective-colour": {
      const settings = normalizeSelective(spec.selective);
      const out: Extract<PsdAdjustmentOut, { type: "selective color" }> = { type: "selective color", mode: settings.mode };
      for (const range of SELECTIVE_RANGES) {
        const v = settings.ranges[range];
        if (!v) continue;
        out[range] = {
          c: clampPsdPercent(v.c),
          m: clampPsdPercent(v.m),
          y: clampPsdPercent(v.y),
          k: clampPsdPercent(v.k),
        };
      }
      return out;
    }
    case "gradient-map": {
      const stops = sortMapStops(spec.map ?? []);
      // A one-stop record is not a gradient Photoshop will accept, and a map
      // with no stops carries nothing: fall back to flattening rather than
      // writing a malformed record that opens as an identity.
      if (stops.length < 2) return null;
      const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
      return {
        type: "gradient map",
        gradientType: "solid",
        colorStops: stops.map((stop) => ({
          color: { r: byte(stop.color[0]), g: byte(stop.color[1]), b: byte(stop.color[2]) },
          location: Math.max(0, Math.min(1, stop.pos)),
          midpoint: 0.5,
        })),
      };
    }
    default:
      return null;
  }
}

export interface PsdOut {
  width: number;
  height: number;
  children: PsdLayerOut[];
}

/**
 * A solid-colour fill layer's PSD content record, or null when the model has no
 * exact colour to write. The colour is clamped/rounded because the model stores
 * bytes and PSD colour descriptors are floats.
 */
export function psdFillRecord(layer: Layer): PsdFillRecord | null {
  if (layer.kind !== "fill" || !layer.fill) return null;
  const grad = layer.fill.gradient;
  if (grad) {
    const stops = grad.stops
      .map((st) => ({
        color: { r: Math.round(st.color[0]), g: Math.round(st.color[1]), b: Math.round(st.color[2]) },
        location: st.at,
        midpoint: 0.5,
      }))
      .sort((a, b) => a.location - b.location);
    if (stops.length < 2) return null;
    return {
      type: "solid",
      name: "Guazzo gradient",
      style: grad.type,
      // undo the import's conversion: Guazzo angle = 360 - Photoshop angle
      angle: (((360 - grad.angle) % 360) + 360) % 360,
      reverse: false,
      colorStops: stops,
      opacityStops: [0, 1].map((location) => ({ opacity: 1, location })),
    };
  }
  const [r, g, b] = layer.fill.color;
  if (![r, g, b].every((v) => Number.isFinite(v))) return null;
  return {
    type: "color",
    color: {
      r: Math.max(0, Math.min(255, Math.round(r))),
      g: Math.max(0, Math.min(255, Math.round(g))),
      b: Math.max(0, Math.min(255, Math.round(b))),
    },
  };
}

/** A fill can stay live only when it has no mask: the record has no place to
 *  carry the layer mask, and dropping it would change the picture. */
function fillIsRepresentable(layer: Layer): boolean {
  // Solid colour and linear/radial gradients have records; patterns do not, and
  // a fill with a mask has nowhere to carry the mask — those fall into the
  // documented single-composite fallback, which keeps the picture and names the
  // cause instead of silently freezing a stop.
  return psdFillRecord(layer) !== null && !layer.mask && !layer.fill?.pattern;
}

function textAlignName(align: TextLayerMeta["align"]): string {
  if (align === "center" || align === "right") return align;
  if (align === "justify") return "justify-all";
  return "left";
}

function textStyleOut(seg: TextSeg, meta: TextLayerMeta): PsdTextStyleOut {
  const base = { size: meta.size, color: meta.color };
  const col = runColour(seg, base);
  return {
    font: { name: seg.font.trim() || "Arial" },
    fontSize: runFontSize(seg, base),
    ...(seg.bold ? { fauxBold: true } : {}),
    ...(seg.italic ? { fauxItalic: true } : {}),
    ...(seg.underline ? { underline: true } : {}),
    ...(seg.strike ? { strikethrough: true } : {}),
    fillColor: { r: col[0], g: col[1], b: col[2] },
  };
}

/**
 * A live Photoshop type record for a pixel layer that carries a text recipe.
 * Every run carries its own size, colour, font and decorations; the layer's own
 * size and colour are the base for runs that do not override them. A layer with
 * no usable recipe returns null and keeps its pixels.
 */
export function psdTextRecord(layer: Layer): PsdTextOut | null {
  if (layer.kind !== "pixel" || !layer.textData) return null;
  const meta = layer.textData;
  if (!(meta.size > 0) || meta.size > 1000) return null;
  if (!meta.lines.length) return null;

  const first = meta.lines.flat().find((seg) => seg.text.length > 0);
  if (!first) return null;
  const baseStyle = textStyleOut(first, meta);
  const runs: Array<{ length: number; style: PsdTextStyleOut }> = [];
  let text = "";
  meta.lines.forEach((line, lineIndex) => {
    for (const seg of line) {
      if (!seg.text) continue;
      text += seg.text;
      runs.push({ length: seg.text.length, style: textStyleOut(seg, meta) });
    }
    if (lineIndex < meta.lines.length - 1) {
      const last = line[line.length - 1];
      text += "\r";
      runs.push({ length: 1, style: last ? textStyleOut(last, meta) : baseStyle });
    }
  });
  if (!text.trim()) return null;

  const x = Math.round(meta.x);
  const y = Math.round(meta.y);
  const w = Math.max(1, Math.round(meta.w));
  const h = Math.max(1, Math.round(meta.h));
  const boxWidth = meta.wrap !== undefined && meta.wrap > 0 ? Math.max(1, Math.round(meta.wrap)) : undefined;
  const boxHeight = boxWidth !== undefined ? Math.max(1, Math.round(meta.boxH ?? h)) : undefined;
  // Export the box as `bounds` when there is one, not the ink rect: import
  // prefers named bounds, so an ink-width bounds would shrink our own wrap on
  // the way back in.
  const bounds = {
    top: { units: "Pixels" as const, value: y },
    left: { units: "Pixels" as const, value: x },
    right: { units: "Pixels" as const, value: x + (boxWidth ?? w) },
    bottom: { units: "Pixels" as const, value: y + (boxHeight ?? h) },
  };
  return {
    text,
    style: baseStyle,
    styleRuns: runs,
    paragraphStyle: { justification: textAlignName(meta.align) },
    transform: [1, 0, 0, 1, 0, 0],
    orientation: "horizontal",
    shapeType: boxWidth === undefined ? "point" : "box",
    ...(boxWidth !== undefined ? { boxBounds: [x, y, boxWidth, boxHeight!] as [number, number, number, number] } : {}),
    bounds,
  };
}

/**
 * Read one layer's pixels into a tight RGBA buffer covering only its bounding box
 * (PSD layers carry their own rect; a full-canvas buffer per layer would inflate
 * the file by orders of magnitude on a 20 MP document).
 */
function layerImage(layer: Layer, docW: number, docH: number): PsdLayerOut {
  const base: PsdLayerOut = {
    name: layer.name,
    opacity: layer.opacity,
    blendMode: psdBlendName(layer.blendMode),
    hidden: !layer.visible,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };
  // Styles travel as a recipe, exactly as they were read. Baking them here
  // would make the exported file look right and be wrong: the recipient could
  // no longer turn the shadow off.
  if (layer.effects) base.effects = toAgEffects(layer.effects);
  const box = gridBBox(layer.grid);
  if (!box) return base;
  const w = Math.min(box.w, Math.max(0, docW - box.x));
  const h = Math.min(box.h, Math.max(0, docH - box.y));
  if (w <= 0 || h <= 0) return base;
  const data = new Uint8ClampedArray(w * h * 4);
  layer.grid.readRect(box.x, box.y, w, h, data);
  if (layer.mask) {
    // bake the mask into exported alpha — mirrors psd.ts's import bakeMask, so
    // export/import is symmetric instead of silently dropping coverage
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = maskAt(layer.mask, box.x + x, box.y + y, layer.maskHide ? 0 : 255) / 255;
        const i = (y * w + x) * 4;
        if (m >= 1) continue;
        const a = data[i + 3]! * m;
        data[i + 3] = a;
        if (a === 0) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
      }
    }
  }
  base.clipping = layer.clipToBelow === true;
  base.left = box.x;
  base.top = box.y;
  base.right = box.x + w;
  base.bottom = box.y + h;
  base.imageData = { width: w, height: h, data };
  return base;
}

/**
 * Build the ag-psd object for a document.
 *
 * Pixel layers are written directly. Adjustment layers whose spec has an exact
 * Photoshop record and solid-colour fills are written as live records. Everything else with no pixel
 * buffer — fill layers and adjustment kinds without a record — is passed through
 * a caller-supplied `flatten` hook that returns the composited layer as pixels,
 * which is what Photoshop itself does when you flatten-and-save. Without a hook
 * those layers are omitted, never silently invented.
 */
export function buildPsd(
  doc: Document,
  flatten?: (layer: Layer, index: number) => { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null,
): PsdOut {
  const children: PsdLayerOut[] = [];
  doc.layers.forEach((layer, i) => {
    const out = buildPsdLayer(layer, i, doc.width, doc.height, flatten);
    if (out) children.push(out);
  });
  return { width: doc.width, height: doc.height, children };
}

function buildPsdLayer(
  layer: Layer,
  index: number,
  docW: number,
  docH: number,
  flatten?: (layer: Layer, index: number) => { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null,
): PsdLayerOut | null {
  if (layer.kind === "group") {
    const children: PsdLayerOut[] = [];
    (layer.children ?? []).forEach((child, i) => {
      const out = buildPsdLayer(child, i, docW, docH, flatten);
      if (out) children.push(out);
    });
    return {
      name: layer.name,
      opacity: layer.opacity,
      // ag-psd treats "pass through" as the explicit spelling of Photoshop's
      // default; leaving it out would make the group isolated on read.
      blendMode: layer.passThrough ? "pass through" : psdBlendName(layer.blendMode),
      hidden: !layer.visible,
      clipping: layer.clipToBelow === true,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      children,
    };
  }
  if (layer.kind === "adjust") {
    const adjustment = psdAdjustmentRecord(layer.adjust);
    if (adjustment) {
      // A live record keeps the layer's own opacity, blend and clipping.
      // There are no pixel channels; the record is the layer.
      return {
        name: layer.name,
        opacity: layer.opacity,
        blendMode: psdBlendName(layer.blendMode),
        hidden: !layer.visible,
        clipping: layer.clipToBelow === true,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        adjustment,
      };
    }
  }
  if (layer.kind === "fill") {
    const vectorFill = fillIsRepresentable(layer) ? psdFillRecord(layer) : null;
    if (vectorFill) {
      return {
        name: layer.name,
        opacity: layer.opacity,
        blendMode: psdBlendName(layer.blendMode),
        hidden: !layer.visible,
        clipping: layer.clipToBelow === true,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        vectorFill,
      };
    }
  }
  if (layer.kind !== "pixel") {
    const flat = flatten?.(layer, index) ?? null;
    if (!flat) return null;
    return {
      name: layer.name,
      opacity: 1,
      blendMode: "normal",
      hidden: !layer.visible,
      clipping: layer.clipToBelow === true,
      left: flat.x,
      top: flat.y,
      right: flat.x + flat.w,
      bottom: flat.y + flat.h,
      imageData: { width: flat.w, height: flat.h, data: flat.data },
      __flattened: true,
    };
  }
  const image = layerImage(layer, docW, docH);
  const text = psdTextRecord(layer);
  if (text) image.text = text;
  return image;
}

/** A layer the writer can carry without changing the picture. */
export function psdLayerRepresentable(layer: Layer): boolean {
  if (layer.kind === "group") {
    return !layer.mask && (layer.children ?? []).every(psdLayerRepresentable);
  }
  return layer.kind === "pixel" ||
    (layer.kind === "adjust" && !layer.mask && psdAdjustmentRecord(layer.adjust) !== null) ||
    fillIsRepresentable(layer);
}

function psdLayerLabel(layer: Layer): string {
  return layer.kind === "adjust" ? layer.adjust?.kind ?? "adjustment" : layer.kind;
}

/**
 * A text layer whose recipe cannot be written still exports its pixels. Unlike
 * the flatten fallback this keeps the layer, so say the recipe was left behind
 * instead of letting it disappear silently.
 */
function layerPath(doc: Document, layer: Layer): string {
  const parts = [layer.name];
  let parent = doc.parentOf(layer);
  while (parent) {
    parts.unshift(parent.name);
    parent = doc.parentOf(parent);
  }
  return parts.join(" / ");
}

function textRecipeNote(doc: Document, layer: Layer): string | null {
  if (layer.kind !== "pixel" || !layer.textData || psdTextRecord(layer)) return null;
  return `text recipe for “${layerPath(doc, layer)}” could not be written; pixels kept`;
}

/** What the export dialog, the status line and the writer all agree on. */
export interface PsdExportLoss {
  /** Root layers that cannot be written as a live record. */
  blocked: Layer[];
  /** Per-layer recipe losses that still keep the layer's pixels. */
  notes: string[];
  admission: string;
}

/**
 * The one export-loss decision. It walks ROOT layers only and never composites:
 * a group is one layer for this purpose, even when a descendant is the reason it
 * is blocked. A non-representable layer cannot be flattened on its own without
 * changing the picture: clipped and unmapped adjustment layers depend on the
 * backdrop, and a group with a masked child would lose that child's mask if the
 * group were written as if the child were live.
 */
export function psdExportLoss(doc: Document): PsdExportLoss {
  const blocked = doc.layers.filter((layer) => !psdLayerRepresentable(layer));
  // A grouped text layer loses its recipe just as silently as a root one; walk
  // the whole tree and name the path the import report uses.
  const notes = doc.allLayers()
    .map((layer) => textRecipeNote(doc, layer))
    .filter((note): note is string => note !== null);
  if (blocked.length === 0) return { blocked, notes, admission: notes.join("; ") };

  const labels = [...new Set(blocked.map(psdLayerLabel))].join(", ");
  const count = blocked.length;
  const textSuffix = notes.length ? `; ${notes.join("; ")}` : "";
  return {
    blocked,
    notes,
    admission: `a single flattened image because ${count} layer${count === 1 ? "" : "s"} ` +
      `${count === 1 ? "has" : "have"} no live PSD record (${labels})${textSuffix}`,
  };
}

/** The product export decision. */
export function buildPsdForExport(
  doc: Document,
  flattenedName: string,
): { psd: PsdOut; admission: string } {
  const loss = psdExportLoss(doc);
  if (loss.blocked.length === 0) return { psd: buildPsd(doc), admission: loss.admission };

  // Build the literal directly. Calling buildPsd(doc) here would read every
  // pixel layer's bounds off the tile grid only to throw that tree away.
  return {
    psd: {
      width: doc.width,
      height: doc.height,
      children: [{
        name: flattenedName,
        opacity: 1,
        blendMode: "normal",
        hidden: false,
        left: 0,
        top: 0,
        right: doc.width,
        bottom: doc.height,
        imageData: { width: doc.width, height: doc.height, data: doc.composite() },
      }],
    },
    admission: loss.admission,
  };
}
