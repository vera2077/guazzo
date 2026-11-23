/**
 * Polygon → selection mask.
 *
 * The polygonal lasso accumulates its corner points in the UI, but turning a
 * point list into an antialiased mask is the same fill the pen path uses. It
 * lives here so the UI helper does not have to own document dimensions or the
 * mask constructor — a mask with no enclosed pixels stays `null` rather than
 * replacing a real selection with an empty one.
 */
import { SelectionMask } from "./mask.ts";

export function polygonMask(
  width: number,
  height: number,
  points: readonly (readonly [number, number])[],
  rule: "nonzero" | "evenodd" = "nonzero",
): SelectionMask | null {
  if (points.length < 3) return null;
  const next = new SelectionMask(width, height);
  const pts = points.map((p) => [p[0], p[1]] as [number, number]);
  return next.selectPolygon(pts, rule) ? next : null;
}
