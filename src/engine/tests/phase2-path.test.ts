/**
 * phase2-path.test.ts — additive, pure path helper exports (no DOM, no shared
 * helpers mutated). Verifies neighbour-derived handles, rect selection, and
 * partial anchor translation without input mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  curvatureHandleAnchors,
  pathAnchorsInRect,
  movePathAnchors,
  type PathAnchor,
} from "../path.ts";

const copy = (a: readonly PathAnchor[]): PathAnchor[] => a.map((p) => ({ ...p }));

test("curvatureHandleAnchors: 3 anchors in a straight line get symmetric horizontal handles", () => {
  const line: PathAnchor[] = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }];
  const out = curvatureHandleAnchors(line);
  // interior: prev (0,0), next (60,0) -> ((60-0)/6, (0-0)/6) = (10, 0)
  assert.equal(out[1]!.hx, 10);
  assert.equal(out[1]!.hy, 0);
  // endpoints use the single available neighbour plus self
  assert.equal(out[0]!.hx, 5); // (30-0)/6
  assert.equal(out[0]!.hy, 0);
  assert.equal(out[2]!.hx, 5); // (60-30)/6
  assert.equal(out[2]!.hy, 0);
  for (const a of out) assert.equal(a.hy, 0, "handles stay horizontal on a straight line");
  assert.notStrictEqual(out, line, "fresh array");
  assert.notStrictEqual(out[1], line[1], "fresh objects");
  assert.deepEqual(line, [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }], "input untouched");
});

test("curvatureHandleAnchors: endpoints derive from one neighbour", () => {
  const tri: PathAnchor[] = [{ x: 0, y: 0 }, { x: 12, y: 6 }, { x: 24, y: 0 }];
  const out = curvatureHandleAnchors(tri);
  // first: only next (12,6) -> ((12-0)/6, (6-0)/6) = (2, 1)
  assert.equal(out[0]!.hx, 2);
  assert.equal(out[0]!.hy, 1);
  // last: only prev (12,6) -> ((24-12)/6, (0-6)/6) = (2, -1)
  assert.equal(out[2]!.hx, 2);
  assert.equal(out[2]!.hy, -1);
  // middle uses both -> ((24-0)/6, (0-0)/6) = (4, 0)
  assert.equal(out[1]!.hx, 4);
  assert.equal(out[1]!.hy, 0);
  assert.deepEqual(tri, [{ x: 0, y: 0 }, { x: 12, y: 6 }, { x: 24, y: 0 }]);
});

test("curvatureHandleAnchors: a single anchor keeps no handles; empty stays empty", () => {
  const one: PathAnchor[] = [{ x: 5, y: 7, hx: 99, hy: -99 }];
  const out = curvatureHandleAnchors(one);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.hx, undefined);
  assert.equal(out[0]!.hy, undefined);
  assert.equal(one[0]!.hx, 99, "input untouched");
  assert.deepEqual(curvatureHandleAnchors([]), []);
});

test("pathAnchorsInRect selects only the anchors inside the rect, in order", () => {
  const pts: PathAnchor[] = [
    { x: 5, y: 5 },    // 0 inside
    { x: 15, y: 5 },   // 1 inside
    { x: 50, y: 5 },   // outside in x
    { x: 15, y: 25 },  // 3 inside
    { x: 5, y: 50 },   // outside in y
    { x: 18, y: 18 },  // 5 inside
  ];
  assert.deepEqual(pathAnchorsInRect(pts, { x: 0, y: 0, w: 20, h: 30 }), [0, 1, 3, 5]);
  // inclusive bounds
  assert.deepEqual(
    pathAnchorsInRect([{ x: 20, y: 30 }, { x: 21, y: 30 }], { x: 0, y: 0, w: 20, h: 30 }),
    [0],
  );
  assert.deepEqual(pathAnchorsInRect([], { x: 0, y: 0, w: 20, h: 30 }), []);
});

test("movePathAnchors moves only selected anchors, preserves hx/hy, never mutates input", () => {
  const input: PathAnchor[] = [
    { x: 0, y: 0, hx: 2, hy: -1 },
    { x: 10, y: 0, hx: 3, hy: 4 },
    { x: 20, y: 0, hx: -2, hy: 5 },
    { x: 30, y: 0 },
  ];
  const snapshot = copy(input);
  const out = movePathAnchors(input, [1, 3], 7, -4);

  // selected anchors moved by exactly (dx, dy)
  assert.equal(out[1]!.x, 17);
  assert.equal(out[1]!.y, -4);
  assert.equal(out[3]!.x, 37);
  assert.equal(out[3]!.y, -4);

  // CRITICAL: unselected anchors must NOT move. These assertions fail if the
  // delta were applied to every anchor instead of only the listed indices.
  assert.equal(out[0]!.x, 0, "unselected anchor must not move (fails on move-all)");
  assert.equal(out[0]!.y, 0, "unselected anchor must not move (fails on move-all)");
  assert.equal(out[2]!.x, 20, "unselected anchor must not move (fails on move-all)");
  assert.equal(out[2]!.y, 0, "unselected anchor must not move (fails on move-all)");

  // handles preserved on both moved and unmoved anchors
  assert.equal(out[1]!.hx, 3);
  assert.equal(out[1]!.hy, 4);
  assert.equal(out[0]!.hx, 2);
  assert.equal(out[0]!.hy, -1);
  assert.equal(out[2]!.hx, -2);
  assert.equal(out[2]!.hy, 5);

  // fresh array/objects, input untouched
  assert.notStrictEqual(out, input);
  assert.notStrictEqual(out[1], input[1]);
  assert.deepEqual(input, snapshot);
});

test("movePathAnchors ignores invalid indices, dedupes, and is deterministic", () => {
  const input: PathAnchor[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const ignored = movePathAnchors(input, [-1, 2, 1.5, 99], 5, 5);
  assert.deepEqual(ignored, input);
  assert.notStrictEqual(ignored, input, "still a fresh array");

  const dup = movePathAnchors(input, [1, 1], 3, 3);
  assert.equal(dup[1]!.x, 4, "a duplicate index moves an anchor once");
  assert.equal(dup[1]!.y, 4);
  assert.equal(dup[0]!.x, 0);
  assert.deepEqual(
    movePathAnchors(input, [0], 2, 2),
    movePathAnchors(input, [0], 2, 2),
    "deterministic",
  );
});
