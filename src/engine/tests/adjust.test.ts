/**
 * adjust.test.ts — pixel-math adjustments + layerOpCommand undo.
 * Golden expectations are hand-computed (see comments); deepEqual is used
 * everywhere because assert.strictEqual's `asserts actual is T` narrowing
 * corrupts inference on closure-mutated variables (see history.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { applyAdjustment } from "../adjust.ts";
import { Document } from "../document.ts";
import { layerOpCommand, History } from "../history.ts";
import { stampDab } from "../paint.ts";


test("brightness adds to rgb, clamps at 255, preserves alpha", () => {
  const grid = new TileGrid(1, 1);
  grid.fillRect(0, 0, 1, 1, [128, 128, 128, 200]);
  applyAdjustment(grid, 0, 0, 1, 1, { kind: "brightness", amount: 100 });
  const res = new Uint8ClampedArray(4);
  grid.readRect(0, 0, 1, 1, res);
  assert.deepEqual(Array.from(res), [228, 228, 228, 200]);
  // clamp
  applyAdjustment(grid, 0, 0, 1, 1, { kind: "brightness", amount: 200 });
  grid.readRect(0, 0, 1, 1, res);
  assert.deepEqual(Array.from(res), [255, 255, 255, 200]);
});

test("invert maps 100,150,200 → 155,105,55", () => {
  const grid = new TileGrid(1, 1);
  grid.fillRect(0, 0, 1, 1, [100, 150, 200, 255]);
  applyAdjustment(grid, 0, 0, 1, 1, { kind: "invert", amount: 0 });
  const res = new Uint8ClampedArray(4);
  grid.readRect(0, 0, 1, 1, res);
  assert.deepEqual(Array.from(res), [155, 105, 55, 255]);
});

test("grayscale red → lum 76.5 stored as 76 (ties-to-even)", () => {
  const grid = new TileGrid(1, 1);
  grid.fillRect(0, 0, 1, 1, [255, 0, 0, 255]);
  applyAdjustment(grid, 0, 0, 1, 1, { kind: "grayscale", amount: 0 });
  const res = new Uint8ClampedArray(4);
  grid.readRect(0, 0, 1, 1, res);
  assert.deepEqual(Array.from(res), [76, 76, 76, 255]);
});

test("saturation -100 equals grayscale", () => {
  const a = new TileGrid(1, 1);
  a.fillRect(0, 0, 1, 1, [200, 100, 50, 255]);
  applyAdjustment(a, 0, 0, 1, 1, { kind: "saturation", amount: -100 });
  const b = new TileGrid(1, 1);
  b.fillRect(0, 0, 1, 1, [200, 100, 50, 255]);
  applyAdjustment(b, 0, 0, 1, 1, { kind: "grayscale", amount: 0 });
  const ra = new Uint8ClampedArray(4), rb = new Uint8ClampedArray(4);
  a.readRect(0, 0, 1, 1, ra);
  b.readRect(0, 0, 1, 1, rb);
  assert.deepEqual(Array.from(ra), Array.from(rb));
});

test("hue +120 rotates red to exact green", () => {
  const grid = new TileGrid(1, 1);
  grid.fillRect(0, 0, 1, 1, [255, 0, 0, 255]);
  applyAdjustment(grid, 0, 0, 1, 1, { kind: "hue", amount: 120 });
  const res = new Uint8ClampedArray(4);
  grid.readRect(0, 0, 1, 1, res);
  assert.deepEqual(Array.from(res), [0, 255, 0, 255]);
  // achromatic stays
  const g2 = new TileGrid(1, 1);
  g2.fillRect(0, 0, 1, 1, [128, 128, 128, 255]);
  applyAdjustment(g2, 0, 0, 1, 1, { kind: "hue", amount: 90 });
  g2.readRect(0, 0, 1, 1, res);
  assert.deepEqual(Array.from(res), [128, 128, 128, 255]);
});

test("contrast +100 doubles distance from 128", () => {
  const grid = new TileGrid(1, 1);
  grid.fillRect(0, 0, 1, 1, [100, 100, 100, 255]);
  applyAdjustment(grid, 0, 0, 1, 1, { kind: "contrast", amount: 100 }); // f=2
  const res = new Uint8ClampedArray(4);
  grid.readRect(0, 0, 1, 1, res);
  assert.deepEqual(Array.from(res), [72, 72, 72, 255]); // (100-128)*2+128
});

test("posterize 2 → only 0/255; threshold splits at luminance", () => {
  const grid = new TileGrid(2, 1);
  grid.fillRect(0, 0, 1, 1, [0, 10, 200, 255]);
  grid.fillRect(1, 0, 1, 1, [200, 200, 200, 255]);
  applyAdjustment(grid, 0, 0, 1, 1, { kind: "posterize", amount: 2 });
  applyAdjustment(grid, 1, 0, 1, 1, { kind: "threshold", amount: 128 });
  const res = new Uint8ClampedArray(8);
  grid.readRect(0, 0, 2, 1, res);
  // NOTE: threshold boundaries are float-fragile (0.59 is not a binary-exact
  // coefficient), so test with pixels safely above/below the cutoff.
  assert.deepEqual(Array.from(res), [0, 0, 255, 255, 255, 255, 255, 255]);
  const g2 = new TileGrid(1, 1);
  g2.fillRect(0, 0, 1, 1, [50, 50, 50, 255]);
  applyAdjustment(g2, 0, 0, 1, 1, { kind: "threshold", amount: 128 });
  const r2 = new Uint8ClampedArray(4);
  g2.readRect(0, 0, 1, 1, r2);
  assert.deepEqual(Array.from(r2), [0, 0, 0, 255]);
});

test("applyAdjustment never allocates tiles", () => {
  const grid = new TileGrid(600, 600);
  applyAdjustment(grid, 300, 300, 20, 20, { kind: "invert", amount: 0 });
  assert.equal(grid.allocated, 0);
});

test("partial rect: pixels outside the rect are untouched", () => {
  const grid = new TileGrid(4, 1);
  grid.fillRect(0, 0, 4, 1, [50, 50, 50, 255]);
  applyAdjustment(grid, 1, 0, 2, 1, { kind: "brightness", amount: 50 });
  const res = new Uint8ClampedArray(16);
  grid.readRect(0, 0, 4, 1, res);
  assert.deepEqual(Array.from(res.slice(0, 4)), [50, 50, 50, 255]);
  assert.deepEqual(Array.from(res.slice(4, 8)), [100, 100, 100, 255]);
  assert.deepEqual(Array.from(res.slice(8, 12)), [100, 100, 100, 255]);
  assert.deepEqual(Array.from(res.slice(12, 16)), [50, 50, 50, 255]);
});

test("layerOpCommand: adjustment undo/redo restores composite exactly", () => {
  const doc = new Document(8, 4);
  const layer = doc.addLayer("L");
  layer.grid.fillRect(0, 0, 8, 4, [100, 150, 200, 255]);

  const original = doc.composite();
  const entry = layerOpCommand(layer, "Brightness +50", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    applyAdjustment(layer.grid, 0, 0, 8, 4, { kind: "brightness", amount: 50 });
  });
  assert.ok(entry !== null);
  const adjusted = doc.composite();
  assert.notDeepEqual(Array.from(original), Array.from(adjusted));

  entry!.undo();
  assert.deepEqual(Array.from(doc.composite()), Array.from(original));
  entry!.redo();
  assert.deepEqual(Array.from(doc.composite()), Array.from(adjusted));
});

test("layerOpCommand: op that allocates NEW tiles reverts them to transparent on undo", () => {
  const doc = new Document(600, 600);
  const layer = doc.addLayer("L");
  stampDab(layer.grid, { x: 30, y: 30, radius: 10, hardness: 1, alpha: 1, color: [255, 0, 0], mode: "normal" });
  const before = doc.composite();

  const entry = layerOpCommand(layer, "Fill new area", () => {
    layer.grid.fillRect(300, 300, 20, 20, [0, 255, 0, 255]); // tile (1,1) is new
  });
  assert.ok(entry !== null);
  const after = doc.composite();
  assert.notDeepEqual(Array.from(before), Array.from(after));

  entry!.undo();
  assert.deepEqual(Array.from(doc.composite()), Array.from(before)); // new tile → zeroed → transparent
  entry!.redo();
  assert.deepEqual(Array.from(doc.composite()), Array.from(after));
});

test("layerOpCommand: empty layer, allocating mutation, then undo → back to empty", () => {
  const doc = new Document(600, 600);
  const layer = doc.addLayer("L");
  const before = doc.composite();
  const entry = layerOpCommand(layer, "First paint", () => {
    layer.grid.fillRect(10, 10, 5, 5, [9, 9, 9, 255]);
  });
  assert.ok(entry !== null);
  entry!.undo();
  assert.deepEqual(Array.from(doc.composite()), Array.from(before));
  // and through a History stack
  const h = new History(10);
  const e2 = layerOpCommand(layer, "Second paint", () => {
    layer.grid.fillRect(20, 20, 5, 5, [9, 9, 9, 255]);
  });
  assert.ok(e2 !== null);
  h.push(e2);
  assert.ok(h.undo());
  assert.deepEqual(Array.from(doc.composite()), Array.from(before));
});

test("layerOpCommand: layer with no pixels and allocating nothing → null", () => {
  const doc = new Document(8, 8);
  const layer = doc.addLayer("L");
  const entry = layerOpCommand(layer, "no-op", () => { /* nothing */ });
  assert.equal(entry, null);
});
