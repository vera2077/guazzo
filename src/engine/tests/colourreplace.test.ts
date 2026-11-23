import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { replaceColourDab } from "../colourreplace.ts";
import { SelectionMask } from "../mask.ts";

function px(g: TileGrid, x: number, y: number): [number, number, number, number] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

function filled(colour: [number, number, number]): TileGrid {
  const g = new TileGrid(32, 32);
  const buf = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    buf[i * 4] = colour[0]; buf[i * 4 + 1] = colour[1]; buf[i * 4 + 2] = colour[2]; buf[i * 4 + 3] = 255;
  }
  g.writeRect(0, 0, 32, 32, buf);
  return g;
}

const lum = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

test("replace: swaps the hue and keeps the pixel's luminosity", () => {
  // Red at 200 has luma ≈ 60. Replacing it with green must keep that luma —
  // "turn the red car green at the same brightness", not "paint green over it".
  const g = filled([200, 0, 0]);
  const before = lum(200, 0, 0);
  const rect = replaceColourDab(g, 16, 16, {
    radius: 5, hardness: 1, target: [200, 0, 0], tolerance: 0, colour: [0, 255, 0],
  });
  assert.ok(rect);
  const [r, gg, b] = px(g, 16, 16);
  assert.ok(r < 40, `red must go away (got r=${r})`);
  assert.ok(gg > 0, "the replacement hue must be present");
  assert.ok(Math.abs(lum(r, gg, b) - before) <= 2, `luma must be preserved (${lum(r, gg, b)} vs ${before})`);
});

test("replace: a colour outside the tolerance is left alone", () => {
  const g = filled([200, 0, 0]);
  replaceColourDab(g, 16, 16, { radius: 5, hardness: 1, target: [0, 200, 0], tolerance: 0, colour: [0, 0, 255] });
  assert.deepEqual(px(g, 16, 16), [200, 0, 0, 255]);
});

test("replace: the selection clips it like any paint tool", () => {
  const g = filled([200, 0, 0]);
  const mask = new SelectionMask(32, 32);
  mask.setAlpha(16, 16, 255);
  const rect = replaceColourDab(g, 16, 16, {
    radius: 6, hardness: 1, target: [200, 0, 0], tolerance: 0, colour: [0, 200, 0], mask,
  });
  assert.ok(rect);
  assert.ok(px(g, 16, 16)[1] > 0, "the selected pixel is replaced");
  assert.deepEqual(px(g, 20, 16), [200, 0, 0, 255], "an unselected pixel keeps its colour");
});
