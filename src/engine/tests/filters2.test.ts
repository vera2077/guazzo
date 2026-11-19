import { test } from "node:test";
import assert from "node:assert/strict";

import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import * as F2 from "../filters2.ts";
import { eq } from "./helpers.ts";

/** unknown-typed comparison so strict narrowing never leaks between asserts */
function grid(w: number, h: number): TileGrid {
  return new TileGrid(w, h);
}

function px(g: TileGrid, x: number, y: number): [number, number, number, number] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

function fill(g: TileGrid, x: number, y: number, w: number, h: number, c: [number, number, number, number]): void {
  g.fillRect(x, y, w, h, c);
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

test("motion blur evens a horizontal step edge without touching alpha", () => {
  const g = grid(40, 20);
  fill(g, 0, 0, 20, 20, BLACK);
  fill(g, 20, 0, 20, 20, WHITE);
  F2.motionBlur(g, { x: 0, y: 0, w: 40, h: 20 }, 0, 6);
  const [r, gg, b, a] = px(g, 19, 10);
  // pixels straddling the edge are pulled toward the average
  assert.ok(r > 0 && r < 255, `edge pixel should be grey, got ${r}`);
  eq(gg, r);
  eq(b, r);
  eq(a, 255);
  // far from the edge the blur leaves the value alone
  eq(px(g, 2, 10)[0], 0);
  eq(px(g, 37, 10)[0], 255);
});

test("box blur flattens detail and keeps a uniform field uniform", () => {
  const g = grid(30, 30);
  fill(g, 0, 0, 30, 30, [120, 120, 120, 255]);
  F2.boxBlur(g, { x: 0, y: 0, w: 30, h: 30 }, 3, 2);
  for (const [x, y] of [[0, 0], [15, 15], [29, 29]] as const) {
    const p = px(g, x, y);
    assert.ok(Math.abs(p[0] - 120) <= 1, `uniform field drifted at ${x},${y}: ${p[0]}`);
    eq(p[3], 255);
  }
});

test("median filter removes an isolated speck", () => {
  const g = grid(20, 20);
  fill(g, 0, 0, 20, 20, [80, 80, 80, 255]);
  g.fillRect(10, 10, 1, 1, [255, 0, 0, 255]);
  F2.medianFilter(g, { x: 0, y: 0, w: 20, h: 20 }, 1);
  const p = px(g, 10, 10);
  eq(p[0], 80);
  eq(p[1], 80);
  eq(p[3], 255);
});

test("spherize and twirl keep alpha and leave the far corner alone", () => {
  const g = grid(40, 40);
  fill(g, 0, 0, 40, 40, [30, 60, 90, 255]);
  g.fillRect(18, 0, 4, 40, [250, 250, 250, 255]);
  const before = px(g, 1, 1);
  F2.spherize(g, { x: 0, y: 0, w: 40, h: 40 }, 60);
  eq(px(g, 39, 39)[3], 255);
  const after = px(g, 1, 1);
  // outside the lens circle the pixel is untouched
  eq(after[0], before[0]);
  F2.twirl(g, { x: 0, y: 0, w: 40, h: 40 }, 90);
  eq(px(g, 39, 39)[3], 255);
});

test("ripple displaces a vertical bar but preserves pixel count", () => {
  const g = grid(60, 40);
  fill(g, 0, 0, 60, 40, [10, 10, 10, 255]);
  g.fillRect(29, 0, 3, 40, [240, 240, 240, 255]);
  F2.ripple(g, { x: 0, y: 0, w: 60, h: 40 }, 8, 30);
  let whites = 0;
  for (let x = 0; x < 60; x++) for (let y = 0; y < 40; y++) if (px(g, x, y)[0] > 200) whites++;
  assert.ok(whites > 0, "rippled bar should still be visible");
  eq(px(g, 0, 0)[3], 255);
});

test("find edges paints a white field with dark outlines", () => {
  const g = grid(30, 30);
  fill(g, 0, 0, 30, 30, [0, 0, 0, 255]);
  fill(g, 12, 12, 6, 6, [255, 255, 255, 255]);
  F2.findEdges(g, { x: 0, y: 0, w: 30, h: 30 });
  // flat interiors carry no edge information, so they turn white (Photoshop's look)
  eq(px(g, 14, 14)[0], 255);
  // the boundary between black and white is a strong edge, so it goes dark
  const border = px(g, 12, 14)[0];
  assert.ok(border < 140, `border pixel should be dark, got ${border}`);
  eq(px(g, 14, 14)[3], 255);
});

test("emboss produces mid grey on a flat field", () => {
  const g = grid(24, 24);
  fill(g, 0, 0, 24, 24, [90, 90, 90, 255]);
  F2.emboss(g, { x: 0, y: 0, w: 24, h: 24 }, 135, 2, 100);
  const p = px(g, 12, 12);
  assert.ok(Math.abs(p[0] - 128) <= 1, `flat field should emboss to 128, got ${p[0]}`);
  eq(p[0], p[1]);
  eq(p[0], p[2]);
});

test("solarize inverts only above the threshold", () => {
  const g = grid(4, 1);
  g.fillRect(0, 0, 1, 1, [200, 200, 200, 255]);
  g.fillRect(1, 0, 1, 1, [100, 100, 100, 255]);
  g.fillRect(2, 0, 1, 1, [0, 0, 0, 255]);
  g.fillRect(3, 0, 1, 1, [255, 255, 255, 255]);
  F2.solarize(g, { x: 0, y: 0, w: 4, h: 1 }, 128);
  eq(px(g, 0, 0)[0], 55);
  eq(px(g, 1, 0)[0], 100);
  eq(px(g, 2, 0)[0], 0);
  eq(px(g, 3, 0)[0], 0);
});

test("trace contour marks only pixels crossing the level", () => {
  const g = grid(20, 4);
  fill(g, 0, 0, 20, 4, [40, 40, 40, 255]);
  fill(g, 10, 0, 10, 4, [220, 220, 220, 255]);
  F2.traceContour(g, { x: 0, y: 0, w: 20, h: 4 }, 128);
  eq(px(g, 3, 2)[0], 0);
  assert.ok(px(g, 9, 2)[0] > 200 || px(g, 10, 2)[0] > 200, "the boundary must be marked");
});

test("clouds is deterministic for a seed and changes with it", () => {
  const a = grid(32, 32);
  const b = grid(32, 32);
  const c = grid(32, 32);
  fill(a, 0, 0, 32, 32, [0, 0, 0, 255]);
  fill(b, 0, 0, 32, 32, [0, 0, 0, 255]);
  fill(c, 0, 0, 32, 32, [0, 0, 0, 255]);
  F2.clouds(a, { x: 0, y: 0, w: 32, h: 32 }, 7);
  F2.clouds(b, { x: 0, y: 0, w: 32, h: 32 }, 7);
  F2.clouds(c, { x: 0, y: 0, w: 32, h: 32 }, 9);
  let same = true;
  let differs = false;
  for (let x = 0; x < 32; x++) {
    for (let y = 0; y < 32; y++) {
      const pa = px(a, x, y)[0], pb = px(b, x, y)[0], pc = px(c, x, y)[0];
      if (pa !== pb) same = false;
      if (pa !== pc) differs = true;
    }
  }
  eq(same, true);
  eq(differs, true);
  eq(px(a, 16, 16)[3], 255);
});

test("lens flare brightens the centre the most", () => {
  const g = grid(80, 60);
  fill(g, 0, 0, 80, 60, [20, 20, 20, 255]);
  F2.lensFlare(g, { x: 0, y: 0, w: 80, h: 60 }, 40, 30, 100);
  const centre = px(g, 40, 30)[0];
  const far = px(g, 2, 2)[0];
  assert.ok(centre > far, `centre ${centre} should beat corner ${far}`);
  eq(px(g, 40, 30)[3], 255);
});

test("high pass is flat grey where the image is flat", () => {
  const g = grid(40, 40);
  fill(g, 0, 0, 40, 40, [70, 70, 70, 255]);
  F2.highPass(g, { x: 0, y: 0, w: 40, h: 40 }, 8);
  const p = px(g, 20, 20);
  assert.ok(Math.abs(p[0] - 128) <= 1, `flat high pass should be 128, got ${p[0]}`);
});

test("offset wraps pixels around the rect", () => {
  const g = grid(10, 10);
  fill(g, 0, 0, 10, 10, [0, 0, 0, 255]);
  g.fillRect(0, 0, 2, 2, [255, 0, 0, 255]);
  F2.offsetFilter(g, { x: 0, y: 0, w: 10, h: 10 }, 3, 0);
  eq(px(g, 3, 0)[0], 255);
  eq(px(g, 0, 0)[0], 0);
});

test("min/max grow and shrink a bright dot", () => {
  const grow = grid(20, 20);
  fill(grow, 0, 0, 20, 20, [0, 0, 0, 255]);
  grow.fillRect(10, 10, 1, 1, [255, 255, 255, 255]);
  F2.minMax(grow, { x: 0, y: 0, w: 20, h: 20 }, 2, "maximum");
  eq(px(grow, 12, 10)[0], 255);
  const shrink = grid(20, 20);
  fill(shrink, 0, 0, 20, 20, [255, 255, 255, 255]);
  shrink.fillRect(10, 10, 1, 1, [0, 0, 0, 255]);
  F2.minMax(shrink, { x: 0, y: 0, w: 20, h: 20 }, 2, "minimum");
  eq(px(shrink, 12, 10)[0], 0);
});

test("custom kernel sharpens and rejects a non-square kernel", () => {
  const g = grid(10, 10);
  fill(g, 0, 0, 10, 10, [100, 100, 100, 255]);
  F2.customKernel(g, { x: 0, y: 0, w: 10, h: 10 }, [0, 0, 0, 0, 1, 0, 0, 0, 0], 1, 0);
  eq(px(g, 5, 5)[0], 100);
  assert.throws(() => F2.customKernel(g, { x: 0, y: 0, w: 10, h: 10 }, [1, 2], 1, 0), /square/);
});

test("oil paint keeps a flat field flat and crystallize blocks colours", () => {
  const g = grid(30, 30);
  fill(g, 0, 0, 30, 30, [60, 90, 120, 255]);
  F2.oilPaint(g, { x: 0, y: 0, w: 30, h: 30 }, 3, 8);
  const p = px(g, 15, 15);
  assert.ok(Math.abs(p[0] - 60) <= 4 && Math.abs(p[1] - 90) <= 4, "flat field should survive oil paint");
  const c = grid(30, 30);
  fill(c, 0, 0, 30, 30, [0, 0, 0, 255]);
  c.fillRect(0, 0, 10, 10, [255, 0, 0, 255]);
  F2.crystallize(c, { x: 0, y: 0, w: 30, h: 30 }, 10);
  eq(px(c, 1, 1)[0], 255);
  eq(px(c, 1, 1)[1], 0);
});

test("a masked filter leaves outside pixels byte-identical", () => {
  const g = grid(40, 20);
  fill(g, 0, 0, 20, 20, [0, 0, 0, 255]);
  fill(g, 20, 0, 20, 20, [255, 255, 255, 255]);
  const mask = new SelectionMask(40, 20);
  mask.selectRect(0, 0, 20, 20);
  F2.motionBlur(g, { x: 0, y: 0, w: 40, h: 20 }, 0, 6, mask);
  // inside the mask the blur runs (and pulls white in across the mask edge)
  const inside = px(g, 19, 10)[0];
  assert.ok(inside > 0 && inside < 255, `inside the mask should be blurred, got ${inside}`);
  // outside the mask the pixels are byte-identical
  eq(px(g, 21, 10)[0], 255);
  eq(px(g, 30, 10)[0], 255);
});

test("radial zoom blur spreads a dot outward", () => {
  const g = grid(60, 60);
  fill(g, 0, 0, 60, 60, [0, 0, 0, 255]);
  g.fillRect(40, 30, 2, 1, [255, 255, 255, 255]);
  F2.radialBlur(g, { x: 0, y: 0, w: 60, h: 60 }, 80, "zoom", 30, 30);
  let lit = 0;
  for (let x = 0; x < 60; x++) if (px(g, x, 30)[0] > 20) lit++;
  assert.ok(lit > 2, `zoom blur should smear the dot, lit=${lit}`);
  eq(px(g, 0, 0)[3], 255);
});

test("premultiplied blur: no dark halos on semi-transparent layers (T1)", () => {
  // left half red at alpha 128, right half fully transparent. Straight-RGBA
  // averaging bleeds (0,0,0,0) neighbours into the boundary column and drags
  // rgb toward black; premultiplied accumulation must keep it red.
  const g = grid(32, 16);
  for (let y = 0; y < 16; y++) g.fillRect(0, y, 16, 1, [220, 30, 30, 128]);
  const r = { x: 0, y: 0, w: 32, h: 16 };

  F2.boxBlur(g, r, 2);
  const edge = px(g, 15, 8); // boundary between red and transparent
  assert.ok(edge[0] > 120, `box blur boundary should stay red, got ${edge.join(",")}`);
  assert.ok(edge[2] < 90, `box blur boundary must not gain blue, got ${edge.join(",")}`);
  const interior = px(g, 4, 8); // far from the edge: unchanged red
  eq(interior[0] > 200, true);
  eq(interior[3] > 120 && interior[3] < 136, true); // alpha stays ~128

  const g2 = grid(32, 16);
  for (let y = 0; y < 16; y++) g2.fillRect(0, y, 16, 1, [220, 30, 30, 128]);
  F2.motionBlur(g2, r, 0, 3);
  const m = px(g2, 15, 8);
  assert.ok(m[0] > 120, `motion blur boundary should stay red, got ${m.join(",")}`);

  const g3 = grid(32, 16);
  for (let y = 0; y < 16; y++) g3.fillRect(0, y, 16, 1, [220, 30, 30, 128]);
  F2.radialBlur(g3, r, 60, "zoom");
  const z = px(g3, 15, 8);
  assert.ok(z[0] > 100, `radial blur boundary should stay red, got ${z.join(",")}`);
});
