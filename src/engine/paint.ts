/**
 * paint.ts — brush dab stamping onto a TileGrid.
 *
 * A dab is a hard/soft-edged disc composited with paint-mode semantics
 * (normal / behind / clear / any blend mode) into the layer's pixels.
 * The stroke engine (spacing, smoothing, pressure mapping) lives in
 * ui/stroke.ts and calls stampDab per dab.
 */

import { TileGrid, TILE } from "./tile.ts";
import { compositePixel, type BlendMode } from "./blend.ts";
import type { StrokeSession } from "./history.ts";
import type { PixelMask } from "./mask.ts";

export interface DabOptions {
  /** doc coords */
  x: number;
  y: number;
  radius: number;
  /** 0..1, fraction of radius that is fully opaque */
  hardness: number;
  /** 0..1 multiplier applied to the dab alpha (flow × pressure) */
  alpha: number;
  color: readonly [number, number, number];
  mode: BlendMode;
  /** optional selection clip rect (doc coords); pixels outside are untouched */
  clip?: { x: number; y: number; w: number; h: number };
  /** optional nib stretch (pen tilt): the dab becomes an ellipse — major axis
   *  along `angle` (radians), minor axis scaled by `ratio` (0..1) */
  stretch?: { angle: number; ratio: number };
  /** optional selection mask (0..255); dab alpha is scaled per pixel */
  mask?: PixelMask;
  /** optional brush tip image: the dab stamps the tip (bilinear-scaled to
   *  2r) instead of the procedural disc; `data` is RGBA, alpha = density.
   *  Tips ignore hardness and stretch (pen tilt). */
  tip?: TipImage;
  /** optional second tip (dual brush): its alpha multiplies the dab's
   *  coverage. The tip spans `2 * radius * dualScale`, centred on the dab, so
   *  a smaller second tip textures only the middle of the stroke. */
  dual?: TipImage;
  /** second tip size as a fraction of the dab diameter (0.05..1) */
  dualScale?: number;
}

/** a grayscale/alpha brush tip; density is its alpha channel */
export interface TipImage {
  data: Uint8ClampedArray | Uint8Array;
  w: number;
  h: number;
}

/** sample the tip's alpha at bilinear coordinates (u,v in tip pixels) */
function sampleTipAlpha(t: TipImage, u: number, v: number): number {
  const tw = t.w, th = t.h;
  const xi = Math.max(0, Math.min(tw - 2, Math.floor(u)));
  const yi = Math.max(0, Math.min(th - 2, Math.floor(v)));
  const fu = Math.max(0, Math.min(1, u - xi));
  const fv = Math.max(0, Math.min(1, v - yi));
  const a00 = t.data[(yi * tw + xi) * 4 + 3]!;
  const a10 = tw > 1 ? t.data[(yi * tw + xi + 1) * 4 + 3]! : a00;
  const a01 = th > 1 ? t.data[((yi + 1) * tw + xi) * 4 + 3]! : a00;
  const a11 = tw > 1 && th > 1 ? t.data[((yi + 1) * tw + xi + 1) * 4 + 3]! : tw > 1 ? a10 : a01;
  return a00 * (1 - fu) * (1 - fv) + a10 * fu * (1 - fv) + a01 * (1 - fu) * fv + a11 * fu * fv;
}

/** stamp a tip-image dab; used by stampDab when d.tip is set */
function stampTipDab(
  grid: TileGrid,
  d: DabOptions,
  session: StrokeSession | undefined,
): { x: number; y: number; w: number; h: number } | null {
  const t = d.tip!;
  const r = Math.max(0.5, d.radius);
  // scale so the tip's LARGER side spans 2r
  const scale = (2 * r) / Math.max(t.w, t.h);
  const dw = t.w * scale, dh = t.h * scale;
  const x0 = Math.floor(d.x - dw / 2), y0 = Math.floor(d.y - dh / 2);
  const w = Math.ceil(dw) + 1, h = Math.ceil(dh) + 1;
  const x1 = x0 + w, y1 = y0 + h;
  if (x1 <= 0 || y1 <= 0 || x0 >= grid.width || y0 >= grid.height) return null;
  if (d.clip) {
    const cx0 = Math.max(x0, d.clip.x), cy0 = Math.max(y0, d.clip.y);
    const cx1 = Math.min(x1, d.clip.x + d.clip.w), cy1 = Math.min(y1, d.clip.y + d.clip.h);
    if (cx0 >= cx1 || cy0 >= cy1) return null;
  }
  const [cr, cg, cb] = d.color;
  const clip = d.clip;
  const clipX0 = clip ? clip.x : 0, clipY0 = clip ? clip.y : 0;
  const clipX1 = clip ? clip.x + clip.w : 0, clipY1 = clip ? clip.y + clip.h : 0;
  const mask = d.mask;
  const su = (t.w - 1) / Math.max(1, dw - 1);   // doc px → tip px
  const sv = (t.h - 1) / Math.max(1, dh - 1);
  let touched = false;
  grid.forEachTileInRect(x0, y0, w, h, (tile, cx, cy, cw, ch, bx, by) => {
    if (session) session.noteTile(bx / TILE, by / TILE, tile);
    const td = tile.data;
    for (let yy = 0; yy < ch; yy++) {
      const docY = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const docX = bx + cx + xx;
        if (clip && (docX < clipX0 || docY < clipY0 || docX >= clipX1 || docY >= clipY1)) continue;
        const u = (docX - d.x + dw / 2) * su;
        const v = (docY - d.y + dh / 2) * sv;
        const ta = sampleTipAlpha(t, u, v);
        if (ta <= 0.5) continue;
        const ma = mask ? mask.alphaAt(docX, docY) : 255;
        if (ma === 0) continue;
        let a = (ta / 255) * d.alpha * (ma / 255) * 255;
        if (a <= 0) continue;
        // dual brush: a second tip multiplies coverage, so the stroke breaks
        // up where the second tip is dark instead of being one flat disc
        if (d.dual) {
          const ds = Math.max(0.05, Math.min(1, d.dualScale ?? 1));
          const span = 2 * r * ds;
          const du = ((docX - d.x) / span + 0.5) * (d.dual.w - 1);
          const dv = ((docY - d.y) / span + 0.5) * (d.dual.h - 1);
          a *= sampleTipAlpha(d.dual, du, dv) / 255;
          if (a <= 0) continue;
        }
        const tp = ((cy + yy) * TILE + cx + xx) * 4;
        compositePixel(d.mode, cr, cg, cb, a, td[tp]!, td[tp + 1]!, td[tp + 2]!, td[tp + 3]!, td, tp, docX, docY);
        touched = true;
      }
    }
    tile.version++;
  }, true);
  if (!touched) return null;
  let rx = Math.max(0, x0), ry = Math.max(0, y0);
  let rw = Math.min(grid.width, x1) - rx, rh = Math.min(grid.height, y1) - ry;
  if (d.clip) {
    const cx0 = Math.max(rx, d.clip.x), cy0 = Math.max(ry, d.clip.y);
    const cx1 = Math.min(rx + rw, d.clip.x + d.clip.w), cy1 = Math.min(ry + rh, d.clip.y + d.clip.h);
    rx = cx0; ry = cy0; rw = cx1 - cx0; rh = cy1 - cy0;
  }
  if (rw <= 0 || rh <= 0) return null;
  return { x: rx, y: ry, w: rw, h: rh };
}

/** stamp one dab into the grid; returns the affected doc rect or null */
export function stampDab(
  grid: TileGrid,
  d: DabOptions,
  session?: StrokeSession,
): { x: number; y: number; w: number; h: number } | null {
  if (d.tip) return stampTipDab(grid, d, session);
  const r = Math.max(0.5, d.radius);
  // stretched dabs (pen tilt): ellipse with major axis along `angle`, minor
  // scaled by ratio. Effective distance keeps px units so all thresholds
  // (r2 / inner2 / band) stay valid: e2 = u² + v²/ratio².
  const st = d.stretch && d.stretch.ratio < 1 ? d.stretch : null;
  const ca = st ? Math.cos(st.angle) : 1;
  const sa = st ? Math.sin(st.angle) : 0;
  const invRatio2 = st ? 1 / (st.ratio * st.ratio) : 1;
  // ellipse bounding half-extents (exact)
  const bx = st ? r * Math.sqrt(ca * ca + st.ratio * st.ratio * sa * sa) : r;
  const by = st ? r * Math.sqrt(sa * sa + st.ratio * st.ratio * ca * ca) : r;
  const x0 = Math.floor(d.x - bx), y0 = Math.floor(d.y - by);
  const w = Math.ceil(2 * bx) + 1, h = Math.ceil(2 * by) + 1;
  const x1 = x0 + w, y1 = y0 + h;
  if (x1 <= 0 || y1 <= 0 || x0 >= grid.width || y0 >= grid.height) return null;
  if (d.clip) {
    const cx0 = Math.max(x0, d.clip.x), cy0 = Math.max(y0, d.clip.y);
    const cx1 = Math.min(x1, d.clip.x + d.clip.w), cy1 = Math.min(y1, d.clip.y + d.clip.h);
    if (cx0 >= cx1 || cy0 >= cy1) return null;
  }

  const [cr, cg, cb] = d.color;
  // hardness is the fraction of the radius that is fully opaque, the same
  // convention retouch.ts uses — before this it was inverted here, so one
  // slider meant crisp for dodge and soft for the brush
  const inner = Math.max(0.001, r * d.hardness); // solid core radius
  const outer = r;
  // hot-loop hoists (per-dab constants)
  const r2 = outer * outer;
  const inner2 = inner >= outer ? r2 : inner * inner; // hard brush → no band
  const band = outer - inner;
  const clip = d.clip;
  const clipX0 = clip ? clip.x : 0, clipY0 = clip ? clip.y : 0;
  const clipX1 = clip ? clip.x + clip.w : 0, clipY1 = clip ? clip.y + clip.h : 0;
  const mask = d.mask;

  let touched = false;
  grid.forEachTileInRect(x0, y0, w, h, (tile, cx, cy, cw, ch, bx, by) => {
    // note the tile before its first mutation in this stroke (undo support)
    if (session) session.noteTile(bx / TILE, by / TILE, tile);
    const td = tile.data;
    for (let yy = 0; yy < ch; yy++) {
      const docY = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const docX = bx + cx + xx;
        if (clip && (docX < clipX0 || docY < clipY0 || docX >= clipX1 || docY >= clipY1)) continue;
        const dx = docX - d.x, dy = docY - d.y;
        // squared effective distance: plain disc, or tilted ellipse metric
        const d2 = st
          ? (dx * ca + dy * sa) * (dx * ca + dy * sa) + (-dx * sa + dy * ca) * (-dx * sa + dy * ca) * invRatio2
          : dx * dx + dy * dy;
        if (d2 > r2) continue; // outside disc (no sqrt needed)
        const ma = mask ? mask.alphaAt(docX, docY) : 255;
        if (ma === 0) continue;
        // soft edge: 0 at outer, 1 at inner — sqrt only inside the band
        let a: number;
        if (d2 <= inner2) {
          a = d.alpha * (ma / 255) * 255;
        } else {
          const t = 1 - (Math.sqrt(d2) - inner) / band;
          a = t * t * (3 - 2 * t) * d.alpha * (ma / 255) * 255; // smoothstep falloff
        }
        if (a <= 0) continue;
        // dual brush: the second tip multiplies coverage, so the stroke breaks
        // up where the second tip is dark instead of being one flat disc
        if (d.dual) {
          const ds = Math.max(0.05, Math.min(1, d.dualScale ?? 1));
          const span = 2 * r * ds;
          const du = ((docX - d.x) / span + 0.5) * (d.dual.w - 1);
          const dv = ((docY - d.y) / span + 0.5) * (d.dual.h - 1);
          a *= sampleTipAlpha(d.dual, du, dv) / 255;
          if (a <= 0) continue;
        }
        const tp = ((cy + yy) * TILE + cx + xx) * 4;
        compositePixel(d.mode, cr, cg, cb, a, td[tp]!, td[tp + 1]!, td[tp + 2]!, td[tp + 3]!, td, tp, docX, docY);
        touched = true;
      }
    }
    tile.version++;
  }, true);

  if (!touched) return null;
  // clamp rect to grid, then intersect with the clip (pixels outside the
  // clip were never painted, so they are not part of the affected region)
  let rx = Math.max(0, x0), ry = Math.max(0, y0);
  let rw = Math.min(grid.width, x1) - rx, rh = Math.min(grid.height, y1) - ry;
  if (d.clip) {
    const cx0 = Math.max(rx, d.clip.x), cy0 = Math.max(ry, d.clip.y);
    const cx1 = Math.min(rx + rw, d.clip.x + d.clip.w), cy1 = Math.min(ry + rh, d.clip.y + d.clip.h);
    rx = cx0; ry = cy0; rw = cx1 - cx0; rh = cy1 - cy0;
  }
  return { x: rx, y: ry, w: rw, h: rh };
}

/** bresenham-ish spaced dab positions along a segment */
export function dabPositions(
  x0: number, y0: number, x1: number, y1: number, spacing: number,
): Array<[number, number]> {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [[x1, y1]];
  const out: Array<[number, number]> = [];
  const step = Math.max(0.5, spacing);
  for (let s = 0; s <= len; s += step) {
    out.push([x0 + (dx * s) / len, y0 + (dy * s) / len]);
  }
  return out;
}
