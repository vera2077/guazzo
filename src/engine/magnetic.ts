/** Magnetic lasso: pull a hand-drawn outline onto the strongest nearby edge.
 *
 *  A real magnetic lasso follows edges live and decides width from local
 *  contrast. This one snaps the points you drew on release: for each point it
 *  looks in a small square for the largest colour gradient and moves the point
 *  there. Points with no edge within reach stay where they are, so an outline
 *  over flat colour is kept rather than dragged somewhere arbitrary. The
 *  options bar says "snaps after the drag" so the interaction is not a promise
 *  of live tracking.
 */
export interface Pt {
  x: number;
  y: number;
}

function lumaAt(px: Uint8ClampedArray, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  const i = (y * w + x) * 4;
  return px[i]! * 0.299 + px[i + 1]! * 0.587 + px[i + 2]! * 0.114;
}

/** Sobel magnitude at (x,y); 0 outside the image. */
export function edgeMagnitude(px: Uint8ClampedArray, w: number, h: number, x: number, y: number): number {
  // The frame is not an edge: sampling outside the image as luma 0 invents a
  // gradient all along the border, which dragged any point near it onto the
  // frame. One pixel in is the closest a 3×3 kernel can look.
  if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return 0;
  const l = (xx: number, yy: number) => lumaAt(px, w, h, xx, yy);
  const gx =
    -l(x - 1, y - 1) + l(x + 1, y - 1) +
    -2 * l(x - 1, y) + 2 * l(x + 1, y) +
    -l(x - 1, y + 1) + l(x + 1, y + 1);
  const gy =
    -l(x - 1, y - 1) - 2 * l(x, y - 1) - l(x + 1, y - 1) +
    l(x - 1, y + 1) + 2 * l(x, y + 1) + l(x + 1, y + 1);
  return Math.sqrt(gx * gx + gy * gy);
}

/** Move each point to the strongest edge within `radius` (Chebyshev square).
 *  Returns the snapped points; the input is not modified. */
export function snapToEdges(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  points: readonly Pt[],
  radius: number,
): Pt[] {
  const r = Math.max(1, Math.round(radius));
  const out: Pt[] = [];
  for (const p of points) {
    const cx = Math.round(p.x), cy = Math.round(p.y);
    let bestX = cx, bestY = cy;
    let best = edgeMagnitude(px, w, h, cx, cy);
    let bestDist = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dy === 0) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const m = edgeMagnitude(px, w, h, x, y);
        const dist = Math.abs(dx) + Math.abs(dy);
        // Equal gradients along a straight edge are everywhere; without this
        // tie-break the scan order moved the point to the corner of the search
        // square instead of the nearest edge pixel.
        if (m > best + 1e-6 || (Math.abs(m - best) <= 1e-6 && dist < bestDist)) {
          best = m;
          bestDist = dist;
          bestX = x;
          bestY = y;
        }
      }
    }
    out.push({ x: bestX, y: bestY });
  }
  return out;
}
