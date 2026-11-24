import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addSlice,
  moveSlice,
  removeSlice,
  sliceTiles,
  type Slice,
} from "../slices.ts";

const rectOf = (s: Slice) => ({ x: s.x, y: s.y, w: s.w, h: s.h });

test("addSlice clamps to doc bounds and auto-names from the new id", () => {
  const out = addSlice([], 100, 80, { x: -10, y: 70, w: 50, h: 30 });
  assert.equal(out.length, 1);
  assert.deepEqual(rectOf(out[0]!), { x: 0, y: 70, w: 40, h: 10 });
  assert.equal(out[0]!.id, 1);
  assert.equal(out[0]!.name, "Slice 1");
});

test("addSlice uses the supplied name and the next strictly-increasing id", () => {
  const existing: Slice[] = [{ id: 5, x: 0, y: 0, w: 1, h: 1, name: "Existing" }];
  const named = addSlice(existing, 100, 80, { x: 1, y: 2, w: 3, h: 4 }, "Custom");
  assert.equal(named[1]!.id, 6);
  assert.equal(named[1]!.name, "Custom");
  const auto = addSlice(existing, 100, 80, { x: 1, y: 2, w: 3, h: 4 });
  assert.equal(auto[1]!.id, 6);
  assert.equal(auto[1]!.name, "Slice 6");
});

test("addSlice drops zero-area rects but still returns a fresh array", () => {
  const input: Slice[] = [{ id: 1, x: 0, y: 0, w: 2, h: 2 }];
  const outside = addSlice(input, 100, 80, { x: 200, y: 0, w: 10, h: 10 });
  assert.equal(outside.length, 1);
  assert.notStrictEqual(outside, input);
  const zero = addSlice(input, 100, 80, { x: 10, y: 10, w: 0, h: 5 });
  assert.equal(zero.length, 1);
});

test("removeSlice returns a fresh array and drops only the matching id", () => {
  const input: Slice[] = [
    { id: 1, x: 0, y: 0, w: 2, h: 2 },
    { id: 2, x: 3, y: 3, w: 2, h: 2 },
  ];
  const snapshot = structuredClone(input);
  const out = removeSlice(input, 1);
  assert.notStrictEqual(out, input, "result must be a new array");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, 2);
  assert.deepEqual(input, snapshot, "removeSlice must not mutate its input");
});

test("moveSlice clamps the moved rect at the document edge", () => {
  const input: Slice[] = [{ id: 1, x: 5, y: 5, w: 10, h: 10 }];
  const snapshot = structuredClone(input);
  const far = moveSlice(input, 1, 1000, 1000, 100, 80);
  assert.deepEqual(rectOf(far[0]!), { x: 90, y: 70, w: 10, h: 10 });
  const near = moveSlice(input, 1, -1000, -1000, 100, 80);
  assert.deepEqual(rectOf(near[0]!), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(input, snapshot, "moveSlice must not mutate its input");
  assert.notStrictEqual(far, input);
});

test("sliceTiles of disjoint rects tiles the document without overlap or gaps", () => {
  const docW = 30;
  const docH = 20;
  const slices: Slice[] = [
    { id: 1, x: 0, y: 0, w: 10, h: 4 },
    { id: 2, x: 20, y: 10, w: 5, h: 5 },
  ];

  const tiles = sliceTiles(slices, docW, docH);
  assert.ok(tiles.length > slices.length, "gap strips were emitted");

  // Every tile has positive area and stays inside the document.
  for (const t of tiles) {
    assert.ok(t.w > 0 && t.h > 0, "positive-area tile");
    assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= docW && t.y + t.h <= docH,
      `tile inside doc: ${JSON.stringify(t)}`);
  }

  // No two tiles overlap.
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i]!, b = tiles[j]!;
      const ow = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oh = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.equal(ow * oh, 0, `tiles ${i} and ${j} must not overlap`);
    }
  }

  // The areas add up to exactly the whole document.
  const area = tiles.reduce((sum, t) => sum + t.w * t.h, 0);
  assert.equal(area, docW * docH, `tiled area ${area} != ${docW * docH}`);
});

test("sliceTiles of no slices returns a single full-document tile", () => {
  const tiles = sliceTiles([], 10, 10);
  assert.equal(tiles.length, 1);
  assert.deepEqual(rectOf(tiles[0]!), { x: 0, y: 0, w: 10, h: 10 });
});

test("no slicing helper mutates its input slices", () => {
  const input: Slice[] = [
    { id: 1, x: 2, y: 3, w: 10, h: 10, name: "A" },
    { id: 2, x: 30, y: 20, w: 10, h: 10, name: "B" },
  ];
  const snapshot = structuredClone(input);

  addSlice(input, 100, 100, { x: 0, y: 0, w: 5, h: 5 });
  removeSlice(input, 1);
  moveSlice(input, 1, 5, 5, 100, 100);
  sliceTiles(input, 100, 100);

  // This assertion would fail if any helper clamped, moved or added in place.
  assert.deepEqual(input, snapshot, "input slices must be byte-for-byte unchanged");
  assert.notStrictEqual(removeSlice(input, 999), input, "results are always fresh arrays");
  assert.notStrictEqual(moveSlice(input, 999, 0, 0, 100, 100), input);
});
