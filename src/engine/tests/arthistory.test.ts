import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import { artHistoryDab, type ArtSnapshot } from "../arthistory.ts";

const W = 96, H = 96;
const BLUE = [20, 60, 220, 255] as const;
const RED = [220, 30, 40, 255] as const;
const BLACK = [0, 0, 0, 255] as const;

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

function flatSnapshot(rgba: readonly number[]): ArtSnapshot {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0]!; data[i + 1] = rgba[1]!; data[i + 2] = rgba[2]!; data[i + 3] = rgba[3]!;
  }
  return { width: W, height: H, data };
}

/** Flat black field with one vertical white stripe at columns [44,52). */
function stripeSnapshot(): ArtSnapshot {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const white = x >= 44 && x < 52;
      data[p] = white ? 255 : 0;
      data[p + 1] = 0;
      data[p + 2] = 0;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

test("dab paints the source at its centre and leaves distant pixels alone", () => {
  const g = new TileGrid(W, H);
  g.fillRect(0, 0, W, H, BLUE);
  artHistoryDab(g, flatSnapshot(RED), 48, 48, 12, "medium", 1);
  // This assertion fails if the source snapshot is ignored.
  assert.deepEqual(px(g, 48, 48), [...RED], "centre must come from the source, not the seed colour");
  assert.deepEqual(px(g, 90, 90), [...BLUE], "pixels outside the disc are untouched");
});

test("fidelity 0 is an exact no-op", () => {
  const g = new TileGrid(W, H);
  g.fillRect(0, 0, W, H, BLUE);
  const before = wholeGrid(g);
  artHistoryDab(g, flatSnapshot(RED), 48, 48, 16, "loose", 0);
  assert.deepEqual(wholeGrid(g), before);
});

test("loose displaces the sampled stripe farther than medium, which displaces farther than tight", () => {
  const src = stripeSnapshot();
  const grids: Record<string, TileGrid> = {};
  for (const style of ["tight", "medium", "loose"] as const) {
    const g = new TileGrid(W, H);
    g.fillRect(0, 0, W, H, BLACK);
    artHistoryDab(g, src, 48, 48, 40, style, 1);
    grids[style] = g;
  }
  // At row 54 the horizontal wave is near its peak, so the white stripe is
  // carried the farthest left. The leftmost white column measures that shift.
  const leadingEdge = (g: TileGrid): number => {
    for (let x = 0; x < W; x++) if (px(g, x, 54)[0]! >= 250) return x;
    return -1;
  };
  const tightEdge = leadingEdge(grids["tight"]!);
  const mediumEdge = leadingEdge(grids["medium"]!);
  const looseEdge = leadingEdge(grids["loose"]!);
  assert.ok(tightEdge >= 0, "tight dab should carry the white stripe");
  assert.ok(mediumEdge >= 0, "medium dab should carry the white stripe");
  assert.ok(looseEdge >= 0, "loose dab should carry the white stripe");
  assert.ok(
    tightEdge > mediumEdge && mediumEdge > looseEdge,
    `displacement must scale tight(${tightEdge}) > medium(${mediumEdge}) > loose(${looseEdge})`,
  );
});

test("a clip rectangle excludes pixels outside it", () => {
  const g = new TileGrid(W, H);
  g.fillRect(0, 0, W, H, BLUE);
  artHistoryDab(g, flatSnapshot(RED), 48, 48, 12, "tight", 1, null, { x: 48, y: 36, w: 12, h: 24 });
  assert.deepEqual(px(g, 54, 48), [...RED], "inside the clip paints");
  assert.deepEqual(px(g, 42, 48), [...BLUE], "outside the clip stays untouched");
});

test("selection mask coverage blocks painting outside the selection", () => {
  const g = new TileGrid(W, H);
  g.fillRect(0, 0, W, H, BLUE);
  const mask = new SelectionMask(W, H);
  mask.selectRect(44, 44, 9, 9); // covers (48,48) but not (56,48)
  artHistoryDab(g, flatSnapshot(RED), 48, 48, 12, "medium", 1, mask);
  assert.deepEqual(px(g, 48, 48), [...RED], "inside the selection paints");
  assert.deepEqual(px(g, 56, 48), [...BLUE], "outside the selection is blocked");
});

test("full fidelity preserves the sampled source alpha", () => {
  const g = new TileGrid(W, H);
  g.fillRect(0, 0, W, H, [10, 20, 30, 255]);
  artHistoryDab(g, flatSnapshot([200, 100, 50, 128]), 48, 48, 6, "tight", 1);
  assert.deepEqual(px(g, 48, 48), [200, 100, 50, 128]);
});

test("the dab is deterministic", () => {
  const a = new TileGrid(W, H), b = new TileGrid(W, H);
  a.fillRect(0, 0, W, H, BLUE);
  b.fillRect(0, 0, W, H, BLUE);
  const src = stripeSnapshot();
  artHistoryDab(a, src, 48, 48, 24, "loose", 1);
  artHistoryDab(b, src, 48, 48, 24, "loose", 1);
  assert.deepEqual(wholeGrid(a), wholeGrid(b));
});
