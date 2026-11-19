import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TileGrid } from "../tile.ts";
import { SelectionMask, clearMasked } from "../mask.ts";
import { stampDab } from "../paint.ts";
import { applyAdjustment } from "../adjust.ts";
import { applyFilter } from "../filter.ts";
import { fillGradient } from "../gradient.ts";

// strictEqual's `asserts actual is T` narrows closure-mutated vars to never;
// unknown params defeat the narrowing (see history.test.ts).
function eq(actual: unknown, expected: unknown): void {
  assert.strictEqual(actual, expected);
}

function px(g: TileGrid, x: number, y: number): number[] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out as unknown as Uint8ClampedArray);
  return Array.from(out);
}

test("mask: setPx/alphaAt roundtrip, bounds clamped", () => {
  const m = new SelectionMask(8, 8);
  eq(m.isEmpty(), true);
  m.selectRect(2, 2, 3, 2);
  eq(m.isEmpty(), false);
  eq(m.alphaAt(2, 2), 255);
  eq(m.alphaAt(4, 3), 255);
  eq(m.alphaAt(5, 3), 0);
  eq(m.alphaAt(-1, 0), 0);
  eq(m.alphaAt(8, 8), 0);
  m.clear();
  eq(m.isEmpty(), true);
});

test("mask: ellipse membership via pixel centers", () => {
  const m = new SelectionMask(8, 8);
  m.selectEllipse(0, 0, 6, 4); // cx=3 cy=2 rx=3 ry=2
  // center pixel: (0.1667)^2 + (0.25)^2 = 0.09 <= 1 → in
  eq(m.alphaAt(3, 2), 255);
  // corner pixel: (0.8333)^2 + (0.75)^2 = 1.257 > 1 → out
  eq(m.alphaAt(0, 0), 0);
  eq(m.alphaAt(0, 3), 0);
});

test("mask: polygon even-odd ray casting", () => {
  const m = new SelectionMask(8, 8);
  m.selectPolygon([[0, 0], [6, 0], [0, 6]]);
  eq(m.alphaAt(1, 1), 255); // inside triangle
  eq(m.alphaAt(5, 5), 0);  // beyond hypotenuse
  // NOTE: (4,1) is ON the hypotenuse at its center (4.5+1.5=6) — boundary,
  // never test boundary pixels; (3,1) is safely inside
  eq(m.alphaAt(3, 1), 255);
});

test("mask: invert flips inside bounds", () => {
  const m = new SelectionMask(8, 8);
  m.selectRect(3, 3, 2, 2);
  m.invert();
  eq(m.alphaAt(3, 3), 0);
  eq(m.alphaAt(0, 0), 255);
  eq(m.alphaAt(7, 7), 255);
});

test("mask: bbox + isRect fast path", () => {
  const r = new SelectionMask(8, 8);
  r.selectRect(2, 2, 3, 2);
  assert.deepEqual(r.bbox(), { x: 2, y: 2, w: 3, h: 2 });
  assert.deepEqual(r.isRect(), { x: 2, y: 2, w: 3, h: 2 });
  const e = new SelectionMask(8, 8);
  e.selectEllipse(0, 0, 6, 6);
  eq(e.isRect(), null); // ring has holes → not a rect
});

test("clearMasked: erases under mask, keeps rgb, leaves rest", () => {
  const g = new TileGrid(8, 8);
  g.fillRect(0, 0, 8, 8, [255, 0, 0, 255]);
  const m = new SelectionMask(8, 8);
  m.selectRect(2, 2, 3, 2);
  clearMasked(g, m);
  assert.deepEqual(px(g, 2, 2), [255, 0, 0, 0]);
  assert.deepEqual(px(g, 4, 3), [255, 0, 0, 0]);
  assert.deepEqual(px(g, 0, 0), [255, 0, 0, 255]);
});

test("stampDab honors mask: in-mask painted, out-of-mask untouched", () => {
  const g = new TileGrid(20, 20);
  const m = new SelectionMask(20, 20);
  m.selectRect(5, 5, 10, 10);
  const rect = stampDab(g, {
    x: 10, y: 10, radius: 8, hardness: 1, alpha: 1,
    color: [255, 64, 32], mode: "normal",
    mask: m,
  });
  eq(rect !== null, true);
  // inside mask + dab center → full color
  assert.deepEqual(px(g, 10, 10), [255, 64, 32, 255]);
  // inside dab radius but OUTSIDE mask → untouched
  eq(10 - 4, 6); // (4,4) is 5.66 from (10,10) < 8 → would paint without mask
  assert.deepEqual(px(g, 4, 4), [0, 0, 0, 0]);
});

test("applyAdjustment blends by mask value", () => {
  const g = new TileGrid(8, 8);
  g.fillRect(0, 0, 8, 8, [128, 128, 128, 255]);
  const m = new SelectionMask(8, 8);
  m.selectRect(2, 2, 2, 2);
  applyAdjustment(g, 0, 0, 8, 8, { kind: "invert", amount: 0 }, m);
  assert.deepEqual(px(g, 2, 2), [127, 127, 127, 255]); // 255-128, fully in mask
  assert.deepEqual(px(g, 0, 0), [128, 128, 128, 255]); // outside mask
});

test("fillGradient skips out-of-mask pixels", () => {
  const g = new TileGrid(8, 8);
  const m = new SelectionMask(8, 8);
  m.selectRect(0, 0, 4, 8); // left half only
  fillGradient(g, 0, 0, 8, 8, {
    kind: "linear",
    from: { x: 0, y: 4, c: { r: 255, g: 0, b: 0, a: 255 } },
    to: { x: 8, y: 4, c: { r: 0, g: 0, b: 255, a: 255 } },
  }, m);
  // pixel (0,0): u = (0.5*8)/64 = 0.0625 → r 239, b 16
  assert.deepEqual(px(g, 0, 0), [239, 0, 16, 255]);
  // pixel (6,0): inside the fill rect but outside the mask → untouched
  assert.deepEqual(px(g, 6, 0), [0, 0, 0, 0]);
});

test("applyFilter (blur) leaves out-of-mask pixels byte-exact", () => {
  const g = new TileGrid(8, 8);
  g.fillRect(0, 0, 8, 8, [128, 128, 128, 255]);
  g.fillRect(2, 2, 1, 1, [255, 0, 0, 255]); // impulse
  const m = new SelectionMask(8, 8);
  m.selectRect(0, 0, 4, 8); // left half
  applyFilter(g, 0, 0, 8, 8, { kind: "blur", amount: 2 }, m);
  // (6,2): out of mask — impulse at distance 4 would bleed here unmasked;
  // with the mask it must stay byte-exact gray
  assert.deepEqual(px(g, 6, 2), [128, 128, 128, 255]);
  // (2,2): in mask → blurred (between impulse and background)
  const p = px(g, 2, 2);
  const p0 = p[0] ?? 0, p3 = p[3] ?? 0;
  eq(p3, 255);
  eq(p0 > 128 && p0 < 255, true);
});
