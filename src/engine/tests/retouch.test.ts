import assert from "node:assert/strict";
import { test } from "node:test";
import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import {
  cloneDab, dodgeBurnDab, focusDab, redEyeDab, sampleColor, smudgeDab, spongeDab,
} from "../retouch.ts";
import { eq } from "./helpers.ts";

// assert.equal narrows a closure-mutated `let`; compare through unknown instead.
function px(g: TileGrid, x: number, y: number): number[] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}
/** what the eyedropper actually samples in the app: a merged RGBA frame */
function frame(g: TileGrid): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  g.readRect(0, 0, g.width, g.height, data);
  return { width: g.width, height: g.height, data };
}
function solid(size: number, rgba: [number, number, number, number]): TileGrid {
  const g = new TileGrid(size, size);
  g.fillRect(0, 0, size, size, rgba);
  return g;
}

test("dodge lightens, burn darkens, and the falloff is symmetric", () => {
  const g = solid(64, [120, 120, 120, 255]);
  const rect = dodgeBurnDab(g, { x: 32, y: 32, radius: 10, hardness: 0.5, amount: 0.5, mode: "dodge", range: "midtones" });
  assert.ok(rect);
  const mid = px(g, 32, 32)[0]!;
  assert.ok(mid > 120, `dodge should lighten, got ${mid}`);
  // the same distance left and right must receive the same treatment.
  // NB: the dab is centred on the pixel centre (x+0.5), so the mirror of
  // column 26 is 37, not 38 — 26/38 differ by a whole pixel of falloff.
  eq(px(g, 26, 32)[0], px(g, 37, 32)[0]);
  // a far pixel is untouched
  eq(px(g, 2, 2)[0], 120);

  const g2 = solid(64, [120, 120, 120, 255]);
  dodgeBurnDab(g2, { x: 32, y: 32, radius: 10, hardness: 0.5, amount: 0.5, mode: "burn", range: "midtones" });
  assert.ok(px(g2, 32, 32)[0]! < 120);
});

test("dodge respects tonal ranges: shadows range ignores a white pixel", () => {
  const g = solid(32, [250, 250, 250, 255]);
  const r = dodgeBurnDab(g, { x: 16, y: 16, radius: 8, hardness: 1, amount: 0.8, mode: "burn", range: "shadows" });
  eq(r, null); // gate is 0 at luminance 1.0 → nothing touched
  eq(px(g, 16, 16)[0], 250);
});

test("transparent pixels are never turned opaque by dodge/burn", () => {
  const g = new TileGrid(16, 16);
  const r = dodgeBurnDab(g, { x: 8, y: 8, radius: 5, hardness: 1, amount: 0.9, mode: "dodge", range: "midtones" });
  eq(r, null);
  eq(g.allocated, 0);
});

test("sponge desaturates toward grey and saturate increases separation", () => {
  const g = solid(32, [200, 60, 60, 255]);
  spongeDab(g, { x: 16, y: 16, radius: 8, hardness: 1, amount: 0.9, mode: "desaturate" });
  const p = px(g, 16, 16);
  assert.ok(p[0]! - p[1]! < 140, `red/green separation should shrink, got ${p[0]}-${p[1]}`);
  // luminance is preserved by a saturation change
  assert.ok(Math.abs((0.3 * p[0]! + 0.59 * p[1]! + 0.11 * p[2]!) - (0.3 * 200 + 0.59 * 60 + 0.11 * 60)) < 6);
});

test("blur reduces a hard edge, sharpen increases it", () => {
  const g = new TileGrid(32, 32);
  g.fillRect(0, 0, 16, 32, [255, 255, 255, 255]);
  g.fillRect(16, 0, 16, 32, [0, 0, 0, 255]);
  const edgeBefore = px(g, 16, 16)[0]!;
  focusDab(g, { x: 16, y: 16, radius: 8, hardness: 1, strength: 1, mode: "blur" });
  const edgeBlur = px(g, 16, 16)[0]!;
  assert.ok(edgeBlur > edgeBefore && edgeBlur < 255, `blur should mix the edge, got ${edgeBlur}`);

  const g2 = new TileGrid(32, 32);
  g2.fillRect(0, 0, 16, 32, [200, 200, 200, 255]);
  g2.fillRect(16, 0, 16, 32, [60, 60, 60, 255]);
  const before = px(g2, 16, 16)[0]!;
  focusDab(g2, { x: 16, y: 16, radius: 8, hardness: 1, strength: 1, mode: "sharpen" });
  const after = px(g2, 16, 16)[0]!;
  assert.ok(Math.abs(after - 128) > Math.abs(before - 128), `sharpen should widen contrast: ${before} -> ${after}`);
});

test("smudge pulls colour along the stroke direction", () => {
  const g = new TileGrid(48, 48);
  g.fillRect(0, 0, 24, 48, [255, 0, 0, 255]);
  g.fillRect(24, 0, 24, 48, [0, 0, 255, 255]);
  // drag rightwards across the boundary: red should bleed into the blue side
  smudgeDab(g, { x: 26, y: 24, fromX: 22, fromY: 24, radius: 6, hardness: 1, strength: 0.9 });
  const p = px(g, 26, 24);
  assert.ok(p[0]! > 30, `red should spread into the blue side, got ${p[0]}`);
  eq(px(g, 40, 24)[0], 0); // far away stays pure blue
});

test("clone copies pixels from the sampled offset and keeps transparency", () => {
  const g = new TileGrid(64, 64);
  g.fillRect(4, 4, 8, 8, [10, 200, 30, 255]); // the "source stamp"
  cloneDab(g, { x: 40, y: 40, radius: 6, hardness: 1, offsetX: -36, offsetY: -36, alpha: 1 });
  const p = px(g, 40, 40);
  eq(p[0], 10);
  eq(p[1], 200);
  eq(p[3], 255);
  // cloning from outside the canvas must not paint anything
  const g2 = new TileGrid(32, 32);
  const r = cloneDab(g2, { x: 4, y: 4, radius: 4, hardness: 1, offsetX: -20, offsetY: -20, alpha: 1 });
  eq(r, null);
});

test("red-eye neutralises red but leaves a neutral pixel alone", () => {
  const g = solid(32, [220, 40, 40, 255]);
  redEyeDab(g, { x: 16, y: 16, radius: 8, hardness: 1, darken: 0.5 });
  const p = px(g, 16, 16);
  assert.ok(p[0]! < 120, `red should drop a lot, got ${p[0]}`);

  const grey = solid(32, [120, 120, 120, 255]);
  const r = redEyeDab(grey, { x: 16, y: 16, radius: 8, hardness: 1, darken: 0.5 });
  eq(r, null);
});

test("every retouch dab honours the selection mask", () => {
  const g = solid(32, [120, 120, 120, 255]);
  const m = new SelectionMask(32, 32);
  m.selectRect(0, 0, 16, 32); // left half only
  dodgeBurnDab(g, { x: 16, y: 16, radius: 10, hardness: 1, amount: 0.5, mode: "dodge", range: "midtones", mask: m });
  assert.ok(px(g, 12, 16)[0]! > 120, "inside the selection must change");
  eq(px(g, 22, 16)[0], 120); // outside untouched
});

test("sampleColor averages a neighbourhood and skips transparent pixels", () => {
  const g = new TileGrid(8, 8);
  g.fillRect(0, 0, 8, 8, [100, 150, 200, 255]);
  g.fillRect(0, 0, 1, 1, [255, 0, 0, 255]);
  const one = sampleColor(frame(g), 3, 3, 1);
  assert.deepEqual([one!.r, one!.g, one!.b], [100, 150, 200]);
  const red = sampleColor(frame(g), 0, 0, 1);
  assert.deepEqual([red!.r, red!.g, red!.b], [255, 0, 0]);
  // a 3x3 average over the red corner mixes it with its neighbours
  const avg = sampleColor(frame(g), 0, 0, 3);
  assert.ok(avg!.r! < 255 && avg!.r! > 100);
  // fully transparent canvas → nothing to sample
  eq(sampleColor(frame(new TileGrid(4, 4)), 1, 1, 1), null);
});

test("focus blur does not paint dark halos on a transparent layer", () => {
  // red square on transparency: blurring the edge used to average the rgb=0 of
  // the transparent neighbours straight into the red, greying it out
  const g = new TileGrid(16, 16);
  g.fillRect(0, 0, 8, 16, [255, 0, 0, 255]);
  focusDab(g, { x: 8, y: 8, radius: 6, hardness: 1, strength: 1, mode: "blur" });
  const edge = px(g, 7, 8);
  assert.ok(edge[0]! > 150, `edge red must stay saturated, got r=${edge[0]}`);
  assert.ok(edge[1]! < 60 && edge[2]! < 60, `blur must not invent green/blue, got ${edge[1]}/${edge[2]}`);
});
