import { test } from "node:test";
import { TileGrid } from "../tile.ts";
import { fillGradient, type GradientSpec } from "../gradient.ts";
import { eq } from "./helpers.ts";

// @types/node types strictEqual as asserts actual is T, which narrows
// closure-mutated lets to literal types on later asserts. unknown params
// defeat the narrowing — use eq(), never assert.equal on mutated lets.
function px(g: TileGrid, x: number, y: number): number[] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [...out];
}

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const TRANSPARENT_RED = { r: 255, g: 0, b: 0, a: 0 };

test("linear gradient lands on exact interpolated colors", () => {
  const g = new TileGrid(4, 2);
  const spec: GradientSpec = {
    kind: "linear",
    from: { x: 0, y: 0, c: RED },
    to: { x: 4, y: 0, c: BLUE },
  };
  fillGradient(g, 0, 0, 4, 2, spec);
  // pixel centers x = 0.5, 1.5, 2.5, 3.5 → u = 0.125, 0.375, 0.625, 0.875
  // red = 255·(1−u): 223.125→223, 159.375→159, 95.625→96, 31.875→32
  // blue = 255·u:    31.875→32,  95.625→96,  159.375→159, 223.125→223
  eq(px(g, 0, 0).join(), "223,0,32,255");
  eq(px(g, 1, 0).join(), "159,0,96,255");
  eq(px(g, 2, 1).join(), "96,0,159,255");
  eq(px(g, 3, 1).join(), "32,0,223,255");
});

test("gradient to transparent composites correctly over empty pixels", () => {
  const g = new TileGrid(4, 1);
  fillGradient(g, 0, 0, 4, 1, {
    kind: "linear",
    from: { x: 0, y: 0, c: RED },
    to: { x: 4, y: 0, c: TRANSPARENT_RED },
  });
  // pixel x=2 center 2.5 → u = 0.625 → sa = 95.625 → out alpha 96
  eq(px(g, 2, 0).join(), "255,0,0,96");
  // u = 0.875 at the far end: mostly transparent but still red hue
  const p = px(g, 3, 0);
  const a3 = p[3] ?? 0;
  eq(p.join(",").startsWith("255,0,0,"), true);
  eq(a3 > 0 && a3 < 64, true);
});

test("radial gradient: center is from-color, beyond radius is to-color", () => {
  const g = new TileGrid(10, 5);
  fillGradient(g, 0, 0, 10, 5, {
    kind: "radial",
    from: { x: 2, y: 2, c: RED },
    to: { x: 6, y: 2, c: BLUE },
  });
  // pixel (2,2) center is (2.5,2.5): dist = √0.5, u = √0.5/4 ≈ 0.1768
  // → r = 255·(1−u) = 209.97 → 210, b = 255·u = 45.08 → 45
  eq(px(g, 2, 2).join(), "210,0,45,255");
  // pixel (8,2): distance ≈ 6.5 > radius 4 → clamped to to color
  eq(px(g, 8, 2).join(), "0,0,255,255");
});

test("fill respects the target rect", () => {
  const g = new TileGrid(4, 1);
  fillGradient(g, 0, 0, 2, 1, {
    kind: "linear",
    from: { x: 0, y: 0, c: RED },
    to: { x: 4, y: 0, c: BLUE },
  });
  eq(g.allocated, 1);
  eq(px(g, 1, 0)[3], 255); // inside rect
  eq(px(g, 2, 0).join(), "0,0,0,0"); // outside rect untouched
  eq(px(g, 3, 0).join(), "0,0,0,0");
});

test("degenerate from==to renders the solid from color", () => {
  const g = new TileGrid(2, 1);
  fillGradient(g, 0, 0, 2, 1, {
    kind: "linear",
    from: { x: 1, y: 0, c: RED },
    to: { x: 1, y: 0, c: BLUE },
  });
  eq(px(g, 0, 0).join(), "255,0,0,255");
  eq(px(g, 1, 0).join(), "255,0,0,255");
});
