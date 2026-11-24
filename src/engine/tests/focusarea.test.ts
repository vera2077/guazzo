import assert from "node:assert/strict";
import test from "node:test";
import { focusAreaMask } from "../focusarea.ts";

/** Left half: crisp 2px checkerboard. Right half: flat mid-grey blur stand-in. */
function checkerAndFlat(): { px: Uint8ClampedArray; w: number; h: number } {
  const w = 64;
  const h = 32;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const value =
        x < 32
          ? (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0
            ? 255
            : 0
          : 128;
      const i = (y * w + x) * 4;
      px[i] = value;
      px[i + 1] = value;
      px[i + 2] = value;
      px[i + 3] = 255;
    }
  }
  return { px, w, h };
}

function countOn(mask: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 255) n++;
  return n;
}

test("focusarea: sharp checkerboard selected, flat region not, at default threshold", () => {
  const { px, w, h } = checkerAndFlat();
  const mask = focusAreaMask(px, w, h);

  let sharp = 0;
  for (let y = 4; y < 28; y++) {
    for (let x = 4; x < 28; x++) if (mask[y * w + x] === 255) sharp++;
  }
  let flat = 0;
  for (let y = 4; y < 28; y++) {
    for (let x = 40; x < 60; x++) if (mask[y * w + x] === 255) flat++;
  }

  assert.ok(sharp > 0, "the sharp region must contain selected pixels");
  assert.equal(flat, 0, "a flat region must not be selected");
  assert.ok(sharp > flat, "sharp region must be selected more than flat region");
});

test("focusarea: threshold 1 selects nothing, threshold 0 selects everything", () => {
  const { px, w, h } = checkerAndFlat();
  const none = focusAreaMask(px, w, h, 1);
  const all = focusAreaMask(px, w, h, 0);

  assert.equal(countOn(none), 0);
  assert.equal(countOn(all), w * h);

  // Out-of-range thresholds are clamped into 0..1.
  assert.deepEqual(focusAreaMask(px, w, h, 2), none);
  assert.deepEqual(focusAreaMask(px, w, h, -1), all);
});

test("focusarea: repeated calls are deterministic", () => {
  const { px, w, h } = checkerAndFlat();
  const a = focusAreaMask(px, w, h);
  const b = focusAreaMask(px, w, h);
  assert.deepEqual(a, b);
});

test("focusarea: the input RGBA buffer is never mutated", () => {
  const { px, w, h } = checkerAndFlat();
  const before = px.slice();
  focusAreaMask(px, w, h);
  assert.deepEqual(px, before);
});

test("focusarea: mask length matches w*h for a non-square image", () => {
  const w = 7;
  const h = 11;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 90;
    px[i + 1] = 90;
    px[i + 2] = 90;
    px[i + 3] = 255;
  }
  const mask = focusAreaMask(px, w, h);
  assert.equal(mask.length, w * h);
  assert.ok(mask instanceof Uint8ClampedArray);
  for (let i = 0; i < mask.length; i++) {
    assert.ok(mask[i] === 0 || mask[i] === 255);
  }
});
