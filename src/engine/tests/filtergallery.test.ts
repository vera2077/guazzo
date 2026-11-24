import { test } from "node:test";
import assert from "node:assert/strict";

import { galleryFilter, GALLERY_KINDS, type GalleryKind } from "../filtergallery.ts";

const W = 8;
const H = 8;

/** Deterministic, varied 8x8 RGBA fixture, including non-opaque alpha values. */
function variedFixture(): Uint8ClampedArray {
  const src = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      src[p] = (x * 31 + y * 17) % 256;
      src[p + 1] = (x * 13 + y * 47 + 60) % 256;
      src[p + 2] = (x * 7 + y * 29 + 120) % 256;
      src[p + 3] = (x * 23 + y * 11) % 256;
    }
  }
  return src;
}

test("amount 0 returns a byte-identical copy for every kind", () => {
  const src = variedFixture();
  for (const kind of GALLERY_KINDS) {
    const out = galleryFilter(src, W, H, kind, 0);
    assert.notStrictEqual(out, src, `${kind} must return a new buffer`);
    assert.deepEqual(out, src, `${kind} at amount 0 must be byte-identical`);
  }
  // A non-finite amount is clamped to 0, so it also yields an identical copy.
  assert.deepEqual(galleryFilter(src, W, H, "poster-edges", Number.NaN), src);
});

test("unknown kind returns a byte-identical copy", () => {
  const src = variedFixture();
  const out = galleryFilter(src, W, H, "not-a-filter" as GalleryKind, 100);
  assert.notStrictEqual(out, src, "must still return a new buffer");
  assert.deepEqual(out, src, "unknown kind must be a byte-identical copy");
});

test("each kind changes at least one RGB byte on a varied fixture and leaves alpha untouched", () => {
  const src = variedFixture();
  const original = variedFixture();
  for (const kind of GALLERY_KINDS) {
    const out = galleryFilter(src, W, H, kind, 100);
    let changed = false;
    for (let i = 0; i < src.length; i++) {
      if (i % 4 === 3) {
        assert.equal(out[i], src[i], `${kind} changed alpha at byte ${i}`);
      } else if (out[i] !== src[i]) {
        changed = true;
      }
    }
    assert.ok(changed, `${kind} must change at least one RGB byte`);
  }
  assert.deepEqual(src, original, "the source buffer must never be mutated");
});

test("calling twice with the same input gives identical bytes", () => {
  const src = variedFixture();
  for (const kind of GALLERY_KINDS) {
    const a = galleryFilter(src, W, H, kind, 63);
    const b = galleryFilter(src, W, H, kind, 63);
    assert.deepEqual(a, b, `${kind} must be deterministic`);
  }
});

test("poster-edges darkens pixels near a vertical black/white edge", () => {
  const w = 8;
  const h = 8;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const value = x >= 4 ? 255 : 0;
      src[p] = value;
      src[p + 1] = value;
      src[p + 2] = value;
      src[p + 3] = 255;
    }
  }
  const out = galleryFilter(src, w, h, "poster-edges", 100);
  const near = out[(4 * w + 4) * 4]!; // first white column (x=4), middle row (y=4)
  const far = out[(4 * w + 7) * 4]!; // last white column (x=7), middle row (y=4)
  assert.ok(near < far, `near-edge white pixel (${near}) should be darker than far white pixel (${far})`);
  assert.equal(far, 255, "a white pixel far from the edge should remain white");
  assert.equal(out[(4 * w + 4) * 4 + 3]!, 255, "alpha must be untouched");
});
