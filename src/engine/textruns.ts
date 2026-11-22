/**
 * One place that answers "what size and colour is this text run?".
 *
 * A text layer carries a base size and colour, and any run may override either.
 * The rasteriser, the PSD writer and the editor all have to agree on the answer;
 * when they each wrote `seg.size ?? meta.size`, a change to the fallback would
 * have to be made three times and would be missed once.
 */

export interface TextRunStyle {
  size?: number;
  color?: readonly [number, number, number];
}

export interface TextRunBase {
  size: number;
  color: readonly [number, number, number];
}

/** The size a run paints at, clamped to the range the rest of the model accepts. */
export function runFontSize(seg: TextRunStyle, base: TextRunBase): number {
  const px = seg.size ?? base.size;
  if (!Number.isFinite(px)) return Math.max(1, Math.min(1000, base.size));
  return Math.max(1, Math.min(1000, px));
}

/** The colour a run paints in; an override wins, otherwise the layer's own. */
export function runColour(seg: TextRunStyle, base: TextRunBase): [number, number, number] {
  const c = seg.color ?? base.color;
  const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)));
  return [ch(c[0]), ch(c[1]), ch(c[2])];
}

/** The canvas font string for a run. Shared so measurement and paint cannot drift. */
export function runFont(
  seg: { bold: boolean; italic: boolean; font: string; size?: number },
  base: TextRunBase,
): string {
  const px = runFontSize(seg, base);
  return `${seg.italic ? "italic " : ""}${seg.bold ? "bold " : ""}${px}px ${seg.font}`;
}
