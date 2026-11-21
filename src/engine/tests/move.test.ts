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

test("applyLayerMove returns a rect that covers every changed pixel", () => {
  // The caller composites exactly this rect and marks the cache composed, so the
  // property that matters is coverage: no pixel may change outside it, or the
  // vacated pixels would stay on screen.
  const w = 600, h = 40;
  const g = new TileGrid(w, h);
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 8; y < 12; y++) for (let x = 300; x < 309; x++) buf[(y * w + x) * 4 + 3] = 255;
  g.writeRect(0, 0, w, h, buf);
  const snap = snapshotGrid(g);
  const before = new Uint8ClampedArray(w * h * 4);
  g.readRect(0, 0, w, h, before);

  const rect = applyLayerMove(g, snap, 3, 2)!;
  const after = new Uint8ClampedArray(w * h * 4);
  g.readRect(0, 0, w, h, after);
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= w && rect.y + rect.h <= h, "inside the canvas");
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (before[i] === after[i] && before[i + 3] === after[i + 3]) continue;
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      assert.ok(inside, `pixel ${x},${y} changed outside the returned rect ${JSON.stringify(rect)}`);
    }
  }
});

test("the union window is smaller than one tile when the content is", () => {
  // The 24x20 fixture above fits inside a single 256px tile, so the snapshot's
  // bounds were always the whole canvas and the union arithmetic was never
  // exercised. Here the content sits in one tile of a 600x600 canvas, which is
  // the case the optimisation exists for.
  const W = 600, H = 600;
  const g = new TileGrid(W, H);
  // Only the content rect is written: a full-canvas writeRect allocates every
  // tile, and the tile-aligned bounds would then be the canvas again.
  const CW = 30, CH = 20, CX = 480, CY = 300;
  const block = new Uint8ClampedArray(CW * CH * 4);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const i = (y * CW + x) * 4;
    block[i] = (x * 7) & 0xff;
    block[i + 1] = (y * 5) & 0xff;
    block[i + 2] = 90;
    block[i + 3] = 255;
  }
  g.writeRect(CX, CY, CW, CH, block);
  const snap = snapshotGrid(g);
  assert.deepEqual(snap.bounds, { x: 256, y: 256, w: 256, h: 256 });

  const reference = (dx: number, dy: number): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const tx = CX + x + dx, ty = CY + y + dy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const from = (y * CW + x) * 4;
      out.set(block.subarray(from, from + 4), (ty * W + tx) * 4);
    }
    return out;
  };

  // Compare by first difference: a failing deepEqual here formats 1.4 MB of
  // pixels, which took a minute when this test did fail (the same trap as
  // "never assert on a document").
  const firstDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) return i / 4;
    }
    return -1;
  };
  for (const [dx, dy] of [[40, 10], [-50, 0], [200, 200]] as const) {
    const grid2 = new TileGrid(W, H);
    grid2.writeRect(CX, CY, CW, CH, block);
    const rect = applyLayerMove(grid2, snapshotGrid(grid2), dx, dy, null);
    assert.ok(rect && rect.w < W, `the written rect should be narrow, got ${JSON.stringify(rect)}`);
    const got = new Uint8ClampedArray(W * H * 4);
    grid2.readRect(0, 0, W, H, got);
    assert.equal(firstDiff(got, reference(dx, dy)), -1, `offset ${dx},${dy} differs`);
  }
});
