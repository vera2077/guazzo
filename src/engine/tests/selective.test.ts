/**
 * selective.test.ts — Selective Colour's weights and ink maths.
 *
 * Two things can go wrong here and neither throws: a range that claims
 * pixels it should not own (so editing Reds moves the sky), and relative
 * mode adding a flat percentage instead of a share of the ink already on
 * the page. Both are asserted numerically rather than by eye.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applySelective, normalizeSelective, selectiveIsIdentity, selectiveWeights, type SelectiveSettings } from "../selective.ts";

const { eq } = await import("./helpers.ts");

function spec(ranges: SelectiveSettings["ranges"], mode: SelectiveSettings["mode"] = "absolute"): SelectiveSettings {
  return { mode, ranges };
}

test("a saturated hue belongs to the range under it and not to its neighbours", () => {
  const red = selectiveWeights(255, 0, 0);
  eq(Math.round(red.reds * 100), 100);
  eq(Math.round(red.yellows * 100), 0);
  eq(Math.round(red.magentas * 100), 0);

  const yellow = selectiveWeights(255, 255, 0);
  eq(Math.round(yellow.yellows * 100), 100);
  eq(Math.round(yellow.reds * 100), 0);

  const blue = selectiveWeights(0, 0, 255);
  eq(Math.round(blue.blues * 100), 100);
});

test("a hue exactly between two centres splits its weight evenly", () => {
  // 30° is halfway between reds (0°) and yellows (60°).
  const orange = selectiveWeights(255, 128, 0);
  assert.ok(Math.abs(orange.reds - 0.5) < 0.05, `reds ${orange.reds}`);
  assert.ok(Math.abs(orange.yellows - 0.5) < 0.05, `yellows ${orange.yellows}`);
});

test("greys belong to the tone ranges, not the hue ranges", () => {
  const mid = selectiveWeights(128, 128, 128);
  for (const range of ["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const) {
    eq(Math.round(mid[range] * 1000) / 1000, 0);
  }
  assert.ok(mid.neutrals > 0.5, `neutrals ${mid.neutrals}`);

  const white = selectiveWeights(255, 255, 255);
  assert.ok(white.whites > 0.99, `whites ${white.whites}`);

  const black = selectiveWeights(0, 0, 0);
  assert.ok(black.blacks > 0.99, `blacks ${black.blacks}`);
});

test("absolute mode moves the ink a flat amount", () => {
  // +50 % cyan on reds: red is 0 % cyan already, so absolute adds 0.5.
  const [r, g, b] = applySelective(255, 0, 0, spec({ reds: { c: 50, m: 0, y: 0, k: 0 } }, "absolute"));
  assert.ok(Math.abs(r - 128) <= 1, `red ${r}`);
  eq(g, 0);
  eq(b, 0);
});

test("relative mode scales the ink that is already there", () => {
  // (128,255,255) is 50 % cyan; +50 % relative brings it to 75 %.
  const [r, g, b] = applySelective(128, 255, 255, spec({ cyans: { c: 50, m: 0, y: 0, k: 0 } }, "relative"));
  assert.ok(Math.abs(r - 64) <= 1, `red ${r}`);
  eq(g, 255);
  eq(b, 255);
});

test("an empty recipe changes nothing, and identity is recognised", () => {
  const empty: SelectiveSettings = { mode: "relative", ranges: {} };
  assert.ok(selectiveIsIdentity(empty));
  assert.deepEqual(applySelective(12, 200, 77, empty), [12, 200, 77]);
  assert.ok(!selectiveIsIdentity(spec({ blues: { c: 1, m: 0, y: 0, k: 0 } })));
});

test("normalizeSelective clamps, drops junk and defaults the mode", () => {
  const got = normalizeSelective({
    mode: "nonsense",
    ranges: {
      reds: { c: 500, m: -500, y: 12.34, k: "x" },
      blues: { c: 10 },
      greens: 42,
    },
  });
  eq(got.mode, "relative");
  eq(got.ranges.reds?.c, 100);
  eq(got.ranges.reds?.m, -100);
  eq(got.ranges.reds?.y, 12.3);
  eq(got.ranges.reds?.k, 0);
  eq(got.ranges.blues?.c, 10);
  eq(got.ranges.blues?.m, 0);
  eq(got.ranges.greens, undefined);
  assert.ok(selectiveIsIdentity(normalizeSelective(undefined)));
});
