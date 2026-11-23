// Background Eraser: erase only the pixels that match the colour the stroke
// started on. The engine half is deliberately pure — it receives a grid, a
// point and a target colour — because the sampling decision (where the colour
// came from, and when it is re-sampled) belongs to the shell.
import type { TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export type BgTarget = readonly [number, number, number];

/** A layer pixel as straight RGB. Null outside the layer or fully transparent. */
export function sampleGridColor(grid: TileGrid, x: number, y: number): BgTarget | null {
  const px = new Uint8ClampedArray(4);
  grid.readRect(Math.floor(x), Math.floor(y), 1, 1, px);
  if (px[3] === 0) return null;
  return [px[0]!, px[1]!, px[2]!];
}

export interface BgEraseOptions {
  radius: number;
  /** 0 = soft feathered rim, 1 = crisp disc edge */
  hardness: number;
  target: BgTarget;
  /** maximum per-channel difference that still counts as "the same colour" */
  tolerance: number;
  /** selection clip rect (doc coords); pixels outside are untouched */
  clip?: { x: number; y: number; w: number; h: number };
  /** selection mask; a pixel with zero coverage is untouched */
  mask?: PixelMask | null;
}

/**
 * Erase the pixels under one dab whose colour is within `tolerance` of
 * `target`, fading the rim by `hardness`. Returns the touched rect, or null
 * when nothing matched — a stroke over a colour it does not target must not
 * report damage it did not do.
 */
export function backgroundEraseDab(
  grid: TileGrid,
  x: number,
  y: number,
  o: BgEraseOptions,
): { x: number; y: number; w: number; h: number } | null {
  const r = Math.max(1, o.radius);
  const x0 = Math.max(0, Math.floor(x - r));
  const y0 = Math.max(0, Math.floor(y - r));
  const x1 = Math.min(grid.width - 1, Math.ceil(x + r));
  const y1 = Math.min(grid.height - 1, Math.ceil(y + r));
  if (x1 < x0 || y1 < y0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const buf = new Uint8ClampedArray(w * h * 4);
  grid.readRect(x0, y0, w, h, buf);
  const inner = r * Math.max(0, Math.min(1, o.hardness));
  const [tr, tg, tb] = o.target;
  let touched = false;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4;
      const a = buf[i + 3]!;
      if (a === 0) continue;
      const gx = x0 + xx, gy = y0 + yy;
      if (o.clip && (gx < o.clip.x || gy < o.clip.y || gx >= o.clip.x + o.clip.w || gy >= o.clip.y + o.clip.h)) continue;
      if (o.mask && o.mask.alphaAt(gx, gy) === 0) continue;
      const dx = x0 + xx + 0.5 - x, dy = y0 + yy + 0.5 - y;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      const diff = Math.max(
        Math.abs(buf[i]! - tr),
        Math.abs(buf[i + 1]! - tg),
        Math.abs(buf[i + 2]! - tb),
      );
      if (diff > o.tolerance) continue;
      // soft rim: full strength inside `inner`, ramping to zero at the radius
      const cov = d <= inner ? 1 : 1 - (d - inner) / (r - inner);
      buf[i + 3] = Math.round(a * (1 - cov));
      if (buf[i + 3]! < a) touched = true;
    }
  }
  if (!touched) return null;
  grid.writeRect(x0, y0, w, h, buf);
  return { x: x0, y: y0, w, h };
}
