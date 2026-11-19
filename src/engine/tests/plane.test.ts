import assert from "node:assert/strict";
import { test } from "node:test";
import { TileGrid } from "../tile.ts";
import { fillPlane } from "../plane.ts";
import { SelectionMask } from "../mask.ts";

// NOTE: assert.equal/ok on a closure-mutated `let` narrows it to a literal and
// the next check fails with TS2322. Compare through unknown parameters instead.
function eq(actual: unknown, expected: unknown): void {
  assert.strictEqual(actual, expected);
}

function px(grid: TileGrid, x: number, y: number): number[] {
  const out = new Uint8ClampedArray(4);
  grid.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

test("fillPlane covers the rect and leaves the rest untouched", () => {
  const g = new TileGrid(20, 20);
  const n = fillPlane(g, { x: 2, y: 3, w: 4, h: 5 }, { r: 10, g: 20, b: 30, a: 255 });
  eq(n, 20);
  assert.deepEqual(px(g, 2, 3), [10, 20, 30, 255]);
  assert.deepEqual(px(g, 5, 7), [10, 20, 30, 255]);
  // just outside the rect
  assert.deepEqual(px(g, 6, 7), [0, 0, 0, 0]);
  assert.deepEqual(px(g, 1, 3), [0, 0, 0, 0]);
});

test("opacity scales the source alpha over existing pixels", () => {
  const g = new TileGrid(8, 8);
  g.fillRect(0, 0, 8, 8, [255, 255, 255, 255]);
  // 50% black over white is the classic midpoint
  fillPlane(g, { x: 0, y: 0, w: 8, h: 8 }, { r: 0, g: 0, b: 0, a: 255 }, { opacity: 0.5 });
  const p = px(g, 4, 4);
  assert.ok(p[0]! > 126 && p[0]! < 130, `expected ~128, got ${p[0]}`);
  eq(p[3], 255);
});

test("colour alpha and fill opacity multiply", () => {
  const g = new TileGrid(4, 4);
  const n = fillPlane(g, { x: 0, y: 0, w: 2, h: 2 }, { r: 200, g: 0, b: 0, a: 128 }, { opacity: 0.5 });
  eq(n, 4);
  const p = px(g, 1, 1);
  eq(p[3], 64); // 128/255 * 0.5 -> 0.251 -> 64
});

test("mask skips pixels outside the selection", () => {
  const g = new TileGrid(10, 10);
  const m = new SelectionMask(10, 10);
  m.selectRect(4, 4, 3, 3);
  const n = fillPlane(g, { x: 0, y: 0, w: 10, h: 10 }, { r: 255, g: 0, b: 0, a: 255 }, { mask: m });
  eq(n, 9);
  assert.deepEqual(px(g, 5, 5), [255, 0, 0, 255]);
  assert.deepEqual(px(g, 0, 0), [0, 0, 0, 0]);
});

test("rect is clipped to the document", () => {
  const g = new TileGrid(6, 6);
  const n = fillPlane(g, { x: -4, y: -4, w: 8, h: 8 }, { r: 1, g: 2, b: 3, a: 255 });
  eq(n, 16); // only the 4x4 overlap exists
  assert.deepEqual(px(g, 0, 0), [1, 2, 3, 255]);
  assert.deepEqual(px(g, 4, 4), [0, 0, 0, 0]);
});

test("an off-canvas rect or zero opacity is a no-op", () => {
  const g = new TileGrid(6, 6);
  eq(fillPlane(g, { x: 10, y: 10, w: 4, h: 4 }, { r: 9, g: 9, b: 9, a: 255 }), 0);
  eq(fillPlane(g, { x: 0, y: 0, w: 6, h: 6 }, { r: 9, g: 9, b: 9, a: 255 }, { opacity: 0 }), 0);
  eq(g.allocated, 0);
});
