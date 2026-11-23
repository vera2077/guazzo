import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeMagnitude, snapToEdges } from "../magnetic.ts";

function edgeImage(w: number, h: number, edgeX: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = x < edgeX ? 0 : 255;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return px;
}

test("magnetic: a point near a hard edge moves onto it", () => {
  const px = edgeImage(32, 32, 16);
  const [p] = snapToEdges(px, 32, 32, [{ x: 18, y: 10 }], 4);
  // A central difference puts the maximum on either side of the boundary,
  // depending on rounding; both are "on the edge".
  assert.ok(p!.x === 15 || p!.x === 16, `expected the boundary column, got ${p!.x}`);
  assert.equal(p!.y, 10);
});

test("magnetic: flat colour leaves the outline alone", () => {
  const px = new Uint8ClampedArray(16 * 16 * 4).fill(200);
  const pts = [{ x: 4.2, y: 7.9 }, { x: 9, y: 2 }];
  const out = snapToEdges(px, 16, 16, pts, 3);
  assert.deepEqual(out.map((q) => [q.x, q.y]), [[4, 8], [9, 2]]);
});

test("magnetic: the edge measure rises on a boundary and is flat inside a field", () => {
  const px = edgeImage(16, 16, 8);
  assert.ok(edgeMagnitude(px, 16, 16, 8, 8) > edgeMagnitude(px, 16, 16, 4, 8));
});
