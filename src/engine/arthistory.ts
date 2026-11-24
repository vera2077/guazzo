/**
 * arthistory.ts — Art History brush dab.
 *
 * Where the History brush is a literal restore, the Art History brush is a
 * stylised one: source pixels are sampled through a small deterministic
 * sinusoidal displacement whose strength is set by the style, then blended
 * toward the destination by fidelity, brush falloff and selection coverage.
 * There is no noise, dither or randomness: identical inputs yield identical
 * bytes, so the dab is safe to replay from history.
 */

import { TileGrid, TILE } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

/** Brush character — larger values displace the source sample farther. */
export type ArtHistoryStyle = "tight" | "medium" | "loose";

/** A full-document, straight-RGBA source copy (row-major, top-left origin). */
export interface ArtSnapshot {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Displacement amplitude as a fraction of the dab radius. */
const STYLE_AMPLITUDE: Record<ArtHistoryStyle, number> = {
  tight: 0.15,
  medium: 0.35,
  loose: 0.6,
};

const ahClamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * Stamp one stylised Art History dab at document coordinates (x,y).
 *
 * The dab is a soft circular disc with a solid core and a smoothstep rim.
 * Inside it, each destination pixel is blended toward a displaced sample of
 * the source: `dst += (src - dst) * coverage * fidelity * maskCoverage`.
 * Fidelity 1 reproduces the displaced source (alpha included); fidelity 0 is
 * an exact no-op. Painting is clipped to the grid, the source snapshot and an
 * optional document-space rectangle.
 */
export function artHistoryDab(
  grid: TileGrid,
  src: ArtSnapshot,
  x: number,
  y: number,
  radius: number,
  style: ArtHistoryStyle,
  fidelity: number,
  mask?: PixelMask | null,
  clip?: { x: number; y: number; w: number; h: number } | null,
): void {
  const fid = ahClamp01(fidelity);
  if (fid <= 0) return; // fidelity 0 is an exact no-op
  if (src.width <= 0 || src.height <= 0 || src.data.length < src.width * src.height * 4) return;

  const r = Math.max(0.5, radius);
  const amp = (STYLE_AMPLITUDE[style] ?? STYLE_AMPLITUDE.medium) * r;
  const inner = r * 0.8; // solid core; smooth falloff occupies the outer 20%
  const band = r - inner;
  const r2 = r * r;
  const inner2 = inner * inner;
  const sw = src.width, sh = src.height;

  const x0 = Math.max(0, Math.floor(x - r));
  const y0 = Math.max(0, Math.floor(y - r));
  const x1 = Math.min(grid.width, Math.ceil(x + r) + 1);
  const y1 = Math.min(grid.height, Math.ceil(y + r) + 1);
  if (x0 >= x1 || y0 >= y1) return; // fully off-canvas

  grid.forEachTileInRect(x0, y0, x1 - x0, y1 - y0, (tile, cx, cy, cw, ch, bx, by) => {
    const d = tile.data;
    let touched = false;
    for (let yy = 0; yy < ch; yy++) {
      const docY = by + cy + yy;
      const dy = docY - y;
      // Per-row wave: deterministic, and cheap to hoist out of the x loop.
      const waveX = Math.sin(dy * 0.25);
      const waveY = Math.cos(dy * 0.25);
      for (let xx = 0; xx < cw; xx++) {
        const docX = bx + cx + xx;
        if (clip && (docX < clip.x || docY < clip.y || docX >= clip.x + clip.w || docY >= clip.y + clip.h)) continue;
        const dx = docX - x;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue; // outside the disc

        let coverage: number;
        if (d2 <= inner2 || band <= 0) coverage = 1;
        else {
          const t = 1 - (Math.sqrt(d2) - inner) / band;
          coverage = t * t * (3 - 2 * t); // smoothstep falloff
        }
        if (coverage <= 0) continue;

        const ma = mask ? mask.alphaAt(docX, docY) : 255;
        if (ma <= 0) continue;
        const a = coverage * fid * (ma >= 255 ? 1 : ma / 255);
        if (a <= 0) continue;

        // Displace the source sample by a small sinusoid; nearest-neighbour
        // keeps the operation exact and reproducible.
        const sx = Math.round(docX + waveX * amp);
        const sy = Math.round(docY + waveY * amp * 0.5);
        if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue; // no source here

        const tp = ((cy + yy) * TILE + cx + xx) * 4;
        const sp = (sy * sw + sx) * 4;
        // Straight RGBA interpolation, alpha included: full fidelity/coverage
        // copies the sampled source byte-for-byte, zero leaves dst alone.
        for (let c = 0; c < 4; c++) {
          const dv = d[tp + c]!;
          d[tp + c] = dv + (src.data[sp + c]! - dv) * a;
        }
        touched = true;
      }
    }
    if (touched) tile.version++;
  });
}
