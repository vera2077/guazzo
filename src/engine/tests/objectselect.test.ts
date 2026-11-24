import { test } from "node:test";
import assert from "node:assert/strict";
import { objectSelectionMask } from "../objectselect.ts";

/** Solid red square centred in a contrasting blue field. */
function redSquare(w: number, h: number, sx: number, sy: number, s: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const red = x >= sx && x < sx + s && y >= sy && y < sy + s;
      px[i] = red ? 220 : 20;
      px[i + 1] = 30;
      px[i + 2] = red ? 30 : 220;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Same idea, with deterministic per-pixel noise so colours spread across bins. */
function noisyRedBlue(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  const clamp = (n: number): number => Math.max(0, Math.min(255, n));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const noise = ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 41) - 20;
      const red = x >= 6 && x < 16 && y >= 6 && y < 18;
      const base = red ? [210, 40, 40] : [30, 30, 200];
      px[i] = clamp(base[0]! + noise);
      px[i + 1] = clamp(base[1]! + noise);
      px[i + 2] = clamp(base[2]! + noise);
      px[i + 3] = 255;
    }
  }
  return px;
}

function isBinaryMask(m: Uint8ClampedArray, n: number): boolean {
  return m.length === n && m.every((v) => v === 0 || v === 255);
}

test("1. an invalid rect returns an all-zero mask", () => {
  const px = redSquare(16, 16, 4, 4, 8);
  const invalid = [
    { x: 0, y: 0, w: 0, h: 0 },
    { x: 2, y: 2, w: -4, h: 6 },
    { x: 20, y: 20, w: 4, h: 4 }, // clamps away to nothing
    { x: Number.NaN, y: 0, w: 4, h: 4 },
    { x: 0, y: 0, w: 4, h: Number.POSITIVE_INFINITY },
  ];
  for (const rect of invalid) {
    const m = objectSelectionMask(px, 16, 16, rect);
    assert.equal(m.length, 16 * 16);
    assert.ok(m.every((v) => v === 0), `expected all zero for ${JSON.stringify(rect)}`);
  }
});

test("2. a red square on blue: centre selected, far background corner excluded", () => {
  const W = 16;
  const H = 16;
  const px = redSquare(W, H, 4, 4, 8);
  const m = objectSelectionMask(px, W, H, { x: 4, y: 4, w: 8, h: 8 });
  assert.equal(m[8 * W + 8], 255, "red square centre must be foreground");
  assert.equal(m[6 * W + 6], 255, "another point inside the square must be foreground");
  assert.equal(m[0], 0, "far blue corner must be background");
  assert.equal(m[15 * W + 15], 0, "opposite far corner must be background");
  assert.ok(isBinaryMask(m, W * H));
});

test("3. repeated calls are byte-for-byte identical", () => {
  const W = 24;
  const H = 24;
  const px = noisyRedBlue(W, H);
  const rect = { x: 5, y: 5, w: 12, h: 14 };
  const a = objectSelectionMask(px, W, H, rect, 4);
  const b = objectSelectionMask(px, W, H, rect, 4);
  const c = objectSelectionMask(px, W, H, rect, 4);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("4. iterations 1 and 4 both produce valid masks (clamping is bounded)", () => {
  const W = 24;
  const H = 24;
  const px = noisyRedBlue(W, H);
  const rect = { x: 5, y: 5, w: 12, h: 14 };
  const one = objectSelectionMask(px, W, H, rect, 1);
  const four = objectSelectionMask(px, W, H, rect, 4);
  assert.ok(isBinaryMask(one, W * H), "iterations=1 must be a valid binary mask");
  assert.ok(isBinaryMask(four, W * H), "iterations=4 must be a valid binary mask");

  // Out-of-range counts clamp to 1..8 and remain valid; default matches 4.
  assert.deepEqual(objectSelectionMask(px, W, H, rect), four);
  assert.deepEqual(objectSelectionMask(px, W, H, rect, 0), one);
  assert.ok(isBinaryMask(objectSelectionMask(px, W, H, rect, 99), W * H));
});

test("5. the alpha channel of px is unchanged after the call", () => {
  const W = 16;
  const H = 16;
  const px = redSquare(W, H, 4, 4, 8);
  for (let p = 0; p < W * H; p++) px[p * 4 + 3] = (p * 37) % 256;
  const before = Uint8ClampedArray.from(px);

  objectSelectionMask(px, W, H, { x: 4, y: 4, w: 8, h: 8 }, 4);

  assert.deepEqual(px, before, "the whole pixel buffer must be untouched");
  for (let p = 0; p < W * H; p++) {
    assert.equal(px[p * 4 + 3], (p * 37) % 256, `alpha at pixel ${p} changed`);
  }
});
