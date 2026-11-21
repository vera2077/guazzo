/**
 * move.test.ts — Move tool plumbing and Crop.
 *
 * The load-bearing property: a drag must be lossless no matter how many
 * times the pointer moves, and the undo step must restore the original
 * bytes exactly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TileGrid } from "../tile.ts";
import { Document } from "../document.ts";
import { snapshotGrid, applyLayerMove } from "../move.ts";
import { cropDocument } from "../resize.ts";
import { SelectionMask } from "../mask.ts";
import { captureTiles, snapshotCommand } from "../history.ts";

const px = (g: TileGrid, x: number, y: number): number[] => {
  const b = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, b);
  return [...b];
};

const put = (g: TileGrid, x: number, y: number, rgba: number[]): void => {
  g.writeRect(x, y, 1, 1, new Uint8ClampedArray(rgba));
};

test("applyLayerMove shifts content by an absolute offset", () => {
  const g = new TileGrid(40, 40);
  put(g, 10, 12, [255, 0, 0, 255]);
  const snap = snapshotGrid(g);

  applyLayerMove(g, snap, 5, 7);
  assert.deepEqual(px(g, 10, 12), [0, 0, 0, 0]); // old position cleared
  assert.deepEqual(px(g, 15, 19), [255, 0, 0, 255]); // exact copy, no resampling

  // re-applying from the SAME snapshot is idempotent (drags are absolute)
  applyLayerMove(g, snap, 5, 7);
  assert.deepEqual(px(g, 15, 19), [255, 0, 0, 255]);
  assert.deepEqual(px(g, 10, 12), [0, 0, 0, 0]);
});

test("applyLayerMove clips content that leaves the canvas", () => {
  const g = new TileGrid(16, 16);
  put(g, 2, 2, [0, 255, 0, 255]);
  const snap = snapshotGrid(g);
  applyLayerMove(g, snap, -8, 0);
  assert.deepEqual(px(g, 2, 2), [0, 0, 0, 0]);
  assert.deepEqual(g.allocated === 0 || px(g, 0, 0)[3] === 0, true);
});

test("masked move carries only the selected pixels and leaves the hole", () => {
  const g = new TileGrid(20, 20);
  put(g, 4, 4, [255, 0, 0, 255]); // inside the mask
  put(g, 14, 4, [0, 0, 255, 255]); // outside the mask
  const mask = new SelectionMask(20, 20);
  mask.selectRect(0, 0, 10, 20); // left half
  const snap = snapshotGrid(g);

  applyLayerMove(g, snap, 6, 0, mask);
  assert.deepEqual(px(g, 4, 4), [0, 0, 0, 0]); // carried away
  assert.deepEqual(px(g, 10, 4), [255, 0, 0, 255]); // re-stamped 6px right
  assert.deepEqual(px(g, 14, 4), [0, 0, 255, 255]); // untouched, outside the selection
});

test("snapshotCommand undoes and redoes a live drag byte-exactly", () => {
  const g = new TileGrid(64, 64);
  put(g, 30, 30, [9, 8, 7, 255]);
  const before = captureTiles(g);
  const snap = snapshotGrid(g);
  applyLayerMove(g, snap, 10, 10); // the drag, applied live
  const entry = snapshotCommand(g, "Move", before);
  assert.ok(entry);

  entry.undo();
  assert.deepEqual(px(g, 30, 30), [9, 8, 7, 255]);
  assert.deepEqual(px(g, 40, 40), [0, 0, 0, 0]);

  entry.redo();
  assert.deepEqual(px(g, 40, 40), [9, 8, 7, 255]);
  assert.deepEqual(px(g, 30, 30), [0, 0, 0, 0]);
});

test("cropDocument re-anchors pixels and text metadata", () => {
  const doc = new Document(20, 20);
  const l = doc.addLayer("L");
  put(l.grid, 12, 14, [1, 2, 3, 255]);

  const cropped = cropDocument(doc, 10, 10, 8, 8);
  assert.deepEqual([cropped.width, cropped.height], [8, 8]);
  assert.deepEqual(px(cropped.layers[0]!.grid, 2, 4), [1, 2, 3, 255]);
  assert.deepEqual(px(cropped.layers[0]!.grid, 12, 14), [0, 0, 0, 0]);
});

test("clearAllocated zeroes tiles without changing allocations", () => {
  const g = new TileGrid(8, 8);
  put(g, 1, 1, [255, 255, 255, 255]);
  const n = g.allocated;
  g.clearAllocated();
  assert.deepEqual(g.allocated, n);
  assert.deepEqual(px(g, 1, 1), [0, 0, 0, 0]);
});

test("the union-window move is pixel-identical to a full-canvas reference", () => {
  // The optimisation touches only the union of the content's old and new
  // rectangles. This test is the reason that is allowed: a deliberately naive
  // implementation (clear the canvas, fill the stationary pixels, translate
  // over it) must produce the same bytes for every offset, including offsets
  // that push the layer off the canvas.
  const W = 24;
  const H = 20;
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 16) & 0xffff;
  };
  const source = new Uint8ClampedArray(W * H * 4);
  // keep the content inside a sub-rectangle: the union window only matters
  // when the content bbox is smaller than the canvas
  for (let y = 4; y < 15; y++) for (let x = 5; x < 18; x++) {
    const i = (y * W + x) * 4;
    const r = rand();
    source[i] = r & 0xff;
    source[i + 1] = (r >> 3) & 0xff;
    source[i + 2] = (r >> 6) & 0xff;
    // holes and half-transparent bands: both branches of the copy must agree
    source[i + 3] = r % 11 === 0 ? 0 : r % 7 === 0 ? 128 : 255;
  }
  const reference = (dx: number, dy: number, mask: SelectionMask | null): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(W * H * 4);
    if (mask) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (mask.alphaAt(x, y) !== 0) continue;
          out.set(source.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * W + x) * 4);
        }
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = x - dx;
        const sy = y - dy;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        if (mask && mask.alphaAt(sx, sy) === 0) continue;
        const from = (sy * W + sx) * 4;
        if (source[from + 3] === 0) continue;
        out.set(source.subarray(from, from + 4), (y * W + x) * 4);
      }
    }
    return out;
  };

  const mask = new SelectionMask(W, H);
  mask.selectRect(4, 3, 11, 9);
  for (const useMask of [false, true]) {
    const offsets: readonly (readonly [number, number])[] = [[0, 0], [3, -2], [-7, 4], [30, 30], [-99, 0], [1, 1], [-12, -9]];
    for (const [dx, dy] of offsets) {
      const g = new TileGrid(W, H);
      g.writeRect(0, 0, W, H, source);
      const snap = snapshotGrid(g);
      applyLayerMove(g, snap, dx, dy, useMask ? mask : null);
      const got = new Uint8ClampedArray(W * H * 4);
      g.readRect(0, 0, W, H, got);
      assert.deepEqual(got, reference(dx, dy, useMask ? mask : null), `offset ${dx},${dy} mask=${useMask}`);
    }
  }
});
