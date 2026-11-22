import test from "node:test";
import assert from "node:assert";
import { eq } from "./helpers.ts";
import { Document } from "../document.ts";
import {
  DEFAULT_FILL_GRADIENT,
  fillGradientColourAt,
  fillGradientParam,
  normalizeFillGradient,
} from "../fillgradient.ts";

const red: [number, number, number] = [255, 0, 0];
const blue: [number, number, number] = [0, 0, 255];

test("normalizeFillGradient sorts by position and keeps both endpoints", () => {
  const g = normalizeFillGradient({ type: "linear", angle: 0, stops: [{ at: 1, color: blue }, { at: 0, color: red }] });
  eq(g.stops.length, 2);
  eq(g.stops[0]!.at, 0);
  eq(g.stops[1]!.at, 1);
});

test("normalizeFillGradient clamps channels and drops malformed stops", () => {
  const g = normalizeFillGradient({
    type: "radial",
    angle: 0,
    stops: [
      { at: 0, color: [300, -20, 12.6] },
      { at: 0.5, color: [-1, -1] as unknown as [number, number, number] },
      { at: 1, color: [0, 0, 255] },
    ],
  });
  // The malformed stop is gone; the surviving ones are rounded and clamped.
  eq(g.stops.length, 2);
  eq(g.stops[0]!.color[0], 255);
  eq(g.stops[0]!.color[1], 0);
  eq(g.stops[0]!.color[2], 13);
});

test("normalizeFillGradient falls back to the default with fewer than two stops", () => {
  const g = normalizeFillGradient({ type: "linear", angle: 0, stops: [{ at: 0.5, color: red }] });
  eq(g.stops.length, DEFAULT_FILL_GRADIENT.stops.length);
  eq(g.type, DEFAULT_FILL_GRADIENT.type);
});

test("normalizeFillGradient survives a missing or nonsense input", () => {
  for (const input of [undefined, null, 42, "gradient", {}, { stops: "x" }]) {
    const g = normalizeFillGradient(input as unknown);
    eq(g.stops.length, 2);
    eq(g.type, "linear");
  }
});

test("a linear gradient runs end to end and never leaves the [0,1] range", () => {
  const g = normalizeFillGradient({ type: "linear", angle: 0, stops: [{ at: 0, color: red }, { at: 1, color: blue }] });
  const left = fillGradientParam(g, 0, 50, 100, 100);
  const right = fillGradientParam(g, 99, 50, 100, 100);
  eq(left, 0);
  eq(right, 1);
  for (let x = 0; x < 100; x++) {
    const t = fillGradientParam(g, x, 50, 100, 100);
    assert.ok(t >= 0 && t <= 1, `param at x=${x} was ${t}`);
  }
  const mid = fillGradientColourAt(g, 50, 50, 100, 100);
  assert.ok(mid[0] > 0 && mid[0] < 255, "the midpoint is a blend, not an endpoint");
  assert.ok(mid[2] > 0 && mid[2] < 255, "the midpoint is a blend, not an endpoint");
});

test("a radial gradient is a disc: same colour at equal radius, corners past the edge", () => {
  const g = normalizeFillGradient({ type: "radial", angle: 0, stops: [{ at: 0, color: red }, { at: 1, color: blue }] });
  // 101 px wide so a pixel sits exactly on the centre (50,50); with 100 the
  // centre pixel is half a pixel off and the first stop is never sampled.
  const left = fillGradientParam(g, 0, 50, 101, 101);
  const right = fillGradientParam(g, 100, 50, 101, 101);
  const top = fillGradientParam(g, 50, 0, 101, 101);
  const bottom = fillGradientParam(g, 50, 100, 101, 101);
  eq(left, right);
  eq(left, top);
  eq(left, bottom);
  eq(fillGradientParam(g, 50, 50, 101, 101), 0);
  const centre = fillGradientColourAt(g, 50, 50, 101, 101);
  eq(centre[0], 255);
  eq(centre[2], 0);
  // A corner is further from the centre than an edge midpoint.
  assert.ok(fillGradientParam(g, 0, 0, 101, 101) > left);
});

test("angle 90 runs top to bottom, angle 0 runs left to right", () => {
  const horizontal = normalizeFillGradient({ type: "linear", angle: 0, stops: [{ at: 0, color: red }, { at: 1, color: blue }] });
  const vertical = normalizeFillGradient({ type: "linear", angle: 90, stops: [{ at: 0, color: red }, { at: 1, color: blue }] });
  // Angle 0 varies along x and not along y; angle 90 the other way around.
  eq(fillGradientParam(horizontal, 0, 10, 100, 100), fillGradientParam(horizontal, 0, 90, 100, 100));
  eq(fillGradientParam(vertical, 10, 0, 100, 100), fillGradientParam(vertical, 90, 0, 100, 100));
  assert.ok(fillGradientParam(vertical, 50, 0, 100, 100) < fillGradientParam(vertical, 50, 99, 100, 100));
});

test("stops do not have to start at 0 or end at 1", () => {
  const g = normalizeFillGradient({ type: "linear", angle: 0, stops: [{ at: 0.25, color: red }, { at: 0.75, color: blue }] });
  // Before the first stop and after the last, the colour is held, not extrapolated.
  eq(fillGradientColourAt(g, 0, 50, 100, 100)[0], 255);
  eq(fillGradientColourAt(g, 99, 50, 100, 100)[2], 255);
});

test("a gradient fill layer composites as a gradient, not a flat colour", () => {
  const doc = new Document(64, 32);
  doc.addFillLayer([0, 0, 0], "Grad", { type: "linear", angle: 0, stops: [{ at: 0, color: red }, { at: 1, color: blue }] });
  const px = doc.composite();
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * 64 + x) * 4;
    return [px[i]!, px[i + 1]!, px[i + 2]!];
  };
  const left = at(0, 16);
  const right = at(63, 16);
  assert.ok(left[0] > 240 && left[2] < 15, `left edge should be red, got ${left.join(",")}`);
  assert.ok(right[2] > 240 && right[0] < 15, `right edge should be blue, got ${right.join(",")}`);
  // A flat fill would make these equal; that is the regression this catches.
  assert.notDeepEqual(left, right);
});

test("the gradient is evaluated in document space, so a resize re-evaluates it", () => {
  const g = normalizeFillGradient({ type: "linear", angle: 0, stops: [{ at: 0, color: red }, { at: 1, color: blue }] });
  // Same document pixel, two canvas widths: a stretched bitmap would return the
  // same colour, a live fill returns the colour its new position implies.
  const narrow = fillGradientColourAt(g, 32, 16, 64, 32);
  const wide = fillGradientColourAt(g, 32, 16, 128, 32);
  assert.notDeepEqual(narrow, wide);
});
