/**
 * smart.test.ts — a smart object keeps its source, so scaling samples the
 * original image rather than the pixels already on screen.
 *
 * The proof that matters is comparative: the same two transforms are applied
 * to a smart layer and to an ordinary one, and the smart result must be closer
 * to the original. A single "it did not crash" assertion would pass for a
 * feature that silently resampled twice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../document.ts";
import { TileGrid } from "../tile.ts";
import { gridBBox, transformLayer } from "../transform.ts";
import { smartSourceFromGrid, renderSmartIntoGrid, transformSmartGrid, normalizeSmartSource, contentBounds } from "../smart.ts";
import { serializeProject, deserializeProject } from "../io.ts";

/** 64×64 with 2 px vertical stripes — high frequency, so resampling shows up */
function stripes(): TileGrid {
  const g = new TileGrid(64, 64);
  const px = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const o = (y * 64 + x) * 4;
      const on = Math.floor(x / 2) % 2 === 0;
      px[o] = on ? 255 : 0;
      px[o + 1] = on ? 255 : 0;
      px[o + 2] = on ? 255 : 0;
      px[o + 3] = 255;
    }
  }
  g.writeRect(0, 0, 64, 64, px);
  return g;
}

function readAll(g: TileGrid): Uint8ClampedArray {
  const bb = gridBBox(g)!;
  const out = new Uint8ClampedArray(bb.w * bb.h * 4);
  g.readRect(bb.x, bb.y, bb.w, bb.h, out);
  return out;
}

function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  // a size mismatch is a difference too, not a free pass
  return sum / n + Math.abs(a.length - b.length) / 4;
}

test("the source is the layer's bounding box, pixel for pixel", () => {
  const g = stripes();
  const src = smartSourceFromGrid(g)!;
  assert.equal(src.width, 64);
  assert.equal(src.height, 64);
  assert.deepEqual(Array.from(src.data.subarray(0, 8)), Array.from(readAll(g).subarray(0, 8)));
});

test("rendering the source back into its own rect reproduces the pixels", () => {
  const g = stripes();
  const src = smartSourceFromGrid(g)!;
  const before = readAll(g);
  renderSmartIntoGrid(g, src, { x: 0, y: 0, w: 64, h: 64 });
  assert.deepEqual(Array.from(readAll(g)), Array.from(before));
});

test("shrink to 25 % then grow back keeps the detail a plain raster loses", () => {
  const source = smartSourceFromGrid(stripes())!;

  // smart: two transforms, each derived from the source
  const smart = stripes().constructor === TileGrid ? stripes() : stripes();
  transformSmartGrid(smart, source, { angleDeg: 0, scaleX: 0.25, scaleY: 0.25, dx: 0, dy: 0 }, 64, 64);
  const small = contentBounds(smart)!;
  assert.ok(small.w >= 14 && small.w <= 18, `expected ~16 px after a quarter scale, got ${small.w}`);
  transformSmartGrid(smart, source, { angleDeg: 0, scaleX: 4, scaleY: 4, dx: 0, dy: 0 }, small.w, small.h);

  // ordinary: the same two transforms on the pixels themselves
  const plainDoc = new Document(64, 64);
  const plain = plainDoc.addLayer("plain");
  plain.grid.writeRect(0, 0, 64, 64, readAll(stripes()));
  transformLayer(plain, { angleDeg: 0, scaleX: 0.25, scaleY: 0.25, dx: 0, dy: 0 });
  transformLayer(plain, { angleDeg: 0, scaleX: 4, scaleY: 4, dx: 0, dy: 0 });

  const original = readAll(stripes());
  const smartDiff = meanAbsDiff(readAll(smart), original);
  const plainDiff = meanAbsDiff(readAll(plain.grid), original);
  assert.ok(smartDiff <= 2, `smart object should come back clean, mean difference ${smartDiff.toFixed(1)}`);
  assert.ok(
    smartDiff < plainDiff - 5,
    `smart must be measurably better than resampling twice (smart ${smartDiff.toFixed(1)}, plain ${plainDiff.toFixed(1)})`,
  );
});

test("a smart source is validated like any other untrusted input", () => {
  const good = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  assert.ok(normalizeSmartSource(good));
  assert.equal(normalizeSmartSource(null), null);
  assert.equal(normalizeSmartSource({ width: 0, height: 2, data: new Uint8ClampedArray(8) }), null);
  assert.equal(normalizeSmartSource({ width: 2.5, height: 2, data: new Uint8ClampedArray(20) }), null);
  assert.equal(normalizeSmartSource({ width: 3, height: 3, data: new Uint8ClampedArray(4) }), null);
  assert.equal(normalizeSmartSource({ width: 40000, height: 2, data: new Uint8ClampedArray(320000) }), null);
});

test("a smart object survives the project format", () => {
  const doc = new Document(32, 32);
  const layer = doc.addLayer("photo");
  layer.grid.writeRect(0, 0, 8, 8, new Uint8ClampedArray(8 * 8 * 4).fill(200));
  const src = smartSourceFromGrid(layer.grid)!;
  layer.smart = src;
  const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc, "smart"))));
  const loaded = back.doc.layers[0]!;  // groups/layers as loaded
  assert.ok(loaded.smart, "the source must travel with the project");
  assert.equal(loaded.smart!.width, 8);
  assert.equal(loaded.smart!.height, 8);
  assert.deepEqual(
    Array.from(loaded.smart!.data.subarray(0, 16)),
    Array.from(src.data.subarray(0, 16)),
  );
});

test("transformSmartGrid keeps an offset layer where it sits", () => {
  // A source-sized temp grid put every layer back at the origin: the part of
  // the picture outside the source rect was cut and an offset layer wiped
  // (code-r28 #1). The temp grid must be document-sized and the source written
  // at the footprint.
  const grid = new TileGrid(64, 64);
  const src = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 8 * 8; i++) {
    src[i * 4] = 255;
    src[i * 4 + 3] = 255;
  }
  const source = { width: 8, height: 8, data: src };
  renderSmartIntoGrid(grid, source, { x: 20, y: 10, w: 8, h: 8 });
  transformSmartGrid(
    grid,
    source,
    { angleDeg: 0, scaleX: 2, scaleY: 2, dx: 0, dy: 0 },
    16,
    16,
  );
  const px = new Uint8ClampedArray(4);
  grid.readRect(17, 7, 1, 1, px);
  assert.ok(px[3]! > 0, "the scaled layer must still cover its own corner");
  grid.readRect(2, 2, 1, 1, px);
  assert.equal(px[3], 0, "and must not be resurrected at the origin");
  const bb = contentBounds(grid)!;
  assert.ok(bb.x < 20 && bb.y < 10, "the footprint must grow around its own centre");
});


test("a replaced source larger than the canvas does not clip on the next transform", () => {
  // Replace Contents installs a 600 px source into a 100 px footprint on a
  // 400 px canvas; the old path wrote the source at natural size into the
  // document and clipped it, collapsing the layer to ~21 px (code-r29 #1).
  const grid = new TileGrid(400, 300);
  const source = new Uint8ClampedArray(600 * 600 * 4);
  for (let i = 0; i < 600 * 600; i++) {
    source[i * 4] = 120;
    source[i * 4 + 3] = 255;
  }
  const src = { width: 600, height: 600, data: source };
  renderSmartIntoGrid(grid, src, { x: 10, y: 10, w: 100, h: 100 });
  transformSmartGrid(
    grid,
    src,
    { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 5, dy: 0 },
    100,
    100,
  );
  const bb = contentBounds(grid)!;
  assert.ok(bb.w >= 95 && bb.w <= 105, `expected the same footprint, got ${bb.w}`);
  assert.ok(bb.h >= 95 && bb.h <= 105, `expected the same height, got ${bb.h}`);
  const px = new Uint8ClampedArray(4);
  grid.readRect(65, 60, 1, 1, px);
  assert.ok(px[3]! > 0, "the moved layer must still cover its centre");
});
