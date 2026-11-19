import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySample, readGridRGBA, samplePremul, straightRGB } from "../sample.ts";
import { TileGrid } from "../tile.ts";

const eq = (actual: unknown, expected: unknown) => assert.strictEqual(actual, expected);

/** 2×1 buffer: opaque red at x=0, fully transparent at x=1. */
function redThenClear(): Uint8ClampedArray {
  const b = new Uint8ClampedArray(2 * 1 * 4);
  b[0] = 255;
  b[3] = 255;
  return b;
}

test("a flat opaque field samples back exactly, alpha 255", () => {
  const w = 4, h = 4;
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = 10;
    buf[i * 4 + 1] = 120;
    buf[i * 4 + 2] = 200;
    buf[i * 4 + 3] = 255;
  }
  const s = emptySample();
  const rgb = new Float32Array(3);
  for (const [x, y] of [[0, 0], [1.5, 2.25], [3, 3]] as [number, number][]) {
    samplePremul(buf, w, h, x, y, s, true);
    straightRGB(s, rgb);
    eq(Math.round(rgb[0]!), 10);
    eq(Math.round(rgb[1]!), 120);
    eq(Math.round(rgb[2]!), 200);
    eq(Math.round(s.a * 255), 255);
  }
});

test("a transparent neighbour cannot darken the colour (premultiplied)", () => {
  const s = emptySample();
  const rgb = new Float32Array(3);
  // halfway between opaque red and fully transparent
  samplePremul(redThenClear(), 2, 1, 0.5, 0, s, true);
  straightRGB(s, rgb);
  eq(Math.round(rgb[0]!), 255); // straight red survives; no pull toward black
  eq(Math.round(rgb[1]!), 0);
  eq(Math.round(s.a * 255), 128); // half covered
});

test("clamp extends the edge colour and keeps full alpha", () => {
  const s = emptySample();
  const rgb = new Float32Array(3);
  samplePremul(redThenClear(), 2, 1, -6, 0, s, true);
  straightRGB(s, rgb);
  eq(Math.round(rgb[0]!), 255);
  eq(Math.round(s.a * 255), 255);
});

test("no clamp reports the covered footprint instead of inventing edge pixels", () => {
  const s = emptySample();
  samplePremul(redThenClear(), 2, 1, 9, 0, s, false);
  eq(s.a, 0);
  eq(s.wsum, 0);
  const rgb = new Float32Array(3);
  straightRGB(s, rgb);
  eq(rgb[0], 0);
  // hanging half off the right edge: half the footprint existed
  samplePremul(redThenClear(), 2, 1, 1.5, 0, s, false);
  assert.ok(s.wsum > 0 && s.wsum < 1, `wsum reports partial coverage, got ${s.wsum}`);
});

test("readGridRGBA copies the whole grid, transparency included", () => {
  const g = new TileGrid(4, 4);
  g.writeRect(1, 1, 2, 2, new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]));
  const buf = readGridRGBA(g, 4, 4);
  eq(buf.length, 64);
  eq(buf[(1 * 4 + 1) * 4], 255);
  eq(buf[(0 * 4 + 0) * 4 + 3], 0);
});
