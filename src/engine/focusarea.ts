/**
 * Deterministic, DOM-free heuristic focus-area detection.
 *
 * Works directly on an RGBA byte buffer: no canvas, no DOM, no randomness.
 * For every pixel a 5x5 neighbourhood of BT.601 luma is summarised by two
 * focus cues:
 *
 *   - local luma variance  - sharp texture oscillates, flat blur does not;
 *   - Sobel edge energy    - crisp boundaries have strong gradients.
 *
 * Both cues are normalised into 0..1 and combined as
 * `0.6 * variance + 0.4 * edge`. Pixels whose score reaches the (clamped)
 * threshold belong to the in-focus area and become 255; all others become 0.
 *
 * Sampling outside the image is clamped to the border, so every pixel of the
 * input gets a score and the returned mask is exactly w*h bytes long.
 */

/** Clamp `value` into the inclusive range [lo, hi]. */
function faClamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Build a new focus-area mask from an RGBA buffer.
 *
 * @param px RGBA bytes, length w*h*4. Never mutated.
 * @param w image width in pixels.
 * @param h image height in pixels.
 * @param threshold acceptance level in 0..1 (default 0.2); values outside
 *                   the range are clamped, non-finite values use the default.
 * @returns a NEW Uint8ClampedArray of length w*h: 255 = in focus, 0 = out.
 */
export function focusAreaMask(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  threshold = 0.2,
): Uint8ClampedArray {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return new Uint8ClampedArray(0);
  }
  const width = Math.floor(w);
  const height = Math.floor(h);
  const pixels = width * height;
  const mask = new Uint8ClampedArray(pixels);
  if (px.length < pixels * 4) return mask;

  const t = Number.isFinite(threshold) ? faClamp(threshold, 0, 1) : 0.2;

  // BT.601 luma kept floating (0..255) so the variance stays smooth.
  const luma = new Float64Array(pixels);
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    luma[p] = (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000;
  }

  const at = (x: number, y: number): number =>
    luma[faClamp(y, 0, height - 1) * width + faClamp(x, 0, width - 1)]!;

  // A population variance over values in 0..255 peaks at (255/2)^2.
  const varianceMax = (255 * 255) / 4;
  // Sobel kernels sum to +/-4 per axis; the largest magnitude is 4*255*sqrt(2).
  const edgeMax = 4 * 255 * Math.SQRT2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Local luma variance over the 5x5 neighbourhood (replicated borders).
      let sum = 0;
      let sumSq = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const sy = faClamp(y + dy, 0, height - 1);
        for (let dx = -2; dx <= 2; dx++) {
          const sx = faClamp(x + dx, 0, width - 1);
          const value = luma[sy * width + sx]!;
          sum += value;
          sumSq += value * value;
        }
      }
      const mean = sum / 25;
      const variance = Math.max(0, sumSq / 25 - mean * mean);
      const varianceNorm = Math.min(1, variance / varianceMax);

      // Sobel edge energy at the centre (3x3 kernel inside the 5x5 window).
      const tl = at(x - 1, y - 1), tc = at(x, y - 1), tr = at(x + 1, y - 1);
      const ml = at(x - 1, y), mr = at(x + 1, y);
      const bl = at(x - 1, y + 1), bc = at(x, y + 1), br = at(x + 1, y + 1);
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      const edgeNorm = Math.min(1, Math.hypot(gx, gy) / edgeMax);

      const score = 0.6 * varianceNorm + 0.4 * edgeNorm;
      mask[y * width + x] = score >= t ? 255 : 0;
    }
  }
  return mask;
}
