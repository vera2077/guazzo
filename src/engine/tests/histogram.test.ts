import assert from "node:assert/strict";
import test from "node:test";
import { histogramOf, histogramLuma } from "../histogram.ts";

test("histogram: counts only opaque pixels and reports the mean", () => {
  const px = new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 255, 255, 255,
    255, 255, 255, 0, // transparent — must not count
  ]);
  const h = histogramOf(px);
  assert.equal(h.count, 2);
  assert.equal(h.r[0], 1);
  assert.equal(h.r[255], 1);
  assert.equal(h.mean, 128); // (0 + 255) / 2, the transparent pixel excluded
  assert.equal(h.clippedShadows, 0.5);
  assert.equal(h.clippedHighlights, 0.5);
});

test("histogram: luma uses the BT.601 weights the compositor uses", () => {
  assert.equal(Math.round(histogramLuma(255, 0, 0)), 76);
  assert.equal(Math.round(histogramLuma(0, 255, 0)), 150);
  assert.equal(Math.round(histogramLuma(0, 0, 255)), 29);
});

test("histogram: an empty buffer has no peak", () => {
  const h = histogramOf(new Uint8ClampedArray(0));
  assert.equal(h.count, 0);
  assert.equal(h.peak, 0);
  assert.equal(h.mean, 0);
});
