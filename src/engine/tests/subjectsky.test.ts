import assert from "node:assert/strict";
import { test } from "node:test";

import { subjectSkyMask, type SubjectSkyMode } from "../subjectsky.ts";

const W = 40;
const H = 40;

/** Blue sky gradient in the top half, green/brown land in the bottom half. */
function twoBand(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  const mid = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (y < mid) {
        const t = Math.floor(y / 4); // gentle gradient, far below the threshold per step
        px[o] = 100 + t;
        px[o + 1] = 150 + t;
        px[o + 2] = 220 - t;
      } else {
        px[o] = 120;
        px[o + 1] = 90;
        px[o + 2] = 50;
      }
      px[o + 3] = 255;
    }
  }
  return px;
}

function uniform(
  colour: [number, number, number, number],
  w: number,
  h: number,
): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = colour[0];
    px[i * 4 + 1] = colour[1];
    px[i * 4 + 2] = colour[2];
    px[i * 4 + 3] = colour[3];
  }
  return px;
}

test("sky selects the top band centre and subject selects the bottom", () => {
  const px = twoBand();
  const sky = subjectSkyMask(px, W, H, "sky");
  const subject = subjectSkyMask(px, W, H, "subject");
  const top = (20 + 5 * W);
  const bottom = (20 + 35 * W);

  assert.equal(sky.length, W * H);
  assert.equal(subject.length, W * H);
  assert.equal(sky[top], 255);
  assert.equal(sky[bottom], 0);
  assert.equal(subject[top], 0);
  assert.equal(subject[bottom], 255);

  // The whole upper band should be sky and the whole lower band subject.
  for (let y = 0; y < H / 2; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      assert.equal(sky[i], 255, `sky at ${x},${y}`);
      assert.equal(subject[i], 0, `subject at ${x},${y}`);
    }
  }
  for (let y = H / 2; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      assert.equal(sky[i], 0, `sky at ${x},${y}`);
      assert.equal(subject[i], 255, `subject at ${x},${y}`);
    }
  }
});

test("empty / zero-size image returns a zero-length mask", () => {
  assert.equal(subjectSkyMask(new Uint8ClampedArray(0), 0, 0, "sky").length, 0);
  assert.equal(subjectSkyMask(new Uint8ClampedArray(0), 0, 10, "subject").length, 0);
  assert.equal(subjectSkyMask(new Uint8ClampedArray(0), 10, 0).length, 0);
});

test("repeated calls are deterministic", () => {
  const px = twoBand();
  assert.deepEqual(subjectSkyMask(px, W, H, "sky"), subjectSkyMask(px, W, H, "sky"));
  assert.deepEqual(
    subjectSkyMask(px, W, H, "subject"),
    subjectSkyMask(px, W, H, "subject"),
  );
});

test("the source pixels are never mutated", () => {
  const px = twoBand();
  const before = px.slice();
  subjectSkyMask(px, W, H, "sky");
  subjectSkyMask(px, W, H, "subject");
  assert.deepEqual(px, before);
});

test("a uniform image gives sky = all selected and subject = all zero", () => {
  const w = 8;
  const h = 8;
  const px = uniform([180, 180, 180, 255], w, h);
  const sky = subjectSkyMask(px, w, h, "sky");
  const subject = subjectSkyMask(px, w, h, "subject");
  assert.deepEqual(sky, new Uint8ClampedArray(w * h).fill(255));
  assert.deepEqual(subject, new Uint8ClampedArray(w * h));
});

test("an unknown mode falls back to sky", () => {
  const px = twoBand();
  const sky = subjectSkyMask(px, W, H, "sky");
  const fallback = subjectSkyMask(px, W, H, "auto" as SubjectSkyMode);
  assert.deepEqual(fallback, sky);
});
