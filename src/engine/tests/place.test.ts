/**
 * place.test.ts — dropped images fit, centre, and never enlarge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { placeRect } from "../place.ts";

test("an image smaller than the document is centred at full size", () => {
  const r = placeRect(100, 50, 800, 600);
  assert.deepEqual(r, { x: 350, y: 275, w: 100, h: 50, scale: 1 });
});

test("an image larger than the document is scaled down to fit", () => {
  const r = placeRect(1600, 900, 800, 600);
  assert.equal(r.w, 800);
  assert.equal(r.h, 450);
  assert.equal(r.x, 0);
  assert.equal(r.y, 75);
  assert.ok(r.scale < 1);
});

test("the wider axis decides the scale", () => {
  // portrait image in a landscape document: height fits first
  const r = placeRect(400, 1600, 800, 800);
  assert.equal(r.h, 800);
  assert.equal(r.w, 200);
  assert.equal(r.x, 300);
  assert.equal(r.y, 0);
});

test("an exact fit is a copy, not a resample", () => {
  const r = placeRect(640, 480, 640, 480);
  assert.deepEqual(r, { x: 0, y: 0, w: 640, h: 480, scale: 1 });
});

test("degenerate sizes are clamped to one pixel rather than dividing by zero", () => {
  const r = placeRect(0, 0, 100, 100);
  assert.deepEqual(r, { x: 49, y: 49, w: 1, h: 1, scale: 1 });
});
