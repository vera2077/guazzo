/**
 * dualbrush.test.ts — the second brush tip multiplies dab coverage.
 *
 * The observable is pixels, not the call: a dual tip that is transparent on
 * one side must leave that side of the dab unpainted, and a tip of zeros must
 * paint nothing at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { stampDab, type TipImage } from "../paint.ts";

/** a tip whose alpha is `left` on the left half and `right` on the right half */
function splitTip(left: number, right: number, w = 32, h = 32): TipImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = x < w / 2 ? left : right;
    }
  }
  return { data, w, h };
}

const RED = [255, 0, 0] as const;

function alphaAt(grid: TileGrid, x: number, y: number): number {
  const px = new Uint8ClampedArray(4);
  grid.readRect(x, y, 1, 1, px);
  return px[3]!;
}

test("without a dual tip the dab paints the whole disc", () => {
  const grid = new TileGrid(64, 64);
  stampDab(grid, { x: 32, y: 32, radius: 10, hardness: 1, alpha: 1, color: RED, mode: "normal" });
  assert.equal(alphaAt(grid, 25, 32), 255);
  assert.equal(alphaAt(grid, 39, 32), 255);
});

test("a dual tip that is transparent on the right leaves that side unpainted", () => {
  const grid = new TileGrid(64, 64);
  stampDab(grid, {
    x: 32, y: 32, radius: 10, hardness: 1, alpha: 1, color: RED, mode: "normal",
    dual: splitTip(255, 0), dualScale: 1,
  });
  assert.equal(alphaAt(grid, 25, 32), 255, "left of the dab's centre stays painted");
  assert.equal(alphaAt(grid, 39, 32), 0, "right of centre is masked out");
});

test("a dual tip of zeros paints nothing and reports no affected rect", () => {
  const grid = new TileGrid(64, 64);
  const rect = stampDab(grid, {
    x: 32, y: 32, radius: 10, hardness: 1, alpha: 1, color: RED, mode: "normal",
    dual: splitTip(0, 0),
  });
  assert.equal(rect, null);
  // the dab walk still materialises the tile before it can know nothing was
  // painted, so assert the pixels rather than the allocation count
  assert.equal(alphaAt(grid, 32, 32), 0);
});

test("a smaller dual tip textures the middle and leaves the rim alone", () => {
  // tip is fully transparent in the middle column and opaque elsewhere, so a
  // half-size dual can only remove paint near the centre of the dab
  const w = 32, h = 32;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= 14 && x <= 17) data[(y * w + x) * 4 + 3] = 0;
    }
  }
  const grid = new TileGrid(64, 64);
  stampDab(grid, {
    x: 32, y: 32, radius: 10, hardness: 1, alpha: 1, color: RED, mode: "normal",
    dual: { data, w, h }, dualScale: 0.5,
  });
  assert.equal(alphaAt(grid, 32, 32), 0, "the middle is under the second tip");
  assert.equal(alphaAt(grid, 24, 32), 255, "the rim is outside a half-size second tip");
});

test("hardness 1 paints a crisp disc, so a dual tip's boundary is exact", () => {
  // pin the assumption the tests above rely on: at hardness 1 the dab has no
  // soft band, otherwise "unpainted" would mean "dim" rather than zero
  const grid = new TileGrid(64, 64);
  stampDab(grid, { x: 32, y: 32, radius: 8, hardness: 1, alpha: 1, color: RED, mode: "normal" });
  assert.equal(alphaAt(grid, 32, 32), 255);
  assert.equal(alphaAt(grid, 38, 32), 255);
  assert.equal(alphaAt(grid, 41, 32), 0);
});
