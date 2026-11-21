/**
 * The renderer is one canvas. A 16384² document is already ~1.07 GB in RGBA;
 * asking the export path for a second full-resolution canvas is what makes the
 * window die. The scaled canvas gets 256 MiB: 8192² at 100 % exactly fits, and
 * a 16384² document is told to halve its dimensions. The source composite is
 * still allocated; this is the destination's share, not the whole budget.
 */
export const MAX_EXPORT_CANVAS_BYTES = 256 * 1024 * 1024;

const GB = 1_000_000_000;

/** Largest whole-percent scale whose RGBA canvas fits the budget. */
function largestPercent(w: number, h: number): number {
  const bytes = w * h * 4;
  return Math.max(1, Math.min(100, Math.floor(Math.sqrt(MAX_EXPORT_CANVAS_BYTES / bytes) * 100)));
}

/**
 * Pure refusal for the scaled-export canvas. `null` means it fits.
 *
 * Kept outside main.ts so the threshold and the wording are unit-testable and
 * the export path cannot forget to ask before allocating.
 */
export function exportRefusal(w: number, h: number, format: string): string | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    return "Export dimensions are invalid.";
  }
  const bytes = w * h * 4;
  if (bytes <= MAX_EXPORT_CANVAS_BYTES) return null;
  const percent = largestPercent(w, h);
  const gb = (bytes / GB).toFixed(2);
  return `This ${format.toUpperCase()} export is ${w} × ${h} (${gb} GB in RGBA). Export at ${percent} % or lower.`;
}
