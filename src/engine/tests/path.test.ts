/**
 * path.test.ts — pen anchors become a polyline a mask can rasterise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenPath, pathBounds, penHandleFor, type PathAnchor } from "../path.ts";
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

test("a dragged handle curves the segment it belongs to, and only that one", () => {
  // Two-segment path: the middle anchor gets an outward handle in +y.
  const anchors = [
    { x: 0, y: 0 },
    { x: 20, y: 0, hx: 0, hy: 12 },
    { x: 40, y: 0 },
  ];
  const pts = flattenPath(anchors, false);
  const nearFirst = pts.filter(([x]) => x > 4 && x < 16);
  const nearSecond = pts.filter(([x]) => x > 24 && x < 36);
  // The handle pulls the incoming side of the segment in -y and the outgoing
  // side in +y, so the two halves bulge in opposite directions.
  assert.ok(Math.min(...nearFirst.map(([, y]) => y)) < -4, "the first segment must bulge out");
  assert.ok(Math.max(...nearSecond.map(([, y]) => y)) > 4, "the second segment must bulge the other way");
  // endpoints stay exact
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[pts.length - 1], [40, 0]);
});

test("zero handles keep the straight-corner behaviour", () => {
  const zig = [
    { x: 0, y: 0, hx: 0, hy: 0 },
    { x: 10, y: 10 },
    { x: 20, y: 0 },
  ];
  assert.deepEqual(flattenPath(zig, false), [[0, 0], [10, 10], [20, 0]]);
});

test("penHandleFor: a drag bends the anchor, wobble keeps it a corner", () => {
  const a = { x: 10, y: 10 };
  // A click wobbles a pixel or two; smoothing that would destroy a sharp corner.
  assert.deepEqual(penHandleFor(a, 1, -2), a, "a 2.2px wobble must not add a handle");
  assert.equal(penHandleFor(a, 3, 0).hx, undefined, "exactly at the threshold stays a corner");
  const bent = penHandleFor(a, 20, -5);
  assert.equal(bent.hx, 20);
  assert.equal(bent.hy, -5);
  assert.equal(bent.x, 10, "the anchor itself does not move");
  // A handled anchor then flattens into a curve, not the straight segment.
  const curve = flattenPath([{ x: 0, y: 0 }, bent, { x: 40, y: 10 }], false);
  assert.ok(curve.length > 20, `a handled path must flatten into segments (got ${curve.length})`);
  const straight = flattenPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 10 }], false);
  assert.equal(straight.length, 3, "corner anchors stay verbatim");
});

test("a handle can be retracted back to a corner", () => {
  // AP3: under PEN_DRAG_MIN the old code returned the anchor unchanged, so
  // dragging a long handle back onto its anchor kept the handle forever.
  const a: PathAnchor = { x: 10, y: 10, hx: 40, hy: 0 };
  const bent = penHandleFor(a, 60, 0);
  assert.equal(bent.hx, 60);
  const retracted = penHandleFor(bent, 1, 1);
  assert.equal(retracted.hx, undefined, "a small drag on an existing handle clears it");
  assert.equal(retracted.hy, undefined);
  // a small drag on a corner anchor still creates nothing
  const corner: PathAnchor = { x: 4, y: 4 };
  assert.equal(penHandleFor(corner, 1, 0).hx, undefined);
  assert.equal(penHandleFor(corner, 30, 0).hx, 30);
});
