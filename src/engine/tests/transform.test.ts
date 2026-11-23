/**
 * transform.test.ts — Free Transform engine goldens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridBBox, transformLayer } from "../transform.ts";
import { Document, createLayerMask, maskAt, setMaskAt } from "../document.ts";
import { layerOpCommand } from "../history.ts";

function pxAt(out: Uint8ClampedArray, w: number, x: number, y: number): number[] {
  const o = (y * w + x) * 4;
  return [out[o] ?? 0, out[o + 1] ?? 0, out[o + 2] ?? 0, out[o + 3] ?? 0];
}

function readAll(l: { grid: { readRect(x: number, y: number, w: number, h: number, out: Uint8ClampedArray): void } }, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  l.grid.readRect(0, 0, w, h, out);
  return out;
}

test("gridBBox spans allocated tiles clipped to the grid", () => {
  const doc = new Document(600, 600);
  const l = doc.addLayer();
  l.grid.fillRect(10, 10, 100, 100, [255, 0, 0, 255]); // one 256×256 tile
  assert.deepEqual(gridBBox(l.grid), { x: 0, y: 0, w: 256, h: 256 });
});

test("translate moves content and clears the original spot", () => {
  const doc = new Document(8, 8);
  const l = doc.addLayer();
  l.grid.fillRect(1, 1, 1, 1, [255, 0, 0, 255]);
  transformLayer(l, { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 4, dy: 0 });
  const out = readAll(l, 8, 8);
  assert.deepEqual(pxAt(out, 8, 5, 1), [255, 0, 0, 255]);
  assert.deepEqual(pxAt(out, 8, 1, 1), [0, 0, 0, 0]);
});

test("rotate 90° maps pixel centers exactly", () => {
  const doc = new Document(8, 8);
  const l = doc.addLayer();
  l.grid.fillRect(1, 1, 1, 1, [0, 255, 0, 255]);
  transformLayer(l, { angleDeg: 90, scaleX: 1, scaleY: 1, dx: 0, dy: 0 });
  const out = readAll(l, 8, 8);
  // (1.5,1.5) around (4,4) → (6.5,1.5) → pixel (6,1), bilinear-exact at centers
  assert.deepEqual(pxAt(out, 8, 6, 1), [0, 255, 0, 255]);
  assert.deepEqual(pxAt(out, 8, 1, 1), [0, 0, 0, 0]);
});

test("rotate 180° flips around the center", () => {
  const doc = new Document(8, 8);
  const l = doc.addLayer();
  l.grid.fillRect(1, 1, 1, 1, [0, 0, 255, 255]);
  transformLayer(l, { angleDeg: 180, scaleX: 1, scaleY: 1, dx: 0, dy: 0 });
  const out = readAll(l, 8, 8);
  assert.deepEqual(pxAt(out, 8, 6, 6), [0, 0, 255, 255]);
  assert.deepEqual(pxAt(out, 8, 1, 1), [0, 0, 0, 0]);
});

test("scale ×2 around the center doubles a uniform square", () => {
  const doc = new Document(16, 16);
  const l = doc.addLayer();
  l.grid.fillRect(2, 2, 4, 4, [255, 0, 0, 255]);
  transformLayer(l, { angleDeg: 0, scaleX: 2, scaleY: 2, dx: 0, dy: 0 });
  const out = readAll(l, 16, 16);
  assert.deepEqual(pxAt(out, 16, 1, 1), [255, 0, 0, 255]);          // interior: all taps inside
  assert.deepEqual(pxAt(out, 16, 6, 6), [0, 0, 0, 0]);               // far outside
  const edge = pxAt(out, 16, 4, 4)[3] ?? 0;             // soft edge at the boundary
  assert.deepEqual(edge > 0 && edge < 255, true);
});

test("transform is fully undoable across tile boundaries", () => {
  const doc = new Document(600, 600);
  const l = doc.addLayer();
  l.grid.fillRect(10, 10, 100, 100, [10, 200, 30, 255]);
  const before = readAll(l, 600, 600);
  const entry = layerOpCommand(l, "Transform", () => {
    transformLayer(l, { angleDeg: 180, scaleX: 1, scaleY: 1, dx: 300, dy: 0 });
  });
  if (entry) entry.undo();
  assert.deepEqual(readAll(l, 600, 600), before); // byte-exact restore
});

test("zero scale does not crash", () => {
  const doc = new Document(8, 8);
  const l = doc.addLayer();
  l.grid.fillRect(2, 2, 4, 4, [255, 0, 0, 255]);
  transformLayer(l, { angleDeg: 45, scaleX: 0, scaleY: 0, dx: 0, dy: 0 });
  assert.deepEqual(l.grid.allocated > 0, true); // ran, layer state sane
});

test("transform: a hide mask moves with its pixels and the vacated area stays hidden", () => {
  // code-r18 #3: the mask used to rotate around its own bbox, and its vacated
  // footprint was filled with 0 — which a hide mask reads as "revealed".
  const doc = new Document(64, 64);
  const layer = doc.addLayer("Masked");
  layer.grid.writeRect(8, 8, 1, 1, new Uint8ClampedArray([10, 20, 30, 255]));
  const mask = createLayerMask(doc.width, doc.height);
  layer.mask = mask;
  layer.maskHide = true;
  setMaskAt(mask, 8, 8, 255); // revealed where the pixels are, hidden elsewhere

  transformLayer(layer, { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 16, dy: 0 });
  assert.equal(maskAt(mask, 24, 8, 0), 255, "the revealed window moved with the pixels");
  assert.equal(maskAt(mask, 8, 8, 0), 0, "the vacated area is hidden, not revealed");
});
