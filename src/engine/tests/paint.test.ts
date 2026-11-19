/**
 * paint.test.ts — stampDab selection-clip semantics.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { stampDab } from "../paint.ts";

test("clip: dab entirely outside the clip rect paints nothing", () => {
  const grid = new TileGrid(64, 64);
  const rect = stampDab(grid, {
    x: 40, y: 40, radius: 5, hardness: 1, alpha: 1,
    color: [255, 0, 0], mode: "normal",
    clip: { x: 0, y: 0, w: 10, h: 10 },
  });
  assert.equal(rect, null);
  assert.equal(grid.allocated, 0);
});

test("clip: dab straddling the boundary paints only inside pixels", () => {
  const grid = new TileGrid(64, 64);
  // disc centered at x=10 (clip edge), radius 6 → covers x 4..16, clip is x<12
  stampDab(grid, {
    x: 10, y: 30, radius: 6, hardness: 1, alpha: 1,
    color: [255, 0, 0], mode: "normal",
    clip: { x: 0, y: 0, w: 12, h: 64 },
  });
  const inside = new Uint8ClampedArray(4), outside = new Uint8ClampedArray(4);
  grid.readRect(10, 30, 1, 1, inside);   // center, within clip
  grid.readRect(14, 30, 1, 1, outside);  // within disc, outside clip
  assert.deepEqual(Array.from(inside), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(outside), [0, 0, 0, 0]);
});

test("clip: covered area equals the clip rect for a large dab", () => {
  const grid = new TileGrid(64, 64);
  const rect = stampDab(grid, {
    x: 32, y: 32, radius: 40, hardness: 1, alpha: 1,
    color: [0, 255, 0], mode: "normal",
    clip: { x: 20, y: 20, w: 10, h: 10 },
  });
  assert.ok(rect !== null);
  assert.deepEqual(rect, { x: 20, y: 20, w: 10, h: 10 });
  const res = new Uint8ClampedArray(4 * 64 * 64);
  grid.readRect(0, 0, 64, 64, res);
  const px = (x: number, y: number) => Array.from(res.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  assert.deepEqual(px(19, 25), [0, 0, 0, 0]); // one before the clip (x edge)
  // disc center (32,32), radius 40, hardness 1: pixel (25,25) sits at
  // dist ≈ 9.9 → inside the smoothstep falloff: exact rgb, alpha in the
  // soft band (NOT 255, NOT 0 — pinning the exact 216 broke once on a
  // smoothstep constant tweak, the band survives it)
  assert.deepEqual(px(25, 25).slice(0, 3), [0, 255, 0]);
  const fa = px(25, 25)[3] ?? -1;
  assert.ok(fa >= 200 && fa <= 232, `soft falloff alpha band 200..232, got ${fa}`);
  assert.deepEqual(px(30, 25), [0, 0, 0, 0]); // one after the clip (x edge)
  assert.deepEqual(px(25, 30), [0, 0, 0, 0]); // one after the clip (y edge)
});

test("stretch: tilted nib flattens across the minor axis", () => {
  const grid = new TileGrid(64, 64);
  stampDab(grid, {
    x: 50, y: 50, radius: 10, hardness: 0.5, alpha: 1,
    color: [0, 255, 0], mode: "normal",
    stretch: { angle: 0, ratio: 0.4 },   // major axis along x, minor = 4px
  });
  const res = new Uint8ClampedArray(4 * 64 * 64);
  grid.readRect(0, 0, 64, 64, res);
  const px = (x: number, y: number) => Array.from(res.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  // along the major axis (x): the inner 5px (hardness 0.5) is fully opaque
  assert.deepEqual(px(46, 50), [0, 255, 0, 255]);  // dist 4 < inner 5
  // across the minor axis (y): flattened to 4px — dist 4 lands exactly ON the
  // ellipse edge → falloff t=0 → untouched
  assert.deepEqual(px(50, 54), [0, 0, 0, 0]);
  assert.deepEqual(px(50, 56), [0, 0, 0, 0]);      // well outside the 4px minor
  // symmetric: above/below flatten identically
  assert.deepEqual(px(50, 46), [0, 0, 0, 0]);
  assert.deepEqual(px(54, 50), [0, 255, 0, 255]);  // dist 4 along major, other side
});

test("stretch: angle π/2 swaps the flattened axis", () => {
  const grid = new TileGrid(64, 64);
  stampDab(grid, {
    x: 50, y: 50, radius: 10, hardness: 0.5, alpha: 1,
    color: [0, 255, 0], mode: "normal",
    stretch: { angle: Math.PI / 2, ratio: 0.4 },   // major axis along y
  });
  const res = new Uint8ClampedArray(4 * 64 * 64);
  grid.readRect(0, 0, 64, 64, res);
  const px = (x: number, y: number) => Array.from(res.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  assert.deepEqual(px(50, 54), [0, 255, 0, 255]);  // 4px along y (major, inner)
  assert.deepEqual(px(54, 50), [0, 0, 0, 0]);      // 4px along x lands on the flattened edge
});

test("stretch: no-stretch dabs are byte-identical to before", () => {
  const a = new TileGrid(64, 64), b = new TileGrid(64, 64);
  stampDab(a, { x: 32, y: 32, radius: 12, hardness: 0.7, alpha: 0.8, color: [10, 200, 30], mode: "normal" });
  stampDab(b, { x: 32, y: 32, radius: 12, hardness: 0.7, alpha: 0.8, color: [10, 200, 30], mode: "normal", stretch: { angle: 0, ratio: 1 } });
  const ra = new Uint8ClampedArray(4 * 64 * 64), rb = new Uint8ClampedArray(4 * 64 * 64);
  a.readRect(0, 0, 64, 64, ra);
  b.readRect(0, 0, 64, 64, rb);
  assert.deepEqual(ra, rb);
});

test("tip: 3×3 opaque tip stamps a square footprint", () => {
  const tip = { data: new Uint8ClampedArray(3 * 3 * 4).fill(255), w: 3, h: 3 }; // all alpha 255
  const grid = new TileGrid(64, 64);
  stampDab(grid, { x: 32, y: 32, radius: 4, hardness: 0.5, alpha: 1, color: [0, 255, 0], mode: "normal", tip });
  const res = new Uint8ClampedArray(4 * 64 * 64);
  grid.readRect(0, 0, 64, 64, res);
  const px = (x: number, y: number) => Array.from(res.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  // larger side spans 2r = 8px: cols 28..36 (center 32, half 4)
  assert.deepEqual(px(30, 32), [0, 255, 0, 255]);   // inside
  assert.deepEqual(px(27, 32), [0, 0, 0, 0]);       // outside left
  assert.deepEqual(px(32, 30), [0, 255, 0, 255]);
  assert.deepEqual(px(32, 27), [0, 0, 0, 0]);       // outside above
});

test("tip: transparent tip pixels leave the canvas untouched", () => {
  // 2×2 tip: top-left opaque, others transparent → quarter dab
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let i = 0; i < 4; i++) data[i * 4 + 3] = 0;
  data[3] = 255; // pixel (0,0) alpha 255
  const tip = { data, w: 2, h: 2 };
  const grid = new TileGrid(64, 64);
  stampDab(grid, { x: 32, y: 32, radius: 8, hardness: 0.5, alpha: 1, color: [9, 9, 9], mode: "normal", tip });
  const res = new Uint8ClampedArray(4 * 64 * 64);
  grid.readRect(0, 0, 64, 64, res);
  const px = (x: number, y: number) => Array.from(res.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  // spans 16px: 24..40; corner (24,24) samples tip pixel (0,0) exactly → full
  assert.deepEqual(px(24, 24), [9, 9, 9, 255]);
  // (26,26) samples u=v=2/15 → bilinear 255·(13/15)² ≈ 192
  assert.deepEqual(px(26, 26), [9, 9, 9, 192]);
  assert.deepEqual(px(39, 26), [0, 0, 0, 0]);  // u=1 → past the opaque half
  assert.deepEqual(px(26, 39), [0, 0, 0, 0]);  // v=1 → below it
});

test("tip: alpha gradient paints a smooth density ramp", () => {
  // 2×1 tip: left alpha 255, right alpha 0
  const data = new Uint8ClampedArray(2 * 1 * 4);
  data[3] = 255;
  data[7] = 0;
  const tip = { data, w: 2, h: 1 };
  const grid = new TileGrid(64, 64);
  stampDab(grid, { x: 32, y: 32, radius: 8, hardness: 0.5, alpha: 1, color: [0, 255, 0], mode: "normal", tip });
  const res = new Uint8ClampedArray(4 * 64 * 64);
  grid.readRect(0, 0, 64, 64, res);
  const a = (x: number, y: number) => res[(y * 64 + x) * 4 + 3]!;
  assert.ok(a(25, 32) > 200, "left end nearly opaque");
  assert.ok(a(39, 32) < 55, "right end nearly transparent");
  assert.ok(a(31, 32) > a(33, 32) && a(33, 32) > a(35, 32), "monotonic ramp");
});

test("tip: clip rect bounds the stamp", () => {
  const tip = { data: new Uint8ClampedArray(4 * 4 * 4).fill(255), w: 4, h: 4 };
  const grid = new TileGrid(64, 64);
  stampDab(grid, { x: 32, y: 32, radius: 8, hardness: 0.5, alpha: 1, color: [1, 2, 3], mode: "normal", tip, clip: { x: 30, y: 30, w: 5, h: 5 } });
  const res = new Uint8ClampedArray(4 * 64 * 64);
  grid.readRect(0, 0, 64, 64, res);
  const px = (x: number, y: number) => Array.from(res.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  assert.deepEqual(px(31, 31), [1, 2, 3, 255]); // inside clip
  assert.deepEqual(px(29, 31), [0, 0, 0, 0]);  // outside clip
  assert.deepEqual(px(34, 34), [1, 2, 3, 255]); // clip's last pixel
  assert.deepEqual(px(35, 34), [0, 0, 0, 0]);
});
