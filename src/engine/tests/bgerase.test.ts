import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { backgroundEraseDab, sampleGridColor } from "../bgerase.ts";
import { SelectionMask } from "../mask.ts";

function px(g: TileGrid, x: number, y: number): [number, number, number, number] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

function painted(w = 32, h = 32): TileGrid {
  const g = new TileGrid(w, h);
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = 200; buf[i * 4 + 1] = 40; buf[i * 4 + 2] = 40; buf[i * 4 + 3] = 255;
  }
  g.writeRect(0, 0, w, h, buf);
  return g;
}

test("background eraser: erases the target colour and leaves the rest", () => {
  const g = painted();
  const px = new Uint8ClampedArray(4);
  g.writeRect(16, 16, 1, 1, new Uint8ClampedArray([20, 200, 20, 255]));
  const hit = backgroundEraseDab(g, 8, 8, { radius: 4, hardness: 1, target: [200, 40, 40], tolerance: 8 });
  assert.ok(hit, "the red field must be erased");
  assert.deepEqual(hit, { x: 4, y: 4, w: 9, h: 9 });
  g.readRect(8, 8, 1, 1, px);
  assert.equal(px[3], 0, "a targeted pixel loses its alpha");
  g.readRect(16, 16, 1, 1, px);
  assert.equal(px[3], 255, "a pixel of a different colour survives");
});

test("background eraser: tolerance 0 erases only the exact colour", () => {
  const g = painted();
  const px = new Uint8ClampedArray(4);
  g.writeRect(6, 8, 1, 1, new Uint8ClampedArray([200, 41, 40, 255]));
  backgroundEraseDab(g, 8, 8, { radius: 6, hardness: 1, target: [200, 40, 40], tolerance: 0 });
  g.readRect(8, 8, 1, 1, px);
  assert.equal(px[3], 0, "the exact colour goes");
  g.readRect(6, 8, 1, 1, px);
  assert.equal(px[3], 255, "one level of difference survives a zero tolerance");
});

test("background eraser: a soft rim leaves partial alpha at the edge", () => {
  const g = painted();
  const px = new Uint8ClampedArray(4);
  backgroundEraseDab(g, 16, 16, { radius: 8, hardness: 0, target: [200, 40, 40], tolerance: 8 });
  g.readRect(16, 16, 1, 1, px);
  const centre = px[3]!;
  g.readRect(23, 16, 1, 1, px); // 7.5 px from the centre, inside the soft ramp
  const rim = px[3]!;
  assert.ok(centre > 0 && centre < 255, `a soft centre is partly erased, got ${centre}`);
  assert.ok(rim > centre && rim < 255, `the rim ${rim} must be less erased than the centre ${centre}`);
});

test("background eraser: an unmatched stroke reports no damage", () => {
  const g = painted();
  const hit = backgroundEraseDab(g, 8, 8, { radius: 4, hardness: 1, target: [10, 200, 10], tolerance: 4 });
  assert.equal(hit, null);
});

test("sampleGridColor: reads a layer pixel and refuses a transparent one", () => {
  const g = new TileGrid(8, 8);
  assert.equal(sampleGridColor(g, 2, 2), null);
  g.writeRect(2, 2, 1, 1, new Uint8ClampedArray([12, 34, 56, 255]));
  assert.deepEqual(sampleGridColor(g, 2, 2), [12, 34, 56]);
});

test("clip and mask: the eraser obeys the selection like every other paint tool", () => {
  // Erasing "inside this shape" must leave the rest of the dab alone. Before
  // this, a selection clipped the brush but not the background eraser.
  const g = new TileGrid(40, 20);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) g.writeRect(x, y, 1, 1, new Uint8ClampedArray([200, 40, 40, 255]));
  const rect = backgroundEraseDab(g, 10, 10, {
    radius: 6, hardness: 1, target: [200, 40, 40], tolerance: 0,
    clip: { x: 0, y: 0, w: 10, h: 20 },
  });
  assert.ok(rect);
  assert.equal(px(g, 8, 10)[3], 0, "inside the clip the colour is erased");
  assert.equal(px(g, 14, 10)[3], 255, "outside the clip the dab must not touch the pixel");

  const g2 = new TileGrid(40, 20);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) g2.writeRect(x, y, 1, 1, new Uint8ClampedArray([200, 40, 40, 255]));
  const mask = new SelectionMask(40, 20);
  mask.setAlpha(8, 10, 255);
  backgroundEraseDab(g2, 10, 10, { radius: 6, hardness: 1, target: [200, 40, 40], tolerance: 0, mask });
  assert.equal(px(g2, 8, 10)[3], 0, "a selected pixel is erased");
  assert.equal(px(g2, 12, 10)[3], 255, "an unselected pixel is not");
});
