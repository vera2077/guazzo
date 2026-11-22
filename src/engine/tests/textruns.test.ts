import assert from "node:assert/strict";
import { test } from "node:test";
import { runColour, runFont, runFontSize } from "../textruns.ts";
import { eq } from "./helpers.ts";

const base = { size: 24, color: [10, 20, 30] as const };

test("a run without an override uses the layer's size and colour", () => {
  eq(runFontSize({}, base), 24);
  assert.deepEqual(runColour({}, base), [10, 20, 30]);
});

test("a run's own size wins and is clamped to the model's range", () => {
  eq(runFontSize({ size: 48 }, base), 48);
  eq(runFontSize({ size: 0.4 }, base), 1);
  eq(runFontSize({ size: 4000 }, base), 1000);
  // a NaN would otherwise reach ctx.font and silently paint at 10px
  eq(runFontSize({ size: Number.NaN }, base), 24);
});

test("a run's own colour wins and is rounded into byte range", () => {
  assert.deepEqual(runColour({ color: [255, 0, 0] }, base), [255, 0, 0]);
  assert.deepEqual(runColour({ color: [-20, 300, 12.6] }, base), [0, 255, 13]);
});

test("the font string carries the run's size, not the layer's", () => {
  const f = runFont({ bold: true, italic: false, font: "Georgia", size: 48 }, base);
  eq(f, "bold 48px Georgia");
  eq(runFont({ bold: false, italic: true, font: "Arial" }, base), "italic 24px Arial");
});
