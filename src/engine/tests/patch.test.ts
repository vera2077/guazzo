import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../document.ts";
import { SelectionMask } from "../mask.ts";
import { patchFromOffset } from "../patch.ts";

function paint(grid: { writeRect: (x: number, y: number, w: number, h: number, b: Uint8ClampedArray) => void }, x: number, y: number, rgba: [number, number, number, number]) {
  grid.writeRect(x, y, 1, 1, new Uint8ClampedArray(rgba));
}

test("patch: the selection takes the source colour, not its own", () => {
  const doc = new Document(32, 32);
  const g = doc.addLayer("Patch").grid;
  const px = new Uint8ClampedArray(4);
  paint(g, 5, 5, [255, 0, 0, 255]);
  paint(g, 15, 5, [0, 0, 255, 255]);
  const mask = new SelectionMask(32, 32);
  mask.setAlpha(5, 5, 255);
  const out = patchFromOffset(g, mask, 10, 0);
  assert.ok(out);
  g.readRect(5, 5, 1, 1, px);
  assert.deepEqual(Array.from(px), [0, 0, 255, 255]);
});

test("patch: a zero drag and an empty mask do nothing", () => {
  const doc = new Document(16, 16);
  const g = doc.addLayer("Patch").grid;
  paint(g, 2, 2, [10, 20, 30, 255]);
  assert.equal(patchFromOffset(g, new SelectionMask(16, 16), 0, 0), null);
  const mask = new SelectionMask(16, 16);
  assert.equal(patchFromOffset(g, mask, 4, 0), null);
});

test("patch: a feathered selection blends toward the source", () => {
  const doc = new Document(16, 16);
  const g = doc.addLayer("Patch").grid;
  paint(g, 2, 2, [0, 0, 0, 255]);
  paint(g, 6, 2, [200, 200, 200, 255]);
  const mask = new SelectionMask(16, 16);
  mask.setAlpha(2, 2, 128);
  patchFromOffset(g, mask, 4, 0);
  const px = new Uint8ClampedArray(4);
  g.readRect(2, 2, 1, 1, px);
  assert.ok(px[0]! > 90 && px[0]! < 110, `expected about 100, got ${px[0]}`);
});
