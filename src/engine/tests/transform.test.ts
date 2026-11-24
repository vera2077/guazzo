/**
 * transform.test.ts — Free Transform engine goldens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridBBox, transformLayer } from "../transform.ts";
import { Document, createLayerMask, maskAt, setMaskAt } from "../document.ts";
import { layerOpCommand } from "../history.ts";
import { projectTileCount } from "../io.ts";

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
  // A transformGrid now releases the fully-empty tile the zero scale leaves
  // behind, so a sane result is zero (or, without that cleanup, one) tile.
  assert.deepEqual(l.grid.allocated <= 1, true); // ran, layer state sane
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

test("transform releases empty mask tiles swept across tile boundaries", () => {
  // r41 code item: a mask transform filled the vacated footprint with `empty`
  // but never released it, so every transform grew the mask's allocated tile
  // count toward the 512-tile cap — and widened gridBBox for the next op.
  for (const hideMask of [false, true] as const) {
    const label = hideMask ? "hide mask (empty=255)" : "reveal mask (empty=0)";
    const doc = new Document(600, 600);
    const layer = doc.addLayer("Masked");
    const mask = doc.attachMask(layer);
    layer.maskHide = hideMask;
    const empty = hideMask ? 255 : 0;
    // One mask tile holding content of the NON-empty polarity: a hidden pixel
    // on a reveal mask, a revealed pixel on a hide mask. Everything else in
    // the tile stores `empty`, so swept-but-unwritten tiles are releasable.
    mask.fillRect(0, 0, 256, 256, [empty, empty, empty, empty === 0 ? 0 : 255]);
    setMaskAt(mask, 10, 10, hideMask ? 255 : 0);
    assert.equal(mask.allocated, 1, `${label}: seeded one tile`);
    assert.equal(projectTileCount(doc), 1, `${label}: one projected tile before`);

    // One tile step (~300 px rounded to the 256 px tile) still crosses the tile
    // boundary: (0,0) -> (1,0). Source and destination are both fully written,
    // so the vacated tile is the only empty one in the swept union.
    transformLayer(layer, { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 256, dy: 0 });

    assert.equal(mask.allocated, 1, `${label}: only the tile with mask content stays allocated`);
    assert.equal(maskAt(mask, 266, 10, hideMask ? 0 : 255), hideMask ? 255 : 0,
      `${label}: the mask content moved with the transform`);
    assert.equal(maskAt(mask, 10, 10, 0), 0,
      `${label}: the vacated area reads hidden/unselected`);
    assert.equal(mask.tile(0, 0, false), undefined, `${label}: vacated tile released`);
    assert.notEqual(mask.tile(1, 0, false), undefined, `${label}: destination tile kept`);
    assert.equal(projectTileCount(doc), 1, `${label}: no swept-but-empty mask tile projected`);

    // A second step proves the count does NOT grow: the newly vacated (1,0)
    // is released too, so the swept union never accumulates tiles.
    transformLayer(layer, { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 256, dy: 0 });
    assert.equal(mask.allocated, 1, `${label}: still one tile after a second transform`);
    assert.equal(maskAt(mask, 522, 10, hideMask ? 0 : 255), hideMask ? 255 : 0,
      `${label}: the content moved again with the second transform`);
    assert.equal(mask.tile(1, 0, false), undefined, `${label}: second vacated tile released`);
    assert.equal(projectTileCount(doc), 1, `${label}: projection stays sparse after two transforms`);
  }
});
