/**
 * effects.ts — Photoshop layer styles as data, rendered at composite time.
 *
 * The effect maths lives in effects-bake.ts; this module owns the recipe
 * (what the panel and the PSD record agree on) and the order in which the
 * effect buffers are stacked. Keeping the order here means the importer, the
 * exporter and the canvas cannot disagree about what a style looks like.
 *
 * Render order follows Photoshop: dropShadow → outerGlow → stroke (outside
 * band) → content (solidFill, then gradientOverlay baked onto it) →
 * innerShadow → innerGlow → bevel highlight → bevel shadow.
 */

import {
  bakeGradientOverlay,
  bakeSolidFill,
  compositeOver,
  makeBevelLayers,
  makeDropShadowLayer,
  makeInnerGlowLayer,
  makeInnerShadowLayer,
  makeOuterGlowLayer,
  makeStrokeLayer,
  unitPx,
  type GradientStop,
  type RgbaBuffer,
} from "./effects-bake.ts";

export interface EffectColor {
  r?: number;
  g?: number;
  b?: number;
}

export interface EffectShadow {
  enabled?: boolean;
  color?: EffectColor;
  opacity?: number;
  angle?: number;
  distance?: number | { value: number };
  size?: number | { value: number };
}

export interface EffectGlow {
  enabled?: boolean;
  color?: EffectColor;
  opacity?: number;
  size?: number | { value: number };
  choke?: number | { value: number };
}

export interface EffectFill {
  enabled?: boolean;
  color?: EffectColor;
  opacity?: number;
}

export interface EffectStroke {
  enabled?: boolean;
  color?: EffectColor;
  opacity?: number;
  size?: number | { value: number };
  fillType?: string;
}

export interface EffectGradientStop {
  color?: EffectColor;
  location?: number;
}

export interface EffectGradient {
  enabled?: boolean;
  opacity?: number;
  angle?: number;
  reverse?: boolean;
  type?: string;
  gradient?: { colorStops?: EffectGradientStop[]; type?: string };
}

export interface EffectBevel {
  enabled?: boolean;
  size?: number | { value: number };
  angle?: number;
  direction?: string;
  highlightColor?: EffectColor;
  highlightOpacity?: number;
  shadowColor?: EffectColor;
  shadowOpacity?: number;
}

/** The subset of a Photoshop layer-style record Guazzo renders and writes. */
export interface LayerEffects {
  disabled?: boolean;
  dropShadow?: EffectShadow[];
  innerShadow?: EffectShadow[];
  outerGlow?: EffectGlow;
  innerGlow?: EffectGlow;
  bevel?: EffectBevel;
  solidFill?: EffectFill[];
  gradientOverlay?: EffectGradient[];
  stroke?: EffectStroke[];
}

const EFFECT_MAX_PIXELS = 64_000_000;

function numberOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function colourOf(v: unknown): EffectColor | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  const r = numberOf(c.r), g = numberOf(c.g), b = numberOf(c.b);
  if (r === undefined && g === undefined && b === undefined) return undefined;
  return { r, g, b };
}

function passNumber<K extends string>(out: Record<string, unknown>, src: Record<string, unknown>, key: K): void {
  const n = numberOf(src[key]);
  if (n !== undefined) out[key] = n;
}

/**
 * Sizes arrive as ag-psd `UnitsValue` objects. The recipe stores plain pixels
 * so the renderer, the panel and the exporter read one number, not three shapes.
 */
function passUnit(out: Record<string, unknown>, src: Record<string, unknown>, key: string): void {
  const n = unitPx(src[key] as number | { value: number } | undefined, Number.NaN);
  if (Number.isFinite(n)) out[key] = n;
}

function normalizeShadow(v: unknown): EffectShadow | null {
  if (!v || typeof v !== "object") return null;
  const src = v as Record<string, unknown>;
  const out: EffectShadow = {};
  if (src.enabled === false) out.enabled = false;
  const color = colourOf(src.color);
  if (color) out.color = color;
  passNumber(out as unknown as Record<string, unknown>, src, "opacity");
  passNumber(out as unknown as Record<string, unknown>, src, "angle");
  passUnit(out as unknown as Record<string, unknown>, src, "distance");
  passUnit(out as unknown as Record<string, unknown>, src, "size");
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeGlow(v: unknown): EffectGlow | null {
  if (!v || typeof v !== "object") return null;
  const src = v as Record<string, unknown>;
  const out: EffectGlow = {};
  if (src.enabled === false) out.enabled = false;
  const color = colourOf(src.color);
  if (color) out.color = color;
  passNumber(out as unknown as Record<string, unknown>, src, "opacity");
  passUnit(out as unknown as Record<string, unknown>, src, "size");
  passUnit(out as unknown as Record<string, unknown>, src, "choke");
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Accepts ag-psd's effects record and returns the recipe Guazzo stores.
 * Unknown effect kinds are dropped rather than half-rendered; a null return
 * means the layer has no styles worth carrying.
 */
export function normalizeLayerEffects(raw: unknown): LayerEffects | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: LayerEffects = {};

  const shadows = (v: unknown): EffectShadow[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const list = v.map(normalizeShadow).filter((e): e is EffectShadow => !!e);
    return list.length > 0 ? list : undefined;
  };
  const dropShadow = shadows(src.dropShadow);
  if (dropShadow) out.dropShadow = dropShadow;
  const innerShadow = shadows(src.innerShadow);
  if (innerShadow) out.innerShadow = innerShadow;

  const outerGlow = normalizeGlow(src.outerGlow);
  if (outerGlow) out.outerGlow = outerGlow;
  const innerGlow = normalizeGlow(src.innerGlow);
  if (innerGlow) out.innerGlow = innerGlow;

  if (src.bevel && typeof src.bevel === "object") {
    const b = src.bevel as Record<string, unknown>;
    const bevel: EffectBevel = {};
    if (b.enabled === false) bevel.enabled = false;
    passUnit(bevel as unknown as Record<string, unknown>, b, "size");
    passNumber(bevel as unknown as Record<string, unknown>, b, "angle");
    if (typeof b.direction === "string") bevel.direction = b.direction;
    const hc = colourOf(b.highlightColor);
    if (hc) bevel.highlightColor = hc;
    passNumber(bevel as unknown as Record<string, unknown>, b, "highlightOpacity");
    const sc = colourOf(b.shadowColor);
    if (sc) bevel.shadowColor = sc;
    passNumber(bevel as unknown as Record<string, unknown>, b, "shadowOpacity");
    if (Object.keys(bevel).length > 0) out.bevel = bevel;
  }

  if (Array.isArray(src.solidFill)) {
    const fills = src.solidFill.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const f = v as Record<string, unknown>;
      const fill: EffectFill = {};
      if (f.enabled === false) fill.enabled = false;
      const color = colourOf(f.color);
      if (color) fill.color = color;
      passNumber(fill as unknown as Record<string, unknown>, f, "opacity");
      return Object.keys(fill).length > 0 ? [fill] : [];
    });
    if (fills.length > 0) out.solidFill = fills;
  }

  if (Array.isArray(src.gradientOverlay)) {
    const grads = src.gradientOverlay.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const g = v as Record<string, unknown>;
      const grad: EffectGradient = {};
      if (g.enabled === false) grad.enabled = false;
      passNumber(grad as unknown as Record<string, unknown>, g, "opacity");
      passNumber(grad as unknown as Record<string, unknown>, g, "angle");
      if (g.reverse === true) grad.reverse = true;
      if (typeof g.type === "string") grad.type = g.type;
      const gradient = g.gradient && typeof g.gradient === "object" ? g.gradient as Record<string, unknown> : null;
      if (gradient) {
        if (typeof gradient.type === "string") grad.gradient = { type: gradient.type };
        const rawStops = Array.isArray(gradient.colorStops) ? gradient.colorStops : [];
        const stops = rawStops.flatMap((s) => {
          if (!s || typeof s !== "object") return [];
          const st = s as Record<string, unknown>;
          const color = colourOf(st.color);
          const location = numberOf(st.location);
          if (!color) return [];
          const stop: EffectGradientStop = { color };
          if (location !== undefined) stop.location = location;
          return [stop];
        });
        if (stops.length > 0) grad.gradient = { ...(grad.gradient ?? {}), colorStops: stops };
      }
      return Object.keys(grad).length > 0 ? [grad] : [];
    });
    if (grads.length > 0) out.gradientOverlay = grads;
  }

  if (Array.isArray(src.stroke)) {
    const strokes = src.stroke.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const s = v as Record<string, unknown>;
      const stroke: EffectStroke = {};
      if (s.enabled === false) stroke.enabled = false;
      const color = colourOf(s.color);
      if (color) stroke.color = color;
      passNumber(stroke as unknown as Record<string, unknown>, s, "opacity");
      passUnit(stroke as unknown as Record<string, unknown>, s, "size");
      if (typeof s.fillType === "string") stroke.fillType = s.fillType;
      return Object.keys(stroke).length > 0 ? [stroke] : [];
    });
    if (strokes.length > 0) out.stroke = strokes;
  }

  if (src.disabled === true) out.disabled = true;
  return Object.keys(out).length > 0 ? out : null;
}

function isOn(e: { enabled?: boolean }): boolean {
  return e.enabled !== false;
}

/** How far the rendered style can reach beyond the layer's own pixels. */
export function effectPadding(fx: LayerEffects): number {
  const shadow = fx.dropShadow?.find((e) => isOn(e) && e.color);
  const innerShadow = fx.innerShadow?.find((e) => isOn(e) && e.color);
  const outerGlow = fx.outerGlow && isOn(fx.outerGlow) && fx.outerGlow.color ? fx.outerGlow : undefined;
  const innerGlow = fx.innerGlow && isOn(fx.innerGlow) && fx.innerGlow.color ? fx.innerGlow : undefined;
  const bevel = fx.bevel && isOn(fx.bevel) ? fx.bevel : undefined;
  const stroke = fx.stroke?.find((e) => isOn(e) && e.color && e.fillType !== "gradient" && e.fillType !== "pattern");
  const shadowPad = shadow ? unitPx(shadow.distance, 0) + unitPx(shadow.size, 0) : 0;
  const innerShadowPad = innerShadow ? unitPx(innerShadow.distance, 0) + unitPx(innerShadow.size, 0) : 0;
  const glowPad = outerGlow ? unitPx(outerGlow.size, 0) + unitPx(outerGlow.choke, 0)
    : innerGlow ? unitPx(innerGlow.size, 0) : 0;
  const bevelPad = bevel ? unitPx(bevel.size, 0) : 0;
  const strokePad = stroke ? unitPx(stroke.size, 1) : 0;
  return Math.ceil(Math.max(shadowPad, innerShadowPad, glowPad, bevelPad, strokePad));
}

/** ag-psd writes sizes as `{ units, value }`; the recipe stores plain pixels. */
function unitOut(v: number | { value: number } | undefined): { units: "Pixels"; value: number } | undefined {
  const n = unitPx(v, -1);
  return n < 0 ? undefined : { units: "Pixels", value: n };
}

/**
 * Convert the recipe back to the shape ag-psd writes. The import path normalises
 * away `present`/`units`, so export has to put them back or Photoshop reads a
 * style with zero reach.
 */
export function toAgEffects(fx: LayerEffects): Record<string, unknown> {
  const out: Record<string, unknown> = { disabled: fx.disabled === true };
  const shadowOut = (e: EffectShadow): Record<string, unknown> => ({
    present: true,
    enabled: e.enabled !== false,
    color: e.color,
    opacity: e.opacity,
    angle: e.angle,
    distance: unitOut(e.distance),
    size: unitOut(e.size),
  });
  if (fx.dropShadow?.length) out.dropShadow = fx.dropShadow.map(shadowOut);
  if (fx.innerShadow?.length) out.innerShadow = fx.innerShadow.map(shadowOut);
  if (fx.outerGlow) {
    out.outerGlow = {
      present: true, enabled: fx.outerGlow.enabled !== false, color: fx.outerGlow.color,
      opacity: fx.outerGlow.opacity, size: unitOut(fx.outerGlow.size), choke: unitOut(fx.outerGlow.choke),
    };
  }
  if (fx.innerGlow) {
    out.innerGlow = {
      present: true, enabled: fx.innerGlow.enabled !== false, color: fx.innerGlow.color,
      opacity: fx.innerGlow.opacity, size: unitOut(fx.innerGlow.size), choke: unitOut(fx.innerGlow.choke),
    };
  }
  if (fx.bevel) {
    out.bevel = {
      present: true, enabled: fx.bevel.enabled !== false, size: unitOut(fx.bevel.size),
      angle: fx.bevel.angle, direction: fx.bevel.direction,
      highlightColor: fx.bevel.highlightColor, highlightOpacity: fx.bevel.highlightOpacity,
      shadowColor: fx.bevel.shadowColor, shadowOpacity: fx.bevel.shadowOpacity,
    };
  }
  if (fx.solidFill?.length) {
    out.solidFill = fx.solidFill.map((e) => ({
      present: true, enabled: e.enabled !== false, color: e.color, opacity: e.opacity,
    }));
  }
  if (fx.gradientOverlay?.length) {
    out.gradientOverlay = fx.gradientOverlay.map((e) => ({
      present: true, enabled: e.enabled !== false, opacity: e.opacity, angle: e.angle,
      reverse: e.reverse, type: e.type,
      gradient: e.gradient ? {
        type: e.gradient.type,
        colorStops: e.gradient.colorStops?.map((st) => ({ color: st.color, location: st.location })),
      } : undefined,
    }));
  }
  if (fx.stroke?.length) {
    out.stroke = fx.stroke.map((e) => ({
      present: true, enabled: e.enabled !== false, color: e.color, opacity: e.opacity,
      size: unitOut(e.size), fillType: e.fillType ?? "color",
    }));
  }
  return out;
}

/**
 * Render `content` with its layer styles applied. Returns the same buffer
 * when no effect is enabled, so callers can skip the copy.
 */
export function renderLayerEffects(content: RgbaBuffer, fx: LayerEffects): RgbaBuffer {
  if (fx.disabled === true) return content;
  const shadow = fx.dropShadow?.find((e) => isOn(e) && e.color);
  const innerShadow = fx.innerShadow?.find((e) => isOn(e) && e.color);
  const outerGlow = fx.outerGlow && isOn(fx.outerGlow) && fx.outerGlow.color ? fx.outerGlow : undefined;
  const innerGlow = fx.innerGlow && isOn(fx.innerGlow) && fx.innerGlow.color ? fx.innerGlow : undefined;
  const bevel = fx.bevel && isOn(fx.bevel) ? fx.bevel : undefined;
  const fill = fx.solidFill?.find((e) => isOn(e) && e.color);
  const grad = fx.gradientOverlay?.find(
    (e) => isOn(e) && e.gradient?.type !== "noise" && (e.gradient?.colorStops?.length ?? 0) > 0,
  );
  const stroke = fx.stroke?.find((e) => isOn(e) && e.color && e.fillType !== "gradient" && e.fillType !== "pattern");
  if (!shadow && !innerShadow && !outerGlow && !innerGlow && !bevel && !fill && !grad && !stroke) return content;

  if (content.width * content.height > EFFECT_MAX_PIXELS) {
    throw new Error(`psd: layer effects are too large to rasterise (${content.width} × ${content.height})`);
  }

  const sc = shadow?.color ?? {};
  const fc = fill?.color ?? {};
  const tc = stroke?.color ?? {};

  // behind-content effects
  let merged: RgbaBuffer | null = null;
  const over = (b: RgbaBuffer): void => { if (merged) compositeOver(merged, b); else merged = b; };
  if (shadow && shadow.color) {
    over(makeDropShadowLayer(content, {
      r: sc.r ?? 0, g: sc.g ?? 0, b: sc.b ?? 0,
      opacity: shadow.opacity ?? 1,
      angleDeg: shadow.angle ?? 120,
      distance: unitPx(shadow.distance, 0),
      size: unitPx(shadow.size, 0),
    }));
  }
  if (outerGlow) {
    over(makeOuterGlowLayer(content, {
      r: outerGlow.color!.r ?? 0, g: outerGlow.color!.g ?? 0, b: outerGlow.color!.b ?? 0,
      opacity: outerGlow.opacity ?? 1,
      size: unitPx(outerGlow.size, 0),
      choke: unitPx(outerGlow.choke, 0),
    }));
  }
  if (stroke && stroke.color) {
    over(makeStrokeLayer(content, {
      r: tc.r ?? 0, g: tc.g ?? 0, b: tc.b ?? 0,
      opacity: stroke.opacity ?? 1,
      size: unitPx(stroke.size, 1),
    }));
  }

  // content with baked overlays (Color Overlay, then Gradient Overlay)
  if (fill) {
    content = bakeSolidFill(content, {
      r: fc.r ?? 0, g: fc.g ?? 0, b: fc.b ?? 0,
      opacity: fill.opacity ?? 1,
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
    if (stops.length > 0) {
      content = bakeGradientOverlay(content, {
        stops,
        angleDeg: grad.angle ?? 90,
        opacity: grad.opacity ?? 1,
        reverse: grad.reverse === true,
      });
    }
  }

  if (merged) compositeOver(merged, content);
  else merged = content;

  // inner effects, over the content
  if (innerShadow && innerShadow.color) {
    compositeOver(merged, makeInnerShadowLayer(content, {
      r: innerShadow.color.r ?? 0, g: innerShadow.color.g ?? 0, b: innerShadow.color.b ?? 0,
      opacity: innerShadow.opacity ?? 1,
      angleDeg: innerShadow.angle ?? 120,
      distance: unitPx(innerShadow.distance, 0),
      size: unitPx(innerShadow.size, 0),
    }));
  }
  if (innerGlow) {
    compositeOver(merged, makeInnerGlowLayer(content, {
      r: innerGlow.color!.r ?? 0, g: innerGlow.color!.g ?? 0, b: innerGlow.color!.b ?? 0,
      opacity: innerGlow.opacity ?? 1,
      size: unitPx(innerGlow.size, 0),
      choke: unitPx(innerGlow.choke, 0),
    }));
  }
  if (bevel) {
    const b = makeBevelLayers(content, {
      size: unitPx(bevel.size, 3),
      angleDeg: bevel.angle ?? 90,
      highlight: {
        r: bevel.highlightColor?.r ?? 255,
        g: bevel.highlightColor?.g ?? 255,
        b: bevel.highlightColor?.b ?? 255,
        opacity: bevel.highlightOpacity ?? 1,
      },
      shadow: {
        r: bevel.shadowColor?.r ?? 0,
        g: bevel.shadowColor?.g ?? 0,
        b: bevel.shadowColor?.b ?? 0,
        opacity: bevel.shadowOpacity ?? 1,
      },
      invert: bevel.direction === "down",
    });
    compositeOver(merged, b.highlight);
    compositeOver(merged, b.shadow);
  }
  return merged;
}
