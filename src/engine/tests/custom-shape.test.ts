import { test } from "node:test";
import assert from "node:assert/strict";

import { drawShape, shapePolyline, shapeSelection } from "../shapes.ts";
import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import { eq } from "./helpers.ts";

const BOX = { x0: 10, y0: 10, x1: 90, y1: 90 } as const;

/** Alpha of a single document pixel. */
function alphaAt(g: TileGrid, x: number, y: number): number {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return out[3]!;
}

test("heart polyline is smooth, stays inside its box, and is symmetric about the box centre", () => {
  const pts = shapePolyline({ kind: "heart", ...BOX });
  assert.ok(pts, "heart must expose an outline polyline");
  const outline = pts!;
  assert.ok(outline.length >= 24, `expected at least 24 points, got ${outline.length}`);

  const cx = (BOX.x0 + BOX.x1) / 2;
  const eps = 1e-6;
  for (const [x, y] of outline) {
    assert.ok(x >= BOX.x0 - eps && x <= BOX.x1 + eps, `x=${x} outside the box`);
    assert.ok(y >= BOX.y0 - eps && y <= BOX.y1 + eps, `y=${y} outside the box`);
    // Mirror across the vertical line through the box centre — the heart's
    // axis of symmetry. (A heart is not symmetric under 180° rotation, so
    // "symmetric about the centre" is checked as left/right mirror symmetry.)
    const mx = 2 * cx - x;
    assert.ok(
      outline.some(([qx, qy]) => Math.abs(qx - mx) <= eps && Math.abs(qy - y) <= eps),
      `no mirror point for (${x}, ${y}) about x=${cx}`,
    );
  }

  // The outline really spans the box: lobes reach the top, cusp the bottom.
  assert.ok(Math.min(...outline.map((p) => p[1])) <= BOX.y0 + eps, "lobes must reach the top edge");
  assert.ok(Math.max(...outline.map((p) => p[1])) >= BOX.y1 - eps, "cusp must reach the bottom edge");
});

test("heart geometry is deterministic and ignores polygon-only knobs", () => {
  const plain = shapePolyline({ kind: "heart", ...BOX });
  const knobbed = shapePolyline({ kind: "heart", ...BOX, sides: 3, innerRatio: 0.9, radius: 99 });
  assert.deepEqual(knobbed, plain);
});

test("drawShape fills the heart centre, leaves the outer corner empty, and is not a rectangle", () => {
  const g = new TileGrid(120, 120);
  const area = drawShape(g, { kind: "heart", ...BOX, fill: [255, 0, 0] });
  assert.ok(area);
  eq(alphaAt(g, 50, 50), 255);

  // The corner is where a heart and a rectangle of the same bbox disagree.
  eq(alphaAt(g, 11, 11), 0);

  // This pair is the guard that fails if "heart" were silently rasterised as
  // a rectangle: the same pixel is fully covered by the rectangle.
  const rectGrid = new TileGrid(120, 120);
  drawShape(rectGrid, { kind: "rectangle", ...BOX, fill: [255, 0, 0] });
  assert.equal(alphaAt(rectGrid, 11, 11), 255, "rectangle must cover that corner");
  assert.notEqual(alphaAt(g, 11, 11), alphaAt(rectGrid, 11, 11), "heart outline must actually be used");
});

test("shapeSelection follows the heart outline rather than the bounding box", () => {
  const m = new SelectionMask(120, 120);
  shapeSelection(120, 120, { kind: "heart", ...BOX }, m);
  eq(m.alphaAt(50, 50), 255);
  eq(m.alphaAt(11, 11), 0);

  const rect = new SelectionMask(120, 120);
  rect.selectRect(BOX.x0, BOX.y0, BOX.x1 - BOX.x0, BOX.y1 - BOX.y0);
  eq(rect.alphaAt(11, 11), 255);
});
