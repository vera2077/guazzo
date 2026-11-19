/**
 * filters2.ts — the second filter family: blur, noise, distort, stylize,
 * render and "other" filters that need neighbours or noise.
 *
 * Every op reads the affected rect (plus a margin for the neighbourhood it
 * needs) into a float buffer, transforms it, and writes the result back.
 * Alpha is carried through untouched unless the filter is explicitly about
 * coverage (clouds, lens flare), so a selection edge never erodes.
 */

import { TileGrid } from "./tile.ts";
import { type PixelMask } from "./mask.ts";

export interface F2Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** read a rect with a margin, clamped to the grid; returns the expanded rect */
interface Sampled {
  data: Float32Array;
  /** expanded rect in doc coords */
  ex: number;
  ey: number;
  ew: number;
  eh: number;
}

function f2Sample(grid: TileGrid, r: F2Rect, margin: number): Sampled | null {
  const x0 = Math.max(0, Math.floor(r.x) - margin);
  const y0 = Math.max(0, Math.floor(r.y) - margin);
  const x1 = Math.min(grid.width, Math.ceil(r.x + r.w) + margin);
  const y1 = Math.min(grid.height, Math.ceil(r.y + r.h) + margin);
  const ew = x1 - x0, eh = y1 - y0;
  if (ew <= 0 || eh <= 0) return null;
  const raw = new Uint8ClampedArray(ew * eh * 4);
  grid.readRect(x0, y0, ew, eh, raw);
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw[i]!;
  return { data, ex: x0, ey: y0, ew, eh };
}

/** write a sampled buffer back, honouring the mask and rect clip */
function f2Write(
  grid: TileGrid,
  s: Sampled,
  r: F2Rect,
  mask?: PixelMask | null,
): void {
  const rx0 = Math.max(s.ex, Math.floor(r.x));
  const ry0 = Math.max(s.ey, Math.floor(r.y));
  const rx1 = Math.min(s.ex + s.ew, Math.ceil(r.x + r.w));
  const ry1 = Math.min(s.ey + s.eh, Math.ceil(r.y + r.h));
  const w = rx1 - rx0, h = ry1 - ry0;
  if (w <= 0 || h <= 0) return;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((ry0 - s.ey + y) * s.ew + (rx0 - s.ex + x)) * 4;
      const di = (y * w + x) * 4;
      out[di] = s.data[si]!;
      out[di + 1] = s.data[si + 1]!;
      out[di + 2] = s.data[si + 2]!;
      out[di + 3] = s.data[si + 3]!;
    }
  }
  if (mask) {
    // The grid still holds the original pixels here, so a masked filter can
    // blend the *filtered* result toward the untouched original by coverage.
    const orig = new Uint8ClampedArray(w * h * 4);
    grid.readRect(rx0, ry0, w, h, orig);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = mask.alphaAt(rx0 + x, ry0 + y) / 255;
        if (m >= 1) continue;
        const di = (y * w + x) * 4;
        out[di] = orig[di]! + (out[di]! - orig[di]!) * m;
        out[di + 1] = orig[di + 1]! + (out[di + 1]! - orig[di + 1]!) * m;
        out[di + 2] = orig[di + 2]! + (out[di + 2]! - orig[di + 2]!) * m;
        out[di + 3] = orig[di + 3]!;
      }
    }
  }
  grid.writeRect(rx0, ry0, w, h, out);
}

/** clamp read with edge extension */
function pxAt(s: Sampled, x: number, y: number, c: number): number {
  const xx = Math.min(s.ew - 1, Math.max(0, x));
  const yy = Math.min(s.eh - 1, Math.max(0, y));
  return s.data[(yy * s.ew + xx) * 4 + c]!;
}

// --------------------------------------------------------------- blur -----

/** one-direction box blur: Photoshop's Motion Blur (angle + distance) */
export function motionBlur(grid: TileGrid, r: F2Rect, angleDeg: number, distance: number, mask?: PixelMask | null): void {
  const dist = Math.max(1, Math.round(distance));
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a), dy = -Math.sin(a);
  const s = f2Sample(grid, r, dist);
  if (!s) return;
  const out = s.data.slice();
  const n = dist * 2 + 1;
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      // PREMULTIPLIED accumulation (same convention as resize.ts's sampler):
      // averaging straight RGBA drags rgb toward black wherever transparent
      // neighbours join the kernel — the classic dark-halo artifact (T1).
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let k = -dist; k <= dist; k++) {
        const sx = x + dx * k, sy = y + dy * k;
        const ix = Math.round(sx), iy = Math.round(sy);
        const na = pxAt(s, ix, iy, 3);
        const w = na / 255;
        ar += pxAt(s, ix, iy, 0) * w;
        ag += pxAt(s, ix, iy, 1) * w;
        ab += pxAt(s, ix, iy, 2) * w;
        aa += na;
      }
      const i = (y * s.ew + x) * 4;
      out[i + 3] = aa / n;
      const uw = aa > 0 ? 255 / aa : 0;
      out[i] = ar * uw;
      out[i + 1] = ag * uw;
      out[i + 2] = ab * uw;
    }
  }
  s.data.set(out);
  f2Write(grid, s, r, mask);
}

/** zoom blur toward the centre of the selection (Radial Blur, zoom mode) */
export function radialBlur(grid: TileGrid, r: F2Rect, amount: number, mode: "zoom" | "spin", cx?: number, cy?: number): void {
  const s = f2Sample(grid, r, 2);
  if (!s) return;
  const out = s.data.slice();
  const ox = (cx ?? r.x + r.w / 2) - s.ex;
  const oy = (cy ?? r.y + r.h / 2) - s.ey;
  const steps = 12;
  const strength = Math.max(0, Math.min(1, amount / 100)) * 0.22;
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let k = 0; k < steps; k++) {
        const t = 1 - (k / (steps - 1)) * strength;
        let sx: number, sy: number;
        if (mode === "zoom") {
          sx = ox + (x - ox) * t;
          sy = oy + (y - oy) * t;
        } else {
          // spin: rotate around the centre by up to `strength` radians
          const ang = (k / (steps - 1)) * strength;
          const cos = Math.cos(ang), sin = Math.sin(ang);
          const ddx = x - ox, ddy = y - oy;
          sx = ox + ddx * cos - ddy * sin;
          sy = oy + ddx * sin + ddy * cos;
        }
        // premultiplied accumulation - see motionBlur (T1)
        const ix = Math.round(sx), iy = Math.round(sy);
        const na = pxAt(s, ix, iy, 3);
        const w = na / 255;
        ar += pxAt(s, ix, iy, 0) * w;
        ag += pxAt(s, ix, iy, 1) * w;
        ab += pxAt(s, ix, iy, 2) * w;
        aa += na;
      }
      const i = (y * s.ew + x) * 4;
      out[i + 3] = aa / steps;
      const uw = aa > 0 ? 255 / aa : 0;
      out[i] = ar * uw;
      out[i + 1] = ag * uw;
      out[i + 2] = ab * uw;
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** separable box blur, repeated for a cheap approximation of gaussian */
export function boxBlur(grid: TileGrid, r: F2Rect, radius: number, iterations = 2, mask?: PixelMask | null): void {
  const rad = Math.max(1, Math.round(radius));
  const s = f2Sample(grid, r, rad * iterations);
  if (!s) return;
  for (let it = 0; it < iterations; it++) {
    const tmp = new Float32Array(s.data.length);
    // horizontal
    for (let y = 0; y < s.eh; y++) {
      for (let x = 0; x < s.ew; x++) {
        let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
        for (let k = -rad; k <= rad; k++) {
          const sx = x + k;
          if (sx < 0 || sx >= s.ew) continue;
          const i = (y * s.ew + sx) * 4;
          const na = s.data[i + 3]!; const w = na / 255;
          ar += s.data[i]! * w; ag += s.data[i + 1]! * w; ab += s.data[i + 2]! * w; aa += na;
          n++;
        }
        const i = (y * s.ew + x) * 4;
        const uw = aa > 0 ? 255 / aa : 0; // un-premultiply (T1)
        tmp[i] = ar * uw; tmp[i + 1] = ag * uw; tmp[i + 2] = ab * uw; tmp[i + 3] = aa / n;
      }
    }
    // vertical (in place on tmp → data)
    for (let y = 0; y < s.eh; y++) {
      for (let x = 0; x < s.ew; x++) {
        let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
        for (let k = -rad; k <= rad; k++) {
          const sy = y + k;
          if (sy < 0 || sy >= s.eh) continue;
          const i = (sy * s.ew + x) * 4;
          const na = tmp[i + 3]!; const w = na / 255;
          ar += tmp[i]! * w; ag += tmp[i + 1]! * w; ab += tmp[i + 2]! * w; aa += na;
          n++;
        }
        const i = (y * s.ew + x) * 4;
        const uw = aa > 0 ? 255 / aa : 0; // un-premultiply (T1)
        s.data[i] = ar * uw; s.data[i + 1] = ag * uw; s.data[i + 2] = ab * uw; s.data[i + 3] = aa / n;
      }
    }
  }
  f2Write(grid, s, r, mask);
}

// -------------------------------------------------------------- noise -----

/** median filter: kills salt-and-pepper noise (Noise ▸ Median) */
export function medianFilter(grid: TileGrid, r: F2Rect, radius = 1, mask?: PixelMask | null): void {
  const rad = Math.max(1, Math.round(radius));
  const s = f2Sample(grid, r, rad);
  if (!s) return;
  const out = s.data.slice();
  const win: number[] = [];
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      win.length = 0;
      for (let ky = -rad; ky <= rad; ky++) {
        for (let kx = -rad; kx <= rad; kx++) {
          win.push(pxAt(s, x + kx, y + ky, 0));
        }
      }
      win.sort((a, b) => a - b);
      const mr = win[win.length >> 1]!;
      win.length = 0;
      for (let ky = -rad; ky <= rad; ky++) {
        for (let kx = -rad; kx <= rad; kx++) win.push(pxAt(s, x + kx, y + ky, 1));
      }
      win.sort((a, b) => a - b);
      const mg = win[win.length >> 1]!;
      win.length = 0;
      for (let ky = -rad; ky <= rad; ky++) {
        for (let kx = -rad; kx <= rad; kx++) win.push(pxAt(s, x + kx, y + ky, 2));
      }
      win.sort((a, b) => a - b);
      const mb = win[win.length >> 1]!;
      const i = (y * s.ew + x) * 4;
      out[i] = mr; out[i + 1] = mg; out[i + 2] = mb;
    }
  }
  s.data.set(out);
  f2Write(grid, s, r, mask);
}

/** Dust & Scratches: median with a smaller window, useful on flat areas */
export function dustScratches(grid: TileGrid, r: F2Rect, radius = 1, mask?: PixelMask | null): void {
  medianFilter(grid, r, radius, mask);
}

// ----------------------------------------------------------- distort -----

/** Pinch / Spherize style lens warp around the rect centre */
export function spherize(grid: TileGrid, r: F2Rect, amount: number, mode: "pinch" | "spherize" = "spherize"): void {
  const s = f2Sample(grid, r, 1);
  if (!s) return;
  const cx = s.ew / 2, cy = s.eh / 2;
  const rad = Math.min(cx, cy);
  const strength = Math.max(-100, Math.min(100, amount)) / 100;
  const out = s.data.slice();
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      const dx = (x - cx) / rad, dy = (y - cy) / rad;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const d = Math.sqrt(d2);
      let nd: number;
      if (mode === "pinch") {
        nd = Math.pow(d, 1 + strength * 1.2);
      } else {
        // spherize: bulge outward (or inward for a negative amount)
        nd = d === 0 ? 0 : Math.pow(d, 1 - strength * 0.9);
      }
      const sx = cx + (d === 0 ? 0 : (dx / d) * nd * rad);
      const sy = cy + (d === 0 ? 0 : (dy / d) * nd * rad);
      const i = (y * s.ew + x) * 4;
      out[i] = pxAt(s, Math.round(sx), Math.round(sy), 0);
      out[i + 1] = pxAt(s, Math.round(sx), Math.round(sy), 1);
      out[i + 2] = pxAt(s, Math.round(sx), Math.round(sy), 2);
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** Twirl: rotate pixels around the centre, with an angle that decays outward */
export function twirl(grid: TileGrid, r: F2Rect, angleDeg: number): void {
  const s = f2Sample(grid, r, 1);
  if (!s) return;
  const cx = s.ew / 2, cy = s.eh / 2;
  const rad = Math.min(cx, cy);
  const max = (angleDeg * Math.PI) / 180;
  const out = s.data.slice();
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy) / rad;
      if (d >= 1) continue;
      const ang = max * (1 - d) * (1 - d);
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const sx = cx + dx * cos - dy * sin;
      const sy = cy + dx * sin + dy * cos;
      const i = (y * s.ew + x) * 4;
      out[i] = pxAt(s, Math.round(sx), Math.round(sy), 0);
      out[i + 1] = pxAt(s, Math.round(sx), Math.round(sy), 1);
      out[i + 2] = pxAt(s, Math.round(sx), Math.round(sy), 2);
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** Ripple: sinusoidal displacement, Photoshop's default pond ripples */
export function ripple(grid: TileGrid, r: F2Rect, amount = 10, wavelength = 30, phase = 0): void {
  const s = f2Sample(grid, r, Math.ceil(amount) + 1);
  if (!s) return;
  const out = s.data.slice();
  const k = (Math.PI * 2) / Math.max(2, wavelength);
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      const offX = Math.sin((y + phase) * k) * amount;
      const offY = Math.cos((x + phase) * k) * amount;
      const i = (y * s.ew + x) * 4;
      out[i] = pxAt(s, Math.round(x + offX), Math.round(y + offY), 0);
      out[i + 1] = pxAt(s, Math.round(x + offX), Math.round(y + offY), 1);
      out[i + 2] = pxAt(s, Math.round(x + offX), Math.round(y + offY), 2);
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** Wave: horizontal band displacement with a chosen amplitude */
export function wave(grid: TileGrid, r: F2Rect, amplitude = 10, wavelength = 60, phase = 0): void {
  const s = f2Sample(grid, r, Math.ceil(amplitude) + 1);
  if (!s) return;
  const out = s.data.slice();
  const k = (Math.PI * 2) / Math.max(2, wavelength);
  for (let y = 0; y < s.eh; y++) {
    const off = Math.sin((y + phase) * k) * amplitude;
    for (let x = 0; x < s.ew; x++) {
      const i = (y * s.ew + x) * 4;
      out[i] = pxAt(s, Math.round(x + off), y, 0);
      out[i + 1] = pxAt(s, Math.round(x + off), y, 1);
      out[i + 2] = pxAt(s, Math.round(x + off), y, 2);
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** Polar Coordinates: rect ↔ polar */
export function polarCoordinates(grid: TileGrid, r: F2Rect, mode: "rect-to-polar" | "polar-to-rect"): void {
  const s = f2Sample(grid, r, 1);
  if (!s) return;
  const cx = s.ew / 2, cy = s.eh / 2;
  const out = s.data.slice();
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      const i = (y * s.ew + x) * 4;
      let sx: number, sy: number;
      if (mode === "polar-to-rect") {
        // x becomes angle, y becomes radius
        const ang = (x / s.ew) * Math.PI * 2;
        const rad = (y / s.eh) * cy;
        sx = cx + Math.cos(ang) * rad;
        sy = cy + Math.sin(ang) * rad;
      } else {
        const dx = x - cx, dy = y - cy;
        const ang = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
        const rad = Math.hypot(dx, dy);
        sx = ang * s.ew;
        sy = (rad / cy) * s.eh;
      }
      out[i] = pxAt(s, Math.round(sx), Math.round(sy), 0);
      out[i + 1] = pxAt(s, Math.round(sx), Math.round(sy), 1);
      out[i + 2] = pxAt(s, Math.round(sx), Math.round(sy), 2);
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

// ---------------------------------------------------------- stylize -----

/** Sobel edge magnitude (Find Edges) */
export function findEdges(grid: TileGrid, r: F2Rect, mask?: PixelMask | null): void {
  const s = f2Sample(grid, r, 1);
  if (!s) return;
  const out = new Float32Array(s.data.length);
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      let mr = 0, mg = 0, mb = 0;
      for (let c = 0; c < 3; c++) {
        let sx = 0, sy = 0, k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const v = pxAt(s, x + kx, y + ky, c);
            sx += v * gx[k]!;
            sy += v * gy[k]!;
            k++;
          }
        }
        const mag = Math.min(255, Math.hypot(sx, sy));
        if (c === 0) mr = mag; else if (c === 1) mg = mag; else mb = mag;
      }
      const i = (y * s.ew + x) * 4;
      out[i] = 255 - mr; // Photoshop shows white edges on black
      out[i + 1] = 255 - mg;
      out[i + 2] = 255 - mb;
      out[i + 3] = s.data[i + 3]!;
    }
  }
  s.data.set(out);
  f2Write(grid, s, r, mask);
}

/** Emboss with a selectable light angle */
export function emboss(grid: TileGrid, r: F2Rect, angleDeg = 135, height = 3, amount = 100): void {
  const s = f2Sample(grid, r, Math.ceil(height));
  if (!s) return;
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a) * height, dy = -Math.sin(a) * height;
  const out = new Float32Array(s.data.length);
  const scale = amount / 100;
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      const i = (y * s.ew + x) * 4;
      const base = (pxAt(s, x, y, 0) + pxAt(s, x, y, 1) + pxAt(s, x, y, 2)) / 3;
      const lifted =
        (pxAt(s, Math.round(x + dx), Math.round(y + dy), 0) +
          pxAt(s, Math.round(x + dx), Math.round(y + dy), 1) +
          pxAt(s, Math.round(x + dx), Math.round(y + dy), 2)) / 3;
      const v = 128 + (lifted - base) * scale;
      out[i] = v; out[i + 1] = v; out[i + 2] = v;
      out[i + 3] = s.data[i + 3]!;
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** Solarize: invert everything above the threshold */
export function solarize(grid: TileGrid, r: F2Rect, threshold = 128): void {
  const s = f2Sample(grid, r, 0);
  if (!s) return;
  for (let i = 0; i < s.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = s.data[i + c]!;
      if (v > threshold) s.data[i + c] = 255 - v;
    }
  }
  f2Write(grid, s, r);
}

/** Trace Contour: mark pixels that cross a level */
export function traceContour(grid: TileGrid, r: F2Rect, level = 128): void {
  const s = f2Sample(grid, r, 1);
  if (!s) return;
  const out = new Float32Array(s.data.length);
  const lum = (x: number, y: number): number =>
    pxAt(s, x, y, 0) * 0.3 + pxAt(s, x, y, 1) * 0.59 + pxAt(s, x, y, 2) * 0.11;
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      const here = lum(x, y);
      const neighbours = [lum(x + 1, y), lum(x - 1, y), lum(x, y + 1), lum(x, y - 1)];
      const crosses = neighbours.some((n) => (here < level) !== (n < level));
      const i = (y * s.ew + x) * 4;
      const v = crosses ? 255 : 0;
      out[i] = v; out[i + 1] = v; out[i + 2] = v;
      out[i + 3] = s.data[i + 3]!;
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

// ------------------------------------------------------------- render -----

/** deterministic value-noise clouds, seeded so results are reproducible */
export function clouds(grid: TileGrid, r: F2Rect, seed = 1, opacity = 1, mode: "clouds" | "difference" = "clouds"): void {
  const s = f2Sample(grid, r, 0);
  if (!s) return;
  let state = (seed >>> 0) || 1;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  // coarse lattice, bilinear upsampled, two octaves
  const gridSize = 16;
  const lattice = new Float32Array((gridSize + 1) * (gridSize + 1));
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand() * 255;
  const sample = (fx: number, fy: number): number => {
    const gx = fx * gridSize, gy = fy * gridSize;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = gx - x0, ty = gy - y0;
    const at = (x: number, y: number): number =>
      lattice[Math.min(gridSize, y) * (gridSize + 1) + Math.min(gridSize, x)]!;
    const a = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const b = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return a * (1 - ty) + b * ty;
  };
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      const fx = x / Math.max(1, s.ew - 1), fy = y / Math.max(1, s.eh - 1);
      const v = (sample(fx, fy) * 0.65 + sample(fx * 2.7, fy * 2.7) * 0.35) * opacity;
      const i = (y * s.ew + x) * 4;
      const c = Math.max(0, Math.min(255, v));
      if (mode === "difference") {
        s.data[i] = Math.abs(s.data[i]! - c);
        s.data[i + 1] = Math.abs(s.data[i + 1]! - c);
        s.data[i + 2] = Math.abs(s.data[i + 2]! - c);
      } else {
        s.data[i] = c; s.data[i + 1] = c; s.data[i + 2] = c;
      }
    }
  }
  f2Write(grid, s, r);
}

/** Lens Flare: a bright core plus a faint ring, screen-blended */
export function lensFlare(grid: TileGrid, r: F2Rect, cx: number, cy: number, brightness = 100): void {
  const s = f2Sample(grid, r, 0);
  if (!s) return;
  const lx = cx - s.ex, ly = cy - s.ey;
  const radius = Math.max(40, Math.min(s.ew, s.eh) * 0.28);
  const k = Math.max(0, Math.min(200, brightness)) / 100;
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      const d = Math.hypot(x - lx, y - ly);
      if (d > radius * 2.2) continue;
      const core = Math.max(0, 1 - d / (radius * 0.22)) ** 2;
      const ring = Math.max(0, 1 - Math.abs(d - radius * 0.8) / (radius * 0.35)) * 0.32;
      const streak = Math.max(0, 1 - Math.abs(y - ly) / 2.5) * Math.max(0, 1 - d / (radius * 2)) * 0.4;
      const add = Math.min(255, (core * 255 + ring * 255 + streak * 255) * k);
      if (add <= 0) continue;
      const i = (y * s.ew + x) * 4;
      // screen blend keeps highlights from clipping to pure white too early
      for (let c = 0; c < 3; c++) {
        s.data[i + c] = 255 - ((255 - s.data[i + c]!) * (255 - add)) / 255;
      }
    }
  }
  f2Write(grid, s, r);
}

/** Oil Paint: dominant colour in a small disc (k-means-lite) */
export function oilPaint(grid: TileGrid, r: F2Rect, radius = 4, levels = 12): void {
  const rad = Math.max(1, Math.round(radius));
  const s = f2Sample(grid, r, rad);
  if (!s) return;
  const out = s.data.slice();
  const bin: number[] = new Array(levels * levels * levels).fill(0);
  const sumR: number[] = new Array(bin.length).fill(0);
  const sumG: number[] = new Array(bin.length).fill(0);
  const sumB: number[] = new Array(bin.length).fill(0);
  const q = 256 / levels;
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      bin.fill(0); sumR.fill(0); sumG.fill(0); sumB.fill(0);
      for (let ky = -rad; ky <= rad; ky++) {
        for (let kx = -rad; kx <= rad; kx++) {
          if (kx * kx + ky * ky > rad * rad) continue;
          const rr = pxAt(s, x + kx, y + ky, 0);
          const gg = pxAt(s, x + kx, y + ky, 1);
          const bb = pxAt(s, x + kx, y + ky, 2);
          const idx =
            Math.min(levels - 1, Math.floor(rr / q)) * levels * levels +
            Math.min(levels - 1, Math.floor(gg / q)) * levels +
            Math.min(levels - 1, Math.floor(bb / q));
          bin[idx]!++;
          sumR[idx]! += rr; sumG[idx]! += gg; sumB[idx]! += bb;
        }
      }
      let best = 0, bestCount = -1;
      for (let i = 0; i < bin.length; i++) {
        if (bin[i]! > bestCount) { bestCount = bin[i]!; best = i; }
      }
      const n = Math.max(1, bin[best]!);
      const i4 = (y * s.ew + x) * 4;
      out[i4] = sumR[best]! / n;
      out[i4 + 1] = sumG[best]! / n;
      out[i4 + 2] = sumB[best]! / n;
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

// -------------------------------------------------------------- other -----

/** High Pass: grey 128 plus the difference from a blurred copy */
export function highPass(grid: TileGrid, r: F2Rect, radius = 10): void {
  const s = f2Sample(grid, r, radius);
  if (!s) return;
  const blurred = new Float32Array(s.data.length);
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      let ar = 0, ag = 0, ab = 0, n = 0;
      for (let ky = -radius; ky <= radius; ky += Math.max(1, Math.floor(radius / 2))) {
        for (let kx = -radius; kx <= radius; kx += Math.max(1, Math.floor(radius / 2))) {
          ar += pxAt(s, x + kx, y + ky, 0);
          ag += pxAt(s, x + kx, y + ky, 1);
          ab += pxAt(s, x + kx, y + ky, 2);
          n++;
        }
      }
      const i = (y * s.ew + x) * 4;
      blurred[i] = ar / n; blurred[i + 1] = ag / n; blurred[i + 2] = ab / n; blurred[i + 3] = s.data[i + 3]!;
    }
  }
  for (let i = 0; i < s.data.length; i += 4) {
    s.data[i] = 128 + (s.data[i]! - blurred[i]!);
    s.data[i + 1] = 128 + (s.data[i + 1]! - blurred[i + 1]!);
    s.data[i + 2] = 128 + (s.data[i + 2]! - blurred[i + 2]!);
  }
  f2Write(grid, s, r);
}

/** Offset: wrap the pixels by (dx, dy) */
export function offsetFilter(grid: TileGrid, r: F2Rect, dx: number, dy: number): void {
  const s = f2Sample(grid, r, 0);
  if (!s) return;
  const out = s.data.slice();
  const w = Math.round(r.w), h = Math.round(r.h);
  const ox = Math.round(r.x) - s.ex, oy = Math.round(r.y) - s.ey;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (((x - dx) % w) + w) % w;
      const sy = (((y - dy) % h) + h) % h;
      const si = ((oy + sy) * s.ew + ox + sx) * 4;
      const di = ((oy + y) * s.ew + ox + x) * 4;
      out[di] = s.data[si]!;
      out[di + 1] = s.data[si + 1]!;
      out[di + 2] = s.data[si + 2]!;
      out[di + 3] = s.data[si + 3]!;
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** Minimum / Maximum (grow highlights / shadows by a radius) */
export function minMax(grid: TileGrid, r: F2Rect, radius = 1, mode: "minimum" | "maximum" = "maximum"): void {
  const rad = Math.max(1, Math.round(radius));
  const s = f2Sample(grid, r, rad);
  if (!s) return;
  const out = s.data.slice();
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      for (let c = 0; c < 3; c++) {
        let best = mode === "maximum" ? -1 : 256;
        for (let ky = -rad; ky <= rad; ky++) {
          for (let kx = -rad; kx <= rad; kx++) {
            if (kx * kx + ky * ky > rad * rad) continue;
            const v = pxAt(s, x + kx, y + ky, c);
            if (mode === "maximum" ? v > best : v < best) best = v;
          }
        }
        out[(y * s.ew + x) * 4 + c] = best;
      }
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** Custom convolution (Photoshop's Custom filter) */
export function customKernel(grid: TileGrid, r: F2Rect, kernel: readonly number[], divisor = 1, offset = 0): void {
  const size = Math.round(Math.sqrt(kernel.length));
  if (size * size !== kernel.length) throw new Error("customKernel: kernel must be square");
  const rad = Math.floor(size / 2);
  const div = divisor === 0 ? 1 : divisor;
  const s = f2Sample(grid, r, rad);
  if (!s) return;
  const out = s.data.slice();
  for (let y = 0; y < s.eh; y++) {
    for (let x = 0; x < s.ew; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let k = 0;
        for (let ky = -rad; ky <= rad; ky++) {
          for (let kx = -rad; kx <= rad; kx++) {
            sum += pxAt(s, x + kx, y + ky, c) * (kernel[k++] ?? 0);
          }
        }
        out[(y * s.ew + x) * 4 + c] = sum / div + offset;
      }
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** Crystallize / pointillize style mosaic with irregular cells */
export function crystallize(grid: TileGrid, r: F2Rect, cell = 10): void {
  const size = Math.max(2, Math.round(cell));
  const s = f2Sample(grid, r, 0);
  if (!s) return;
  const out = s.data.slice();
  for (let by = 0; by < s.eh; by += size) {
    for (let bx = 0; bx < s.ew; bx += size) {
      // pick the cell's centre colour, then scatter it over the cell
      const cx = Math.min(s.ew - 1, bx + (size >> 1));
      const cy = Math.min(s.eh - 1, by + (size >> 1));
      const c0 = pxAt(s, cx, cy, 0), c1 = pxAt(s, cx, cy, 1), c2 = pxAt(s, cx, cy, 2);
      for (let y = by; y < Math.min(s.eh, by + size); y++) {
        for (let x = bx; x < Math.min(s.ew, bx + size); x++) {
          const i = (y * s.ew + x) * 4;
          out[i] = c0; out[i + 1] = c1; out[i + 2] = c2;
        }
      }
    }
  }
  s.data.set(out);
  f2Write(grid, s, r);
}

/** keep the module honest about the tile size it assumes for writes */
