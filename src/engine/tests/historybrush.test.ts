import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import { captureRaster, paintHistoryDab } from "../historybrush.ts";
import { eq } from "./helpers.ts";

const W = 64, H = 64;
const RED = [220, 30, 40, 255] as const;
const BLUE = [20, 60, 220, 255] as const;

function px(g: TileGrid, x: number, y: number): number[] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

function wholeGrid(g: TileGrid): number[] {
  const out = new Uint8ClampedArray(W * H * 4);
  g.readRect(0, 0, W, H, out);
  return [...out];
}

function redAreaThenBlue(): { g: TileGrid; snapshot: ReturnType<typeof captureRaster> } {
  const g = new TileGrid(W, H);
  g.fillRect(16, 16, 32, 32, RED); // the red area to be restored
  const snapshot = captureRaster(g);
  g.fillRect(0, 0, W, H, BLUE); // the current (blue) state
  return { g, snapshot };
}

test("history dab restores source pixels at its centre, distant pixels stay blue", () => {
  const { g, snapshot } = redAreaThenBlue();
  eq(snapshot.width, W);
  eq(snapshot.height, H);
  eq(snapshot.data.length, W * H * 4);
  paintHistoryDab(g, snapshot, 32, 32, 8, 1, 1);
  // Would stay blue if the captured source pixels were ignored.
  assert.deepEqual(px(g, 32, 32), [...RED], "centre should be restored from the snapshot");
  assert.deepEqual(px(g, 58, 58), [...BLUE], "far-away pixels must be untouched");
});

test("opacity 0 is an exact no-op", () => {
  const { g, snapshot } = redAreaThenBlue();
  const before = wholeGrid(g);
  paintHistoryDab(g, snapshot, 32, 32, 10, 1, 0);
  assert.deepEqual(wholeGrid(g), before);
});

test("mask blocks painting outside the selection", () => {
  const { g, snapshot } = redAreaThenBlue();
  const mask = new SelectionMask(W, H);
  mask.selectRect(30, 30, 5, 5); // covers (32,32) but not (36,32)
  paintHistoryDab(g, snapshot, 32, 32, 8, 1, 1, mask);
  assert.deepEqual(px(g, 32, 32), [...RED], "inside the selection paints");
  assert.deepEqual(px(g, 36, 32), [...BLUE], "outside the selection is blocked");
});

test("a marquee clip limits the dab to the rectangle", () => {
  const { g, snapshot } = redAreaThenBlue();
  paintHistoryDab(g, snapshot, 32, 32, 8, 1, 1, null, { x: 32, y: 24, w: 8, h: 16 });
  assert.deepEqual(px(g, 35, 32), [...RED], "inside the clip paints");
  assert.deepEqual(px(g, 28, 32), [...BLUE], "outside the clip stays untouched");
});

test("snapshot is a detached, deterministic copy and keeps source alpha", () => {
  const g = new TileGrid(W, H);
  g.fillRect(0, 0, W, H, [200, 100, 50, 128]);
  const a = captureRaster(g);
  const b = captureRaster(g);
  assert.notStrictEqual(a.data, b.data, "each capture must allocate its own buffer");
  assert.deepEqual([...a.data], [...b.data], "captures must be byte-identical");

  g.fillRect(0, 0, W, H, BLUE);
  paintHistoryDab(g, a, 32, 32, 4, 1, 1);
  assert.deepEqual(px(g, 32, 32), [200, 100, 50, 128], "alpha must come from the source");

  // Painting the same dab twice on identical grids gives identical bytes.
  const h = new TileGrid(W, H);
  h.fillRect(0, 0, W, H, BLUE);
  paintHistoryDab(h, a, 32, 32, 4, 1, 1);
  assert.deepEqual(wholeGrid(h), wholeGrid(g));
});

test("hardness 0 produces a soft falloff instead of a hard disc", () => {
  const { g, snapshot } = redAreaThenBlue();
  paintHistoryDab(g, snapshot, 32, 32, 8, 0, 1);
  assert.deepEqual(px(g, 32, 32), [...RED]);
  const mid = px(g, 36, 32)[0]!; // halfway to the rim → partial restoration
  assert.ok(mid > BLUE[0] && mid < RED[0], `expected a blended red value, got ${mid}`);
  assert.deepEqual(px(g, 44, 32), [...BLUE], "beyond the radius is untouched");
});
