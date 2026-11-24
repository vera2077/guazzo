/**
 * specialblur.ts — deterministic, DOM-free "specialty" blurs over raw RGBA.
 *
 * Every entry point takes a flat Uint8ClampedArray (RGBA, `w*h*4` bytes),
 * returns a brand-new buffer and never touches the source. There is no DOM,
 * canvas, `Math.random`, or other ambient state: the same inputs always give
 * the same bytes, which makes these kernels safe for document replay and
 * headless tests.
 *
 * Sampling uses nearest-neighbour with coordinates clamped to the image, so a
 * probe that walks off an edge simply repeats the edge pixel instead of
 * wrapping or reading out of bounds.
 */

export type SpecialBlurKind = "lens" | "field" | "iris" | "tilt-shift";

export const SPECIAL_BLUR_KINDS: readonly SpecialBlurKind[] = [
  "lens",
  "field",
  "iris",
  "tilt-shift",
];

export interface SpecialBlurOptions {
  cx?: number;
  cy?: number;
  /** Optional override for the positional `radius` (still clamped 0..64). */
  radius?: number;
  focusY?: number;
  band?: number;
  samples?: number;
}

/** clamp a radius into 0..64; NaN/Infinity become 0 */
function clampRadius(v: number): number {
  return Number.isFinite(v) ? Math.min(64, Math.max(0, v)) : 0;
}

function finiteOr(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}

/**
 * Average `count` nearest-neighbour RGB samples from `src` at the given
 * floating-point coordinates, writing the rounded result into `dst[di..di+2]`.
 * Coordinates outside the image are clamped to the edge.
 */
function averageAt(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  xs: Float64Array,
  ys: Float64Array,
  count: number,
  dst: Uint8ClampedArray,
  di: number,
): void {
  let sr = 0, sg = 0, sb = 0;
  for (let k = 0; k < count; k++) {
    let xi = Math.round(xs[k]!);
    let yi = Math.round(ys[k]!);
    if (xi < 0) xi = 0;
    else if (xi >= w) xi = w - 1;
    if (yi < 0) yi = 0;
    else if (yi >= h) yi = h - 1;
    const si = (yi * w + xi) * 4;
    sr += src[si]!;
    sg += src[si + 1]!;
    sb += src[si + 2]!;
  }
  dst[di] = sr / count;
  dst[di + 1] = sg / count;
  dst[di + 2] = sb / count;
}

export function specialBlur(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  kind: SpecialBlurKind,
  radius: number,
  opts?: SpecialBlurOptions,
): Uint8ClampedArray {
  // Always start from a fresh buffer; unknown kinds / zero radius return a
  // byte-identical copy of the source.
  const dst = new Uint8ClampedArray(src);

  const baseR = clampRadius(radius);
  if (baseR === 0 || !SPECIAL_BLUR_KINDS.includes(kind)) return dst;

  const o = opts ?? {};
  const effR = o.radius !== undefined && Number.isFinite(o.radius)
    ? clampRadius(o.radius)
    : baseR;
  if (effR === 0) return dst;

  const count = Math.min(32, Math.max(4, Math.round(finiteOr(o.samples, 12))));
  const cx = finiteOr(o.cx, w / 2);
  const cy = finiteOr(o.cy, h / 2);
  const focusY = finiteOr(o.focusY, h / 2);
  const band = Math.max(0, finiteOr(o.band, h / 6));

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const maxDim = Math.max(w, h);
  const TWO_PI = Math.PI * 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      let n = 0;

      switch (kind) {
        case "lens": {
          // Radial blur: walk from this pixel toward (cx, cy) in steps of
          // radius/samples, averaging everything we pass through.
          const dx = x - cx;
          const dy = y - cy;
          const d = Math.hypot(dx, dy);
          if (d < 1e-9) {
            // At the exact centre there is no line to walk — keep the dot.
            n = 0;
            break;
          }
          const ux = dx / d;
          const uy = dy / d;
          const step = effR / count;
          for (let k = 0; k < count; k++) {
            const dist = k * step;
            xs[k] = x - ux * dist;
            ys[k] = y - uy * dist;
          }
          n = count;
          break;
        }
        case "field": {
          // Local radius grows with distance from (cx, cy).
          const d = Math.hypot(x - cx, y - cy);
          const local = effR * d / maxDim;
          if (local < 1e-9) {
            n = 0;
            break;
          }
          for (let k = 0; k < count; k++) {
            const a = TWO_PI * k / count;
            xs[k] = x + local * Math.cos(a);
            ys[k] = y + local * Math.sin(a);
          }
          n = count;
          break;
        }
        case "iris": {
          // Regular polygon bokeh; the (x+y) mod 6 turn keeps neighbouring
          // pixels from sharing the exact same vertex layout.
          const rot = ((((x + y) % 6) + 6) % 6) * (Math.PI / 3);
          for (let k = 0; k < count; k++) {
            const a = TWO_PI * k / count + rot;
            xs[k] = x + effR * Math.cos(a);
            ys[k] = y + effR * Math.sin(a);
          }
          n = count;
          break;
        }
        case "tilt-shift": {
          // Focus band stays sharp; beyond it the circle grows with distance
          // past the band until it reaches the full radius at the image edge.
          const over = Math.abs(y - focusY) - band;
          if (over <= 0) {
            n = 0;
            break;
          }
          const span = Math.max(1, h / 2 - band);
          const strength = Math.min(1, over / span);
          const local = effR * strength;
          for (let k = 0; k < count; k++) {
            const a = TWO_PI * k / count;
            xs[k] = x + local * Math.cos(a);
            ys[k] = y + local * Math.sin(a);
          }
          n = count;
          break;
        }
      }

      if (n === 0) {
        // No blur at this pixel (centre dot / sharp band): keep source RGB.
        dst[di] = src[di]!;
        dst[di + 1] = src[di + 1]!;
        dst[di + 2] = src[di + 2]!;
      } else {
        averageAt(src, w, h, xs, ys, n, dst, di);
      }
      dst[di + 3] = src[di + 3]!; // alpha is never touched
    }
  }

  return dst;
}
