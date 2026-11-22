import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceScale, isCrispZoom, shouldSmooth } from "../zoomfilter.ts";

// The reports this guards against, in order: "why is everything low res" at
// 100 % on a scaled display, and chewed 1-px strokes at 93 %.
test("device scale is zoom times dpr", () => {
  assert.equal(deviceScale(1, 1), 1);
  assert.equal(deviceScale(0.93, 1), 0.93);
  assert.equal(deviceScale(1, 1.25), 1.25);
});

test("nearest-neighbour is used only when it is lossless", () => {
  assert.equal(isCrispZoom(1, 1), true, "100 % on a 100 % display");
  assert.equal(isCrispZoom(2, 1), true, "200 % is whole device pixels");
  assert.equal(isCrispZoom(3, 1), true, "300 % is whole device pixels");
  assert.equal(isCrispZoom(0.5, 2), true, "50 % on a 200 % display lands on whole pixels");
});

test("fractions are smoothed instead of dropping rows", () => {
  assert.equal(isCrispZoom(0.93, 1), false, "93 % must smooth");
  assert.equal(isCrispZoom(1, 1.25), false, "100 % on a 125 % display must smooth");
  assert.equal(isCrispZoom(1, 1.5), false, "100 % on a 150 % display must smooth");
  assert.equal(shouldSmooth(0.93, 1), true);
  assert.equal(shouldSmooth(1, 1), false, "nothing to smooth at 1:1");
});

test("floating-point drift does not turn a whole scale into a fraction", () => {
  assert.equal(isCrispZoom(1 / 3, 3, 0.01), true);
});

test("degenerate inputs fall back instead of propagating NaN", () => {
  assert.equal(isCrispZoom(0, 1), false);
  assert.equal(isCrispZoom(Number.NaN, 1), false);
  assert.equal(deviceScale(Number.NaN, Number.NaN), 1);
});
