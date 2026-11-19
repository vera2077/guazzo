/**
 * path.test.ts — pen anchors become a polyline a mask can rasterise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenPath, pathBounds, type PathAnchor } from "../path.ts";
import { SelectionMask } from "../mask.ts";

const area = (m: SelectionMask): number => {
  let sum = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) sum += m.alphaAt(x, y);
  }
  return sum / 255;
};

test("a corner path is exactly its anchors (no bulge)", () => {
  const pts = flattenPath([{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }], true);
  assert.deepEqual(pts, [[10, 10], [40, 10], [40, 40]]);
});

test("two anchors stay a straight line", () => {
  const pts = flattenPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], false);
  assert.deepEqual(pts, [[0, 0], [10, 0]]);
});

test("a closed triangle keeps its corners and adds no stray points", () => {
  const tri: PathAnchor[] = [{ x: 4, y: 4 }, { x: 36, y: 4 }, { x: 20, y: 32 }];
  const pts = flattenPath(tri, true, 4, true);
  assert.deepEqual(pts[0], [4, 4]);
  // every corner still appears in the flattened path
  for (const a of tri) {
    assert.ok(pts.some(([x, y]) => Math.abs(x - a.x) < 0.001 && Math.abs(y - a.y) < 0.001));
  }
});

test("a pen path rasterises to the right area", () => {
  // square 10..40 → 30×30 = 900 px of coverage
  const m = new SelectionMask(64, 64);
  m.selectPolygon(flattenPath([
    { x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 },
  ], true));
  const a = area(m);
  assert.ok(Math.abs(a - 900) < 40, `area ${a} should be about 900`);
});

test("smoothing a many-anchor circle stays round and inside itself", () => {
  const anchors: PathAnchor[] = [];
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * Math.PI * 2;
    anchors.push({ x: 32 + Math.cos(t) * 20, y: 32 + Math.sin(t) * 20 });
  }
  const pts = flattenPath(anchors, true, 6, true);
  const m = new SelectionMask(64, 64);
  m.selectPolygon(pts);
  const expected = Math.PI * 20 * 20;
  const got = area(m);
  assert.ok(got > expected * 0.9 && got < expected * 1.1, `circle area ${got} vs ${expected}`);
  // the centre is inside, the corners are not
  assert.ok(m.alphaAt(32, 32) > 128);
  assert.equal(m.alphaAt(1, 1), 0);
});

test("bounds cover the path plus one pixel of edge", () => {
  const b = pathBounds(flattenPath([
    { x: 5.2, y: 6.8 }, { x: 20.1, y: 30.4 }, { x: 2.5, y: 18 },
  ], true));
  assert.ok(b);
  assert.equal(b!.x, 1);          // floor(2.5) - 1
  assert.equal(b!.y, 5);          // floor(6.8) - 1
  assert.equal(b!.x + b!.w, 22);  // ceil(20.1) + 1 = 22
  assert.equal(pathBounds([]), null);
});
