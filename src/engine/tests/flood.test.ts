import assert from "node:assert/strict";
import { test } from "node:test";

import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import { floodFill, magicWand, regionMap, sampleGrid } from "../flood.ts";
import { eq } from "./helpers.ts";

/** assert helper that defeats TS literal narrowing on captured `let`s */
function px(grid: TileGrid, x: number, y: number): number[] {
  const out = new Uint8ClampedArray(4);
  grid.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/** a 4x4 grid: left half red, right half blue, one green pixel at (3,0) */
function twoTone(): TileGrid {
  const g = new TileGrid(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const c: [number, number, number, number] = x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255];
      g.fillRect(x, y, 1, 1, c);
    }
  }
  g.fillRect(3, 0, 1, 1, [0, 255, 0, 255]);
  return g;
}

test("contiguous flood stops at a colour edge", () => {
  const g = twoTone();
  const r = floodFill(g, 0, 0, { r: 255, g: 255, b: 255, a: 255 }, { tolerance: 0 });
  assert.ok(r);
  eq(r!.w, 2);
  eq(r!.h, 4);
  // left half repainted, right half untouched
  assert.deepEqual(px(g, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(g, 1, 3), [255, 255, 255, 255]);
  assert.deepEqual(px(g, 2, 0), [0, 0, 255, 255]);
});

test("non-contiguous fill reaches every similar pixel in the layer", () => {
  const make = (): TileGrid => {
    const g = new TileGrid(4, 4);
    // two separate red islands with blue between them
    g.fillRect(0, 0, 1, 1, [255, 0, 0, 255]);
    g.fillRect(3, 3, 1, 1, [255, 0, 0, 255]);
    g.fillRect(1, 1, 2, 2, [0, 0, 255, 255]);
    return g;
  };

  const nearGrid = make();
  const near = floodFill(nearGrid, 0, 0, { r: 0, g: 255, b: 0, a: 255 }, { tolerance: 0, contiguous: true });
  assert.ok(near);
  eq(near!.w, 1); // only the seed island
  assert.deepEqual(px(nearGrid, 3, 3), [255, 0, 0, 255]); // far island untouched

  const farGrid = make();
  const far = floodFill(farGrid, 0, 0, { r: 0, g: 255, b: 0, a: 255 }, { tolerance: 0, contiguous: false });
  assert.ok(far);
  eq(far!.w, 4); // both islands are in the rect now
  assert.deepEqual(px(farGrid, 0, 0), [0, 255, 0, 255]);
  assert.deepEqual(px(farGrid, 3, 3), [0, 255, 0, 255]);
  assert.deepEqual(px(farGrid, 1, 1), [0, 0, 255, 255]); // blue island untouched
});

test("tolerance widens the region, zero tolerance is exact", () => {
  const make = (): TileGrid => {
    const g = new TileGrid(3, 1);
    g.fillRect(0, 0, 1, 1, [100, 100, 100, 255]);
    g.fillRect(1, 0, 1, 1, [120, 120, 120, 255]);
    g.fillRect(2, 0, 1, 1, [200, 200, 200, 255]);
    return g;
  };

  const tightGrid = make();
  const tight = floodFill(tightGrid, 0, 0, { r: 0, g: 0, b: 0, a: 255 }, { tolerance: 0 });
  assert.ok(tight);
  eq(tight!.w, 1);

  const looseGrid = make();
  const loose = floodFill(looseGrid, 0, 0, { r: 0, g: 0, b: 0, a: 255 }, { tolerance: 25 });
  assert.ok(loose);
  eq(loose!.w, 2); // 100 and 120 are within 25, 200 is not
});

test("bucket respects a selection mask and reports the painted rect", () => {
  const g = new TileGrid(4, 4);
  g.fillRect(0, 0, 4, 4, [255, 255, 255, 255]);
  const mask = new SelectionMask(4, 4);
  mask.selectRect(1, 1, 2, 2);
  const r = floodFill(g, 0, 0, { r: 255, g: 0, b: 0, a: 255 }, { tolerance: 0, mask });
  assert.ok(r);
  eq(r!.w, 4); // the region map still covers the whole white layer
  assert.deepEqual(px(g, 2, 2), [255, 0, 0, 255]); // inside: filled
  assert.deepEqual(px(g, 0, 0), [255, 255, 255, 255]); // outside: untouched
});

test("transparent area is its own region and fills with alpha", () => {
  const g = new TileGrid(3, 3);
  g.fillRect(0, 0, 1, 1, [255, 0, 0, 255]); // one opaque pixel
  const r = floodFill(g, 2, 2, { r: 0, g: 128, b: 255, a: 128 }, { tolerance: 0 });
  assert.ok(r);
  eq(px(g, 2, 2)[3], 128);
  assert.deepEqual(px(g, 0, 0), [255, 0, 0, 255]); // opaque pixel survived
});

test("magic wand selects exactly the similar region", () => {
  const g = twoTone();
  const px4 = sampleGrid(g, 4, 4);
  const res = magicWand(px4, 4, 4, 2, 2, { tolerance: 0 });
  assert.ok(res);
  eq(res!.bbox.x, 2);
  eq(res!.bbox.w, 2);
  eq(res!.bbox.h, 4);
  eq(res!.mask.alphaAt(2, 0), 255);
  eq(res!.mask.alphaAt(3, 1), 255);
  eq(res!.mask.alphaAt(0, 0), 0);
});

test("magic wand antialias feathers the boundary, off keeps it hard", () => {
  const g = twoTone();
  const px4 = sampleGrid(g, 4, 4);
  const soft = magicWand(px4, 4, 4, 2, 0, { tolerance: 0, antialias: true });
  assert.ok(soft);
  eq(soft!.mask.alphaAt(1, 0), 128); // left of the edge: soft fringe
  eq(soft!.mask.alphaAt(0, 0), 0);

  const hard = magicWand(px4, 4, 4, 2, 0, { tolerance: 0, antialias: false });
  assert.ok(hard);
  eq(hard!.mask.alphaAt(1, 0), 0);
});

test("seed outside the canvas produces nothing", () => {
  const g = twoTone();
  assert.equal(floodFill(g, -1, 0, { r: 0, g: 0, b: 0, a: 255 }), null);
  const px4 = sampleGrid(g, 4, 4);
  assert.equal(magicWand(px4, 4, 4, 99, 0), null);
});

test("regionMap reports the matched count", () => {
  const g = twoTone();
  const px4 = sampleGrid(g, 4, 4);
  const red = regionMap(px4, 4, 4, 0, 0, { tolerance: 0 });
  eq(red.count, 8); // 2x4 red block
  const all = regionMap(px4, 4, 4, 0, 0, { tolerance: 255 });
  eq(all.count, 16); // huge tolerance swallows everything
});
