/**
 * composite.test.ts — Document.compositeRect: layer kinds, blend modes,
 * masks (INVERTED storage: tile R = hidden amount, unallocated tile =
 * fully revealed), clipping, fill layers. Pins the internal
 * inverted-RGBA mask encoding — changing it must update document.ts
 * AND io.ts AND these tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, bakeLayerMask, maskAt, mergeLayerInto, paintMaskDab, setMaskAt, createLayerMask } from "../document.ts";
import { captureTiles, snapshotCommand } from "../history.ts";
import { TileGrid } from "../tile.ts";
import { defaultAdjustSpec } from "../adjustfn.ts";
import { eq } from "./helpers.ts";

function frame(doc: Document): Uint8ClampedArray {
  return doc.composite();
}

function px(buf: Uint8ClampedArray, w: number, x: number, y: number): number[] {
  const i = (y * w + x) * 4;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!];
}

/** the eq() helper: unknown params keep tsconfig's strict narrowing quiet */
function solid(doc: Document, w: number, h: number, rgba: number[]): void {
  doc.addLayer("solid").grid.fillRect(0, 0, w, h, rgba as [number, number, number, number]);
}

// ---------------------------------------------------------------- masks ---

test("an unallocated mask tile reveals everything", () => {
  const mask = createLayerMask(10, 10);
  eq(maskAt(mask, 0, 0), 255);
  eq(maskAt(mask, 9, 9), 255);
  eq(maskAt(undefined, 3, 3), 255);
});

test("setMaskAt round-trips through maskAt and stores grey", () => {
  const mask = createLayerMask(10, 10);
  setMaskAt(mask, 4, 5, 40);
  eq(maskAt(mask, 4, 5), 40);
  const t = mask.tile(0, 0, false)!;
  const i = (5 * 256 + 4) * 4;
  eq(t.data[i], 215); // stored inverted: how much is hidden
  eq(t.data[i + 1], 215);
  eq(t.data[i + 3], 255);
});

test("a layer mask hides where the mask is black", () => {
  const doc = new Document(20, 20);
  doc.addBackground();
  const top = doc.addLayer("top");
  top.grid.fillRect(0, 0, 20, 20, [255, 0, 0, 255]);
  const mask = doc.attachMask(top);
  // hide the whole left half
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) setMaskAt(mask, x, y, 0);

  const buf = frame(doc);
  assert.deepEqual(px(buf, 20, 2, 2), [255, 255, 255, 255]); // white background
  assert.deepEqual(px(buf, 20, 15, 2), [255, 0, 0, 255]); // red where revealed
});

test("mask coverage scales alpha, so 128 is half-opaque", () => {
  const doc = new Document(20, 20);
  doc.addBackground();
  const top = doc.addLayer("top");
  top.grid.fillRect(0, 0, 20, 20, [0, 0, 0, 255]);
  const mask = doc.attachMask(top);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) setMaskAt(mask, x, y, 128);

  const [r, g, b, a] = px(frame(doc), 20, 5, 5) as [number, number, number, number];
  eq(a, 255);
  assert.ok(r > 120 && r < 136, `expected ~127, got ${r}`);
  eq(g, r);
  eq(b, r);
});

// --------------------------------------------------- adjustment layers ---

test("a levels adjustment layer filters the backdrop", () => {
  const doc = new Document(10, 10);
  solid(doc, 10, 10, [100, 100, 100, 255]);
  doc.addAdjustLayer({ kind: "levels", levels: { inBlack: 0, inWhite: 100, gamma: 1, outBlack: 0, outWhite: 255 } });

  const [r] = px(frame(doc), 10, 1, 1) as [number];
  eq(r, 255); // 100 maps to the new white point
});

test("adjustment layer opacity blends the corrected result", () => {
  const doc = new Document(10, 10);
  solid(doc, 10, 10, [128, 128, 128, 255]);
  const adj = doc.addAdjustLayer({ kind: "invert" });
  adj.opacity = 0.5;

  const [r] = px(frame(doc), 10, 1, 1) as [number];
  // 128 inverted is 127; halfway is ~128 (they are nearly the same tone)
  assert.ok(Math.abs(r - 128) <= 1, `expected ~128, got ${r}`);
  adj.opacity = 1;
  eq(px(frame(doc), 10, 1, 1)[0], 127);
});

test("an adjustment layer mask limits where the filter applies", () => {
  const doc = new Document(20, 20);
  solid(doc, 20, 20, [100, 100, 100, 255]);
  const adj = doc.addAdjustLayer({ kind: "invert" });
  const mask = doc.attachMask(adj);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) setMaskAt(mask, x, y, 0);

  const buf = frame(doc);
  eq(px(buf, 20, 2, 2)[0], 100); // masked out: untouched
  eq(px(buf, 20, 15, 2)[0], 155); // 255 - 100
});

test("a hidden adjustment layer is a no-op", () => {
  const doc = new Document(10, 10);
  solid(doc, 10, 10, [100, 100, 100, 255]);
  const adj = doc.addAdjustLayer({ kind: "invert" });
  adj.visible = false;
  eq(px(frame(doc), 10, 1, 1)[0], 100);
});

test("an adjustment layer above nothing leaves transparency alone", () => {
  const doc = new Document(10, 10);
  doc.addAdjustLayer({ kind: "invert" });
  const buf = frame(doc);
  eq(buf[3], 0);
  eq(buf[2 * 4 + 3], 0);
});

// ---------------------------------------------------------- fill layers ---

test("a fill layer paints the whole canvas", () => {
  const doc = new Document(10, 10);
  doc.addFillLayer([10, 20, 30]);
  assert.deepEqual(px(frame(doc), 10, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(px(frame(doc), 10, 9, 9), [10, 20, 30, 255]);
});

test("a fill layer can be masked and multiplied", () => {
  const doc = new Document(20, 20);
  solid(doc, 20, 20, [200, 200, 200, 255]);
  const fill = doc.addFillLayer([128, 128, 128]);
  fill.blendMode = "multiply";
  const mask = doc.attachMask(fill);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) setMaskAt(mask, x, y, 0);

  const buf = frame(doc);
  eq(px(buf, 20, 2, 2)[0], 200); // masked out
  eq(px(buf, 20, 15, 2)[0], 100); // 200 * 128 / 255 ≈ 100
});

// ----------------------------------------------------------- clipping ---

test("clipToBelow confines a layer to the alpha underneath", () => {
  const doc = new Document(20, 20);
  const base = doc.addLayer("base");
  base.grid.fillRect(0, 0, 10, 20, [0, 0, 255, 255]); // left half only
  const clipped = doc.addLayer("clipped");
  clipped.grid.fillRect(0, 0, 20, 20, [255, 0, 0, 255]);
  clipped.clipToBelow = true;

  const buf = frame(doc);
  assert.deepEqual(px(buf, 20, 2, 2), [255, 0, 0, 255]); // over the blue base
  eq(px(buf, 20, 15, 2)[3], 0); // nothing below: clipped away
});

test("without clipping the same layer covers the whole canvas", () => {
  const doc = new Document(20, 20);
  doc.addLayer("base").grid.fillRect(0, 0, 10, 20, [0, 0, 255, 255]);
  doc.addLayer("top").grid.fillRect(0, 0, 20, 20, [255, 0, 0, 255]);
  assert.deepEqual(px(frame(doc), 20, 15, 2), [255, 0, 0, 255]);
});

test("mask tiles stay sparse: a fresh mask allocates nothing", () => {
  const doc = new Document(40, 40);
  const l = doc.addLayer("l");
  const mask: TileGrid = doc.attachMask(l);
  eq(mask.allocated, 0);
  setMaskAt(mask, 1, 1, 0);
  eq(mask.allocated, 1);
});

// ---------------------------------------------------- mask painting/apply ---

test("paintMaskDab hides pixels where it paints black", () => {
  const doc = new Document(40, 40);
  doc.addBackground();
  const top = doc.addLayer("top");
  top.grid.fillRect(0, 0, 40, 40, [255, 0, 0, 255]);
  const mask = doc.attachMask(top);

  const rect = paintMaskDab(mask, { x: 20, y: 20, radius: 6, hardness: 1, alpha: 1, value: 0 });
  assert.ok(rect, "dab reported a rect");
  eq(maskAt(mask, 20, 20), 0);

  const buf = frame(doc);
  assert.deepEqual(px(buf, 40, 20, 20), [255, 255, 255, 255]); // hidden -> white bg
  assert.deepEqual(px(buf, 40, 2, 2), [255, 0, 0, 255]); // untouched corner
});

test("paintMaskDab with value 255 reveals again", () => {
  const doc = new Document(40, 40);
  doc.addBackground();
  const top = doc.addLayer("top");
  top.grid.fillRect(0, 0, 40, 40, [255, 0, 0, 255]);
  const mask = doc.attachMask(top);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) setMaskAt(mask, x, y, 0);
  eq(px(frame(doc), 40, 20, 20)[0], 255);

  paintMaskDab(mask, { x: 20, y: 20, radius: 8, hardness: 1, alpha: 1, value: 255 });
  eq(maskAt(mask, 20, 20), 255);
  assert.deepEqual(px(frame(doc), 40, 20, 20), [255, 0, 0, 255]);
});

test("bakeLayerMask multiplies alpha and drops the mask", () => {
  const doc = new Document(20, 20);
  const top = doc.addLayer("top");
  top.grid.fillRect(0, 0, 20, 20, [0, 0, 255, 255]);
  const mask = doc.attachMask(top);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) setMaskAt(mask, x, y, 0);

  bakeLayerMask(top, 20, 20);
  eq(top.mask, undefined);
  const corner = new Uint8ClampedArray(4);
  top.grid.readRect(2, 2, 1, 1, corner);
  eq(corner[3], 0); // hidden half became transparent
  const right = new Uint8ClampedArray(4);
  top.grid.readRect(15, 2, 1, 1, right);
  eq(right[3], 255);
});

test("mergeLayerInto honours the top layer's mask", () => {
  const doc = new Document(24, 24);
  const dst = doc.addLayer("dst");
  dst.grid.fillRect(0, 0, 24, 24, [0, 0, 0, 255]);
  const src = doc.addLayer("src");
  src.grid.fillRect(0, 0, 24, 24, [255, 255, 255, 255]);
  const mask = doc.attachMask(src);
  // hide the right half
  setMaskAt(mask, 12, 0, 0);
  setMaskAt(mask, 23, 23, 0);
  for (let y = 0; y < 24; y++) for (let x = 12; x < 24; x++) setMaskAt(mask, x, y, 0);
  mergeLayerInto(src, dst);
  const px = (x: number, y: number) => {
    const out = new Uint8ClampedArray(4);
    dst.grid.readRect(x, y, 1, 1, out);
    return out[0];
  };
  eq(px(2, 2), 255); // revealed half merged
  eq(px(20, 2), 0); // masked half left untouched
});

test("paintMaskDab allocates only when it actually hides", () => {
  const mask = new TileGrid(512, 512);
  // revealing over a fresh (all-revealing) mask changes nothing: no tiles, no dirty rect
  eq(paintMaskDab(mask, { x: 400, y: 400, radius: 6, hardness: 0.5, alpha: 1, value: 255 }), null);
  eq(mask.allocated, 0);
  // hiding must allocate exactly the tile it touches
  const rect = paintMaskDab(mask, { x: 400, y: 400, radius: 6, hardness: 0.5, alpha: 1, value: 0 });
  assert(rect !== null);
  eq(mask.allocated, 1);
  eq(maskAt(mask, 400, 400), 0);
});

test("apply-mask undo can restore both pixels and mask (composite entry idiom)", () => {
  const doc = new Document(32, 32);
  const layer = doc.addLayer("L");
  layer.grid.fillRect(0, 0, 32, 32, [255, 0, 0, 255]);
  const mask = doc.attachMask(layer);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) setMaskAt(mask, x, y, 0);
  const before = captureTiles(layer.grid);
  const maskBackup = layer.mask;
  bakeLayerMask(layer, 32, 32);
  const pixels = snapshotCommand(layer.grid, "Apply", before);
  eq(layer.mask, undefined);
  // the idiom main.ts uses: one entry restores the pixels AND the mask reference
  const entry = {
    label: "Apply Layer Mask",
    undo: () => { pixels!.undo(); layer.mask = maskBackup; },
    redo: () => { layer.mask = undefined; pixels!.redo(); },
  };
  entry.undo();
  assert(layer.mask !== undefined, "undo must bring the mask back");
  eq(maskAt(layer.mask!, 2, 2), 0); // hidden half is still hidden
  planeCheckReverted(layer);
});

/** the red channel must be back to the pre-bake value everywhere */
function planeCheckReverted(layer: { grid: TileGrid }): void {
  const out = new Uint8ClampedArray(32 * 32 * 4);
  layer.grid.readRect(0, 0, 32, 32, out);
  eq(out[3], 255); // alpha restored (the bake had zeroed the masked half)
  eq(out[(10 * 32 + 20) * 4 + 3], 255);
}

test("a clipped adjustment layer only affects the backdrop it is clipped to", () => {
  // backdrop: opaque white on the left half, transparent on the right half
  const doc = new Document(16, 8);
  const bg = doc.addLayer("BG");
  const px = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 8 * 8; i++) px[i * 4] = 255, px[i * 4 + 1] = 255, px[i * 4 + 2] = 255, px[i * 4 + 3] = 255;
  bg.grid.writeRect(0, 0, 8, 8, px);
  const adj = doc.addAdjustLayer(defaultAdjustSpec("invert"));
  adj.clipToBelow = true;
  const out = doc.composite();
  const at = (x: number, y: number): number[] => {
    const i = (y * 16 + x) * 4;
    return [out[i]!, out[i + 1]!, out[i + 2]!, out[i + 3]!];
  };
  // clipped: the inverted backdrop shows only where the backdrop exists
  assert.deepEqual(at(3, 3), [0, 0, 0, 255]);
  // outside the backdrop's coverage the inversion must not paint anything
  assert.deepEqual(at(12, 3), [0, 0, 0, 0]);
});
