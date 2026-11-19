// Content-Aware Fill / Spot Healing: patch-based inpainting, fully local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import { contentAwareFill, spotHeal } from "../heal.ts";
import { eq } from "./helpers.ts";

function grid(w: number, h: number, rgba: [number, number, number, number]): TileGrid {
  const g = new TileGrid(w, h);
  g.fillRect(0, 0, w, h, rgba);
  return g;
}

function px(g: TileGrid, x: number, y: number): [number, number, number, number] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

test("a hole in flat colour is refilled with that colour", () => {
  const g = grid(80, 80, [90, 140, 200, 255]);
  // punch a dark blemish into the middle
  g.fillRect(30, 30, 14, 14, [0, 0, 0, 255]);
  const hole = new SelectionMask(80, 80);
  hole.selectRect(30, 30, 14, 14);
  const changed = contentAwareFill(g, { x: 30, y: 30, w: 14, h: 14 }, hole);
  assert.ok(changed, "fill should report work done");
  const [r, gg, b, a] = px(g, 36, 36);
  assert.ok(Math.abs(r - 90) < 6 && Math.abs(gg - 140) < 6 && Math.abs(b - 200) < 6, `centre was ${r},${gg},${b}`);
  eq(a, 255);
});

test("pixels outside the hole are untouched byte for byte", () => {
  const g = grid(64, 64, [30, 60, 90, 255]);
  g.fillRect(20, 20, 10, 10, [255, 255, 255, 255]);
  const before = new Uint8ClampedArray(64 * 64 * 4);
  g.readRect(0, 0, 64, 64, before);
  const mask = new SelectionMask(64, 64);
  mask.selectRect(20, 20, 10, 10);
  contentAwareFill(g, { x: 20, y: 20, w: 10, h: 10 }, mask);
  const after = new Uint8ClampedArray(64 * 64 * 4);
  g.readRect(0, 0, 64, 64, after);
  for (let i = 0; i < before.length; i += 4) {
    const x = (i / 4) % 64;
    const y = Math.floor(i / 4 / 64);
    const inside = x >= 20 && x < 30 && y >= 20 && y < 30;
    if (inside) continue;
    assert.deepEqual(
      [after[i], after[i + 1], after[i + 2], after[i + 3]],
      [before[i], before[i + 1], before[i + 2], before[i + 3]],
      `pixel ${x},${y} changed outside the hole`,
    );
  }
});

test("a black bar over a vertical gradient is repaired between its neighbours", () => {
  const g = new TileGrid(60, 60);
  for (let y = 0; y < 60; y++) {
    g.fillRect(0, y, 60, 1, [y * 4, y * 4, y * 4, 255]);
  }
  g.fillRect(20, 25, 20, 10, [0, 0, 0, 255]); // bar
  const mask = new SelectionMask(60, 60);
  mask.selectRect(20, 25, 20, 10);
  contentAwareFill(g, { x: 20, y: 25, w: 20, h: 10 }, mask);
  for (const y of [26, 29, 33]) {
    const [, v] = px(g, 30, y);
    const want = y * 4;
    assert.ok(Math.abs(v - want) < 24, `row ${y} filled ${v}, expected about ${want}`);
  }
});

test("filling the whole grid (no donors) still terminates and produces something", () => {
  const g = grid(40, 40, [12, 34, 56, 255]);
  const mask = new SelectionMask(40, 40);
  mask.selectRect(0, 0, 40, 40);
  const changed = contentAwareFill(g, { x: 0, y: 0, w: 40, h: 40 }, mask);
  assert.ok(changed);
  const [r, gg, b] = px(g, 20, 20);
  assert.ok(Number.isFinite(r) && Number.isFinite(gg) && Number.isFinite(b));
});

test("an empty selection does no work", () => {
  const g = grid(32, 32, [200, 100, 50, 255]);
  const mask = new SelectionMask(32, 32);
  eq(contentAwareFill(g, { x: 4, y: 4, w: 10, h: 10 }, mask), null);
});

test("a rect entirely off-canvas does no work", () => {
  const g = grid(32, 32, [10, 20, 30, 255]);
  eq(contentAwareFill(g, { x: 500, y: 500, w: 10, h: 10 }, null), null);
});

test("no mask means the whole rect is repaired", () => {
  const g = grid(50, 50, [60, 120, 180, 255]);
  g.fillRect(10, 10, 8, 8, [0, 0, 0, 255]);
  contentAwareFill(g, { x: 10, y: 10, w: 8, h: 8 }, null);
  const [r, gg, b] = px(g, 14, 14);
  assert.ok(Math.abs(r - 60) < 8 && Math.abs(gg - 120) < 8 && Math.abs(b - 180) < 8);
});

test("the fill is deterministic for identical input", () => {
  const build = (): TileGrid => {
    const g = new TileGrid(70, 70);
    for (let y = 0; y < 70; y++) g.fillRect(0, y, 70, 1, [(y * 3) % 255, 90, 180 - y, 255]);
    g.fillRect(25, 25, 16, 16, [255, 0, 0, 255]);
    const mask = new SelectionMask(70, 70);
    mask.selectRect(25, 25, 16, 16);
    contentAwareFill(g, { x: 25, y: 25, w: 16, h: 16 }, mask);
    return g;
  };
  const a = new Uint8ClampedArray(70 * 70 * 4);
  build().readRect(0, 0, 70, 70, a);
  const b = new Uint8ClampedArray(70 * 70 * 4);
  build().readRect(0, 0, 70, 70, b);
  assert.deepEqual([...a], [...b]);
});

test("transparent surroundings stay transparent rather than turning black", () => {
  const g = new TileGrid(40, 40); // nothing allocated: fully transparent
  g.fillRect(0, 20, 40, 1, [0, 0, 0, 255]); // one opaque line to sample
  const mask = new SelectionMask(40, 40);
  mask.selectRect(18, 8, 4, 4);
  contentAwareFill(g, { x: 18, y: 8, w: 4, h: 4 }, mask, { search: 16 });
  const [r, gg, b, a] = px(g, 20, 10);
  assert.ok(a === 0 || (r === gg && gg === b), `got ${r},${gg},${b},${a}`);
});

test("spotHeal repairs a small brush-shaped hole", () => {
  const g = grid(48, 48, [120, 120, 120, 255]);
  g.fillRect(20, 21, 5, 5, [250, 10, 10, 255]); // red speck
  const brush = new SelectionMask(48, 48);
  brush.selectEllipse(19, 20, 8, 8); // x, y, w, h — covers the whole speck
  const changed = spotHeal(g, { x: 18, y: 19, w: 10, h: 10 }, brush);
  assert.ok(changed);
  const [r, gg, b] = px(g, 22, 23);
  assert.ok(Math.abs(r - 120) < 12 && Math.abs(gg - 120) < 12 && Math.abs(b - 120) < 12, `got ${r},${gg},${b}`);
});

test("a repair inside a smooth gradient carries the gradient, not flat grey", () => {
  const g = new TileGrid(120, 120);
  for (let y = 0; y < 120; y++) g.fillRect(0, y, 120, 1, [y * 2, y * 2, y * 2, 255]);
  g.fillRect(40, 40, 24, 24, [0, 0, 0, 255]);
  const mask = new SelectionMask(120, 120);
  mask.selectRect(40, 40, 24, 24);
  contentAwareFill(g, { x: 40, y: 40, w: 24, h: 24 }, mask);
  const values: number[] = [];
  for (let y = 42; y < 62; y++) values.push(px(g, 52, y)[1]);
  const first = values[0]!;
  const last = values[values.length - 1]!;
  assert.ok(last - first > 18, `expected a rising gradient inside the hole, got ${first} -> ${last}`);
  // monotone enough to be a gradient rather than noise
  let drops = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! < values[i - 1]! - 3) drops++;
  assert.ok(drops <= 2, `gradient inverted ${drops} times: ${values.join(",")}`);
});

test("a vertical edge is continued through the hole instead of being smeared", () => {
  const g = new TileGrid(96, 96);
  g.fillRect(0, 0, 48, 96, [20, 20, 20, 255]);
  g.fillRect(48, 0, 48, 96, [235, 235, 235, 255]);
  g.fillRect(36, 36, 24, 24, [128, 128, 128, 255]); // grey blob on the seam
  const mask = new SelectionMask(96, 96);
  mask.selectRect(36, 36, 24, 24);
  contentAwareFill(g, { x: 36, y: 36, w: 24, h: 24 }, mask);
  const left = px(g, 42, 48)[0];
  const right = px(g, 56, 48)[0];
  assert.ok(left < 110, `left of the seam should stay dark, got ${left}`);
  assert.ok(right > 140, `right of the seam should stay light, got ${right}`);
});

test("repeated texture survives the repair", () => {
  const g = new TileGrid(96, 96);
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const v = ((x >> 2) + (y >> 2)) % 2 === 0 ? 40 : 210;
      g.fillRect(x, y, 1, 1, [v, v, v, 255]);
    }
  }
  g.fillRect(36, 36, 20, 20, [0, 0, 0, 255]);
  const mask = new SelectionMask(96, 96);
  mask.selectRect(36, 36, 20, 20);
  contentAwareFill(g, { x: 36, y: 36, w: 20, h: 20 }, mask);
  const vals: number[] = [];
  for (let y = 38; y < 54; y++) for (let x = 38; x < 54; x++) vals.push(px(g, x, y)[0]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  assert.ok(sd > 45, `patterned fill collapsed to a flat patch (sd ${sd.toFixed(1)})`);
});

test("a soft mask edge is feathered, not cut into a hard rim", () => {
  const g = new TileGrid(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) g.fillRect(x, y, 1, 1, [90, 120, 150, 255]);
  g.fillRect(28, 28, 8, 8, [10, 10, 10, 255]); // dark blemish
  const mask = new SelectionMask(64, 64);
  // a gradient edge: 255 in the middle, 128 at the rim
  for (let y = 26; y < 38; y++) {
    for (let x = 26; x < 38; x++) {
      const d = Math.max(Math.abs(x - 31.5), Math.abs(y - 31.5));
      mask.setAlpha(x, y, d <= 2 ? 255 : d <= 4 ? 128 : 0);
    }
  }
  spotHeal(g, { x: 26, y: 26, w: 12, h: 12 }, mask);
  const centre = px(g, 32, 32);
  const rim = px(g, 26, 32);
  const outside = px(g, 24, 32);
  assert.ok(centre[0] > 60, `the centre should be rebuilt, got ${centre[0]}`);
  assert.ok(rim[0] > 20, `the half-covered rim should be blended, got ${rim[0]}`);
  eq(outside[0], 90); // untouched background
});
