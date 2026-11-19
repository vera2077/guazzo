import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid, TILE } from "../tile.ts";

test("sparse: untouched grid allocates nothing", () => {
  const g = new TileGrid(2048, 2048);
  assert.equal(g.allocated, 0);
});

test("fillRect allocates only intersecting tiles", () => {
  const g = new TileGrid(2048, 2048);
  g.fillRect(10, 10, 100, 100, [255, 0, 0, 255]);
  assert.equal(g.allocated, 1); // fits inside one 256×256 tile
  g.fillRect(250, 250, 20, 20, [0, 255, 0, 255]);
  // crosses into tiles (1,0),(0,1),(1,1); tile (0,0) already exists → 4 total
  assert.equal(g.allocated, 4);
});

test("fillRect + readRect roundtrip", () => {
  const g = new TileGrid(600, 600);
  g.fillRect(100, 100, 200, 150, [10, 20, 30, 255]);
  const out = new Uint8ClampedArray(200 * 150 * 4);
  g.readRect(100, 100, 200, 150, out);
  assert.deepEqual([...out.slice(0, 4)], [10, 20, 30, 255]);
  // last pixel of the rect
  const last = out.slice((200 * 150 - 1) * 4, (200 * 150 - 1) * 4 + 4);
  assert.deepEqual([...last], [10, 20, 30, 255]);
  // outside: transparent
  const out2 = new Uint8ClampedArray(50 * 50 * 4);
  g.readRect(0, 0, 50, 50, out2);
  assert.deepEqual([...out2.slice(0, 4)], [0, 0, 0, 0]);
});

test("readRect clips at grid bounds", () => {
  const g = new TileGrid(300, 300);
  g.fillRect(290, 290, 10, 10, [255, 255, 255, 255]);
  const out = new Uint8ClampedArray(20 * 20 * 4);
  g.readRect(290, 290, 20, 20, out); // extends past bounds, must not throw
  assert.deepEqual([...out.slice(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...out.slice((20 * 20 - 1) * 4)], [0, 0, 0, 0]);
});

test("writeRect then readRect roundtrip across tile boundary", () => {
  const g = new TileGrid(600, 600);
  const w = 20, h = 20;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    src[i * 4] = i % 256; src[i * 4 + 1] = 7; src[i * 4 + 2] = 200; src[i * 4 + 3] = 255;
  }
  g.writeRect(250, 250, w, h, src); // straddles the 256 tile edge
  const out = new Uint8ClampedArray(w * h * 4);
  g.readRect(250, 250, w, h, out);
  assert.deepEqual([...out], [...src]);
});

test("writeRect clips at bounds", () => {
  const g = new TileGrid(64, 64);
  const src = new Uint8ClampedArray(10 * 10 * 4).fill(255);
  g.writeRect(60, 60, 10, 10, src); // only 4×4 fits
  const out = new Uint8ClampedArray(4 * 4 * 4);
  g.readRect(60, 60, 4, 4, out);
  assert.deepEqual([...out.slice(0, 4)], [255, 255, 255, 255]);
  assert.equal(g.allocated, 1);
});

test("negative-origin rect reads doc coords correctly", () => {
  const g = new TileGrid(TILE, TILE);
  g.fillRect(0, 0, 8, 8, [9, 9, 9, 255]);
  const out = new Uint8ClampedArray(16 * 16 * 4);
  g.readRect(-8, -8, 16, 16, out);
  // doc (0,0) lands at out (8,8)
  const p = out.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4);
  assert.deepEqual([...p], [9, 9, 9, 255]);
});
