/**
 * selectops.ts — selection morphology: everything under Photoshop's
 * Select ▸ Modify menu, plus Grow and Similar.
 *
 * These work on a SelectionMask (byte coverage per pixel) and return a NEW
 * mask, so the caller can push an undoable command without worrying about
 * aliasing.
 */

import { SelectionMask } from "./mask.ts";

/** every mask op walks the same bounding box; grow it for the radius used */
function walkRect(m: SelectionMask, pad: number): { x: number; y: number; w: number; h: number } {
  const box = m.bbox();
  if (!box) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const x1 = Math.min(m.width, box.x + box.w + pad);
  const y1 = Math.min(m.height, box.y + box.h + pad);
  return { x, y, w: x1 - x, h: y1 - y };
}

function cloneMask(m: SelectionMask): SelectionMask {
  const out = new SelectionMask(m.width, m.height);
  const rect = walkRect(m, 0);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const v = m.alphaAt(x, y);
      if (v > 0) out.setAlpha(x, y, v);
    }
  }
  return out;
}

/** circular structuring element offsets, precomputed per radius */
function disc(radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) out.push([dx, dy]);
    }
  }
  return out;
}

/** Expand: grow the selection outward by `radius` pixels (max filter) */
export function expandSelection(m: SelectionMask, radius: number): SelectionMask {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return cloneMask(m);
  const rect = walkRect(m, r);
  const out = new SelectionMask(m.width, m.height);
  if (rect.w === 0) return out;
  const kern = disc(r);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      let best = 0;
      for (const [dx, dy] of kern) {
        const v = m.alphaAt(x + dx, y + dy);
        if (v > best) {
          best = v;
          if (best === 255) break;
        }
      }
      if (best > 0) out.setAlpha(x, y, best);
    }
  }
  return out;
}

/** Contract: shrink the selection inward by `radius` pixels (min filter) */
export function contractSelection(m: SelectionMask, radius: number): SelectionMask {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return cloneMask(m);
  const rect = walkRect(m, 0);
  const out = new SelectionMask(m.width, m.height);
  if (rect.w === 0) return out;
  const kern = disc(r);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      let worst = 255;
      for (const [dx, dy] of kern) {
        const nx = x + dx, ny = y + dy;
        // outside the canvas counts as unselected, which erodes the border
        const v = nx < 0 || ny < 0 || nx >= m.width || ny >= m.height ? 0 : m.alphaAt(nx, ny);
        if (v < worst) {
          worst = v;
          if (worst === 0) break;
        }
      }
      if (worst > 0) out.setAlpha(x, y, worst);
    }
  }
  return out;
}

/** Feather: a radius-N box blur applied twice, which is a cheap gaussian */
export function featherSelection(m: SelectionMask, radius: number): SelectionMask {
  const r = Math.max(1, Math.round(radius));
  const rect = walkRect(m, r * 2);
  const out = new SelectionMask(m.width, m.height);
  if (rect.w === 0) return out;
  const w = rect.w, h = rect.h;
  const src = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      src[y * w + x] = m.alphaAt(rect.x + x, rect.y + y) / 255;
    }
  }
  let buf = src;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const sx = x + k;
          if (sx < 0 || sx >= w) continue;
          sum += buf[y * w + sx]!;
          n++;
        }
        tmp[y * w + x] = sum / n;
      }
    }
    const out2 = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const sy = y + k;
          if (sy < 0 || sy >= h) continue;
          sum += tmp[sy * w + x]!;
          n++;
        }
        out2[y * w + x] = sum / n;
      }
    }
    buf = out2;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(buf[y * w + x]! * 255);
      if (v > 0) out.setAlpha(rect.x + x, rect.y + y, v);
    }
  }
  return out;
}

/** Smooth: expand then contract, which rounds off stray single pixels */
export function smoothSelection(m: SelectionMask, radius: number): SelectionMask {
  const r = Math.max(1, Math.round(radius));
  return contractSelection(expandSelection(m, r), r);
}

/**
 * Grow: expand outward but only into pixels whose colour is close to the
 * current selection's average — Photoshop's Select ▸ Grow.
 */
export function growSelection(
  m: SelectionMask,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
): SelectionMask {
  // average colour of the selected pixels
  let ar = 0, ag = 0, ab = 0, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (m.alphaAt(x, y) < 128) continue;
      const i = (y * width + x) * 4;
      ar += pixels[i]!; ag += pixels[i + 1]!; ab += pixels[i + 2]!;
      n++;
    }
  }
  const out = cloneMask(m);
  if (n === 0) return out;
  ar /= n; ag /= n; ab /= n;
  const tol = Math.max(0, tolerance);
  // one dilation pass into matching neighbours
  const rect = walkRect(m, 1);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (m.alphaAt(x, y) > 0) continue;
      let touching = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (m.alphaAt(x + dx, y + dy) > 0) {
          touching = true;
          break;
        }
      }
      if (!touching) continue;
      const nx = Math.max(0, Math.min(width - 1, x));
      const ny = Math.max(0, Math.min(height - 1, y));
      const i = (ny * width + nx) * 4;
      if (
        Math.abs(pixels[i]! - ar) <= tol &&
        Math.abs(pixels[i + 1]! - ag) <= tol &&
        Math.abs(pixels[i + 2]! - ab) <= tol
      ) {
        out.setAlpha(x, y, 255);
      }
    }
  }
  return out;
}

/**
 * Similar: select every pixel in the document close to the selection's
 * average colour, connected or not — Photoshop's Select ▸ Similar.
 */
export function similarSelection(
  m: SelectionMask,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
): SelectionMask {
  let ar = 0, ag = 0, ab = 0, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (m.alphaAt(x, y) < 128) continue;
      const i = (y * width + x) * 4;
      ar += pixels[i]!; ag += pixels[i + 1]!; ab += pixels[i + 2]!;
      n++;
    }
  }
  const out = new SelectionMask(width, height);
  if (n === 0) return cloneMask(m);
  ar /= n; ag /= n; ab /= n;
  const tol = Math.max(0, tolerance);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        Math.abs(pixels[i]! - ar) <= tol &&
        Math.abs(pixels[i + 1]! - ag) <= tol &&
        Math.abs(pixels[i + 2]! - ab) <= tol
      ) {
        out.setAlpha(x, y, 255);
      }
    }
  }
  return out;
}

/** Border: keep only a band `width` pixels wide just inside the selection edge */
export function borderSelection(m: SelectionMask, width: number): SelectionMask {
  const r = Math.max(1, Math.round(width));
  const shrunk = contractSelection(m, r);
  const out = new SelectionMask(m.width, m.height);
  const rect = walkRect(m, 0);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const outer = m.alphaAt(x, y);
      const inner = shrunk.alphaAt(x, y);
      // the band is what the selection keeps after eroding it by `width`
      if (outer > inner) out.setAlpha(x, y, outer);
    }
  }
  return out;
}

/** invert already lives on SelectionMask; re-exported here for symmetry */

/**
 * Colour Range: every pixel whose channel distance to `colour` is within
 * `fuzziness` (0..200, Photoshop's scale) becomes selected. Unlike Similar it
 * does not need an existing selection — it is the entry point.
 */
export function colourRangeSelection(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  colour: readonly [number, number, number],
  fuzziness: number,
): SelectionMask {
  const out = new SelectionMask(width, height);
  const tol = Math.max(1, Math.round((fuzziness / 200) * 255));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3]! === 0) continue;
      const d = Math.max(
        Math.abs(pixels[i]! - colour[0]),
        Math.abs(pixels[i + 1]! - colour[1]),
        Math.abs(pixels[i + 2]! - colour[2]),
      );
      if (d <= tol) out.setAlpha(x, y, 255);
    }
  }
  return out;
}
