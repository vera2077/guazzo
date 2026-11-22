/**
 * fillgradient.ts — the sampling maths for a **gradient fill layer**.
 *
 * Distinct from `gradient.ts`, which is the destructive Gradient tool: that one
 * paints pixels once, this one describes a live, non-destructive fill whose
 * colour is evaluated per document pixel at composite time, so it survives
 * canvas resizes and re-edits the way a fill layer should.
 */

export type FillRgb = [number, number, number];

export interface FillGradientStop {
  /** 0..1 along the gradient */
  at: number;
  color: FillRgb;
}

export interface FillGradientSpec {
  type: "linear" | "radial";
  /** degrees, clockwise from +x, linear only */
  angle: number;
  stops: FillGradientStop[];
}

export const DEFAULT_FILL_GRADIENT: FillGradientSpec = {
  type: "linear",
  angle: 90,
  stops: [
    { at: 0, color: [255, 255, 255] },
    { at: 1, color: [0, 0, 0] },
  ],
};

const clampFillUnit = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const fillChannel = (v: number): number => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));

/**
 * A copy with stops sorted, clamped to 0..1, and never shorter than two — a
 * one-stop gradient is a solid colour, which is what the plain colour field is.
 */
export function normalizeFillGradient(input: unknown): FillGradientSpec {
  // Takes `unknown` on purpose: this is the sanitiser for both the project
  // loader and a PSD-derived layer, so it must survive junk rather than
  // trusting a cast at every call site.
  const raw = (input && typeof input === "object" ? input : {}) as {
    type?: unknown;
    angle?: unknown;
    stops?: unknown;
  };
  const list = Array.isArray(raw.stops) ? (raw.stops as unknown[]) : [];
  const stops = list
    .filter((s): s is FillGradientStop => {
      if (!s || typeof s !== "object") return false;
      const color = (s as FillGradientStop).color;
      return Array.isArray(color) && color.length >= 3;
    })
    .map((s) => ({ at: clampFillUnit(Number(s.at)), color: [fillChannel(s.color[0]), fillChannel(s.color[1]), fillChannel(s.color[2])] as FillRgb }))
    .sort((a, b) => a.at - b.at);
  const safeStops =
    stops.length >= 2 ? stops : DEFAULT_FILL_GRADIENT.stops.map((s) => ({ at: s.at, color: [...s.color] as FillRgb }));
  return {
    type: raw.type === "radial" ? "radial" : "linear",
    angle: Number.isFinite(Number(raw.angle)) ? Number(raw.angle) : 90,
    stops: safeStops,
  };
}

/** Where along the gradient (0..1) a document pixel sits. */
export function fillGradientParam(
  gradient: FillGradientSpec,
  gx: number,
  gy: number,
  width: number,
  height: number,
): number {
  const w = Math.max(1, width - 1);
  const h = Math.max(1, height - 1);
  if (gradient.type === "radial") {
    const cx = w / 2;
    const cy = h / 2;
    const max = Math.hypot(cx, cy) || 1;
    return clampFillUnit(Math.hypot(gx - cx, gy - cy) / max);
  }
  const rad = ((gradient.angle ?? 90) * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // The gradient line runs through the canvas centre. Projecting the offset
  // from the centre (not the absolute coordinate) is what makes 0 land on the
  // trailing edge: my first version added span/2 to an already-positive
  // projection, so angle 0 ran 0.5..1 instead of 0..1 and every linear fill
  // was half-blended at the left edge.
  const span = Math.abs(dx) + Math.abs(dy) || 1;
  const offset = (gx / w - 0.5) * dx + (gy / h - 0.5) * dy;
  return clampFillUnit(offset / span + 0.5);
}

/** The gradient's colour at one document pixel. */
export function fillGradientColourAt(
  gradient: FillGradientSpec,
  gx: number,
  gy: number,
  width: number,
  height: number,
): FillRgb {
  const t = fillGradientParam(gradient, gx, gy, width, height);
  const stops = gradient.stops;
  if (t <= stops[0]!.at) return [...stops[0]!.color] as FillRgb;
  const last = stops[stops.length - 1]!;
  if (t >= last.at) return [...last.color] as FillRgb;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (t > b.at) continue;
    const span = b.at - a.at;
    const k = span <= 0 ? 0 : (t - a.at) / span;
    return [
      Math.round(a.color[0] + (b.color[0] - a.color[0]) * k),
      Math.round(a.color[1] + (b.color[1] - a.color[1]) * k),
      Math.round(a.color[2] + (b.color[2] - a.color[2]) * k),
    ];
  }
  return [...last.color] as FillRgb;
}
