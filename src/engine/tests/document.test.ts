import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, mergeLayerInto } from "../document.ts";

const pxAt = (buf: Uint8ClampedArray, w: number, x: number, y: number) =>
  [...buf.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

test("background composite is white", () => {
  const doc = new Document(64, 64);
  doc.addBackground();
  const out = doc.composite();
  assert.deepEqual(pxAt(out, 64, 0, 0), [255, 255, 255, 255]);
});

test("normal layer over background", () => {
  const doc = new Document(64, 64);
  doc.addBackground();
  const l = doc.addLayer();
  l.grid.fillRect(10, 10, 5, 5, [255, 0, 0, 255]);
  const out = doc.composite();
  assert.deepEqual(pxAt(out, 64, 12, 12), [255, 0, 0, 255]);
  assert.deepEqual(pxAt(out, 64, 0, 0), [255, 255, 255, 255]);
});

test("hidden layer is skipped", () => {
  const doc = new Document(64, 64);
  doc.addBackground();
  const l = doc.addLayer();
  l.grid.fillRect(10, 10, 5, 5, [255, 0, 0, 255]);
  l.visible = false;
  const out = doc.composite();
  assert.deepEqual(pxAt(out, 64, 12, 12), [255, 255, 255, 255]);
});

test("layer opacity scales source alpha", () => {
  const doc = new Document(64, 64);
  doc.addBackground(); // white
  const l = doc.addLayer();
  l.grid.fillRect(0, 0, 64, 64, [0, 0, 0, 255]); // black
  l.opacity = 0.5;
  const out = doc.composite();
  assert.deepEqual(pxAt(out, 64, 5, 5), [128, 128, 128, 255]);
});

test("multiply blend between layers", () => {
  const doc = new Document(64, 64);
  const bg = doc.addLayer("bg");
  bg.grid.fillRect(0, 0, 64, 64, [255, 255, 255, 255]);
  const top = doc.addLayer("top");
  top.grid.fillRect(0, 0, 64, 64, [128, 255, 64, 255]);
  top.blendMode = "multiply";
  const out = doc.composite();
  assert.deepEqual(pxAt(out, 64, 5, 5), [128, 255, 64, 255]);
  // over mid-gray it darkens: 128·200/255, 255·200/255, 64·200/255
  bg.grid.fillRect(0, 0, 64, 64, [200, 200, 200, 255]);
  const out2 = doc.composite();
  assert.deepEqual(pxAt(out2, 64, 5, 5), [100, 200, 50, 255]);
});

test("compositeRect equals composite for the same region", () => {
  const doc = new Document(64, 64);
  doc.addBackground();
  const l = doc.addLayer();
  l.grid.fillRect(20, 20, 10, 10, [0, 255, 0, 255]);
  const full = doc.composite();
  const part = new Uint8ClampedArray(10 * 10 * 4);
  doc.compositeRect(15, 15, 10, 10, part);
  // doc pixel (22,22) ↔ part pixel (7,7)
  assert.deepEqual(pxAt(full, 64, 22, 22), pxAt(part, 10, 7, 7));
  assert.deepEqual(pxAt(part, 10, 7, 7), [0, 255, 0, 255]);
});

test("layer order: topmost wins with normal blend", () => {
  const doc = new Document(64, 64);
  const a = doc.addLayer("a");
  a.grid.fillRect(0, 0, 64, 64, [255, 0, 0, 255]);
  const b = doc.addLayer("b");
  b.grid.fillRect(0, 0, 64, 64, [0, 0, 255, 255]);
  const out = doc.composite();
  assert.deepEqual(pxAt(out, 64, 1, 1), [0, 0, 255, 255]);
  doc.moveLayer(b, 0);
  const out2 = doc.composite();
  assert.deepEqual(pxAt(out2, 64, 1, 1), [255, 0, 0, 255]);
});

test("mergeLayerInto: top layer blends onto the bottom in place", () => {
  const doc = new Document(64, 64);
  const bottom = doc.addLayer("bottom");
  bottom.grid.fillRect(10, 10, 20, 20, [255, 255, 255, 255]);
  const top = doc.addLayer("top");
  top.blendMode = "multiply";
  top.opacity = 0.5;
  top.grid.fillRect(20, 20, 20, 20, [128, 128, 128, 255]);
  const bb = mergeLayerInto(top, bottom);
  assert.ok(bb !== null);
  doc.removeLayer(top); // the merge consumer drops the top layer afterward
  // overlap region (both squares cover 20..29): white × gray128 × opacity 0.5
  // over opaque white → ~191; alpha stays 255
  const res = new Uint8ClampedArray(4 * 64 * 64);
  doc.compositeRect(0, 0, 64, 64, res);
  const px = (x: number, y: number) => Array.from(res.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  assert.ok(px(25, 25)[0]! > 150 && px(25, 25)[0]! < 230, `overlap blend, got ${px(25, 25)}`);
  assert.equal(px(25, 25)[3]!, 255);
  // top-only region: blend over transparent keeps the src color, alpha ≈127.5
  assert.deepEqual(px(30, 30), [128, 128, 128, 128]);
  // bottom-only region unchanged white
  assert.deepEqual(px(12, 12), [255, 255, 255, 255]);
  // far top-only region also carries over
  assert.ok(px(35, 35)[3]! > 0, "top-only pixels carry over");
});

test("mergeLayerInto: empty layers return null", () => {
  const doc = new Document(64, 64);
  const a = doc.addLayer("a"), b = doc.addLayer("b");
  assert.equal(mergeLayerInto(b, a), null);
});
