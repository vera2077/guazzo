/**
 * objectselect.ts — deterministic, DOM-free heuristic object selection.
 *
 * This is a GrabCut-STYLE heuristic, not a semantic / ML model. It never loads
 * weights, never touches the DOM, and never uses randomness: the same pixels,
 * rectangle and iteration count always produce the same mask.
 *
 * Model (deliberately simple):
 *   - The clamped rectangle splits the image into "inside" (probable foreground)
 *     and "outside" (definite background). Outside pixels are pinned to
 *     background for the whole run.
 *   - Colour is modelled by two 16-bin-per-channel RGB histograms (16×16×16 =
 *     4096 cells), seeded from the inner border band of the rectangle (foreground)
 *     and everything outside it (background). A Laplace-style pseudocount keeps
 *     every cell non-zero, so the score is a proper -log(probability).
 *   - Each iteration visits pixels in raster order and assigns each inside pixel
 *     to whichever histogram gives the lower colour distance, minus a spatial
 *     smoothness bonus for already-assigned (left / up) neighbours of the same
 *     label. The histograms are then rebuilt from the new labels for the next
 *     iteration. This is iterated conditional modes, not a probabilistic graph
 *     cut — cheap, bounded and fully reproducible.
 */

/** Axis-aligned selection rectangle in image pixels: [x, x+w) × [y, y+h). */
export interface OSRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BINS = 16;
const BIN_COUNT = BINS * BINS * BINS;
/** Per-cell pseudocount: avoids infinite distance for unseen colours. */
const SMOOTH = 1;
/** Weight of one agreeing left/up neighbour in the smoothness term. */
const LAMBDA = 0.7;

const FG = 1;
const BG = 0;

interface Model {
  /** Precomputed -log(count + SMOOTH) per histogram cell. */
  logCount: Float64Array;
  /** log(total + SMOOTH * BIN_COUNT), subtracted to give -log(probability). */
  logDenom: number;
}

function binOf(r: number, g: number, b: number): number {
  // Uint8ClampedArray reads are integer 0..255, so >> 4 gives a 0..15 bin.
  return (((r >> 4) * BINS) + (g >> 4)) * BINS + (b >> 4);
}

function modelFromCounts(counts: Float64Array, total: number): Model {
  const logCount = new Float64Array(BIN_COUNT);
  for (let b = 0; b < BIN_COUNT; b++) logCount[b] = Math.log(counts[b]! + SMOOTH);
  return { logCount, logDenom: Math.log(total + SMOOTH * BIN_COUNT) };
}

function countsFromLabels(px: Uint8ClampedArray, size: number, labels: Uint8Array, want: number): Model {
  const counts = new Float64Array(BIN_COUNT);
  let total = 0;
  for (let p = 0; p < size; p++) {
    if (labels[p] !== want) continue;
    const i = p * 4;
    counts[binOf(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0)]! += 1;
    total++;
  }
  return modelFromCounts(counts, total);
}

/**
 * Seed the two histograms before any assignment: foreground from the inner
 * border band of the rectangle, background from everything outside it. Falls
 * back to the whole rectangle if the band produced no samples (tiny rect).
 */
function seedModels(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { fg: Model; bg: Model } {
  const fgCounts = new Float64Array(BIN_COUNT);
  const bgCounts = new Float64Array(BIN_COUNT);
  let fgTotal = 0;
  let bgTotal = 0;
  const band = Math.max(1, Math.min(3, Math.floor(Math.min(x1 - x0, y1 - y0) / 5)));

  const add = (counts: Float64Array, bin: number): void => {
    counts[bin]! += 1;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      const bin = binOf(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0);
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        const nearBorder =
          x - x0 < band || x1 - 1 - x < band || y - y0 < band || y1 - 1 - y < band;
        if (nearBorder) {
          add(fgCounts, bin);
          fgTotal++;
        }
      } else {
        add(bgCounts, bin);
        bgTotal++;
      }
    }
  }

  if (fgTotal === 0) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        fgCounts[binOf(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0)]! += 1;
        fgTotal++;
      }
    }
  }

  return { fg: modelFromCounts(fgCounts, fgTotal), bg: modelFromCounts(bgCounts, bgTotal) };
}

/**
 * One iterated-conditional-modes sweep. Pixels outside the rectangle stay
 * definite background; inside pixels pick the lower of colour distance minus
 * the smoothness bonus from their already-assigned left / up neighbours.
 */
function assign(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fg: Model,
  bg: Model,
  labels: Uint8Array,
): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) {
        labels[p] = BG; // definite background — never reconsidered
        continue;
      }
      const i = p * 4;
      const bin = binOf(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0);
      const fgDist = fg.logDenom - fg.logCount[bin]!;
      const bgDist = bg.logDenom - bg.logCount[bin]!;

      let agreeFG = 0;
      let agreeBG = 0;
      if (x > 0) {
        if (labels[p - 1] === FG) agreeFG++;
        else agreeBG++;
      }
      if (y > 0) {
        if (labels[p - w] === FG) agreeFG++;
        else agreeBG++;
      }

      const fgScore = fgDist - LAMBDA * agreeFG;
      const bgScore = bgDist - LAMBDA * agreeBG;
      labels[p] = fgScore <= bgScore ? FG : BG;
    }
  }
}

/**
 * Build a foreground selection mask for the object inside `rect`.
 *
 * @param px RGBA pixel data, length `w * h * 4`. Read only — never mutated.
 * @param w Image width in pixels.
 * @param h Image height in pixels.
 * @param rect Selection rectangle; clamped to the image. Invalid rectangles
 *             (non-finite coordinates, non-positive size after clamping) yield
 *             an all-zero mask.
 * @param iterations Number of ICM passes, default 4, clamped to 1..8.
 * @returns A NEW alpha mask, length `w * h` (255 = foreground, 0 = background).
 */
export function objectSelectionMask(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  rect: OSRect,
  iterations?: number,
): Uint8ClampedArray {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    return new Uint8ClampedArray(0);
  }
  const width = Math.floor(w);
  const height = Math.floor(h);
  const size = width * height;
  const mask = new Uint8ClampedArray(size);

  const rx = Math.round(rect.x);
  const ry = Math.round(rect.y);
  const rw = Math.round(rect.w);
  const rh = Math.round(rect.h);
  if (![rx, ry, rw, rh].every(Number.isFinite)) return mask;

  const x0 = Math.max(0, Math.min(width, rx));
  const y0 = Math.max(0, Math.min(height, ry));
  const x1 = Math.max(0, Math.min(width, rx + rw));
  const y1 = Math.max(0, Math.min(height, ry + rh));
  if (x1 <= x0 || y1 <= y0) return mask;

  let passes = Math.round(iterations ?? 4);
  if (!Number.isFinite(passes)) passes = 4;
  passes = Math.max(1, Math.min(8, passes));

  const labels = new Uint8Array(size);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) labels[y * width + x] = FG;
  }

  let { fg, bg } = seedModels(px, width, height, x0, y0, x1, y1);
  for (let it = 0; it < passes; it++) {
    assign(px, width, height, x0, y0, x1, y1, fg, bg, labels);
    // Rebuild both histograms from the labels just produced, for the next pass.
    fg = countsFromLabels(px, size, labels, FG);
    bg = countsFromLabels(px, size, labels, BG);
  }

  for (let p = 0; p < size; p++) mask[p] = labels[p] === FG ? 255 : 0;
  return mask;
}
