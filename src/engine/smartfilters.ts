/**
 * smartfilters.ts — classic filters applied to a freshly resampled smart
 * source.
 *
 * `renderSmartFiltered` is the buffer-returning sibling of
 * `renderSmartIntoGrid`: it maps the immutable source into a rect using the
 * same dest-pixel-centre → source-pixel formula, then runs the requested
 * filters over the resulting straight RGBA bytes. Nothing is written back into
 * the source (layers may share one after Duplicate), and the returned buffer
 * is always freshly allocated.
 *
 * Only enabled filters with a positive amount run, in the order supplied.
 * Blur/sharpen/emboss are deterministic convolutions; noise is a fixed 4x4
 * Bayer ordered dither, so the same inputs always produce the same bytes.
 * Alpha is carried through every filter untouched (the convention in
 * filter.ts / filters2.ts): filtering colour must not erode coverage.
 */
import { emptySample, samplePremul, straightRGB } from "./sample.ts";
import type { SmartSource, SmartRect } from "./smart.ts";

export type SmartFilterKind = "blur" | "sharpen" | "emboss" | "noise";

export const SMART_FILTER_KINDS: readonly SmartFilterKind[] = ["blur", "sharpen", "emboss", "noise"];

export interface SmartFilterSpec {
  kind: SmartFilterKind;
  /** 0..100; values above 100 are clamped, values at/below 0 skip the filter */
  amount: number;
  enabled: boolean;
}

/** clamp a float into the byte range (Uint8ClampedArray assignment also does this) */
function sfClamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 3x3 box average of luminance at (x, y), with edge pixels replicated */
function sfLumAt(src: Uint8ClampedArray, w: number, h: number, x: number, y: number): number {
  const sx = x < 0 ? 0 : x >= w ? w - 1 : x;
  const sy = y < 0 ? 0 : y >= h ? h - 1 : y;
  const o = (sy * w + sx) * 4;
  return (src[o]! + src[o + 1]! + src[o + 2]!) / 3;
}

/** separable-in-effect 3x3 box blur, blended toward the original by `t` (0..1) */
function sfBlur(buf: Uint8ClampedArray, w: number, h: number, t: number): void {
  const src = new Uint8ClampedArray(buf);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const sy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const q = (sy * w + sx) * 4;
          r += src[q]!; g += src[q + 1]!; b += src[q + 2]!;
        }
      }
      buf[o] = src[o]! + (r / 9 - src[o]!) * t;
      buf[o + 1] = src[o + 1]! + (g / 9 - src[o + 1]!) * t;
      buf[o + 2] = src[o + 2]! + (b / 9 - src[o + 2]!) * t;
    }
  }
}

/** additive Laplacian: centre + k·(centre − average of the 4 neighbours) */
function sfSharpen(buf: Uint8ClampedArray, w: number, h: number, t: number): void {
  const src = new Uint8ClampedArray(buf);
  const k = 2 * t;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const xl = x > 0 ? x - 1 : x, xr = x < w - 1 ? x + 1 : x;
      const yt = y > 0 ? y - 1 : y, yb = y < h - 1 ? y + 1 : y;
      for (let c = 0; c < 3; c++) {
        const centre = src[o + c]!;
        const avg = (
          src[(y * w + xl) * 4 + c]! + src[(y * w + xr) * 4 + c]! +
          src[(yt * w + x) * 4 + c]! + src[(yb * w + x) * 4 + c]!
        ) / 4;
        buf[o + c] = sfClamp(centre + (centre - avg) * k);
      }
    }
  }
}

/** classic directional emboss kernel, scaled by `t`, around neutral grey 128 */
function sfEmboss(buf: Uint8ClampedArray, w: number, h: number, t: number): void {
  const src = new Uint8ClampedArray(buf);
  // weights sum to zero so flat regions stay at neutral grey 128
  const kernel = [-1, -1, 0, -1, 0, 1, 0, 1, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, ki = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, ki++) {
          sum += sfLumAt(src, w, h, x + dx, y + dy) * kernel[ki]!;
        }
      }
      const o = (y * w + x) * 4;
      // assignment clamps and rounds; grey means flat areas settle at 128
      buf[o] = buf[o + 1] = buf[o + 2] = sfClamp(128 + sum * t);
    }
  }
}

/** 4x4 Bayer threshold, mapped to [-1, 1] — an ordered dither, not RNG */
const sfBayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function sfNoise(buf: Uint8ClampedArray, w: number, h: number, amount: number): void {
  const src = new Uint8ClampedArray(buf);
  const amp = Math.max(1, Math.round(amount));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const threshold = sfBayer4[(y & 3) * 4 + (x & 3)]!;
      const n = Math.round(((threshold / 15) * 2 - 1) * amp * 0.5);
      buf[o] = sfClamp(src[o]! + n);
      buf[o + 1] = sfClamp(src[o + 1]! + n);
      buf[o + 2] = sfClamp(src[o + 2]! + n);
    }
  }
}

/**
 * Resample `source` into `rect` with renderSmartIntoGrid's mapping and apply
 * the enabled filters. Returns a fresh `w * h * 4` buffer; `source` is read
 * only. The rect origin cancels out of the sampling formula, so clamping the
 * rect to non-negative size (`w, h >= 1`) is all that is needed here, and
 * clamping samples to the source rect extends the edge colour so an upscale
 * of a fully opaque source stays fully opaque.
 */
export function renderSmartFiltered(
  source: SmartSource,
  rect: SmartRect,
  filters: readonly SmartFilterSpec[],
): Uint8ClampedArray {
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const out = new Uint8ClampedArray(w * h * 4);

  const smp = emptySample();
  const rgb3 = new Float32Array(3);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // dest pixel centre → source pixel index; source pixel (i,j) centre is i+0.5
      const fx = ((px + 0.5) / w) * source.width - 0.5;
      const fy = ((py + 0.5) / h) * source.height - 0.5;
      samplePremul(source.data, source.width, source.height, fx, fy, smp, true);
      const o = (py * w + px) * 4;
      if (smp.a > 0) {
        straightRGB(smp, rgb3);
        out[o] = rgb3[0]!;
        out[o + 1] = rgb3[1]!;
        out[o + 2] = rgb3[2]!;
      }
      out[o + 3] = smp.a * 255;
    }
  }

  for (const f of filters) {
    if (!f.enabled || !(f.amount > 0)) continue;
    const t = Math.min(1, f.amount / 100);
    switch (f.kind) {
      case "blur": sfBlur(out, w, h, t); break;
      case "sharpen": sfSharpen(out, w, h, t); break;
      case "emboss": sfEmboss(out, w, h, t); break;
      case "noise": sfNoise(out, w, h, f.amount); break;
    }
  }
  return out;
}
