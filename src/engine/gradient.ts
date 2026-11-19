/**
 * gradient.ts — fill a rect with a two-stop gradient (Gradient tool).
 *
 * Linear: t is the projection of the pixel center onto the from→to axis,
 * clamped to [0,1] (so the ends extend outward, like Photoshop).
 * Radial: t is distance(from) / distance(from→to), clamped.
 * Colors lerp per channel including alpha; each pixel is composited OVER
 * the destination with the same W3C math as the rest of the engine.
 * Pure function of the grid — undoable via history.layerOpCommand.
 */

import { TILE, type TileGrid } from "./tile.ts";
import { compositePixel, clamp01 } from "./blend.ts";
import type { PixelMask } from "./mask.ts";

export interface GradColor {
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..255
}

export interface GradientSpec {
  kind: "linear" | "radial";
  from: { x: number; y: number; c: GradColor };
  to: { x: number; y: number; c: GradColor };
}

export function fillGradient(
  grid: TileGrid,
  x: number,
  y: number,
  w: number,
  h: number,
  spec: GradientSpec,
  mask?: PixelMask,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(grid.width, Math.ceil(x + w));
  const y1 = Math.min(grid.height, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return;

  const dx = spec.to.x - spec.from.x;
  const dy = spec.to.y - spec.from.y;
  const denom = dx * dx + dy * dy;
  const rlen = Math.max(Math.sqrt(denom), 0.5);
  const f = spec.from.c;
  const t = spec.to.c;

  grid.forEachTileInRect(
    x0, y0, x1 - x0, y1 - y0,
    (tile, cx, cy, cw, ch, bx, by) => {
      const d = tile.data;
      for (let yy = 0; yy < ch; yy++) {
        const py = by + cy + yy + 0.5;
        let p = ((cy + yy) * TILE + cx) * 4;
        for (let xx = 0; xx < cw; xx++) {
          const px = bx + cx + xx + 0.5;
          let u: number;
          if (spec.kind === "linear") {
            u = denom === 0
              ? 0
              : clamp01(((px - spec.from.x) * dx + (py - spec.from.y) * dy) / denom);
          } else {
            const ddx = px - spec.from.x;
            const ddy = py - spec.from.y;
            u = clamp01(Math.sqrt(ddx * ddx + ddy * ddy) / rlen);
          }
          const sr = f.r + (t.r - f.r) * u;
          const sg = f.g + (t.g - f.g) * u;
          const sb = f.b + (t.b - f.b) * u;
          let sa = f.a + (t.a - f.a) * u;
          if (mask) {
            const ma = mask.alphaAt(px | 0, py | 0);
            if (ma === 0) { p += 4; continue; }
            sa = (sa * ma) / 255;
          }
          const dr = d[p] ?? 0, dg = d[p + 1] ?? 0, db = d[p + 2] ?? 0, da = d[p + 3] ?? 0;
          compositePixel("normal", sr, sg, sb, sa, dr, dg, db, da, d, p, px | 0, py | 0);
          p += 4;
        }
      }
      tile.version++;
    },
    true,
  );
}
