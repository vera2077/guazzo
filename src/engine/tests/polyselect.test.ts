import { test } from "node:test";
import { strict as assert } from "node:assert";
import { polygonMask } from "../polyselect.ts";

// The polygonal lasso in the UI accumulates clicks; this module is the one
// place that turns them into a mask. The point of these tests is that a
// degenerate outline (fewer than three points, or one entirely off-canvas)
// returns null instead of replacing a real selection with an empty mask.

test("a triangle produces a filled mask with a hole-free interior", () => {
  const mask = polygonMask(40, 40, [[4, 4], [36, 4], [20, 34]]);
  assert.ok(mask);
  assert.ok(mask.alphaAt(20, 12) > 200, "the interior is selected");
  assert.equal(mask.alphaAt(2, 2), 0, "outside the triangle is not selected");
});

test("fewer than three points is refused rather than half-applied", () => {
  assert.equal(polygonMask(40, 40, []), null);
  assert.equal(polygonMask(40, 40, [[4, 4]]), null);
  assert.equal(polygonMask(40, 40, [[4, 4], [30, 4]]), null);
});

test("an outline entirely outside the document has no pixels to select", () => {
  assert.equal(polygonMask(20, 20, [[100, 100], [140, 100], [120, 140]]), null);
});

test("a degenerate outline that encloses no pixels is refused", () => {
  // Three collinear points have no area: the UI must report an empty polygon
  // rather than replace a real selection with a blank mask.
  assert.equal(polygonMask(40, 40, [[4, 4], [20, 4], [36, 4]]), null);
});
