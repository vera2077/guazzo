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

/**
 * Handoff 9 P0.4: an untrusted PSD can describe far more layer pixels than
 * the document ever contains. The app's own maximum canvas is 16384², which is
 * 1.07 GB in RGBA, so a 512 MB cap refused a file Guazzo itself can export.
 * 1.5 GiB leaves room for one full-canvas layer and its tile overhead while
 * staying bounded; larger documents (or several full layers) are still refused
 * before this module allocates a Document or a walk.
 */
export const PSD_MEMORY_LIMIT = 1536 * 1024 * 1024;
/** Same ceiling as the project loader: a PSD is a project source too. */
export const PSD_MAX_LAYERS = 2000;

import { Document, type Layer, type TextLayerMeta, type TextSeg } from "./document.ts";
import type { AdjustSpec } from "./adjustfn.ts";
import { curveLut, sortMapStops, type CurvePoint, type MapStop } from "./tone.ts";
import { emptyImportReport, type ImportReport } from "./importreport.ts";
import { normalizeSelective } from "./selective.ts";
import { parseCube } from "./lookuptable.ts";
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
  fontSize?: number;
  fauxBold?: boolean;
  fauxItalic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fillColor?: PsdColorLike;
}

export interface PsdTextRunLike {
  length?: number;
  style?: PsdTextStyleLike;
}

export interface PsdParagraphStyleLike {
  justification?: string;
}

export interface PsdParagraphStyleRunLike {
  length?: number;
  style?: PsdParagraphStyleLike;
}

export interface PsdTextBoundsLike {
  top?: { value?: number } | number;
  left?: { value?: number } | number;
  right?: { value?: number } | number;
  bottom?: { value?: number } | number;
}

/** subset of ag-psd's LayerTextData. The raster comes from imageData; this
 *  recipe is what lets a PSD text layer be edited again instead of merely
 *  displaying its baked pixels. */
export interface PsdTextLike {
  text?: string;
  style?: PsdTextStyleLike;
  styleRuns?: PsdTextRunLike[];
  paragraphStyle?: PsdParagraphStyleLike;
  paragraphStyleRuns?: PsdParagraphStyleRunLike[];
  substitutesUsed?: boolean;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  boxBounds?: number[];
  shapeType?: string;
  /** PSD anchor transform: [xx, xy, yx, yy, tx, ty]. Translation alone does
   *  not invalidate an axis-aligned recipe; rotation and shear do. */
  transform?: number[];
  warp?: unknown;
  textOnPath?: unknown;
  orientation?: string;
  bounds?: PsdTextBoundsLike;
}

/** Optional engine-side font lookup. `main.ts` supplies one backed by the
 *  browser FontFace set; tests can force a miss without any DOM. */
export interface PsdImportOptions {
  resolveFont?: (family: string) => string | null;
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

/** One channel-mixer output from a PSD record; missing weights mean identity. */
function mixChannel(raw: unknown): { r: number; g: number; b: number; constant: number } {
  const rec = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    r: clampNumber(numberField(rec.red) ?? 0, -200, 200),
    g: clampNumber(numberField(rec.green) ?? 0, -200, 200),
    b: clampNumber(numberField(rec.blue) ?? 0, -200, 200),
    constant: clampNumber(numberField(rec.constant) ?? 0, -200, 200),
  };
}

function numberField(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function byteField(v: unknown, fallback: number): number {
  return Math.max(0, Math.min(255, Math.round(numberField(v) ?? fallback)));
}

/** PSD colour record to an 8-bit RGB triple. Handles integer RGB and the
 *  float variant ag-psd emits for some colour modes. */
function rgbFromPsdColor(c: PsdColorLike | undefined): [number, number, number] | null {
  if (!c) return null;
  const rgb = [c.r, c.g, c.b];
  if (rgb.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [
      clampNumber(Math.round(rgb[0]!), 0, 255),
      clampNumber(Math.round(rgb[1]!), 0, 255),
      clampNumber(Math.round(rgb[2]!), 0, 255),
    ];
  }
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

/** The RGB triple of a PSD solid-colour fill, or null when the record is a
 *  gradient/pattern or a colour space this model cannot write back exactly. */
function fillColorFromVector(v: PsdVectorFillLike | undefined): [number, number, number] | null {
  return v?.type === "color" ? rgbFromPsdColor(v.color) : null;
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
          feature: "adjustment-partial",
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
    case "channel mixer": {
      const mixer: NonNullable<AdjustSpec["mixer"]> = {
        red: mixChannel(rec.red),
        green: mixChannel(rec.green),
        blue: mixChannel(rec.blue),
      };
      if (rec.monochrome === true) mixer.gray = mixChannel(rec.gray);
      return { kind: "channel-mixer", mixer };
    }
    case "selective color": {
      const ranges: Record<string, { c: number; m: number; y: number; k: number }> = {};
      for (const key of ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"]) {
        const v = (rec as unknown as Record<string, unknown>)[key];
        if (!v || typeof v !== "object") continue;
        const e = v as Record<string, unknown>;
        ranges[key] = {
          c: typeof e.c === "number" ? e.c : 0,
          m: typeof e.m === "number" ? e.m : 0,
          y: typeof e.y === "number" ? e.y : 0,
          k: typeof e.k === "number" ? e.k : 0,
        };
      }
      return {
        kind: "selective-colour",
        selective: normalizeSelective({ mode: rec.mode ?? "relative", ranges }),
      };
    }
    case "gradient map": {
      if (rec.gradientType === "noise") {
        // One admission, not two: the noise record has no stop list, and
        // reporting "no readable stops" afterwards would describe the same
        // loss twice.
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: "a noise gradient is not carried; the layer is imported as its colour ramp",
        });
        return { kind: "gradient-map" };
      }
      const raw = Array.isArray(rec.colorStops) ? rec.colorStops : [];
      const stops: MapStop[] = [];
      for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const stop = entry as Record<string, unknown>;
        const color = colorTriple(stop.color);
        const location = numberField(stop.location);
        if (location === null) continue;
        stops.push({
          pos: Math.max(0, Math.min(1, location)),
          color: [color.r, color.g, color.b],
        });
      }
      if (stops.length < 2) {
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: "gradient map had no readable colour stops; the layer keeps its position",
        });
        return { kind: "gradient-map" };
      }
      // Photoshop may write both ends of the ramp at the same location; the
      // sort keeps the record's order and the sampler holds the end colours.
      return { kind: "gradient-map", map: sortMapStops(stops) };
    }
    case "color lookup": {
      const cubeData = rec.lut3DFileData as Uint8Array | undefined;
      const hasCube = rec.lutFormat === "cube" && cubeData instanceof Uint8Array && cubeData.length > 0;
      if (hasCube && cubeData) {
        const text = new TextDecoder("utf-8").decode(cubeData);
        const parsed = parseCube(text, String(rec.lut3DFileName ?? rec.name ?? "Lookup"));
        if (parsed.table) return { kind: "color-lookup", lookup: parsed.table };
        report.avoided.push({
          path,
          feature: "adjustment",
          detail: `colour lookup table could not be read (${parsed.error ?? "unknown error"}); the layer keeps its position`,
        });
        return "admitted";
      }
      report.avoided.push({
        path,
        feature: "adjustment",
        detail:
          rec.lookupType === "abstractProfile" || rec.lookupType === "deviceLinkProfile"
            ? "colour lookup profile (abstract/device-link) is not carried"
            : "colour lookup table is not carried",
      });
      return "admitted";
    }
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
  textData?: TextLayerMeta,
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

  if (textData) layer.textData = textData;
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

/** PSD font names carry style suffixes ("Arial-BoldMT"). The model stores a
 *  family name; weight/italic are separate flags. */
function fontFamilyFromPsdName(name: string): string {
  const raw = name.trim() || "Arial";
  const family = raw
    .replace(/-(Bold|Italic|BoldItalic|Regular|Light|Medium|SemiBold|Semibold|Black|Heavy|Oblique)(?:MT|PS)?$/i, "")
    .replace(/(?:MT|PS)$/i, "");
  return family.trim() || raw;
}

function isBoldFontName(name: string): boolean {
  return /bold|black|heavy|semibold|demi/i.test(name);
}

function isItalicFontName(name: string): boolean {
  return /italic|oblique/i.test(name);
}

function textAlignFromJustification(justification: string | undefined): TextLayerMeta["align"] {
  switch (justification) {
    case "center": return "center";
    case "right": return "right";
    case "justify-left":
    case "justify-right":
    case "justify-center":
    case "justify-all":
      return "justify";
    default:
      return undefined;
  }
}

function textAdmission(
  report: ImportReport,
  path: string,
  feature: ImportReport["avoided"][number]["feature"],
  detail: string,
): void {
  report.avoided.push({ path, feature, detail });
}

/** A rotated or sheared anchor cannot be carried by an axis-aligned text box.
 *  Translation is fine: the recipe stores x/y from the layer bounds. */
function textTransformIsAxisAligned(t: PsdTextLike | undefined): boolean {
  const m = t?.transform;
  if (!m || m.length < 4) return true;
  const [xx = 1, xy = 0, yx = 0, yy = 1] = m;
  return Math.abs(xx - 1) <= 1e-4
    && Math.abs(xy) <= 1e-4
    && Math.abs(yx) <= 1e-4
    && Math.abs(yy - 1) <= 1e-4;
}

function textBoundsNumber(v: { value?: number } | number | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return typeof v?.value === "number" && Number.isFinite(v.value) ? v.value : null;
}

/** ag-psd writes a default `warp: { style: "none" }` for ordinary point text.
 *  That is an absence, not a warp the importer must refuse. Custom warp data
 *  without a style is still a warp. */
function textHasWarp(t: PsdTextLike | undefined): boolean {
  const w = t?.warp as { style?: string; values?: number[]; customEnvelopeWarp?: unknown } | undefined;
  if (!w) return false;
  if (typeof w.style === "string") return w.style !== "none";
  return w.customEnvelopeWarp !== undefined || (Array.isArray(w.values) && w.values.length > 0);
}

/** The box frame of a text layer, if the file carries one. A `shapeType:"box"`
 *  record names its rectangle in `boxBounds` as `[x, y, width, height]`; trust
 *  that direct reading instead of guessing from the ink. Files without shape
 *  hints fall back to named `bounds`, then to the old ambiguous tie-break (some
 *  exporters wrote `[left,top,right,bottom]` into `boxBounds`). */
function textBoxFrame(
  t: PsdTextLike | undefined,
  inkWidth: number,
): { width: number; height: number | null } | null {
  const bb = t?.boxBounds;
  if (t?.shapeType === "box" && Array.isArray(bb) && bb.length >= 4) {
    const width = bb[2] ?? 0;
    const height = bb[3] ?? 0;
    if (Number.isFinite(width) && width > 0.5) {
      return { width, height: Number.isFinite(height) && height > 0.5 ? height : null };
    }
  }

  const right = textBoundsNumber(t?.bounds?.right);
  const left = textBoundsNumber(t?.bounds?.left);
  if (right !== null && left !== null && right - left > 0.5) {
    const top = textBoundsNumber(t?.bounds?.top);
    const bottom = textBoundsNumber(t?.bounds?.bottom);
    const height = top !== null && bottom !== null && bottom - top > 0.5 ? bottom - top : null;
    return { width: right - left, height };
  }

  // A box shape with neither boxBounds nor named bounds has no declared width;
  // the ink is only the line lengths, so do not pretend it is the wrap.
  if (t?.shapeType === "box") return null;
  if (Array.isArray(bb) && bb.length >= 4) {
    const third = bb[2] ?? 0;
    const first = bb[0] ?? 0;
    const candidates = [third, third - first].filter(w => Number.isFinite(w) && w > 0.5);
    if (candidates.length > 0) {
      const width = inkWidth > 0.5
        ? candidates.reduce((best, w) => Math.abs(w - inkWidth) < Math.abs(best - inkWidth) ? w : best)
        : candidates[0]!;
      return { width, height: null };
    }
    if (inkWidth > 0.5) return { width: inkWidth, height: null };
  }
  return null;
}

/** P4.5: a 100 MB PSD must not become a multi-GB per-character style array. */
const MAX_TEXT_CHARS = 2_000_000;
const MAX_TEXT_RUNS = 4096;

/** Build the editable text recipe from PSD style runs. Pixels stay the
 *  rasterised imageData; the recipe is what lets the layer be re-edited. */
function importTextData(
  c: PsdLayerLike,
  report: ImportReport,
  path: string,
  options: PsdImportOptions,
): TextLayerMeta | null {
  const t = c.text;
  const raw = t?.text ?? "";
  if (!raw.trim()) return null;

  if (!textTransformIsAxisAligned(t)) {
    textAdmission(report, path, "text-transform",
      "rotated, skewed or scaled text is kept as pixels; an editable recipe would be axis-aligned");
    return null;
  }
  if (textHasWarp(t)) {
    textAdmission(report, path, "text-warp", "warped text is kept as pixels; the warp is not represented");
    return null;
  }
  if (t?.textOnPath !== undefined) {
    textAdmission(report, path, "text-on-path", "text on a path is kept as pixels; the path is not represented");
    return null;
  }
  if (t?.orientation === "vertical") {
    textAdmission(report, path, "text-vertical", "vertical text is kept as pixels; the model has no vertical writing mode");
    return null;
  }

  // P4.5: the text and its run list are untrusted. Intervals keep this O(runs)
  // instead of one cloned style object per character, and a cap refuses a
  // recipe that would materialise a huge array we cannot justify.
  if (raw.length > MAX_TEXT_CHARS || (t?.styleRuns?.length ?? 0) > MAX_TEXT_RUNS) {
    textAdmission(report, path, "text-runs",
      "text is too long or has too many style runs for an editable recipe; pixels are kept");
    return null;
  }

  const base = t?.style ?? {};
  const baseSize = Math.max(1, base.fontSize ?? 24);
  const baseColor = rgbFromPsdColor(base.fillColor) ?? [0, 0, 0];
  const intervals: Array<{ end: number; style: PsdTextStyleLike }> = [];
  let at = 0;
  for (const run of t?.styleRuns ?? []) {
    const len = Math.max(0, Math.floor(run.length ?? 0));
    if (len === 0) continue;
    const end = Math.min(raw.length, at + len);
    if (end > at) intervals.push({ end, style: { ...base, ...(run.style ?? {}) } });
    at = end;
  }
  if (at < raw.length) intervals.push({ end: raw.length, style: base });

  const noteMissing = (family: string): void => {
    if (!report.substitutedFonts.includes(family)) report.substitutedFonts.push(family);
  };

  const lines: TextSeg[][] = [[]];
  let current: TextSeg | null = null;
  let currentKey = "";
  let interval = 0;
  let style = intervals[0]?.style ?? base;
  for (let i = 0; i < raw.length; i++) {
    while (interval < intervals.length && i >= intervals[interval]!.end) {
      interval++;
      style = intervals[interval]?.style ?? base;
    }
    const ch = raw[i]!;
    if (ch === "\r" || ch === "\n") {
      // Photoshop writes paragraph breaks as \r; tolerate \r\n and \n too.
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      lines.push([]);
      current = null;
      continue;
    }
    const psdName = (style.font?.name ?? "Arial").trim() || "Arial";
    const family = fontFamilyFromPsdName(psdName);
    const resolved = options.resolveFont ? options.resolveFont(family) : family;
    const font = resolved?.trim() || "Arial";
    if (!resolved) noteMissing(family);
    const bold = style.fauxBold === true || isBoldFontName(psdName);
    const italic = style.fauxItalic === true || isItalicFontName(psdName);
    const underline = style.underline === true;
    const strike = style.strikethrough === true;
    // A run that differs from the layer's own size/colour keeps its own, so the
    // raster matches the PSD instead of collapsing to one style.
    const runSize = typeof style.fontSize === "number" && Math.abs(style.fontSize - baseSize) > 0.5
      ? clampNumber(Math.round(style.fontSize), 1, 1000)
      : null;
    const runColorRaw = rgbFromPsdColor(style.fillColor);
    const runColor = runColorRaw && (
      Math.abs(runColorRaw[0] - baseColor[0]) > 1
      || Math.abs(runColorRaw[1] - baseColor[1]) > 1
      || Math.abs(runColorRaw[2] - baseColor[2]) > 1
    ) ? runColorRaw : null;
    const key = `${font}\u0000${bold}\u0000${italic}\u0000${underline}\u0000${strike}\u0000${runSize ?? ""}\u0000${runColor ? runColor.join(",") : ""}`;
    if (current && currentKey === key) {
      current.text += ch;
    } else {
      current = {
        text: ch, bold, italic, underline, strike, font,
        ...(runSize !== null ? { size: runSize } : {}),
        ...(runColor ? { color: [runColor[0], runColor[1], runColor[2]] as [number, number, number] } : {}),
      };
      currentKey = key;
      lines[lines.length - 1]!.push(current);
    }
  }
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();

  const left = numberField(c.left) ?? numberField(t?.left) ?? 0;
  const top = numberField(c.top) ?? numberField(t?.top) ?? 0;
  const right = numberField(c.right) ?? numberField(t?.right);
  const bottom = numberField(c.bottom) ?? numberField(t?.bottom);
  const img = c.imageData;
  const w = right !== null && right > left ? right - left : (img?.width ?? 0);
  const h = bottom !== null && bottom > top ? bottom - top : (img?.height ?? 0);

  const justification = t?.paragraphStyle?.justification;
  if (justification === "justify-center" || justification === "justify-right" || justification === "justify-all") {
    textAdmission(report, path, "text-justify",
      "justified last-line alignment is not carried; the last line uses the default alignment");
  }
  if ((t?.paragraphStyleRuns?.length ?? 0) > 0) {
    textAdmission(report, path, "text-paragraph-runs",
      "per-run paragraph styles are not carried; only the base paragraph style is kept");
  }
  if (c.effects && !c.effects.disabled && img) {
    textAdmission(report, path, "text-effects",
      "layer effects are baked into pixels; editing the text will not recreate them");
  }

  let wrap: number | undefined;
  let boxH: number | undefined;
  if (t?.shapeType === "box") {
    const frame = textBoxFrame(t, img?.width ?? 0);
    if (frame === null) {
      textAdmission(report, path, "text-wrap",
        "line breaks are kept; Guazzo recomputes wrapping");
    } else {
      wrap = Math.max(1, Math.round(frame.width));
      if (frame.height !== null) boxH = Math.max(1, Math.round(frame.height));
    }
  }

  return {
    lines,
    x: Math.round(left),
    y: Math.round(top),
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h)),
    ...(wrap !== undefined ? { wrap } : {}),
    ...(boxH !== undefined ? { boxH } : {}),
    size: clampNumber(Math.round(baseSize), 1, 1000),
    color: baseColor,
    align: textAlignFromJustification(justification),
  };
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

/** Handoff 9 P0.4: the PSD header bounds the document, not the layer rects.
 *  Walk the parsed tree and refuse an import whose layer rectangles alone
 *  would exceed the budget, before Document allocates its first tile. */
function guardPsdBudget(psd: PsdLike): void {
  let layers = 0;
  let bytes = 0;
  const walk = (children: PsdLayerLike[] | undefined, trail: string): void => {
    for (const c of children ?? []) {
      layers++;
      const name = c.name || "Layer";
      const path = trail ? `${trail} / ${name}` : name;
      if (layers > PSD_MAX_LAYERS) {
        throw new Error(`psd: ${layers} layers exceed the ${PSD_MAX_LAYERS}-layer import limit`);
      }
      const { left, top, right, bottom } = c;
      if (
        typeof left === "number" && Number.isFinite(left) &&
        typeof top === "number" && Number.isFinite(top) &&
        typeof right === "number" && Number.isFinite(right) &&
        typeof bottom === "number" && Number.isFinite(bottom)
      ) {
        const w = Math.max(0, Math.floor(right - left));
        const h = Math.max(0, Math.floor(bottom - top));
        bytes += w * h * 4;
        if (bytes > PSD_MEMORY_LIMIT) {
          const mb = Math.ceil(bytes / (1024 * 1024));
          const limit = (PSD_MEMORY_LIMIT / (1024 * 1024 * 1024)).toFixed(1);
          throw new Error(
            `psd: layer data exceeds the ${limit} GB import limit (${mb} MB at "${path}")`,
          );
        }
      }
      if (c.children) walk(c.children, path);
    }
  };
  walk(psd.children, "");
}

// ---- main entry ------------------------------------------------------------

/** Build a Guazzo Document from a parsed PSD (ag-psd object shape).
 *  children[0] of the psd is the BOTTOM layer; Document.layers is also
 *  bottom→top, so a straight in-order walk preserves stacking. */
export function psdToDocument(
  psd: PsdLike,
  report: ImportReport = emptyImportReport(),
  options: PsdImportOptions = {},
): Document {
  guardPsdBudget(psd);
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
      const textData = c.text ? importTextData(c, report, path, options) ?? undefined : undefined;
      addPixelLayer(doc, c, parent, report, path, textData, spec === "admitted", c.vectorFill !== undefined);
    }
  };
  walk(psd.children, undefined, "");
  return doc;
}
