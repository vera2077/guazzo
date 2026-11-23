/**
 * A histogram of a composited RGBA buffer.
 *
 * Counts are per channel plus luma, over the pixels that are not transparent —
 * a 12 %-hidden layer does not get to dominate the shape of the composite. The
 * panel draws these, but the maths lives here so it can be asserted without a
 * canvas.
 */
export interface Histogram {
  /** 256 buckets per channel; 0 = black, 255 = white. */
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  /** the largest single-channel bucket, for scaling the drawing */
  peak: number;
  /** pixels counted (alpha > 0) */
  count: number;
  /** mean luma in 0..255 */
  mean: number;
  /** fraction of counted pixels at 0 and at 255, 0..1 */
  clippedShadows: number;
  clippedHighlights: number;
}

/** ITU-R BT.601 luma, rounded — the same weights the compositor uses. */
/** Suffixed because the bundle flattens modules into one scope. */
export function histogramLuma(r: number, g: number, b: number): number {
  // Round once, here: adding 500 and letting the caller round again turns
  // 76.245 into 77 and puts the bucket one level off.
  return Math.round((r * 299 + g * 587 + b * 114) / 1000);
}

export function histogramOf(rgba: Uint8ClampedArray): Histogram {
  const h: Histogram = {
    r: new Uint32Array(256),
    g: new Uint32Array(256),
    b: new Uint32Array(256),
    luma: new Uint32Array(256),
    peak: 0,
    count: 0,
    mean: 0,
    clippedShadows: 0,
    clippedHighlights: 0,
  };
  let sum = 0;
  let shadows = 0;
  let highlights = 0;
  const n = rgba.length - (rgba.length % 4);
  for (let i = 0; i < n; i += 4) {
    const a = rgba[i + 3]!;
    if (a === 0) continue;
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    h.r[r]! += 1;
    h.g[g]! += 1;
    h.b[b]! += 1;
    const y = histogramLuma(r, g, b);
    h.luma[y]! += 1;
    sum += y;
    if (y === 0) shadows += 1;
    if (y >= 254) highlights += 1;
    h.count += 1;
  }
  for (let i = 0; i < 256; i++) {
    const m = Math.max(h.r[i]!, h.g[i]!, h.b[i]!, h.luma[i]!);
    if (m > h.peak) h.peak = m;
  }
  if (h.count > 0) {
    h.mean = Math.round(sum / h.count);
    h.clippedShadows = shadows / h.count;
    h.clippedHighlights = highlights / h.count;
  }
  return h;
}
