import { test } from "node:test";
import assert from "node:assert/strict";

import { Document } from "../document.ts";
import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import { drawShape, shapePolyline, shapeSelection } from "../shapes.ts";
import { flip, rotate90, rotate180, trimBounds } from "../imageops.ts";

function eq(actual: unknown, expected: unknown): void {
  assert.strictEqual(actual, expected);
}

function px(g: TileGrid, x: number, y: number): [number, number, number, number] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

function docWith(w: number, h: number, paint: (g: TileGrid) => void): Document {
  const doc = new Document(w, h);
  doc.layers.length = 0;
  const layer = doc.addLayer("L");
  paint(layer.grid);
  return doc;
}

test("a filled rectangle covers exactly its rect and antialiases nothing", () => {
  const g = new TileGrid(40, 40);
  drawShape(g, { kind: "rectangle", x0: 10, y0: 12, x1: 20, y1: 22, fill: [255, 0, 0] });
  eq(px(g, 15, 17)[0], 255);
  eq(px(g, 15, 17)[3], 255);
  eq(px(g, 10, 12)[3], 255); // corners are inside
  eq(px(g, 9, 17)[3], 0); // outside untouched
  eq(px(g, 21, 17)[3], 0);
});

test("an ellipse is round: corners empty, mid-edges filled", () => {
  const g = new TileGrid(40, 40);
  drawShape(g, { kind: "ellipse", x0: 5, y0: 5, x1: 35, y1: 35, fill: [0, 128, 255] });
  eq(px(g, 20, 20)[3], 255);
  eq(px(g, 6, 6)[3], 0); // bounding-box corner is outside the ellipse
  eq(px(g, 20, 4)[3], 0); // just above the ellipse
  assert.ok(px(g, 20, 6)[3] > 200, "inside near the top should be covered");
  // somewhere on the rim the coverage must be partial (that is the antialiasing)
  let partial = 0;
  for (let x = 5; x <= 35; x++) {
    for (let y = 5; y <= 35; y++) {
      const a = px(g, x, y)[3];
      if (a > 0 && a < 255) partial++;
    }
  }
  assert.ok(partial > 0, "the ellipse rim should be antialiased");
});

test("a polygon with 4 sides looks like a diamond", () => {
  const g = new TileGrid(40, 40);
  drawShape(g, { kind: "polygon", sides: 4, x0: 5, y0: 5, x1: 35, y1: 35, fill: [10, 200, 10] });
  eq(px(g, 20, 20)[3], 255);
  eq(px(g, 6, 6)[3], 0); // corners cut off
});

test("a star has a hollow between its points", () => {
  const g = new TileGrid(60, 60);
  drawShape(g, { kind: "star", sides: 5, innerRatio: 0.4, x0: 5, y0: 5, x1: 55, y1: 55, fill: [255, 200, 0] });
  eq(px(g, 30, 30)[3], 255); // centre
  // a star must leave hollows between its points; find at least one
  let hollow = 0;
  for (let x = 5; x <= 55; x++) {
    for (let y = 5; y <= 55; y++) {
      if (px(g, x, y)[3] === 0) hollow++;
    }
  }
  assert.ok(hollow > 100, `star should have hollows, found ${hollow} empty pixels`);
});

test("a line uses strokeWidth as its thickness", () => {
  const g = new TileGrid(40, 40);
  drawShape(g, { kind: "line", x0: 5, y0: 20, x1: 35, y1: 20, strokeWidth: 6, fill: [0, 0, 0] });
  eq(px(g, 20, 20)[3], 255);
  eq(px(g, 20, 22)[3], 255);
  eq(px(g, 20, 30)[3], 0);
  eq(px(g, 20, 16)[3], 0);
});

test("a stroke is drawn only around the outline", () => {
  const g = new TileGrid(40, 40);
  drawShape(g, {
    kind: "rectangle", x0: 10, y0: 10, x1: 30, y1: 30,
    fill: [200, 200, 200], fillAlpha: 0, stroke: [255, 0, 0], strokeWidth: 2,
  });
  assert.ok(px(g, 10, 20)[0] > 150, "left edge should be stroked red");
  eq(px(g, 20, 20)[3], 0); // interior stays empty because fillAlpha is 0
});

test("shape drawing respects a selection mask", () => {
  const g = new TileGrid(40, 40);
  const mask = new SelectionMask(40, 40);
  mask.selectRect(0, 0, 20, 40);
  drawShape(g, { kind: "rectangle", x0: 0, y0: 0, x1: 40, y1: 40, fill: [0, 0, 255], mask });
  eq(px(g, 5, 20)[3], 255);
  eq(px(g, 25, 20)[3], 0);
});

test("shapeSelection fills the same area as the shape", () => {
  const m = new SelectionMask(40, 40);
  shapeSelection(40, 40, { kind: "ellipse", x0: 5, y0: 5, x1: 35, y1: 35 }, m);
  eq(m.alphaAt(20, 20), 255);
  eq(m.alphaAt(6, 6), 0);
});

test("rotate90 clockwise moves the top-left pixel to the top-right", () => {
  const src = docWith(6, 4, (g) => g.fillRect(0, 0, 2, 1, [255, 0, 0, 255]));
  const out = rotate90(src, 1);
  eq(out.width, 4);
  eq(out.height, 6);
  // (0,0) → (h-1-0, 0) = (3, 0)
  eq(px(out.layers[0]!.grid, 3, 0)[0], 255);
  eq(px(out.layers[0]!.grid, 0, 0)[0], 0);
});

test("rotate90 counter-clockwise moves it to the bottom-left", () => {
  const src = docWith(6, 4, (g) => g.fillRect(0, 0, 2, 1, [0, 255, 0, 255]));
  const out = rotate90(src, -1);
  // (0,0) → (0, w-1-0) = (0, 5)
  eq(px(out.layers[0]!.grid, 0, 5)[1], 255);
  eq(px(out.layers[0]!.grid, 0, 0)[1], 0);
});

test("rotate180 twice returns the original pixels", () => {
  const src = docWith(8, 6, (g) => {
    g.fillRect(1, 1, 2, 2, [10, 20, 30, 255]);
    g.fillRect(5, 4, 1, 1, [200, 100, 50, 255]);
  });
  const round = rotate180(rotate180(src));
  assert.deepEqual(Array.from(round.composite()), Array.from(src.composite()));
});

test("flip horizontal mirrors the pixels and keeps the dimensions", () => {
  const src = docWith(8, 4, (g) => g.fillRect(0, 0, 2, 4, [255, 0, 0, 255]));
  const out = flip(src, "horizontal");
  eq(out.width, 8);
  eq(px(out.layers[0]!.grid, 7, 1)[0], 255);
  eq(px(out.layers[0]!.grid, 0, 1)[0], 0);
});

test("flip vertical mirrors the rows", () => {
  const src = docWith(4, 8, (g) => g.fillRect(0, 0, 4, 2, [0, 0, 255, 255]));
  const out = flip(src, "vertical");
  eq(px(out.layers[0]!.grid, 1, 7)[2], 255);
  eq(px(out.layers[0]!.grid, 1, 0)[2], 0);
});

test("trim finds the non-uniform rectangle and refuses a blank canvas", () => {
  const w = 10, h = 10;
  const px4 = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px4.length; i += 4) {
    px4[i] = 255; px4[i + 1] = 255; px4[i + 2] = 255; px4[i + 3] = 255;
  }
  for (let y = 3; y < 7; y++) {
    for (let x = 2; x < 8; x++) {
      const i = (y * w + x) * 4;
      px4[i] = 0; px4[i + 1] = 0; px4[i + 2] = 0;
    }
  }
  const box = trimBounds(px4, w, h);
  assert.ok(box);
  eq(box!.x, 2);
  eq(box!.y, 3);
  eq(box!.w, 6);
  eq(box!.h, 4);
  // a completely uniform image has nothing to trim
  const blank = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < blank.length; i += 4) blank[i + 3] = 255;
  eq(trimBounds(blank, w, h), null);
});

test("shapePolyline exposes the same geometry the rasteriser uses", () => {
  eq(shapePolyline({ kind: "rectangle", x0: 0, y0: 0, x1: 10, y1: 10 }), null);
  eq(shapePolyline({ kind: "ellipse", x0: 0, y0: 0, x1: 10, y1: 10 }), null);
  const poly = shapePolyline({ kind: "polygon", x0: 0, y0: 0, x1: 20, y1: 20, sides: 5 });
  eq(poly?.length, 5);
  const star = shapePolyline({ kind: "star", x0: 0, y0: 0, x1: 20, y1: 20, sides: 6, innerRatio: 0.4 });
  eq(star?.length, 12);
});
