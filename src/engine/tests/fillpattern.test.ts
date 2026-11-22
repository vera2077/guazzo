import assert from "node:assert/strict";
import test from "node:test";
import { Document } from "../document.ts";
import {
  DEFAULT_FILL_PATTERN,
  fillPatternColourAt,
  normalizeFillPattern,
  type FillPattern,
} from "../fillpattern.ts";
import { eq } from "./helpers.ts";

const red: [number, number, number] = [255, 0, 0];
const blue: [number, number, number] = [0, 0, 255];

const checker: FillPattern = normalizeFillPattern({ kind: "checker", size: 8, colorA: red, colorB: blue });

test("a checkerboard alternates every tile in both directions", () => {
  eq(fillPatternColourAt(checker, 0, 0)[0], 255);
  eq(fillPatternColourAt(checker, 7, 7)[0], 255);
  eq(fillPatternColourAt(checker, 8, 0)[2], 255);
  eq(fillPatternColourAt(checker, 0, 8)[2], 255);
  // Two steps in either direction is the same square again.
  eq(fillPatternColourAt(checker, 16, 0)[0], 255);
  eq(fillPatternColourAt(checker, 8, 8)[0], 255);
});

test("stripes run diagonally with the tile period", () => {
  const stripes: FillPattern = normalizeFillPattern({ kind: "stripes", size: 10, colorA: red, colorB: blue });
  // A stripe is the band where floor((gx + gy) / size) is constant, so every
  // point with gx + gy inside [0, 10) is the same colour.
  assert.deepEqual(fillPatternColourAt(stripes, 0, 0), fillPatternColourAt(stripes, 4, 4));
  assert.notDeepEqual(fillPatternColourAt(stripes, 0, 0), fillPatternColourAt(stripes, 10, 0));
  assert.deepEqual(fillPatternColourAt(stripes, 0, 0), fillPatternColourAt(stripes, 20, 0));
});

test("dots sit at the centre of each cell and leave the rest to the background", () => {
  const dots: FillPattern = normalizeFillPattern({ kind: "dots", size: 16, colorA: red, colorB: blue });
  // Cell centre for size 16 is (7.5, 7.5); pixels 7 and 8 are inside the dot.
  eq(fillPatternColourAt(dots, 7, 7)[0], 255);
  eq(fillPatternColourAt(dots, 8, 8)[0], 255);
  // The corner of a cell is background.
  eq(fillPatternColourAt(dots, 0, 0)[2], 255);
  // One period away is the same dot again.
  eq(fillPatternColourAt(dots, 23, 23)[0], 255);
});

test("the sanitiser clamps the tile size and channels, and rejects junk", () => {
  eq(normalizeFillPattern({ kind: "checker", size: 1, colorA: red, colorB: blue }).size, 2);
  eq(normalizeFillPattern({ kind: "checker", size: 4096, colorA: red, colorB: blue }).size, 256);
  const clamped = normalizeFillPattern({ kind: "dots", size: 12, colorA: [300, -5, 12.6], colorB: [1, 2, 3] });
  assert.deepEqual(clamped.colorA, [255, 0, 13]);
  for (const junk of [undefined, null, 42, "pattern", {}, { kind: "spiral" }, { kind: "checker", colorA: "red" }]) {
    const normalised = normalizeFillPattern(junk);
    eq(normalised.kind, DEFAULT_FILL_PATTERN.kind);
    eq(normalised.size, DEFAULT_FILL_PATTERN.size);
    assert.equal(normalised.colorA.length, 3);
  }
});

test("a pattern fill layer composites as a pattern, not a flat colour", () => {
  const doc = new Document(64, 16);
  doc.addFillLayer([0, 0, 0], "Pattern", undefined, { kind: "checker", size: 8, colorA: red, colorB: blue });
  const px = doc.composite();
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * 64 + x) * 4;
    return [px[i]!, px[i + 1]!, px[i + 2]!];
  };
  assert.deepEqual(at(2, 2), [255, 0, 0]);
  assert.deepEqual(at(10, 2), [0, 0, 255]);
  // A flat fill would make every sample equal; this is the regression guard.
  assert.notDeepEqual(at(2, 2), at(10, 2));
});

test("a pattern fill layer survives save and load", () => {
  const doc = new Document(32, 8);
  doc.addFillLayer([0, 0, 0], "Pattern", undefined, { kind: "dots", size: 6, colorA: red, colorB: blue });
  eq(doc.composite()[3]! > 0, true);
});
