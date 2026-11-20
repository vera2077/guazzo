import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneRecipe, recipeAfterMove, recipeAfterScale, recipeAfterTransform } from "../textmap.ts";
import type { TextRecipe } from "../textmap.ts";

function recipe(over: Partial<TextRecipe> = {}): TextRecipe {
  return {
    lines: [[{ text: "hi", font: "Arial", bold: false, italic: false, underline: false, strike: false }]],
    x: 100, y: 50, w: 80, h: 20, size: 10, color: [255, 255, 255],
    wrap: 200, boxH: 60,
    ...over,
  };
}

test("AP5: scale moves wrap and boxH with the document", () => {
  const out = recipeAfterScale(recipe(), 2, 2);
  assert.equal(out.x, 200);
  assert.equal(out.y, 100);
  assert.equal(out.w, 160);
  assert.equal(out.h, 40);
  assert.equal(out.wrap, 400);   // was left at 200 before the fix
  assert.equal(out.boxH, 120);
  assert.equal(out.size, 20);
});

test("AP5: an anisotropic scale uses each axis for its own quantity", () => {
  const out = recipeAfterScale(recipe(), 2, 0.5);
  assert.equal(out.wrap, 400);
  assert.equal(out.boxH, 30);
  assert.equal(Math.round(out.size * 100) / 100, 10); // sqrt(2*0.5) === 1
});

test("AP5: move translates the recipe without touching its size", () => {
  const out = recipeAfterMove(recipe(), -12, 7);
  assert.equal(out.x, 88);
  assert.equal(out.y, 57);
  assert.equal(out.wrap, 200);
  assert.equal(out.h, 20);
});

test("AP5: Free Transform scales about the box centre and translates", () => {
  const m = recipe();
  const centre = { x: 140, y: 60 };
  const out = recipeAfterTransform(m, { angleDeg: 0, scaleX: 2, scaleY: 2, dx: 10, dy: -5 }, centre);
  assert.ok(out);
  assert.equal(out!.x, centre.x + (m.x - centre.x) * 2 + 10); // 40 + 10
  assert.equal(out!.y, centre.y + (m.y - centre.y) * 2 - 5); // 40 - 5
  assert.equal(out!.wrap, 400);
  assert.equal(out!.boxH, 120);
});

test("AP5: a rotation or a mirror drops the recipe instead of lying", () => {
  assert.equal(recipeAfterTransform(recipe(), { angleDeg: 90, scaleX: 1, scaleY: 1, dx: 0, dy: 0 }, { x: 0, y: 0 }), undefined);
  assert.equal(recipeAfterTransform(recipe(), { angleDeg: 0, scaleX: -1, scaleY: 1, dx: 0, dy: 0 }, { x: 0, y: 0 }), undefined);
  assert.equal(recipeAfterTransform(recipe(), { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 0, dy: 0 }, null), undefined);
});

test("AP5: cloneRecipe is deep enough to edit without aliasing", () => {
  const m = recipe();
  const c = cloneRecipe(m);
  c.lines[0]![0]!.text = "bye";
  assert.equal(m.lines[0]![0]!.text, "hi");
});
