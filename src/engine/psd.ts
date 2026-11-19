/**
 * psd.ts — PSD import stage 1: parsed-PSD → Guazzo Document.
 *
 * Pure mapping, no ag-psd dependency: the caller (browser main.ts via the
 * agPsd UMD global, node tests via the real-path require) does the actual
 * parse with `{ useImageData: true }` and hands the resulting plain object
 * here. Stage 1 covers pixel layers, blend modes, opacity, visibility,
 * layer offsets and raster masks (baked into layer alpha).
 *
 * Group layers are flattened: a hidden group drops its subtree, a visible
 * group contributes its children in place (group opacity/blend ignored in
 * stage 1).
 */

/** Guard for effect-driven buffers: effects sizes come from the file, not the canvas. */
const EFFECT_MAX_PIXELS = 64_000_000;

import { Document, type Layer } from "./document.ts";
import { MAX_DIM } from "./docmeta.ts";
import { LAYER_BLEND_MODES, type BlendMode } from "./blend.ts";
import { bakeSolidFill, bakeGradientOverlay, compositeOver, makeDropShadowLayer, makeInnerShadowLayer, makeOuterGlowLayer, makeInnerGlowLayer, makeBevelLayers, makeStrokeLayer, unitPx, type GradientStop, type RgbaBuffer } from "./effects-bake.ts";

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
  children?: PsdLayerLike[];
}

export interface PsdLike {
  width: number;
  height: number;
  children?: PsdLayerLike[];
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
function bakeEffects(layer: Layer, fx: PsdEffectsLike, left: number, top: number, w: number, h: number): void {
  const shadow = fx.dropShadow?.find(e => e.enabled !== false && e.color);
  const innerShadow = fx.innerShadow?.find(e => e.enabled !== false && e.color);
  const outerGlow = fx.outerGlow && fx.outerGlow.enabled !== false && fx.outerGlow.color ? fx.outerGlow : undefined;
  const innerGlow = fx.innerGlow && fx.innerGlow.enabled !== false && fx.innerGlow.color ? fx.innerGlow : undefined;
  const bevel = fx.bevel && fx.bevel.enabled !== false ? fx.bevel : undefined;
  const fill = fx.solidFill?.find(e => e.enabled !== false && e.color);
  const grad = fx.gradientOverlay?.find(e => e.enabled !== false && e.gradient?.type !== "noise" && e.gradient?.colorStops?.length);
  const stroke = fx.stroke?.find(e => e.enabled !== false && e.color && e.fillType !== "gradient" && e.fillType !== "pattern");
  if (!shadow && !innerShadow && !outerGlow && !innerGlow && !bevel && !fill && !grad && !stroke) return;

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
}

function addPixelLayer(doc: Document, c: PsdLayerLike): void {
  const layer = doc.addLayer(c.name || "Layer");
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
    if (c.effects && !c.effects.disabled) bakeEffects(layer, c.effects, left, top, img.width, img.height);
  }
  if (c.mask) bakeMask(layer, c.mask);
}

// ---- main entry ------------------------------------------------------------

/** Build a Guazzo Document from a parsed PSD (ag-psd object shape).
 *  children[0] of the psd is the BOTTOM layer; Document.layers is also
 *  bottom→top, so a straight in-order walk preserves stacking. */
export function psdToDocument(psd: PsdLike): Document {
  const doc = new Document(clampDim(psd.width, 1), clampDim(psd.height, 1));
  const walk = (children: PsdLayerLike[] | undefined): void => {
    if (!children) return;
    for (const c of children) {
      if (c.children) {
        // group: stage 1 flattens — a hidden group hides its whole subtree
        if (!c.hidden) walk(c.children);
        continue;
      }
      // ag-psd synthesizes a degenerate placeholder (name "", bounds 0,0,0,0,
      // no imageData/mask) when a PSD has no layers at all — skip it.
      if (
        !c.imageData && !c.mask && !c.name && !c.hidden &&
        c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0
      ) continue;
      addPixelLayer(doc, c);
    }
  };
  walk(psd.children);
  return doc;
}
