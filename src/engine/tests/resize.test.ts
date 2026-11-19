import test from "node:test";
import * as assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { Document } from "../document.ts";
import { resampleGrid, resizeDocument, canvasResizeDocument } from "../resize.ts";

test("resampleGrid: identity size is byte-exact", () => {
  const g = new TileGrid(64, 64);
  g.fillRect(10, 10, 30, 30, [200, 100, 50, 255]);
  g.fillRect(300, 5, 40, 40, [1, 2, 3, 200]);
  const out = resampleGrid(g, 64, 64);
  const a = new Uint8ClampedArray(4 * 64 * 64), b = new Uint8ClampedArray(4 * 64 * 64);
  g.readRect(0, 0, 64, 64, a);
  out.readRect(0, 0, 64, 64, b);
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("resampleGrid: 2x upscale of quadrants keeps corners exact", () => {
  const g = new TileGrid(2, 2);
  g.fillRect(0, 0, 1, 1, [255, 0, 0, 255]);
  g.fillRect(1, 0, 1, 1, [0, 255, 0, 255]);
  g.fillRect(0, 1, 1, 1, [0, 0, 255, 255]);
  g.fillRect(1, 1, 1, 1, [255, 255, 255, 255]);
  const out = resampleGrid(g, 4, 4);
  const res = new Uint8ClampedArray(4 * 4 * 4);
  out.readRect(0, 0, 4, 4, res);
  const px = (x: number, y: number) => Array.from(res.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
  assert.deepEqual(px(0, 0), [255, 0, 0, 255]); // corner: clamped source
  assert.deepEqual(px(3, 3), [255, 255, 255, 255]);
});

test("resampleGrid: 2x downscale of solid is still solid", () => {
  const g = new TileGrid(8, 8);
  g.fillRect(0, 0, 8, 8, [10, 20, 30, 255]);
  const out = resampleGrid(g, 4, 4);
  const res = new Uint8ClampedArray(4 * 4 * 4);
  out.readRect(0, 0, 4, 4, res);
  assert.deepEqual(Array.from(res.slice(0, 4)), [10, 20, 30, 255]);
  assert.deepEqual(Array.from(res.slice(60, 64)), [10, 20, 30, 255]);
});

test("resizeDocument: pixels + text metadata scale", () => {
  const doc = new Document(100, 100);
  const l = doc.addLayer("t");
  l.grid.fillRect(10, 10, 20, 20, [255, 0, 0, 255]);
  l.textData = { lines: [[{ text: "Hi", bold: false, italic: false, underline: false, strike: false, font: "Arial" }]],
    x: 10, y: 20, w: 30, h: 40, size: 16, color: [0, 0, 0] };
  const out = resizeDocument(doc, 50, 50);
  assert.equal(out.width, 50);
  const m = out.layers[0]!.textData!;
  assert.equal(m.x, 5);
  assert.equal(m.y, 10);
  assert.equal(m.w, 15);
  assert.equal(m.size, 8);
  const res = new Uint8ClampedArray(4 * 50 * 50);
  out.layers[0]!.grid.readRect(0, 0, 50, 50, res);
  // 20x20 block at (10,10) scales to 10x10 at (5,5)
  assert.equal(res[(5 * 50 + 5) * 4 + 3]!, 255);
  assert.equal(res[(4 * 50 + 4) * 4 + 3]!, 0);
});

test("canvasResizeDocument: anchor top-left vs bottom-right", () => {
  const doc = new Document(4, 4);
  doc.addLayer("l").grid.fillRect(0, 0, 4, 4, [255, 255, 255, 255]);
  const tl = canvasResizeDocument(doc, 8, 8, 0, 0);
  const res = new Uint8ClampedArray(4 * 8 * 8);
  tl.layers[0]!.grid.readRect(0, 0, 8, 8, res);
  assert.equal(res[(3 * 8 + 3) * 4]!, 255);   // old content stays at 0..3
  assert.equal(res[(4 * 8 + 4) * 4 + 3]!, 0); // new area transparent
  const br = canvasResizeDocument(doc, 8, 8, 1, 1);
  br.layers[0]!.grid.readRect(0, 0, 8, 8, res);
  assert.equal(res[(4 * 8 + 4) * 4]!, 255);   // content moved to 4..7
  assert.equal(res[(3 * 8 + 3) * 4 + 3]!, 0); // old corner now empty
  // text offset follows the anchor
  doc.layers[0]!.textData = { lines: [[{ text: "x", bold: false, italic: false, underline: false, strike: false, font: "A" }]],
    x: 1, y: 2, w: 1, h: 1, size: 10, color: [0, 0, 0] };
  const shifted = canvasResizeDocument(doc, 8, 8, 0, 0);
  assert.equal(shifted.layers[0]!.textData!.x, 1); // no scale, no move
});
