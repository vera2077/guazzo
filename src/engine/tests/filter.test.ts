/**
 * filter.test.ts — classic filters: property/golden tests.
 * Filters are float-heavy, so tests favor robust properties (symmetry,
 * bounds, determinism, edge behavior) over exact 8-bit golden values.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { applyFilter } from "../filter.ts";

function solid(w: number, h: number, rgba: readonly number[]): TileGrid {
  const g = new TileGrid(w, h);
  g.fillRect(0, 0, w, h, rgba);
  return g;
}

function px(g: TileGrid, x: number, y: number, _w: number): number[] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return Array.from(out);
}

test("blur on a uniform opaque image is a no-op (edge clamp)", () => {
  const g = solid(32, 32, [120, 130, 140, 255]);
  applyFilter(g, 0, 0, 32, 32, { kind: "blur", amount: 4 });
  const res = new Uint8ClampedArray(32 * 32 * 4);
  g.readRect(0, 0, 32, 32, res);
  // every pixel must remain exactly the input color (blur of a constant)
  for (let i = 0; i < res.length; i += 4) {
    if (res[i] !== 120 || res[i + 1] !== 130 || res[i + 2] !== 140 || res[i + 3] !== 255) {
      assert.fail(`pixel ${i / 4} changed: ${Array.from(res.slice(i, i + 4))}`);
    }
  }
});

test("blur of an impulse is radially symmetric and spreads energy", () => {
  const g = solid(21, 21, [0, 0, 0, 255]);
  g.fillRect(10, 10, 1, 1, [255, 0, 0, 255]);
  applyFilter(g, 0, 0, 21, 21, { kind: "blur", amount: 2 });
  const c = px(g, 10, 10, 21)[0]!;
  const right = px(g, 13, 10, 21)[0]!;
  const down = px(g, 10, 13, 21)[0]!;
  const diag = px(g, 13, 13, 21)[0]!;
  assert.ok(c > 0 && c < 255, `center faded: ${c}`);
  assert.ok(right > 0, `energy spread to +3,0: ${right}`);
  assert.equal(right, down, "radially symmetric (x axis == y axis)");
  assert.ok(right > diag, "diagonal falls off faster than axis");
});

test("sharpen overshoots at a step edge and leaves far pixels intact", () => {
  const g = new TileGrid(16, 16);
  for (let x = 0; x < 16; x++) {
    g.fillRect(x, 0, 1, 16, x < 8 ? [50, 50, 50, 255] : [200, 200, 200, 255]);
  }
  applyFilter(g, 0, 0, 16, 16, { kind: "sharpen", amount: 100 }); // k = 4
  const leftEdge = px(g, 6, 8, 16)[0]!;  // 2 px from the step
  const atEdgeL = px(g, 7, 8, 16)[0]!;   // adjacent
  const atEdgeR = px(g, 8, 8, 16)[0]!;
  const far = px(g, 2, 8, 16)[0]!;
  // k=4: adjacent-left = 5*50 - (50*3 + 200) = -100 → clamps to 0
  assert.equal(atEdgeL, 0);
  // adjacent-right = 5*200 - (50 + 200*3) = 350 → clamps to 255
  assert.equal(atEdgeR, 255);
  assert.equal(far, 50, "far from the edge, unchanged");
  assert.equal(leftEdge, 50, "2px away still unchanged (3x3 kernel reach)");
});

test("noise: deterministic (seeded), bounded, skips transparent pixels", () => {
  const g = solid(64, 64, [100, 100, 100, 255]);
  applyFilter(g, 0, 0, 64, 64, { kind: "noise", amount: 30 });
  const res = new Uint8ClampedArray(64 * 64 * 4);
  g.readRect(0, 0, 64, 64, res);
  let min = 255, max = 0;
  for (let i = 0; i < res.length; i += 4) {
    const v = res[i]!;
    min = Math.min(min, v); max = Math.max(max, v);
    assert.ok(res[i + 3] === 255, "alpha untouched");
  }
  assert.ok(min >= 70 && max <= 130, `bounds ±30: got ${min}..${max}`);
  assert.ok(min < 100 && max > 100, "noise actually varies");

  // transparent pixel must stay exactly zero
  const g2 = new TileGrid(64, 64);
  g2.fillRect(10, 10, 5, 5, [200, 200, 200, 255]);
  applyFilter(g2, 0, 0, 64, 64, { kind: "noise", amount: 30 });
  assert.deepEqual(px(g2, 40, 40, 64), [0, 0, 0, 0]);
});

test("pixelate: every block becomes the block average", () => {
  const g = new TileGrid(8, 8);
  // two 4x4 blocks with known averages: left 0/255 checker → 128ish; right solid 200
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = x < 4 ? ((x + y) % 2 === 0 ? 0 : 255) : 200;
      g.fillRect(x, y, 1, 1, [v, v, v, 255]);
    }
  }
  applyFilter(g, 0, 0, 8, 8, { kind: "pixelate", amount: 4 });
  // left block: 8 zeros + 8 255s in 16 pixels → 127.5 → ties-to-even 128
  assert.deepEqual(px(g, 0, 0, 8), [128, 128, 128, 255]);
  assert.deepEqual(px(g, 3, 3, 8), [128, 128, 128, 255]);
  // right block: uniform 200 stays 200
  assert.deepEqual(px(g, 4, 0, 8), [200, 200, 200, 255]);
  assert.deepEqual(px(g, 7, 7, 8), [200, 200, 200, 255]);
});

test("blur respects the rect: pixels outside the filter rect untouched", () => {
  const g = solid(32, 32, [0, 0, 0, 255]);
  g.fillRect(16, 16, 1, 1, [255, 255, 255, 255]);
  applyFilter(g, 8, 8, 16, 16, { kind: "blur", amount: 2 });
  // impulse at (16,16) is inside the rect → spread
  assert.ok(px(g, 16, 16, 32)[0]! < 255, "impulse blurred");
  // pixel far outside the rect keeps its solid color
  assert.deepEqual(px(g, 2, 2, 32), [0, 0, 0, 255]);
});

test("unsharp: step edge overshoots, uniform regions stay byte-exact", () => {
  const g = new TileGrid(64, 64);
  // vertical step: left half 50, right half 200
  g.fillRect(0, 0, 64, 64, [50, 50, 50, 255]);
  g.fillRect(32, 0, 32, 64, [200, 200, 200, 255]);
  applyFilter(g, 8, 8, 48, 48, { kind: "unsharp", amount: 50 });
  const res = new Uint8ClampedArray(4 * 64 * 64);
  g.readRect(0, 0, 64, 64, res);
  const px = (x: number, y: number) => res[(y * 64 + x) * 4]!;
  // far from the edge (beyond the σ=1.5 kernel reach of 5): blur == orig → untouched
  assert.equal(px(12, 32), 50);
  assert.equal(px(52, 32), 200);
  // adjacent to the edge: overshoot on both sides (halo = classic unsharp look)
  assert.ok(px(31, 32) < 50, `edge-left undershoots, got ${px(31, 32)}`);
  assert.ok(px(33, 32) > 200, `edge-right overshoots, got ${px(33, 32)}`);
  // alpha untouched everywhere
  assert.equal(res[(32 * 64 + 12) * 4 + 3]!, 255);
  assert.equal(res[(32 * 64 + 33) * 4 + 3]!, 255);
});
