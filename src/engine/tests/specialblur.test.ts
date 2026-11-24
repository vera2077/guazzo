/**
 * specialblur.test.ts — contract tests for the DOM-free specialty blur engine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  specialBlur,
  SPECIAL_BLUR_KINDS,
  type SpecialBlurKind,
} from "../specialblur.ts";
import { eq } from "./helpers.ts";

/** deterministic noise so the fixture never depends on Math.random */
function noise(w: number, h: number, seed = 0x1a2b3c4d): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s & 255;
  };
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    buf[o] = next();
    buf[o + 1] = next();
    buf[o + 2] = next();
    buf[o + 3] = next(); // varying alpha, which must survive every kernel
  }
  return buf;
}

const px = (_buf: Uint8ClampedArray, w: number, x: number, y: number): number =>
  (y * w + x) * 4;

test("all four kinds are exported and radius 0 returns a byte-identical new copy", () => {
  eq(SPECIAL_BLUR_KINDS.length, 4);
  assert.deepEqual([...SPECIAL_BLUR_KINDS], ["lens", "field", "iris", "tilt-shift"]);

  const w = 16, h = 16;
  for (const kind of SPECIAL_BLUR_KINDS) {
    const src = noise(w, h);
    const out = specialBlur(src, w, h, kind, 0);
    assert.notEqual(out, src, `${kind}: result must be a new buffer`);
    assert.deepEqual(out, src, `${kind}: radius 0 must be a byte-identical copy`);
    // a non-finite radius behaves as 0
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.deepEqual(specialBlur(src, w, h, kind, bad), src, `${kind}: ${bad}`);
    }
  }
});

test("an unknown kind returns a byte-identical new copy", () => {
  const w = 12, h = 10;
  const src = noise(w, h);
  const out = specialBlur(src, w, h, "not-a-kind" as SpecialBlurKind, 16);
  assert.notEqual(out, src);
  assert.deepEqual(out, src);
});

test("each kind changes RGB on a noise fixture and leaves alpha untouched", () => {
  const w = 32, h = 32;
  for (const kind of SPECIAL_BLUR_KINDS) {
    const src = noise(w, h, 0x51f00d + kind.length);
    const out = specialBlur(src, w, h, kind, 16);
    assert.notEqual(out, src);
    let changed = 0;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      eq(out[o + 3], src[o + 3]);
      if (out[o] !== src[o] || out[o + 1] !== src[o + 1] || out[o + 2] !== src[o + 2]) {
        changed++;
      }
    }
    assert.ok(changed > 0, `${kind}: expected RGB changes, got ${changed}`);
  }
});

test("repeated calls are identical and the source buffer is never mutated", () => {
  const w = 24, h = 20;
  const opts = { cx: 9, cy: 11, focusY: 10, band: 3, samples: 9 };
  for (const kind of SPECIAL_BLUR_KINDS) {
    const src = noise(w, h, 0xabcdef);
    const before = new Uint8ClampedArray(src);
    const a = specialBlur(src, w, h, kind, 13, opts);
    const b = specialBlur(src, w, h, kind, 13, opts);
    assert.deepEqual(a, b, `${kind}: deterministic`);
    assert.deepEqual(src, before, `${kind}: source must not be mutated`);
  }
});

test("tilt-shift keeps the focus band sharp but blurs the top and bottom rows", () => {
  const w = 32, h = 32;
  const focusY = 16, band = 5;
  const src = noise(w, h, 0x7a11b2);
  const out = specialBlur(src, w, h, "tilt-shift", 16, { focusY, band });

  for (const y of [15, 16, 17]) {
    for (let x = 0; x < w; x++) {
      const o = px(src, w, x, y);
      eq(out[o], src[o]);
      eq(out[o + 1], src[o + 1]);
      eq(out[o + 2], src[o + 2]);
    }
  }

  const changedInRow = (y: number): number => {
    let n = 0;
    for (let x = 0; x < w; x++) {
      const o = px(src, w, x, y);
      if (out[o] !== src[o] || out[o + 1] !== src[o + 1] || out[o + 2] !== src[o + 2]) n++;
    }
    return n;
  };
  assert.ok(changedInRow(0) >= w * 0.75, `top row should blur, got ${changedInRow(0)}/${w}`);
  assert.ok(changedInRow(h - 1) >= w * 0.75, `bottom row should blur, got ${changedInRow(h - 1)}/${w}`);
});

test("lens spreads a bright centre dot outward while keeping the centre", () => {
  const w = 32, h = 32, cx = 16, cy = 16;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) src[i * 4 + 3] = 255; // opaque black background
  const centre = px(src, w, cx, cy);
  src[centre] = 255; src[centre + 1] = 255; src[centre + 2] = 255;

  const out = specialBlur(src, w, h, "lens", 16, { cx, cy, samples: 12 });

  eq(out[centre], 255);
  const neighbour = px(src, w, cx + 1, cy);
  eq(src[neighbour], 0);
  assert.ok(out[neighbour]! > 0, `neighbour should gain brightness, got ${out[neighbour]}`);
});
