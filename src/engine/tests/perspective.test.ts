/**
 * perspective.test.ts — the mapping is tested geometrically (corners, centre,
 * identity) and the resampling is tested on a known pattern, because a warp can
 * look plausible while being mirrored or half-pixel shifted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../document.ts";
import { mapPoint, perspectiveCrop, quadSize, squareToQuad } from "../perspective.ts";
import { TileGrid } from "../tile.ts";
import { setMaskAt } from "../document.ts";

function docWith(fn: (x: number, y: number) => number[]): Document {
  const doc = new Document(8, 8);
  const layer = doc.addLayer("BG");
  const px = new Uint8ClampedArray(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const px4 = fn(x, y) as [number, number, number, number];
      const i = (y * 8 + x) * 4;
      px[i] = px4[0]; px[i + 1] = px4[1]; px[i + 2] = px4[2]; px[i + 3] = px4[3];
    }
  }
  layer.grid.writeRect(0, 0, 8, 8, px);
  return doc;
}

const at = (doc: Document, x: number, y: number): number[] => {
  const out = new Uint8ClampedArray(4);
  doc.layers[0]!.grid.readRect(x, y, 1, 1, out);
  return [...out];
};

test("squareToQuad maps the unit square corners onto the quad corners", () => {
  const q: [[number, number], [number, number], [number, number], [number, number]] =
    [[10, 20], [90, 12], [95, 80], [8, 70]];
  const m = squareToQuad(q);
  const near = (a: [number, number], b: [number, number]): void => {
    assert.ok(Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6, `${a} != ${b}`);
  };
  near(mapPoint(m, 0, 0), q[0]);
  near(mapPoint(m, 1, 0), q[1]);
  near(mapPoint(m, 1, 1), q[2]);
  near(mapPoint(m, 0, 1), q[3]);
});

test("squareToQuad of a rectangle is affine (no projective term)", () => {
  const m = squareToQuad([[0, 0], [40, 0], [40, 20], [0, 20]]);
  assert.equal(Math.round(m.g * 1e9) / 1e9, 0);
  assert.equal(Math.round(m.h * 1e9) / 1e9, 0);
  assert.deepEqual(mapPoint(m, 0.5, 0.5).map((v) => Math.round(v)), [20, 10]);
});

test("collinear corners are refused, not silently squashed", () => {
  assert.throws(() => squareToQuad([[0, 0], [1, 0], [2, 0], [3, 0]]), /collinear/);
});

test("quadSize is the bounding box", () => {
  assert.deepEqual(quadSize([[2, 3], [10, 1], [12, 9], [4, 11]]), { w: 10, h: 10 });
});

test("a rectangular quad warped to the same size reproduces the pixels", () => {
  const doc = docWith((x, y) => [x * 30, y * 30, 40, 255]);
  const out = perspectiveCrop(doc, [[0, 0], [8, 0], [8, 8], [0, 8]], 8, 8);
  assert.deepEqual(at(out.doc, 0, 0), [0, 0, 40, 255]);
  assert.deepEqual(at(out.doc, 7, 7), [210, 210, 40, 255]);
  assert.deepEqual(at(out.doc, 3, 5), [90, 150, 40, 255]);
});

test("warping a quarter of the document expands it to the full output", () => {
  const doc = docWith((x, y) => [x * 10, y * 10, 0, 255]);
  const out = perspectiveCrop(doc, [[4, 4], [8, 4], [8, 8], [4, 8]], 8, 8);
  // destination pixel centres sit half a pixel inside the quad, so the corner
  // samples ~(4.25, 4.25) and blends texel 3 with texel 4 (37.5 → 38). Asserting
  // an exact 40 here would be asserting a half-pixel bug.
  const first = at(out.doc, 0, 0);
  assert.ok(first[0]! >= 36 && first[0]! <= 42, `expected ~38, got ${first[0]}`);
  const last = at(out.doc, 7, 7);
  assert.ok(last[0]! >= 70 && last[0]! <= 80, `expected ~75, got ${last[0]}`);
});

test("non-pixel layers keep their recipe through the warp", () => {
  const doc = new Document(8, 8);
  doc.addLayer("BG").grid.writeRect(0, 0, 8, 8, new Uint8ClampedArray(8 * 8 * 4).fill(255));
  const adj = doc.addAdjustLayer({ kind: "levels" });
  adj.opacity = 0.4;
  const out = perspectiveCrop(doc, [[0, 0], [8, 0], [8, 8], [0, 8]], 4, 4);
  const back = out.doc.layers[1]!;
  assert.equal(back.kind, "adjust");
  assert.equal(back.opacity, 0.4);
  assert.equal(back.adjust?.kind, "levels");
});

test("layer order, blend mode and group survive the warp", () => {
  const doc = docWith(() => [10, 20, 30, 255]);
  const top = doc.addLayer("Top");
  top.blendMode = "multiply";
  top.groupId = "G2";
  top.opacity = 0.25;
  const out = perspectiveCrop(doc, [[0, 0], [8, 0], [8, 8], [0, 8]], 4, 4);
  assert.equal(out.doc.layers.length, 2);
  assert.equal(out.doc.layers[1]!.name, "Top");
  assert.equal(out.doc.layers[1]!.blendMode, "multiply");
  assert.equal(out.doc.layers[1]!.groupId, "G2");
  assert.equal(out.doc.layers[1]!.opacity, 0.25);
});

test("transparent source stays transparent instead of turning black", () => {
  const doc = docWith((x) => (x < 4 ? [200, 0, 0, 255] : [0, 0, 0, 0]));
  // warp the OPAQUE left half; the transparent right half must not bleed in
  const out = perspectiveCrop(doc, [[0, 0], [4, 0], [4, 8], [0, 8]], 4, 4);
  const solid = at(out.doc, 0, 0);
  assert.ok(solid[3]! > 200, `opaque edge should stay opaque, alpha=${solid[3]}`);
  assert.ok(solid[0]! > 150, `and keep its colour, got ${solid[0]}`);
  const edge = at(out.doc, 3, 3);
  assert.ok(edge[0]! > 150, `right edge still opaque-ish, got ${edge[0]}/${edge[3]}`);
});

test("a hide-polarity mask keeps its polarity through the crop", () => {
  // maskHide stores "hidden" inverted, so an UNALLOCATED tile means hidden. The
  // warp copied coverage with a reveal-polarity default (255), so every tile the
  // mask never allocated became visible — the crop revealed what the mask hid.
  // Use a canvas wider than one tile so one tile can be allocated and the other
  // left unallocated; inside a single tile "unallocated" is not expressible.
  const doc = new Document(512, 8);
  const layer = doc.addLayer("BG");
  const px = new Uint8ClampedArray(512 * 8 * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  layer.grid.writeRect(0, 0, 512, 8, px);
  const mask = new TileGrid(512, 8);
  for (let y = 0; y < 8; y++) for (let x = 256; x < 512; x++) setMaskAt(mask, x, y, 255);
  layer.mask = mask;
  layer.maskHide = true;

  const before = doc.composite();
  assert.equal(before[3]!, 0, "precondition: the unallocated left tile is hidden");

  const out = perspectiveCrop(doc, [[0, 0], [512, 0], [512, 8], [0, 8]], 512, 8);
  const cropped = out.doc.layers[0]!;
  assert.equal(cropped.maskHide, true, "the mask polarity must travel with the mask");
  const after = out.doc.composite();
  assert.equal(after[3]!, 0, "the cropped document still hides the left tile");
  assert.equal(after[(4 * 512 + 300) * 4 + 3]!, 255, "the allocated right tile stays visible");
});
