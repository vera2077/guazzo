/**
 * rotateview.ts — pure screen-space math for rotating the document view.
 *
 * Positive `degrees` rotates the view clockwise as seen on screen. Screen y
 * grows downward, so the trig signs are the mirror of the usual map convention:
 * at 90° a point to the right of the pivot ends up below it. Everything here is
 * deterministic and DOM-free so the canvas controller and node:test can share
 * the exact same maths.
 */

export type ViewPoint = { x: number; y: number };
export type ViewRect = { x: number; y: number; w: number; h: number };

/** Rotate `p` clockwise by `degrees` around `centre` (screen coordinates). */
export function rotateViewPoint(p: ViewPoint, centre: ViewPoint, degrees: number): ViewPoint {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return {
    x: centre.x + dx * cos - dy * sin,
    y: centre.y + dx * sin + dy * cos,
  };
}

/** Exact inverse of `rotateViewPoint`: the same rotation, negated angle. */
export function unrotateViewPoint(p: ViewPoint, centre: ViewPoint, degrees: number): ViewPoint {
  return rotateViewPoint(p, centre, -degrees);
}

/** Axis-aligned bounding box of the four rotated corners; x/y is the min corner. */
export function rotateViewRect(r: ViewRect, centre: ViewPoint, degrees: number): ViewRect {
  const corners: ViewPoint[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const q = rotateViewPoint(corner, centre, degrees);
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Snap an angle to the nearest 15° step, wrapped into [0, 360). */
export function viewAngleSteps(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  const steps = Math.round(wrapped / 15);
  return (((steps % 24) + 24) % 24) * 15;
}
