// Pressure response curves for the brush and eraser.
//
// A stylus reports pressure 0..1; these curves say what that means for three
// attributes. Each curve is three knots at pressure 0, 0.5 and 1, joined with
// straight lines — enough to make size grow fast and then flatten, to hold
// opacity back until half pressure, or to make flow flat so it never varies.
//
// Size has always been mapped through 0.35 + 0.65 * pressure (a pen at rest
// still paints a small dab). That mapping is kept and the curve feeds it, so a
// default size curve of 0 / 0.5 / 1 behaves exactly as before. Opacity and flow
// default to flat 1: pressure changes nothing unless the artist asks.

export type PressureCurve = [number, number, number];

export interface PressureSettings {
  size: PressureCurve;
  opacity: PressureCurve;
  flow: PressureCurve;
}

export const DEFAULT_PRESSURE: PressureSettings = {
  size: [0, 0.5, 1],
  opacity: [1, 1, 1],
  flow: [1, 1, 1],
};

const KNOTS = [0, 0.5, 1] as const;

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Straight lines between the three knots; clamps outside 0..1. */
export function pressureAt(curve: PressureCurve, t: number): number {
  const p = clampUnit(t);
  if (p <= KNOTS[1]) {
    const f = p / KNOTS[1];
    return clampUnit(curve[0] + (curve[1] - curve[0]) * f);
  }
  const f = (p - KNOTS[1]) / (KNOTS[2] - KNOTS[1]);
  return clampUnit(curve[1] + (curve[2] - curve[1]) * f);
}

export function curveIsFlat(curve: PressureCurve): boolean {
  return curve[0] === curve[1] && curve[1] === curve[2];
}

export function isDefaultPressure(s: PressureSettings): boolean {
  return (
    s.size[0] === DEFAULT_PRESSURE.size[0] && s.size[1] === DEFAULT_PRESSURE.size[1] && s.size[2] === DEFAULT_PRESSURE.size[2] &&
    s.opacity[0] === 1 && s.opacity[1] === 1 && s.opacity[2] === 1 &&
    s.flow[0] === 1 && s.flow[1] === 1 && s.flow[2] === 1
  );
}

export function normalizeCurve(input: unknown, fallback: PressureCurve): PressureCurve {
  if (!Array.isArray(input) || input.length !== 3) return [...fallback] as PressureCurve;
  const out: PressureCurve = [...fallback] as PressureCurve;
  for (let i = 0; i < 3; i++) {
    const v = input[i];
    if (typeof v === "number" && Number.isFinite(v)) out[i] = clampUnit(v);
  }
  return out;
}

export function normalizePressureSettings(input: unknown): PressureSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof PressureSettings, unknown>>;
  return {
    size: normalizeCurve(raw.size, DEFAULT_PRESSURE.size),
    opacity: normalizeCurve(raw.opacity, DEFAULT_PRESSURE.opacity),
    flow: normalizeCurve(raw.flow, DEFAULT_PRESSURE.flow),
  };
}

const KEY = "guazzo.pressure.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPressureSettings(storage: StorageLike | null = defaultStorage()): PressureSettings {
  if (!storage) return { ...DEFAULT_PRESSURE };
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PRESSURE };
    return normalizePressureSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PRESSURE };
  }
}

export function savePressureSettings(s: PressureSettings, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify(s));
  } catch {
    // a full or blocked localStorage must not break painting
  }
}

/** How the current settings treat one pressure reading. */
export function pressureResponse(s: PressureSettings, t: number): { size: number; opacity: number; flow: number } {
  return { size: pressureAt(s.size, t), opacity: pressureAt(s.opacity, t), flow: pressureAt(s.flow, t) };
}
