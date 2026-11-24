/**
 * textlayout.test.ts — quarter-turn rotation and bending a glyph along a
 * polyline. Pure, DOM-free, deterministic behaviour only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rotateRaster, placeRasterOnPath, type Raster } from "../textlayout.ts";

type RGBA = readonly [number, number, number, number];

function makeRaster(
  cw: number,
  ch: number,
  fill: (x: number, y: number) => RGBA,
): Raster {
  const rgba = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      const [r, g, b, a] = fill(x, y);
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return { rgba, cw, ch };
}

function pixelAt(r: Raster, x: number, y: number): RGBA {
  const i = (y * r.cw + x) * 4;
  return [r.rgba[i]!, r.rgba[i + 1]!, r.rgba[i + 2]!, r.rgba[i + 3]!];
}

function opaqueCoords(r: Raster): string[] {
  const out: string[] = [];
  for (let y = 0; y < r.ch; y++) {
    for (let x = 0; x < r.cw; x++) {
      if (pixelAt(r, x, y)[3] > 0) out.push(`${x},${y}`);
    }
  }
  return out;
}

test("1. rotateRaster 90/-90/180 map corner pixels correctly on a 3x2 raster", () => {
  // R encodes the source cell index so corners are unambiguous.
  const src = makeRaster(3, 2, (x, y) => {
    const idx = y * 3 + x;
    return [idx + 1, 0, 0, 255 - idx];
  });

  // 90° clockwise -> 2x3: source top-left goes to output top-right.
  const cw = rotateRaster(src, 90);
  assert.equal(cw.cw, 2);
  assert.equal(cw.ch, 3);
  assert.equal(pixelAt(cw, 0, 0)[0], 4); // <- src(0,1)
  assert.equal(pixelAt(cw, 1, 0)[0], 1); // <- src(0,0)
  assert.equal(pixelAt(cw, 0, 2)[0], 6); // <- src(2,1)
  assert.equal(pixelAt(cw, 1, 2)[0], 3); // <- src(2,0)

  // -90° counter-clockwise -> 2x3: source top-left goes to output bottom-left.
  const ccw = rotateRaster(src, -90);
  assert.equal(ccw.cw, 2);
  assert.equal(ccw.ch, 3);
  assert.equal(pixelAt(ccw, 0, 0)[0], 3); // <- src(2,0)
  assert.equal(pixelAt(ccw, 1, 0)[0], 6); // <- src(2,1)
  assert.equal(pixelAt(ccw, 0, 2)[0], 1); // <- src(0,0)
  assert.equal(pixelAt(ccw, 1, 2)[0], 4); // <- src(0,1)

  // 180° -> same size: both axes reversed.
  const half = rotateRaster(src, 180);
  assert.equal(half.cw, 3);
  assert.equal(half.ch, 2);
  assert.equal(pixelAt(half, 0, 0)[0], 6); // <- src(2,1)
  assert.equal(pixelAt(half, 2, 0)[0], 4); // <- src(0,1)
  assert.equal(pixelAt(half, 0, 1)[0], 3); // <- src(2,0)
  assert.equal(pixelAt(half, 2, 1)[0], 1); // <- src(0,0)
});

test("2. rotateRaster never mutates input and preserves alpha", () => {
  const src = makeRaster(3, 2, (x, y) => {
    const idx = y * 3 + x;
    return [10 + idx, 20 + idx, 30 + idx, 200 + idx];
  });
  const before = new Uint8ClampedArray(src.rgba);

  for (const degrees of [90, -90, 180] as const) {
    const out = rotateRaster(src, degrees);
    // Input untouched, output buffer independent.
    assert.deepEqual(src.rgba, before);
    assert.equal(src.cw, 3);
    assert.equal(src.ch, 2);
    assert.notEqual(out.rgba, src.rgba);

    // Every output alpha is exactly the alpha of the sampled source cell.
    for (let oy = 0; oy < out.ch; oy++) {
      for (let ox = 0; ox < out.cw; ox++) {
        let sx: number;
        let sy: number;
        if (degrees === 90) {
          sx = oy;
          sy = src.ch - 1 - ox;
        } else if (degrees === -90) {
          sx = src.cw - 1 - oy;
          sy = ox;
        } else {
          sx = src.cw - 1 - ox;
          sy = src.ch - 1 - oy;
        }
        assert.equal(pixelAt(out, ox, oy)[3], pixelAt(src, sx, sy)[3]);
      }
    }
  }
});

test("3. placeRasterOnPath on a horizontal 2-point path places glyph pixels and is deterministic", () => {
  const src = makeRaster(4, 3, (x, y) => [x * 10 + 1, y * 10 + 1, 7, 255]);
  const anchors = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
  ];
  const out = placeRasterOnPath(src, anchors);

  // Path span 5 wide, 0 tall, plus ch=3 padding on each dimension.
  assert.equal(out.cw, 5 + 3);
  assert.equal(out.ch, 0 + 3);

  // Along y=0 the glyph advances one source column per unit of arc length:
  // output column (1 + j) samples source cell (j, 1).
  for (let j = 0; j < 4; j++) {
    assert.deepEqual(pixelAt(out, 1 + j, 1), pixelAt(src, j, 1));
  }
  assert.ok(opaqueCoords(out).length > 0, "glyph pixels laid down along the line");

  // Same inputs -> byte-identical output.
  const again = placeRasterOnPath(src, anchors);
  assert.deepEqual(again.rgba, out.rgba);
  assert.deepEqual([again.cw, again.ch], [out.cw, out.ch]);
});

test("4. invalid anchors (fewer than 2 points, zero length) return a copy", () => {
  const src = makeRaster(2, 2, (x, y) => [x + 1, y + 1, 3, 255]);

  const cases: Array<Parameters<typeof placeRasterOnPath>[1]> = [
    [],
    [{ x: 0, y: 0 }],
    [
      { x: 3, y: 4 },
      { x: 3, y: 4 },
    ], // zero length: no distinct points
    [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ],
  ];
  for (const anchors of cases) {
    const out = placeRasterOnPath(src, anchors);
    assert.equal(out.cw, src.cw);
    assert.equal(out.ch, src.ch);
    assert.deepEqual(out.rgba, src.rgba);
    assert.notEqual(out.rgba, src.rgba, "fallback is a copy, not the source buffer");
  }

  // A non-positive spacing is likewise rejected rather than dividing by zero.
  const badSpacing = placeRasterOnPath(
    src,
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    0,
  );
  assert.deepEqual(badSpacing.rgba, src.rgba);
  assert.notEqual(badSpacing.rgba, src.rgba);
});

test("5. placeRasterOnPath with a diagonal path differs from horizontal output", () => {
  const src = makeRaster(5, 3, (x, y) => [x * 10 + 1, y * 10 + 1, 3, 255]);
  const horizontal = placeRasterOnPath(
    src,
    [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
    ],
  );
  const diagonal = placeRasterOnPath(
    src,
    [
      { x: 0, y: 0 },
      { x: 6, y: 6 },
    ],
  );

  assert.ok(opaqueCoords(horizontal).length > 0);
  assert.ok(opaqueCoords(diagonal).length > 0);
  assert.notDeepEqual(Array.from(diagonal.rgba), Array.from(horizontal.rgba));
  assert.notDeepEqual(opaqueCoords(diagonal), opaqueCoords(horizontal));
});

test("6. huge finite anchors return a copy rather than throwing", () => {
  const src = makeRaster(2, 2, (x, y) => [x + 1, y + 1, 3, 255]);
  const out = placeRasterOnPath(src, [{ x: 0, y: 0 }, { x: 1e12, y: 1e12 }]);
  assert.equal(out.cw, src.cw);
  assert.equal(out.ch, src.ch);
  assert.deepEqual(out.rgba, src.rgba);
  assert.notEqual(out.rgba, src.rgba, "fallback must be a fresh copy");
});
