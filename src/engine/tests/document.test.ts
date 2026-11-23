import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, cloneLayerContents, fillMaskFromSelection, maskAt, mergeLayerInto, setMaskAt } from "../document.ts";
import { SelectionMask } from "../mask.ts";
import { TileGrid } from "../tile.ts";

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

test("fillMaskFromSelection hides partial prior coverage outside the selection", () => {
  // The invariant is "everything outside the new selection reads hidden". A prior
  // coverage of 100 (partially painted) used to survive because only > 127 was
  // zeroed, leaving a visible fringe the mask is supposed to remove.
  const mask = new TileGrid(16, 16);
  setMaskAt(mask, 2, 2, 100);
  setMaskAt(mask, 12, 12, 255);
  const sel = new SelectionMask(16, 16);
  sel.selectRect(4, 4, 4, 4);
  fillMaskFromSelection(mask, sel, true);
  assert.equal(maskAt(mask, 2, 2, 255), 0, "a 100/255 prior outside the selection must be hidden");
  assert.equal(maskAt(mask, 12, 12, 255), 0, "and so must a fully revealed one");
  assert.equal(maskAt(mask, 5, 5, 255), 255, "inside the selection stays revealed");
});

test("an adjustment layer's blend mode changes the result", () => {
  // The mode was stored and never read: a Multiply Levels behaved Normal.
  const build = (mode: "normal" | "multiply") => {
    const doc = new Document(8, 8);
    const base = doc.addLayer("Base");
    base.grid.fillRect(0, 0, 8, 8, [128, 128, 128, 255]);
    const adj = doc.addLayer("Levels");
    adj.kind = "adjust";
    adj.adjust = { kind: "levels", levels: { inBlack: 0, inWhite: 128, gamma: 1, outBlack: 0, outWhite: 255 } };
    adj.blendMode = mode;
    return doc.composite();
  };
  const normal = build("normal");
  const multiply = build("multiply");
  assert.notDeepEqual(Array.from(normal), Array.from(multiply), "multiply must differ from normal");
  // Multiply against the mid-grey backdrop cannot lift the pixel to the Levels
  // output the way Normal does.
  assert.ok(multiply[0]! < normal[0]!, `multiply ${multiply[0]} should stay below ${normal[0]}`);
});

test("cloneLayerContents copies the subtree, the style and the mask's polarity", () => {
  // Duplicate Layer hand-listed fields, so a group copy was empty and a hide
  // mask came back as reveal.
  const doc = new Document(16, 16);
  const group = doc.addGroup("Folder");
  const child = doc.addLayerTo(group, "Child");
  child.grid.fillRect(2, 2, 3, 3, [30, 60, 90, 255]);
  child.maskHide = true;
  const hidden = doc.addLayer("Hide");
  hidden.grid.fillRect(8, 8, 2, 2, [200, 10, 10, 255]);
  const m = doc.attachMask(hidden);
  m.fillRect(0, 0, 16, 16, [255, 255, 255, 255]);
  hidden.maskHide = true;
  hidden.fill = { color: [1, 2, 3], gradient: { type: "linear", angle: 0, stops: [{ at: 0, color: [255, 0, 0] }, { at: 1, color: [0, 0, 255] }] } };

  const groupCopy = doc.addLayer("Folder copy");
  cloneLayerContents(doc, group, groupCopy);
  assert.equal(groupCopy.kind, "group");
  assert.equal(groupCopy.children?.length, 1, "the group copy kept its child");
  assert.equal(groupCopy.children![0]!.maskHide, true);

  const fillCopy = doc.addLayer("Hide copy");
  cloneLayerContents(doc, hidden, fillCopy);
  assert.equal(fillCopy.maskHide, true, "the copy is a hide mask too");
  assert.ok(fillCopy.fill?.gradient, "the gradient survived the copy");
});

test("an adjustment's blend mode never changes a pixel's alpha (code-r9 #2)", () => {
  const doc = new Document(4, 4);
  const layer = doc.addLayer("soft");
  // A half-transparent red pixel: Multiply must recolour it, not opaque it.
  layer.grid.writeRect(1, 1, 1, 1, new Uint8ClampedArray([200, 40, 40, 128]));
  const adj = doc.addAdjustLayer({ kind: "levels", levels: { inBlack: 0, inWhite: 128, gamma: 1, outBlack: 0, outWhite: 255 } });
  adj.blendMode = "multiply";
  const out = doc.composite();
  const i = (1 * 4 + 1) * 4;
  assert.equal(out[i + 3], 128, `alpha changed to ${out[i + 3]} (was 128)`);
});
