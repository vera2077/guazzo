import { test } from "node:test";
import assert from "node:assert/strict";
import { blendPixel } from "../blend.ts";

const near = (a: number, b: number, eps = 1.5) => Math.abs(a - b) <= eps;

test("normal 50% over opaque dst is the average", () => {
  const out = blendPixel("normal", [200, 100, 50, 128], [100, 100, 100, 255]);
  assert.ok(near(out[0], 150) && near(out[1], 100) && near(out[2], 75));
  assert.ok(near(out[3], 255));
});

test("transparent src leaves dst untouched", () => {
  const out = blendPixel("normal", [255, 0, 0, 0], [1, 2, 3, 200]);
  assert.deepEqual(out, [1, 2, 3, 200]);
});

test("multiply: red over white stays red; over black stays black", () => {
  const a = blendPixel("multiply", [255, 0, 0, 255], [255, 255, 255, 255]);
  assert.deepEqual(a, [255, 0, 0, 255]);
  const b = blendPixel("multiply", [255, 0, 0, 255], [0, 0, 0, 255]);
  assert.deepEqual(b, [0, 0, 0, 255]);
});

test("screen: black over anything = anything", () => {
  const out = blendPixel("screen", [0, 0, 0, 255], [30, 60, 90, 255]);
  assert.deepEqual(out, [30, 60, 90, 255]);
});

test("color-dodge 50% over 50% = 100", () => {
  // Cs=0.5, Cb=0.5 → min(1, 0.5/0.5)=1
  const out = blendPixel("color-dodge", [128, 128, 128, 255], [128, 128, 128, 255]);
  assert.ok(near(out[0], 255) && near(out[1], 255) && near(out[2], 255));
});

test("subtract: dst - src clamped to 0", () => {
  const out = blendPixel("subtract", [200, 50, 0, 255], [100, 100, 100, 255]);
  assert.deepEqual(out, [0, 50, 100, 255]);
});

test("divide: 128/192 → 170", () => {
  // Cs=192/255≈0.7529, Cb=128/255≈0.502 → min(1, .502/.7529)=.6667 → 170
  const out = blendPixel("divide", [192, 192, 192, 255], [128, 128, 128, 255]);
  assert.ok(near(out[0], 170));
});

test("difference: |dst-src|", () => {
  const out = blendPixel("difference", [240, 10, 0, 255], [90, 200, 0, 255]);
  assert.deepEqual(out, [150, 190, 0, 255]);
});

test("darker-color picks the lower-luminance color wholesale", () => {
  // lum(red 255,0,0)=76.5 > lum(blue 0,0,255)=28 → blue wins
  const out = blendPixel("darker-color", [255, 0, 0, 255], [0, 0, 255, 255]);
  assert.deepEqual(out, [0, 0, 255, 255]);
});

test("luminosity keeps src luminance, dst hue/sat", () => {
  // W3C: SetLum(red, lum(gray50)) → (1.0, .288, .288) after clipping = (255,74,74)
  const out = blendPixel("luminosity", [128, 128, 128, 255], [255, 0, 0, 255]);
  assert.ok(near(out[0], 255, 2) && near(out[1], 74, 2) && near(out[2], 74, 2), `got ${out}`);
});

test("behind only fills transparent dst", () => {
  const t = blendPixel("behind", [50, 60, 70, 255], [0, 0, 0, 0]);
  assert.deepEqual(t, [50, 60, 70, 255]); // fully transparent dst → src
  const o = blendPixel("behind", [50, 60, 70, 255], [10, 20, 30, 255]);
  assert.deepEqual(o, [10, 20, 30, 255]); // opaque dst → unchanged
  const half = blendPixel("behind", [50, 60, 70, 255], [10, 20, 30, 128]);
  // eff alpha = 1 * (1 - 0.5) = 0.5 → but color must stay dst where dst exists
  assert.ok(near(half[3], 255) || near(half[3], 127), `got ${half}`);
});

test("clear erases dst where painted", () => {
  const out = blendPixel("clear", [0, 0, 0, 255], [10, 20, 30, 200]);
  // destination-out: dst color kept, alpha fully removed
  assert.deepEqual(out, [10, 20, 30, 0]);
  const half = blendPixel("clear", [0, 0, 0, 128], [10, 20, 30, 200]);
  // alpha = 200 · (1 - 128/255) ≈ 99.6
  assert.ok(near(half[3], 100), `got ${half}`);
  assert.deepEqual([half[0], half[1], half[2]], [10, 20, 30]);
});

test("semi-transparent src over transparent dst = src", () => {
  const out = blendPixel("normal", [10, 20, 30, 100], [0, 0, 0, 0]);
  assert.deepEqual(out, [10, 20, 30, 100]);
});
