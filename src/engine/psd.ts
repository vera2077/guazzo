/**
 * psd.ts — PSD import stage 1: parsed-PSD → Guazzo Document.
 *
 * Pure mapping, no ag-psd dependency: the caller (browser main.ts via the
 * agPsd UMD global, node tests via the real-path require) does the actual
 * parse with `{ useImageData: true }` and hands the resulting plain object
 * here. Stage 1 covers pixel layers, blend modes, opacity, visibility,
 * layer offsets and raster masks (baked into layer alpha).
 *
 * Group layers become real tree nodes. Photoshop's default group blend mode
 * is "pass through", and that is the one that means "let the children blend
 * with the backdrop"; any other mode is an isolated group whose own opacity
 * and blend apply to the subtree as a whole. A hidden group keeps its subtree
 * (the compositor skips it) so showing the group again restores the work.
 */

/** Guard for effect-driven buffers: effects sizes come from the file, not the canvas. */
const EFFECT_MAX_PIXELS = 64_000_000;

import { Document, type Layer } from "./document.ts";
import type { AdjustSpec } from "./adjustfn.ts";
import { curveLut, type CurvePoint } from "./tone.ts";
import { emptyImportReport, type ImportReport } from "./importreport.ts";
import { MAX_DIM } from "./docmeta.ts";
import { LAYER_BLEND_MODES, type BlendMode } from "./blend.ts";
import { bakeSolidFill, bakeGradientOverlay, compositeOver, makeDropShadowLayer, makeInnerShadowLayer, makeOuterGlowLayer, makeInnerGlowLayer, makeBevelLayers, makeStrokeLayer, unitPx, type GradientStop, type RgbaBuffer } from "./effects-bake.ts";

/**
 * AG3: read the 26-byte PSD header BEFORE handing the file to ag-psd.
 * `readPsd` allocates from the header's dimensions, so a 200 KB file that
 * claims 30000 × 30000 must be refused here, not after the allocation.
 * Returns null when the bytes are not a PSD at all (let the parser complain
 * with its own message) and throws when the dimensions cannot be honoured.
 */
export function checkPsdHeader(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 26) return null;
  const signature = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (signature !== "8BPS") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = view.getUint32(14, false);
  const width = view.getUint32(18, false);
  if (width > MAX_DIM || height > MAX_DIM) {
    throw new Error(
      `psd: document is too large (${width} × ${height} exceeds the ${MAX_DIM}px canvas limit)`,
    );
  }
  return { width, height };
}

// ---- structural types of a parsed PSD (subset we consume) ----------------

export interface PsdImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

export interface PsdMaskLike {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  imageData?: PsdImageDataLike;
}

/** ag-psd Color: RGB-ish object (RGBA/RGB/FRGB…) — we consume r/g/b */
export interface PsdColorLike {
  r?: number;
  g?: number;
  b?: number;
}

export interface PsdEffectShadowLike {
  enabled?: boolean;
  color?: PsdColorLike;
  opacity?: number;
  angle?: number;
  distance?: number | { value: number };
  size?: number | { value: number };
}

export interface PsdEffectFillLike {
  enabled?: boolean;
  color?: PsdColorLike;
  opacity?: number;
}

export interface PsdEffectStrokeLike {
  enabled?: boolean;
  color?: PsdColorLike;
  opacity?: number;
  size?: number | { value: number };
  position?: string;
  fillType?: string;
}

export interface PsdEffectGlowLike {
  enabled?: boolean;
  color?: PsdColorLike;
  opacity?: number;
  size?: number | { value: number };
  choke?: number | { value: number };
}

export interface PsdEffectBevelLike {
  enabled?: boolean;
  size?: number | { value: number };
  angle?: number;
  direction?: string;
  highlightColor?: PsdColorLike;
  shadowColor?: PsdColorLike;
  highlightOpacity?: number;
  shadowOpacity?: number;
}

export interface PsdEffectGradientLike {
  enabled?: boolean;
  opacity?: number;
  angle?: number;
  reverse?: boolean;
  gradient?: {
    type?: string;
    colorStops?: { color?: PsdColorLike; location?: number; midpoint?: number }[];
  };
}

/** subset of ag-psd LayerEffectsInfo consumed in stages 2+3 */
export interface PsdEffectsLike {
  disabled?: boolean;
  dropShadow?: PsdEffectShadowLike[];
  innerShadow?: PsdEffectShadowLike[];
  outerGlow?: PsdEffectGlowLike;
  innerGlow?: PsdEffectGlowLike;
  bevel?: PsdEffectBevelLike;
  solidFill?: PsdEffectFillLike[];
  gradientOverlay?: PsdEffectGradientLike[];
  stroke?: PsdEffectStrokeLike[];
}

export interface PsdFontLike {
  name?: string;
}

export interface PsdTextStyleLike {
  font?: PsdFontLike;
}

export interface PsdTextRunLike {
  style?: PsdTextStyleLike;
}

/** subset of ag-psd's LayerTextData (text layers arrive pre-rasterised) */
export interface PsdTextLike {
  text?: string;
  style?: PsdTextStyleLike;
  styleRuns?: PsdTextRunLike[];
  substitutesUsed?: boolean;
}

/** subset of ag-psd's placed-layer data (smart objects and placements) */
export interface PsdPlacedLayerLike {
  id?: string;
  type?: string;
  external?: boolean;
  placed?: string;
}

export interface PsdColorLike {
  r?: number;
  g?: number;
  b?: number;
  fr?: number;
  fg?: number;
  fb?: number;
}

/** ag-psd's colour-content layer record. Only `type:"color"` is a solid fill. */
export interface PsdVectorFillLike {
  type?: string;
  color?: PsdColorLike;
}

export interface PsdLayerLike {
  name?: string;
  blendMode?: string;
  opacity?: number;
  hidden?: boolean;
  /** Photoshop clipping layer: content shows only through the layer below */
  clipping?: boolean;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  imageData?: PsdImageDataLike;
  mask?: PsdMaskLike;
  effects?: PsdEffectsLike;
  text?: PsdTextLike;
  placedLayer?: PsdPlacedLayerLike;
  adjustment?: unknown;
  vectorFill?: PsdVectorFillLike;
  children?: PsdLayerLike[];
}

export interface PsdLike {
  width: number;
  height: number;
  children?: PsdLayerLike[];
  /** 8 for most files; >8 is read through the 8-bit imageData path and clips */
  bitsPerChannel?: number;
}

// ---- helpers --------------------------------------------------------------

/** ag-psd uses Photoshop's space-separated names ("color burn"); the engine
 *  uses kebab-case ("color-burn"). Normalized; unknown modes → normal. */
function normalizeBlend(mode: string | undefined): BlendMode {
  if (!mode) return "normal";
  const m = mode.trim().toLowerCase().replace(/\s+/g, "-");
  return (LAYER_BLEND_MODES as readonly string[]).includes(m) ? (m as BlendMode) : "normal";
}

function clampDim(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  // MAX_DIM (16384) is the real engine/WebView2 canvas limit — a bigger file
  // would allocate gigabytes of tiles and then render blank, so refuse it
  // instead of clamping to a silently-wrong partial document.
  if (n > MAX_DIM) {
    throw new Error(`psd: document is too large (${n}px exceeds the ${MAX_DIM}px canvas limit)`);
  }
  return Math.max(1, Math.min(MAX_DIM, n));
}

/** stage-1 masks: bake the mask into the layer's alpha channel.
 *  PSD masks are grayscale; black hides, white shows. */
function bakeMask(layer: Layer, mask: PsdMaskLike): void {
  const img = mask.imageData;
  if (!img || !img.data || img.width < 1 || img.height < 1) return;
  const mx = typeof mask.left === "number" ? mask.left : 0;
  const my = typeof mask.top === "number" ? mask.top : 0;
  // clip mask area to the document
  const w = Math.max(0, Math.min(img.width, layer.grid.width - mx));
  const h = Math.max(0, Math.min(img.height, layer.grid.height - my));
  if (w < 1 || h < 1 || img.data.length < img.width * img.height * 4) return;

  const buf = new Uint8ClampedArray(w * h * 4);
  layer.grid.readRect(mx, my, w, h, buf);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = img.data[(y * img.width + x) * 4]! / 255; // red channel = mask value
      const o = (y * w + x) * 4;
      buf[o + 3] = buf[o + 3]! * m;
      if (buf[o + 3] === 0) {
        buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0;
      }
    }
  }
  layer.grid.writeRect(mx, my, w, h, buf);
}

/** stage-2/3 effects: bake layer styles into the layer's pixels.
 *  Effects extend beyond the layer's pixel bounds, so the bake runs on a
 *  padded region read back from the grid; writeRect clips at doc bounds.
 *  Merge order follows Photoshop: dropShadow → outerGlow → stroke (outside
 *  band) → content (solidFill / gradientOverlay baked onto it) → innerShadow
 *  → innerGlow → bevel highlight → bevel shadow. */
function bakeEffects(layer: Layer, fx: PsdEffectsLike, left: number, top: number, w: number, h: number): boolean {
  const shadow = fx.dropShadow?.find(e => e.enabled !== false && e.color);
  const innerShadow = fx.innerShadow?.find(e => e.enabled !== false && e.color);
  const outerGlow = fx.outerGlow && fx.outerGlow.enabled !== false && fx.outerGlow.color ? fx.outerGlow : undefined;
  const innerGlow = fx.innerGlow && fx.innerGlow.enabled !== false && fx.innerGlow.color ? fx.innerGlow : undefined;
  const bevel = fx.bevel && fx.bevel.enabled !== false ? fx.bevel : undefined;
  const fill = fx.solidFill?.find(e => e.enabled !== false && e.color);
  const grad = fx.gradientOverlay?.find(e => e.enabled !== false && e.gradient?.type !== "noise" && e.gradient?.colorStops?.length);
  const stroke = fx.stroke?.find(e => e.enabled !== false && e.color && e.fillType !== "gradient" && e.fillType !== "pattern");
  if (!shadow && !innerShadow && !outerGlow && !innerGlow && !bevel && !fill && !grad && !stroke) return false;

  const sc = shadow?.color!, fc = fill?.color!, tc = stroke?.color!;
  const shadowPad = shadow ? unitPx(shadow.distance, 0) + unitPx(shadow.size, 0) : 0;
  const innerShadowPad = innerShadow ? unitPx(innerShadow.distance, 0) + unitPx(innerShadow.size, 0) : 0;
  const glowPad = outerGlow ? unitPx(outerGlow.size, 0) + unitPx(outerGlow.choke, 0) : innerGlow ? unitPx(innerGlow.size, 0) : 0;
  const bevelPad = bevel ? unitPx(bevel.size, 0) : 0;
  const strokePad = stroke ? unitPx(stroke.size, 1) : 0;
  const pad = Math.ceil(Math.max(shadowPad, innerShadowPad, glowPad, bevelPad, strokePad)) + 2;

  const pw = w + pad * 2, ph = h + pad * 2;
  // Effects sizes come from the file, so the padded buffer is attacker-sized.
  if (pw * ph > EFFECT_MAX_PIXELS) {
    throw new Error(`psd: layer effects are too large to rasterise (${pw} × ${ph})`);
  }
  const base = new Uint8ClampedArray(pw * ph * 4);
  layer.grid.readRect(left - pad, top - pad, pw, ph, base);
  let content: RgbaBuffer = { data: base, width: pw, height: ph };

  // behind-content effects
  let merged: RgbaBuffer | null = null;
  const over = (b: RgbaBuffer): void => { if (merged) compositeOver(merged, b); else merged = b; };
  if (shadow) {
    over(makeDropShadowLayer(content, {
      r: sc.r ?? 0, g: sc.g ?? 0, b: sc.b ?? 0,
      opacity: typeof shadow.opacity === "number" ? shadow.opacity : 1,
      angleDeg: typeof shadow.angle === "number" ? shadow.angle : 120,
      distance: unitPx(shadow.distance, 0),
      size: unitPx(shadow.size, 0),
    }));
  }
  if (outerGlow) {
    over(makeOuterGlowLayer(content, {
      r: outerGlow.color!.r ?? 0, g: outerGlow.color!.g ?? 0, b: outerGlow.color!.b ?? 0,
      opacity: typeof outerGlow.opacity === "number" ? outerGlow.opacity : 1,
      size: unitPx(outerGlow.size, 0),
      choke: unitPx(outerGlow.choke, 0),
    }));
  }
  if (stroke) {
    over(makeStrokeLayer(content, {
      r: tc.r ?? 0, g: tc.g ?? 0, b: tc.b ?? 0,
      opacity: typeof stroke.opacity === "number" ? stroke.opacity : 1,
      size: unitPx(stroke.size, 1),
    }));
  }

  // content with baked overlays (Color Overlay, then Gradient Overlay)
  if (fill) {
    content = bakeSolidFill(content, {
      r: fc.r ?? 0, g: fc.g ?? 0, b: fc.b ?? 0,
      opacity: typeof fill.opacity === "number" ? fill.opacity : 1,
    });
  }
  if (grad) {
    const stopsIn = grad.gradient!.colorStops ?? [];
    // Photoshop gradient locations are 0..4096 (older files sometimes 0..100)
    let maxLoc = 0;
    for (const st of stopsIn) if (typeof st.location === "number") maxLoc = Math.max(maxLoc, st.location);
    const scale = maxLoc > 100 ? 4096 : 100;
    const stops: GradientStop[] = [];
    for (const st of stopsIn) {
      if (!st.color) continue;
      const loc = typeof st.location === "number" ? Math.min(1, Math.max(0, st.location / scale)) : 0;
      stops.push({ loc, r: st.color.r ?? 0, g: st.color.g ?? 0, b: st.color.b ?? 0 });
    }
    if (stops.length) {
      content = bakeGradientOverlay(content, {
        stops,
        angleDeg: typeof grad.angle === "number" ? grad.angle : 90,
        opacity: typeof grad.opacity === "number" ? grad.opacity : 1,
        reverse: grad.reverse === true,
      });
    }
  }

  if (merged) compositeOver(merged, content);
  else merged = content; // overlays only: content dims unchanged

  // inner effects, over the content
  if (innerShadow) {
    compositeOver(merged, makeInnerShadowLayer(content, {
      r: innerShadow.color!.r ?? 0, g: innerShadow.color!.g ?? 0, b: innerShadow.color!.b ?? 0,
      opacity: typeof innerShadow.opacity === "number" ? innerShadow.opacity : 1,
      angleDeg: typeof innerShadow.angle === "number" ? innerShadow.angle : 120,
      distance: unitPx(innerShadow.distance, 0),
      size: unitPx(innerShadow.size, 0),
    }));
  }
  if (innerGlow) {
    compositeOver(merged, makeInnerGlowLayer(content, {
      r: innerGlow.color!.r ?? 0, g: innerGlow.color!.g ?? 0, b: innerGlow.color!.b ?? 0,
      opacity: typeof innerGlow.opacity === "number" ? innerGlow.opacity : 1,
      size: unitPx(innerGlow.size, 0),
      choke: unitPx(innerGlow.choke, 0),
    }));
  }
  if (bevel) {
    const b = makeBevelLayers(content, {
      size: unitPx(bevel.size, 3),
      angleDeg: typeof bevel.angle === "number" ? bevel.angle : 90,
      highlight: {
        r: bevel.highlightColor?.r ?? 255, g: bevel.highlightColor?.g ?? 255, b: bevel.highlightColor?.b ?? 255,
        opacity: typeof bevel.highlightOpacity === "number" ? bevel.highlightOpacity : 1,
      },
      shadow: {
        r: bevel.shadowColor?.r ?? 0, g: bevel.shadowColor?.g ?? 0, b: bevel.shadowColor?.b ?? 0,
        opacity: typeof bevel.shadowOpacity === "number" ? bevel.shadowOpacity : 1,
      },
      invert: bevel.direction === "down",
    });
    compositeOver(merged, b.highlight);
    compositeOver(merged, b.shadow);
  }
  layer.grid.writeRect(left - pad, top - pad, pw, ph, merged.data);
  return true;
}

function numberField(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function byteField(v: unknown, fallback: number): number {
  return Math.max(0, Math.min(255, Math.round(numberField(v) ?? fallback)));
}

/** The RGB triple of a PSD solid-colour fill, or null when the record is a
 *  gradient/pattern or a colour space this model cannot write back exactly. */
function fillColorFromVector(v: PsdVectorFillLike | undefined): [number, number, number] | null {
  if (!v || v.type !== "color" || !v.color) return null;
  const c = v.color;
  const rgb = [c.r, c.g, c.b];
  if (rgb.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [
      clampNumber(Math.round(rgb[0]!), 0, 255),
      clampNumber(Math.round(rgb[1]!), 0, 255),
      clampNumber(Math.round(rgb[2]!), 0, 255),
    ];
  }
  // ag-psd also emits float RGB (fr/fg/fb) for some colour modes.
  const frgb = [c.fr, c.fg, c.fb];
  if (frgb.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [
      clampNumber(Math.round(frgb[0]! * 255), 0, 255),
      clampNumber(Math.round(frgb[1]! * 255), 0, 255),
      clampNumber(Math.round(frgb[2]! * 255), 0, 255),
    ];
  }
  return null;
}

function fillVectorLabel(v: PsdVectorFillLike | undefined): string {
  if (!v) return "fill";
  if (v.type === "solid") return "gradient";
  if (v.type === "pattern") return "pattern";
  if (v.type === "color") return "solid fill";
  return "fill";
}

function levelsChannelIsNeutral(v: unknown): boolean {
  if (!v || typeof v !== "object") return true;
  const c = v as Record<string, unknown>;
  return byteField(c.shadowInput, 0) === 0 &&
    byteField(c.highlightInput, 255) === 255 &&
    byteField(c.shadowOutput, 0) === 0 &&
    byteField(c.highlightOutput, 255) === 255 &&
    Math.abs((numberField(c.midtoneInput) ?? 1) - 1) < 1e-9;
}

const clampNumber = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const IDENTITY_CURVE: CurvePoint[] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

function identityLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  return lut;
}

function isIdentityLut(lut: Uint8ClampedArray): boolean {
  for (let i = 0; i < 256; i++) if (lut[i] !== i) return false;
  return true;
}

function normalizeCurvePoints(points: readonly CurvePoint[]): CurvePoint[] {
  const byX = new Map<number, number>();
  for (const p of points) {
    byX.set(Math.round(clampNumber(p.x, 0, 255)), Math.round(clampNumber(p.y, 0, 255)));
  }
  return [...byX].map(([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x);
}

function composeLut(first: Uint8ClampedArray, second: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) out[i] = second[first[i]!]!;
  return out;
}

/** Approximate a 256-entry LUT with a knot set the Curves editor can draw.
 *  Greedy insertion: start from the endpoints, add the worst-fitting sample,
 *  stop at one level of error or 32 knots. `curveLut` is a monotone spline, so
 *  this is the same curve the engine renders, not a straight-line fit. */
function pointsFromLut(lut: Uint8ClampedArray): CurvePoint[] {
  if (isIdentityLut(lut)) return IDENTITY_CURVE;
  let points: CurvePoint[] = [
    { x: 0, y: lut[0] ?? 0 },
    { x: 255, y: lut[255] ?? 255 },
  ];
  for (let added = 0; added < 30; added++) {
    const current = curveLut(points);
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < 256; i++) {
      const err = Math.abs((current[i] ?? 0) - (lut[i] ?? 0));
      if (err > worst) {
        worst = err;
        worstAt = i;
      }
    }
    if (worst <= 1 || worstAt <= 0 || worstAt >= 255) break;
    if (points.some((p) => p.x === worstAt)) break;
    points = normalizeCurvePoints([...points, { x: worstAt, y: lut[worstAt] ?? 0 }]);
  }
  return points;
}

interface CurveChannel {
  lut: Uint8ClampedArray;
  /** The source knots when the file carried a point curve, so importing and
   *  re-exporting an ordinary Photoshop curve does not turn 4 knots into 256. */
  points: CurvePoint[] | null;
}

/** One PSD curve channel is either a knot list ({input,output}) or a 256-byte
 *  lookup table (`values`, the pencil tool). Keep the knot list separate from
 *  the LUT: a knot list is already the compact representation the editor wants. */
function curveChannelFromRaw(raw: unknown): CurveChannel | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { lut: identityLut(), points: IDENTITY_CURVE };
  }
  if (typeof raw[0] === "number") {
    if (raw.length !== 256) return null;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      const v = numberField(raw[i]);
      if (v === null) return null;
      lut[i] = clampNumber(Math.round(v), 0, 255);
    }
    return { lut, points: null };
  }
  const points: CurvePoint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const p = entry as Record<string, unknown>;
    const x = numberField(p.input);
    const y = numberField(p.output);
    if (x === null || y === null) return null;
    points.push({ x: clampNumber(x, 0, 255), y: clampNumber(y, 0, 255) });
  }
  const normalized = normalizeCurvePoints(points);
  if (normalized.length < 2) return null;
  return { lut: curveLut(normalized), points: normalized };
}

/** PSD applies the composite curve first, then the per-channel curve. Our
 *  model's `rgb` is only a fallback, so when both exist we fold them into one
 *  effective per-channel curve instead of dropping either stage. */
function curvesFromRecord(rec: Record<string, unknown>): AdjustSpec | null {
  const channels = Array.isArray(rec.channels) ? rec.channels : null;
  const values = Array.isArray(rec.values) ? rec.values : null;
  const source = channels && channels.length > 0 ? channels : values && values.length > 0 ? values : null;
  if (!source) return { kind: "curves", curves: { rgb: IDENTITY_CURVE } };
  const parsed: CurveChannel[] = [];
  for (const channel of source) {
    const parsedChannel = curveChannelFromRaw(channel);
    if (!parsedChannel) return null;
    parsed.push(parsedChannel);
  }
  const identity: CurveChannel = { lut: identityLut(), points: IDENTITY_CURVE };
  const composite = parsed[0] ?? identity;
  const per = [parsed[1] ?? identity, parsed[2] ?? identity, parsed[3] ?? identity] as const;
  const anyPer = per.some((channel) => !isIdentityLut(channel.lut));
  if (!anyPer) {
    if (isIdentityLut(composite.lut)) return { kind: "curves", curves: { rgb: IDENTITY_CURVE } };
    return {
      kind: "curves",
      curves: { rgb: composite.points ?? pointsFromLut(composite.lut) },
    };
  }
  return {
    kind: "curves",
    curves: {
      rgb: IDENTITY_CURVE,
      r: pointsFromLut(composeLut(composite.lut, per[0].lut)),
      g: pointsFromLut(composeLut(composite.lut, per[1].lut)),
      b: pointsFromLut(composeLut(composite.lut, per[2].lut)),
    },
  };
}

function colorTriple(v: unknown): { r: number; g: number; b: number } {
  const c = v && typeof v === "object" ? v as Record<string, unknown> : {};
  return {
    r: clampNumber(Math.round(numberField(c.r) ?? 0), 0, 255),
    g: clampNumber(Math.round(numberField(c.g) ?? 0), 0, 255),
    b: clampNumber(Math.round(numberField(c.b) ?? 0), 0, 255),
  };
}

function balanceTriple(v: unknown): { r: number; g: number; b: number } {
  const c = v && typeof v === "object" ? v as Record<string, unknown> : {};
  return {
    r: clampNumber(numberField(c.cyanRed) ?? 0, -100, 100),
    g: clampNumber(numberField(c.magentaGreen) ?? 0, -100, 100),
    b: clampNumber(numberField(c.yellowBlue) ?? 0, -100, 100),
  };
}

/** Map the adjustment records slice 1 understands onto an AdjustSpec. A null
 *  return means the record has no faithful recipe here and the caller keeps the
 *  existing blanket admission. `"admitted"` means this record was recognised,
 *  a specific field-level admission was pushed, and the caller must not add the
 *  blanket one again. Fields the model cannot carry are admitted by name on
 *  `report`; the rest of the record is still applied. */
function importAdjustmentRecord(raw: unknown, report: ImportReport, path: string): AdjustSpec | "admitted" | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  switch (rec.type) {
    case "invert":
      return { kind: "invert" };
    case "posterize": {
      const levels = Math.round(numberField(rec.levels) ?? 4);
      return { kind: "posterize", posterizeLevels: clampNumber(levels, 2, 255) };
    }
    case "threshold": {
      const level = Math.round(numberField(rec.level) ?? 128);
      return { kind: "threshold", thresholdLevel: clampNumber(level, 0, 255) };
    }
    case "curves":
      return curvesFromRecord(rec);
    case "levels": {
      const channels = Array.isArray(rec.channels) ? rec.channels : [];
      const first = channels[0];
      if (!first || typeof first !== "object") return null;
      const c = first as Record<string, unknown>;
      if (channels.slice(1).some((ch) => !levelsChannelIsNeutral(ch))) {
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: "per-channel levels are not carried; only the composite channel is kept",
        });
      }
      return {
        kind: "levels",
        levels: {
          inBlack: byteField(c.shadowInput, 0),
          inWhite: byteField(c.highlightInput, 255),
          gamma: Math.max(0.1, Math.min(9.99, numberField(c.midtoneInput) ?? 1)),
          outBlack: byteField(c.shadowOutput, 0),
          outWhite: byteField(c.highlightOutput, 255),
        },
      };
    }
    case "exposure": {
      const exposure = numberField(rec.exposure) ?? 0;
      const offset = numberField(rec.offset) ?? 0;
      const gamma = numberField(rec.gamma) ?? 1;
      if (offset !== 0 || Math.abs(gamma - 1) > 1e-9) {
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: `exposure offset and gamma are not carried (offset ${offset}, gamma ${gamma})`,
        });
      }
      return { kind: "exposure", stops: exposure };
    }
    case "vibrance": {
      const vibrance = numberField(rec.vibrance) ?? 0;
      const saturation = numberField(rec.saturation) ?? 0;
      if (saturation !== 0) {
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: `vibrance saturation ${saturation} is not carried; only vibrance is kept`,
        });
      }
      return { kind: "vibrance", amount: vibrance };
    }
    case "hue/saturation": {
      const ranges = ["reds", "yellows", "greens", "cyans", "blues", "magentas"];
      const nonZero = (v: unknown): boolean => (numberField(v) ?? 0) !== 0;
      const perRange = ranges.some((key) => {
        const ch = rec[key];
        if (!ch || typeof ch !== "object") return false;
        const c = ch as Record<string, unknown>;
        return nonZero(c.hue) || nonZero(c.saturation) || nonZero(c.lightness) ||
          nonZero(c.a) || nonZero(c.b) || nonZero(c.c) || nonZero(c.d);
      });
      const colorization = rec.colorization;
      const nonNeutralColorization = !!colorization && typeof colorization === "object" &&
        Object.values(colorization as Record<string, unknown>).some(nonZero);
      if (rec.colorize === true || nonNeutralColorization || perRange) {
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: "hue/saturation colorize and per-range channels are not carried; only the master channel is kept",
        });
      }
      const master = (rec.master && typeof rec.master === "object")
        ? rec.master as Record<string, unknown>
        : {};
      return {
        kind: "hue-sat",
        hue: numberField(master.hue) ?? 0,
        saturation: numberField(master.saturation) ?? 0,
        lightness: numberField(master.lightness) ?? 0,
      };
    }
    case "brightness/contrast": {
      if (rec.useLegacy === true) {
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: "legacy brightness/contrast maths are not carried; imported as modern brightness/contrast",
        });
      }
      return {
        kind: "brightness-contrast",
        brightness: clampNumber(numberField(rec.brightness) ?? 0, -100, 100),
        contrast: clampNumber(numberField(rec.contrast) ?? 0, -100, 100),
      };
    }
    case "photo filter": {
      const color = colorTriple(rec.color);
      return {
        kind: "photo-filter",
        photoFilter: {
          color: [color.r, color.g, color.b],
          density: clampNumber(numberField(rec.density) ?? 25, 0, 100),
          preserveLuminosity: rec.preserveLuminosity !== false,
        },
      };
    }
    case "color balance":
      return {
        kind: "color-balance",
        colorBalance: {
          shadows: balanceTriple(rec.shadows),
          midtones: balanceTriple(rec.midtones),
          highlights: balanceTriple(rec.highlights),
          preserveLuminosity: rec.preserveLuminosity !== false,
        },
      };
    case "black & white": {
      if (rec.useTint === true) {
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: "black & white tint is not carried; the six weights are kept",
        });
      }
      return {
        kind: "black-white",
        blackWhite: {
          r: clampNumber(numberField(rec.reds) ?? 40, -200, 300),
          g: clampNumber(numberField(rec.greens) ?? 40, -200, 300),
          b: clampNumber(numberField(rec.blues) ?? 40, -200, 300),
          c: clampNumber(numberField(rec.cyans) ?? 60, -200, 300),
          m: clampNumber(numberField(rec.magentas) ?? 20, -200, 300),
          y: clampNumber(numberField(rec.yellows) ?? 60, -200, 300),
        },
      };
    }
    case "channel mixer":
      report.avoided.push({
        path,
        feature: "adjustment",
        detail: "channel mixer channel weights are not carried",
      });
      return "admitted";
    case "gradient map":
      report.avoided.push({
        path,
        feature: "adjustment",
        detail: "gradient map stops are not carried",
      });
      return "admitted";
    case "color lookup":
      report.avoided.push({
        path,
        feature: "adjustment",
        detail: "color lookup table is not carried",
      });
      return "admitted";
    case "selective color":
      report.avoided.push({
        path,
        feature: "adjustment",
        detail: "selective color ranges are not carried",
      });
      return "admitted";
    default:
      return null;
  }
}

function addImportedAdjustment(
  doc: Document,
  c: PsdLayerLike,
  parent: Layer | undefined,
  spec: AdjustSpec,
  report: ImportReport,
): Layer {
  const layer = doc.addAdjustLayer(spec);
  report.layers++;
  doc.removeLayer(layer);
  doc.insertLayer(parent ?? null, layer, parent ? parent.children?.length ?? 0 : doc.layers.length);
  layer.name = c.name || layer.name;
  layer.blendMode = normalizeBlend(c.blendMode);
  layer.opacity = typeof c.opacity === "number" ? Math.min(1, Math.max(0, c.opacity)) : 1;
  layer.visible = !c.hidden;
  layer.locked = false;
  if (c.clipping) layer.clipToBelow = true;
  return layer;
}

function addImportedFill(
  doc: Document,
  c: PsdLayerLike,
  parent: Layer | undefined,
  color: [number, number, number],
  report: ImportReport,
): Layer {
  const layer = doc.addFillLayer(color);
  report.layers++;
  doc.removeLayer(layer);
  doc.insertLayer(parent ?? null, layer, parent ? parent.children?.length ?? 0 : doc.layers.length);
  layer.name = c.name || layer.name;
  layer.blendMode = normalizeBlend(c.blendMode);
  layer.opacity = typeof c.opacity === "number" ? Math.min(1, Math.max(0, c.opacity)) : 1;
  layer.visible = !c.hidden;
  layer.locked = false;
  if (c.clipping) layer.clipToBelow = true;
  return layer;
}

function addPixelLayer(
  doc: Document,
  c: PsdLayerLike,
  parent: Layer | undefined,
  report: ImportReport,
  path: string,
  suppressAdjustmentAdmission = false,
  suppressFillAdmission = false,
): Layer {
  const layer = parent
    ? doc.addLayerTo(parent, c.name || "Layer")
    : doc.addLayer(c.name || "Layer");
  report.layers++;
  layer.blendMode = normalizeBlend(c.blendMode);
  layer.opacity = typeof c.opacity === "number" ? Math.min(1, Math.max(0, c.opacity)) : 1;
  layer.visible = !c.hidden;
  layer.locked = false;
  if (c.clipping) layer.clipToBelow = true;

  const img = c.imageData;
  if (img && img.data && img.width >= 1 && img.height >= 1 && img.data.length >= img.width * img.height * 4) {
    const left = typeof c.left === "number" ? c.left : 0;
    const top = typeof c.top === "number" ? c.top : 0;
    const src = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
    layer.grid.writeRect(left, top, img.width, img.height, src);
    if (c.effects && !c.effects.disabled && bakeEffects(layer, c.effects, left, top, img.width, img.height)) {
      report.avoided.push({
        path,
        feature: "effect",
        detail: "layer effects baked into pixels; they are no longer editable",
      });
    }
  }

  if (c.text) {
    const fonts = textFonts(c);
    const fontClause = fonts.length
      ? `; font${fonts.length === 1 ? "" : "s"} ${fonts.map(f => `"${f}"`).join(", ")} ${fonts.length === 1 ? "is" : "are"} not preserved`
      : "";
    report.avoided.push({ path, feature: "text", detail: `text rasterised${fontClause}` });
    for (const font of fonts) {
      if (!report.substitutedFonts.includes(font)) report.substitutedFonts.push(font);
    }
  }
  if (c.placedLayer) {
    const placed = c.placedLayer;
    const what = placed.external ? "linked smart object" : placed.type === "vector" ? "placed vector" : "smart object";
    report.avoided.push({
      path,
      feature: "smart-object",
      detail: `${what} rasterised; the placed file is not re-editable`,
    });
  }
  if (c.adjustment && !suppressAdjustmentAdmission) {
    report.avoided.push({
      path,
      feature: "adjustment",
      detail: "live adjustment dropped; the layer keeps its position but its settings are gone",
    });
  }
  if (c.vectorFill && !suppressFillAdmission) {
    report.avoided.push({
      path,
      feature: "fill",
      detail: "live fill dropped; the layer keeps its position but its recipe is gone",
    });
  }

  if (c.mask) bakeMask(layer, c.mask);
  return layer;
}

/** First-seen font names on a text layer, used for the report's
 *  substitutedFonts list and the text admission detail. */
function textFonts(c: PsdLayerLike): string[] {
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    const font = name?.trim();
    if (font && !names.includes(font)) names.push(font);
  };
  add(c.text?.style?.font?.name);
  for (const run of c.text?.styleRuns ?? []) add(run.style?.font?.name);
  return names;
}

/** A PSD group becomes a real node with its own children, opacity, blend and
 *  pass-through flag. ag-psd leaves blendMode undefined for the default case
 *  and reports "pass through" for an explicit one; both mean the same thing. */
function addGroupLayer(doc: Document, c: PsdLayerLike, parent?: Layer): Layer {
  const group = parent
    ? doc.addGroupTo(parent, c.name || "Group")
    : doc.addGroup(c.name || "Group");
  group.blendMode = normalizeBlend(c.blendMode);
  group.opacity = typeof c.opacity === "number" ? Math.min(1, Math.max(0, c.opacity)) : 1;
  group.visible = !c.hidden;
  group.locked = false;
  const mode = (c.blendMode ?? "").trim().toLowerCase();
  group.passThrough = mode === "" || mode === "pass through";
  return group;
}

// ---- main entry ------------------------------------------------------------

/** Build a Guazzo Document from a parsed PSD (ag-psd object shape).
 *  children[0] of the psd is the BOTTOM layer; Document.layers is also
 *  bottom→top, so a straight in-order walk preserves stacking. */
export function psdToDocument(psd: PsdLike, report: ImportReport = emptyImportReport()): Document {
  const doc = new Document(clampDim(psd.width, 1), clampDim(psd.height, 1));
  if (typeof psd.bitsPerChannel === "number" && psd.bitsPerChannel > 8) {
    report.avoided.push({
      path: "-",
      feature: "bit-depth",
      detail: `${psd.bitsPerChannel}-bit channels are read as 8-bit; values above 255 clip, so the import is not a faithful copy`,
    });
  }
  const walk = (children: PsdLayerLike[] | undefined, parent: Layer | undefined, trail: string): void => {
    if (!children) return;
    for (const c of children) {
      if (c.children) {
        const name = c.name || "Group";
        const group = addGroupLayer(doc, c, parent);
        report.groups++;
        // A hidden group still keeps its subtree: hiding is a property of the
        // node, not a licence to throw the user's layers away.
        walk(c.children, group, trail ? `${trail} / ${name}` : name);
        continue;
      }
      // ag-psd synthesizes a degenerate placeholder (name "", bounds 0,0,0,0,
      // no imageData/mask) when a PSD has no layers at all — skip it.
      if (
        !c.imageData && !c.mask && !c.name && !c.hidden &&
        c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0
      ) continue;
      const name = c.name || "Layer";
      const path = trail ? `${trail} / ${name}` : name;
      const fillColor = fillColorFromVector(c.vectorFill);
      const hasEffects = !!(c.effects && !c.effects.disabled);
      if (fillColor && !c.mask && !hasEffects) {
        addImportedFill(doc, c, parent, fillColor, report);
        continue;
      }
      if (c.vectorFill) {
        report.avoided.push({
          path,
          feature: "fill",
          detail: fillColor
            ? "solid fill has a layer mask or effects; rasterised, and the live fill recipe is not carried"
            : `${fillVectorLabel(c.vectorFill)} fill is rasterised; the live fill recipe is not carried`,
        });
      }
      const spec = c.adjustment ? importAdjustmentRecord(c.adjustment, report, path) : null;
      if (spec && spec !== "admitted") {
        addImportedAdjustment(doc, c, parent, spec, report);
        continue;
      }
      addPixelLayer(doc, c, parent, report, path, spec === "admitted", c.vectorFill !== undefined);
    }
  };
  walk(psd.children, undefined, "");
  return doc;
}
