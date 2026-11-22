/**
 * fillpattern.ts — procedurally generated pattern fills.
 *
 * A fill layer can hold a solid colour or a live gradient (fillgradient.ts).
 * A pattern is the third kind, and it is generated rather than sampled from an
 * image: nothing is vendored, nothing is downloaded, and the fill stays live at
 * any canvas size because every pixel asks "which cell am I in?".
 *
 * Persistence and PSD: a pattern has nowhere to live in a PSD fill record, so
 * psdexport takes its documented single-composite fallback for these layers —
 * the picture is preserved and the cause is admitted, never silently frozen.
 */
import type { FillRgb } from "./fillgradient.ts";

export type FillPatternKind = "checker" | "stripes" | "dots";

export interface FillPattern {
  kind: FillPatternKind;
  /** tile edge in document pixels, 2..256 */
  size: number;
  /** the cell colour, and the colour between cells */
  colorA: FillRgb;
  colorB: FillRgb;
}

export const DEFAULT_FILL_PATTERN: FillPattern = {
  kind: "checker",
  size: 32,
  colorA: [255, 255, 255],
  colorB: [120, 120, 120],
};

const PATTERN_KINDS: ReadonlyArray<FillPatternKind> = ["checker", "stripes", "dots"];
const MIN_SIZE = 2;
const MAX_SIZE = 256;

const clampSize = (value: unknown): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_FILL_PATTERN.size;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
};

const patternChannel = (value: unknown, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(255, Math.max(0, n));
};

const patternColor = (value: unknown, fallback: FillRgb): FillRgb => {
  if (!Array.isArray(value) || value.length < 3) return [fallback[0], fallback[1], fallback[2]];
  return [
    patternChannel(value[0], fallback[0]),
    patternChannel(value[1], fallback[1]),
    patternChannel(value[2], fallback[2]),
  ];
};

/** The sanitiser for project load, the dialog and anything else untrusted. */
export function normalizeFillPattern(input: unknown): FillPattern {
  if (!input || typeof input !== "object") return DEFAULT_FILL_PATTERN;
  const raw = input as { kind?: unknown; size?: unknown; colorA?: unknown; colorB?: unknown };
  const kind = PATTERN_KINDS.includes(raw.kind as FillPatternKind) ? (raw.kind as FillPatternKind) : DEFAULT_FILL_PATTERN.kind;
  return {
    kind,
    size: clampSize(raw.size),
    colorA: patternColor(raw.colorA, DEFAULT_FILL_PATTERN.colorA),
    colorB: patternColor(raw.colorB, DEFAULT_FILL_PATTERN.colorB),
  };
}

/**
 * The colour of the pattern at a document pixel. `gx`/`gy` are integers, so
 * each kind can decide from its cell coordinates without any sampling state.
 */
export function fillPatternColourAt(pattern: FillPattern, gx: number, gy: number): FillRgb {
  const size = Math.max(MIN_SIZE, pattern.size);
  const cx = Math.floor(gx / size);
  const cy = Math.floor(gy / size);
  if (pattern.kind === "stripes") {
    const stripe = Math.floor((gx + gy) / size);
    return (stripe & 1) === 0 ? pattern.colorA : pattern.colorB;
  }
  if (pattern.kind === "dots") {
    // A dot sits at the centre of every cell; the radius leaves a visible gap so
    // neighbouring dots do not merge into a grid.
    const half = size / 2;
    const dx = ((gx % size) + size) % size - half + 0.5;
    const dy = ((gy % size) + size) % size - half + 0.5;
    return dx * dx + dy * dy <= half * half * 0.62 ? pattern.colorA : pattern.colorB;
  }
  return ((cx + cy) & 1) === 0 ? pattern.colorA : pattern.colorB;
}
