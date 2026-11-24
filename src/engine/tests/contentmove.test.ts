import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentMovePixels,
  contentRemovePixels,
  type CMRect,
} from "../contentmove.ts";

type RGBA = [number, number, number, number];

const W = 16;
const H = 16;
const BG: RGBA = [40, 80, 120, 255];
const INK: RGBA = [250, 10, 20, 255];
const BLOCK: CMRect = { x: 4, y: 4, w: 4, h: 4 };

function image(w: number, h: number, colour: RGBA): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = colour[0];
    px[i * 4 + 1] = colour[1];
    px[i * 4 + 2] = colour[2];
    px[i * 4 + 3] = colour[3];
  }
  return px;
}

function paint(
  px: Uint8ClampedArray, w: number, x: number, y: number,
  rw: number, rh: number, colour: RGBA,
): void {
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 4;
      px[i] = colour[0];
      px[i + 1] = colour[1];
      px[i + 2] = colour[2];
      px[i + 3] = colour[3];
    }
  }
}

function pixel(px: Uint8ClampedArray, w: number, x: number, y: number): RGBA {
  const i = (y * w + x) * 4;
  return [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
}

function same(c: RGBA, d: RGBA): boolean {
  return c[0] === d[0] && c[1] === d[1] && c[2] === d[2] && c[3] === d[3];
}

function dist(c: RGBA, d: RGBA): number {
  const dr = c[0] - d[0], dg = c[1] - d[1], db = c[2] - d[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function assertBytesEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): void {
  assert.equal(a.length, b.length, "buffers must have the same length");
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `byte ${i} differs`);
  }
}

test("contentMovePixels copies the block to the destination and vacates the source", () => {
  const px = image(W, H, BG);
  paint(px, W, BLOCK.x, BLOCK.y, BLOCK.w, BLOCK.h, INK);

  const out = contentMovePixels(px, W, H, BLOCK, 10, 10);
  assert.notStrictEqual(out, px, "must return a new buffer");

  // The distinctive block now lives at the destination, full RGBA included.
  for (let y = 10; y < 14; y++) {
    for (let x = 10; x < 14; x++) {
      assert.ok(same(pixel(out, W, x, y), INK), `destination ${x},${y} is not the moved block`);
    }
  }
  // No pixel of the original 4x4 location still holds the distinctive colour.
  for (let y = BLOCK.y; y < BLOCK.y + BLOCK.h; y++) {
    for (let x = BLOCK.x; x < BLOCK.x + BLOCK.w; x++) {
      assert.ok(!same(pixel(out, W, x, y), INK), `source ${x},${y} still holds the block`);
    }
  }
});

test("contentRemovePixels fills with surrounding-like pixels and leaves far pixels alone", () => {
  const px = image(W, H, BG);
  paint(px, W, BLOCK.x, BLOCK.y, BLOCK.w, BLOCK.h, INK);
  const farBefore = pixel(px, W, 15, 15);

  const out = contentRemovePixels(px, W, H, BLOCK);
  assert.notStrictEqual(out, px, "must return a new buffer");

  const centre = pixel(out, W, 6, 6);
  assert.ok(!same(centre, INK), "the centre must no longer be the original block");
  assert.ok(
    dist(centre, BG) < dist(centre, INK),
    `centre ${centre} should look more like the background than the removed block`,
  );
  assert.deepEqual(pixel(out, W, 15, 15), farBefore, "far-away pixel changed");
});

test("invalid and zero-size rects return a byte-identical copy", () => {
  const px = image(8, 8, BG);
  paint(px, 8, 2, 2, 3, 3, INK);

  const zero = contentMovePixels(px, 8, 8, { x: 2, y: 2, w: 0, h: 0 }, 3, 3);
  assert.notStrictEqual(zero, px);
  assertBytesEqual(zero, px);

  const negative = contentRemovePixels(px, 8, 8, { x: 2, y: 2, w: -4, h: 4 });
  assertBytesEqual(negative, px);

  const offCanvas = contentRemovePixels(px, 8, 8, { x: 20, y: 20, w: 4, h: 4 });
  assertBytesEqual(offCanvas, px);

  const nan = contentMovePixels(px, 8, 8, { x: NaN, y: 2, w: 4, h: 4 }, 3, 3);
  assertBytesEqual(nan, px);
});

test("repeated calls are deterministic", () => {
  const px = image(W, H, BG);
  paint(px, W, BLOCK.x, BLOCK.y, BLOCK.w, BLOCK.h, INK);

  assertBytesEqual(
    contentMovePixels(px, W, H, BLOCK, 10, 10),
    contentMovePixels(px, W, H, BLOCK, 10, 10),
  );
  assertBytesEqual(
    contentRemovePixels(px, W, H, BLOCK),
    contentRemovePixels(px, W, H, BLOCK),
  );
});

test("neither function mutates the input buffer", () => {
  const px = image(W, H, BG);
  paint(px, W, BLOCK.x, BLOCK.y, BLOCK.w, BLOCK.h, INK);
  const before = new Uint8ClampedArray(px);

  contentMovePixels(px, W, H, BLOCK, 10, 10);
  assertBytesEqual(px, before);

  contentRemovePixels(px, W, H, BLOCK);
  assertBytesEqual(px, before);
});
