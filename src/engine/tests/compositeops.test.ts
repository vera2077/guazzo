import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import { applyImageToGrid, calculateMask, type OpRect } from "../compositeops.ts";
import { eq } from "./helpers.ts";

const GRID = 8;
const ALL: OpRect = { x: 0, y: 0, w: GRID, h: GRID };

function grid(rgba: [number, number, number, number]): TileGrid {
  const g = new TileGrid(GRID, GRID);
  g.fillRect(0, 0, GRID, GRID, rgba);
  return g;
}

function pixel(g: TileGrid, x: number, y: number): number[] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

test("multiply: white base by grey source yields grey", () => {
  const base = grid([255, 255, 255, 255]);
  const source = grid([128, 128, 128, 255]);
  applyImageToGrid(base, source, ALL, "multiply", 1);
  assert.deepEqual(pixel(base, 2, 3), [128, 128, 128, 255]);
});

test("blend is applied: multiply red x green is black (normal would be green)", () => {
  const base = grid([255, 0, 0, 255]);
  const source = grid([0, 255, 0, 255]);
  applyImageToGrid(base, source, ALL, "multiply", 1);
  // With the blend ignored (normal) this pixel would be [0, 255, 0, 255].
  assert.deepEqual(pixel(base, 1, 1), [0, 0, 0, 255]);
});

test("difference produces the expected channel values", () => {
  const base = grid([200, 100, 50, 255]);
  const source = grid([100, 200, 50, 255]);
  applyImageToGrid(base, source, ALL, "difference", 1);
  const p = pixel(base, 4, 4);
  eq(p[0], 100); // |200 - 100|
  eq(p[1], 100); // |100 - 200|
  eq(p[2], 0);   // |50 - 50|
  eq(p[3], 255);
});

test("opacity 0 leaves the base untouched", () => {
  const base = grid([7, 8, 9, 255]);
  const source = grid([255, 0, 0, 255]);
  const before = Array.from(pixel(base, 3, 3));
  applyImageToGrid(base, source, ALL, "multiply", 0);
  assert.deepEqual(pixel(base, 3, 3), before);
});

test("a mask blocks the composite outside the selection", () => {
  const base = grid([255, 255, 255, 255]);
  const source = grid([255, 0, 0, 255]);
  const mask = new SelectionMask(GRID, GRID);
  mask.selectRect(0, 0, 4, GRID); // only the left half is selected
  applyImageToGrid(base, source, ALL, "normal", 1, mask);
  assert.deepEqual(pixel(base, 1, 1), [255, 0, 0, 255]); // inside: composited
  assert.deepEqual(pixel(base, 6, 1), [255, 255, 255, 255]); // outside: blocked
});

test("calculateMask returns the expected length and a known value", () => {
  const base = grid([255, 255, 255, 255]);
  const source = grid([128, 128, 128, 255]);
  const out = calculateMask(base, source, ALL, "red", "multiply", 1);
  eq(out.length, GRID * GRID); // w*h
  eq(out[0], 128); // 255 * 128/255
  eq(out[out.length - 1], 128);
});

test("calculateMask uses the blend, not a passthrough", () => {
  const base = grid([200, 200, 200, 255]);
  const source = grid([50, 100, 150, 255]);
  const out = calculateMask(base, source, ALL, "red", "multiply", 1);
  // multiply: 200 * 50 / 255 ~= 39; a passthrough would give 50.
  eq(out[0], 39);
});
