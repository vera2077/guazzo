/**
 * geom.test.ts — geometry ops must preserve the whole layer recipe.
 *
 * Rotate/Flip (imageops), Image Size / Canvas Size / Crop (resize) and
 * Free Transform (transform) all rebuild layers. The review found they
 * silently dropped adjust/fill/clip/group/mask — this file pins every
 * recipe field plus mask coverage plus composite coherence for each path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, maskAt, setMaskAt, type Layer } from "../document.ts";
import { rotate90, flip } from "../imageops.ts";
import { resizeDocument, cropDocument } from "../resize.ts";
import { transformLayer } from "../transform.ts";
import { defaultAdjustSpec } from "../adjustfn.ts";
import { eq } from "./helpers.ts";

/** the acceptance fixture: Curves adjust + masked pixel + clipped fill + group */
function richDoc(): Document {
  const doc = new Document(12, 8);
  const bg = doc.addLayer("BG");
  bg.grid.fillRect(0, 0, 12, 8, [255, 255, 255, 255]);

  const masked = doc.addLayer("Masked");
  masked.grid.fillRect(2, 2, 4, 4, [255, 0, 0, 255]);
  masked.groupId = "G1";
  const mask = doc.attachMask(masked);
  for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) setMaskAt(mask, x, y, 0);

  const fillL = doc.addFillLayer([0, 128, 255], "Fill");
  fillL.clipToBelow = true;
  fillL.opacity = 0.5;

  const spec = defaultAdjustSpec("curves");
  spec.curves = { rgb: [{ x: 0, y: 0 }, { x: 64, y: 180 }, { x: 255, y: 255 }] };
  doc.addAdjustLayer(spec);
  return doc;
}

/** every recipe field of dst must equal src (grid/mask/textData excluded) */
function recipeEqual(a: Layer, b: Layer, msg: string): void {
  eq(a.name, b.name);
  eq(a.kind, b.kind);
  eq(a.visible, b.visible);
  eq(a.opacity, b.opacity);
  eq(a.blendMode, b.blendMode);
  eq(a.locked, b.locked);
  eq(a.clipToBelow, b.clipToBelow);
  eq(a.groupId, b.groupId);
  assert.deepEqual(a.adjust, b.adjust, `${msg}: adjust`);
  assert.deepEqual(a.fill?.color, b.fill?.color, `${msg}: fill`);
}

function allRecipesEqual(src: Document, dst: Document, msg: string): void {
  eq(dst.layers.length, src.layers.length);
  for (let i = 0; i < src.layers.length; i++) recipeEqual(dst.layers[i]!, src.layers[i]!, `${msg} L${i}`);
}

function composite(doc: Document): Uint8ClampedArray {
  return doc.composite();
}

test("rotate90 preserves recipes, masks and the exact composite", () => {
  const doc = richDoc();
  const rot = rotate90(doc, 1); // 12×8 → 8×12, clockwise
  allRecipesEqual(doc, rot, "rotate");

  // mask coverage follows the content: hidden (3,3) maps to (7−1−3→…) CW
  // map is [src.height−1−y, x] with src.height = 8 → (3,3) → (4,3)
  const mask = rot.layers[1]!.mask;
  eq(!!mask, true);
  eq(maskAt(mask, 4, 3), 0);
  eq(maskAt(mask, 2, 2), 255);

  // composite coherence: rotate the flat buffer myself and compare byte-exact
  const src = composite(doc);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 12; x++) {
      const nx = 8 - 1 - y, ny = x;
      out.set(src.subarray((y * 12 + x) * 4, (y * 12 + x) * 4 + 4), (ny * 8 + nx) * 4);
    }
  }
  assert.deepEqual(composite(rot), out);
});

test("flip preserves recipes, masks and the exact composite", () => {
  const doc = richDoc();
  const fh = flip(doc, "horizontal");
  allRecipesEqual(doc, fh, "flip");
  const mask = fh.layers[1]!.mask;
  eq(maskAt(mask, 8, 3), 0);
  eq(maskAt(mask, 3, 3), 255);
  const src = composite(doc);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 12; x++) {
      const nx = 12 - 1 - x, ny = y;
      out.set(src.subarray((y * 12 + x) * 4, (y * 12 + x) * 4 + 4), (ny * 12 + nx) * 4);
    }
  }
  assert.deepEqual(composite(fh), out);
});

test("Image Size preserves recipes and resamples the mask", () => {
  const doc = richDoc();
  const big = resizeDocument(doc, 24, 16);
  allRecipesEqual(doc, big, "resize");
  const mask = big.layers[1]!.mask;
  eq(!!mask, true);
  // hidden block [3,5)² scales 2× — dest (7,7) samples src (3.25,3.25), well
  // inside the block; dest (3,3) samples src (1.25,1.25), well outside
  eq(maskAt(mask, 7, 7), 0);
  eq(maskAt(mask, 3, 3), 255);
  // adjust/fill layers still render (nonzero composite, not a blank canvas)
  const px = composite(big);
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += px[i]!;
  eq(sum > 0, true);
});

test("Crop preserves recipes, masks and the exact composite", () => {
  const doc = richDoc();
  const cropped = cropDocument(doc, 2, 2, 8, 6); // 12×8 → 8×6
  allRecipesEqual(doc, cropped, "crop");
  const mask = cropped.layers[1]!.mask;
  eq(!!mask, true);
  eq(maskAt(mask, 1, 1), 0);
  eq(maskAt(mask, 0, 0), 255);
  const src = composite(doc);
  const out = new Uint8ClampedArray(8 * 6 * 4);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      out.set(src.subarray(((y + 2) * 12 + (x + 2)) * 4, ((y + 2) * 12 + (x + 2)) * 4 + 4), (y * 8 + x) * 4);
    }
  }
  assert.deepEqual(composite(cropped), out);
});

test("Free Transform rotates the layer mask with the layer", () => {
  const doc = new Document(12, 8);
  const layer = doc.addLayer("Rot");
  layer.grid.fillRect(3, 3, 4, 4, [10, 200, 30, 255]);
  const mask = doc.attachMask(layer);
  for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) setMaskAt(mask, x, y, 0);

  transformLayer(layer, { angleDeg: 90, scaleX: 1, scaleY: 1, dx: 0, dy: 0 });

  const after = layer.mask;
  eq(!!after, true);
  // the hidden 2×2 block at [3,5)² rotates to [5,7)×[1,3) (90° CW around the
  // allocated-tile bbox centre); the old spot is revealed again
  const hidden: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 12; x++) {
      if (maskAt(after, x, y) === 0) hidden.push(y * 12 + x);
    }
  }
  assert.deepEqual(hidden, [1 * 12 + 5, 1 * 12 + 6, 2 * 12 + 5, 2 * 12 + 6]);
  eq(maskAt(after, 3, 3), 255);
});

test("rotate only allocates the tiles the picture reaches (code-r9 #3)", () => {
  const doc = new Document(600, 600);
  const layer = doc.addLayer("small");
  // A 4x4 dab lives in one 256px tile; a rotate must not allocate all nine.
  layer.grid.writeRect(8, 8, 4, 4, new Uint8ClampedArray(4 * 4 * 4).fill(200));
  const out = rotate90(doc, 1);
  let blocks = 0;
  out.layers[0]!.grid.forEachTile(() => { blocks++; });
  assert.ok(blocks <= 2, `rotate allocated ${blocks} tiles for one 4x4 dab`);
});

test("an emptied tile is released, so a later transform pivots on the pixels", () => {
  // code-r38 #5: a Move writes the union of the old and new footprints and
  // leaves the vacated 256 px tiles allocated-but-zero; gridBBox then describes
  // everything the layer ever covered, and Free Transform orbits that centre.
  const doc = new Document(600, 600);
  const layer = doc.addLayer("Dab");
  const dab = layer.grid.tile(0, 0, true)!;
  dab.data[3] = 255;
  assert.equal(layer.grid.allocated, 1);
  dab.data.fill(0);
  layer.grid.releaseEmptyTiles();
  assert.equal(layer.grid.allocated, 0);
  // A tile that still holds a pixel is kept.
  const other = layer.grid.tile(1, 0, true)!;
  other.data[3] = 1;
  layer.grid.releaseEmptyTiles();
  assert.equal(layer.grid.allocated, 1);
});
