/**
 * sample.ts — the one bilinear sampler.
 *
 * Three callers need bilinear sampling of an RGBA buffer: Image Size
 * (`resize.ts`), Free Transform (`transform.ts`) and Perspective Crop
 * (`perspective.ts`). Each had grown its own copy, and copies drift: one of them
 * was not premultiplied for a while, which painted black fringes wherever a
 * transparent pixel met an opaque one.
 *
 * The convention, stated once: RGB is accumulated PREMULTIPLIED by alpha, so a
 * transparent neighbour contributes nothing instead of pulling the colour toward
 * black. Callers un-premultiply by the accumulated alpha.
 */
export interface PremulSample {
  /** summed rgb·a — divide by `a` for the straight colour */
  r: number;
  g: number;
  b: number;
  /** accumulated alpha weight (0..1 per contributing texel) */
  a: number;
  /** sum of the bilinear weights that landed inside the buffer (0..1) */
  wsum: number;
}

export function emptySample(): PremulSample {
  return { r: 0, g: 0, b: 0, a: 0, wsum: 0 };
}

/**
 * Bilinear sample of `src` (straight RGBA bytes, length w*h*4) at buffer-space
 * coordinates where texel (i, j) is centred on (i, j).
 *
 * `clamp` true  → coordinates are clamped to the edge and the weights still sum
 *                 to 1 (stretching: the border colour is extended).
 * `clamp` false → texels outside the buffer are skipped and their weight is
 *                 dropped, so `wsum` reports how much of the footprint existed
 *                 (warping/rotating: outside is transparent, not repeated edge).
 */
export function samplePremul(
  src: ArrayLike<number>,
  w: number,
  h: number,
  x: number,
  y: number,
  out: PremulSample,
  clamp = true,
): void {
  out.r = 0;
  out.g = 0;
  out.b = 0;
  out.a = 0;
  out.wsum = 0;
  if (w <= 0 || h <= 0) return;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const wt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (wt <= 0) continue;
      let sx = x0 + dx;
      let sy = y0 + dy;
      if (clamp) {
        sx = Math.min(w - 1, Math.max(0, sx));
        sy = Math.min(h - 1, Math.max(0, sy));
      } else if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
        continue;
      }
      const i = (sy * w + sx) * 4;
      const sa = (src[i + 3] as number) / 255;
      out.r += (src[i] as number) * sa * wt;
      out.g += (src[i + 1] as number) * sa * wt;
      out.b += (src[i + 2] as number) * sa * wt;
      out.a += sa * wt;
      out.wsum += wt;
    }
  }
}

/** Straight (un-premultiplied) colour of a sample, or 0 when nothing was hit. */
export function straightRGB(s: PremulSample, out: Float32Array | number[]): void {
  if (s.a > 0) {
    out[0] = s.r / s.a;
    out[1] = s.g / s.a;
    out[2] = s.b / s.a;
  } else {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
  }
}

/** Read a whole grid into a straight-RGBA byte buffer of w*h*4. */
export function readGridRGBA(grid: { readRect(x: number, y: number, w: number, h: number, out: Uint8ClampedArray): void }, w: number, h: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  grid.readRect(0, 0, w, h, buf);
  return buf;
}
