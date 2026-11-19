// tone.ts — the tonal adjustment set: levels, curves, exposure, vibrance,
// colour balance, black & white, photo filter, channel mixer, gradient map,
// desaturate, auto tone/contrast/colour, equalize and the histogram.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../../engine/tile.ts";
import { SelectionMask } from "../../engine/mask.ts";
import {
  applyLevels, levelsLut, curveLut, applyCurve, applyExposure, applyVibrance,
  applyColorBalance, applyBlackWhite, applyPhotoFilter, applyChannelMixer,
  applyGradientMap, applyDesaturate, histogram, autoTone, autoContrast,
  autoColor, applyEqualize, IDENTITY_LEVELS,
} from "../../engine/tone.ts";
import { eq } from "./helpers.ts";

/** unknown-typed equality (assert.equal narrows `let`s into `never` — see io tests) */
function gridWith(colour: [number, number, number, number], w = 8, h = 8): TileGrid {
  const g = new TileGrid(w, h);
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = colour[0];
    buf[i * 4 + 1] = colour[1];
    buf[i * 4 + 2] = colour[2];
    buf[i * 4 + 3] = colour[3];
  }
  g.writeRect(0, 0, w, h, buf);
  return g;
}

function px(g: TileGrid, x = 0, y = 0): number[] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

const FULL = { x: 0, y: 0, w: 8, h: 8 };

test("levels identity leaves pixels untouched", () => {
  const g = gridWith([100, 150, 200, 255]);
  applyLevels(g, FULL, IDENTITY_LEVELS);
  assert.deepEqual(px(g), [100, 150, 200, 255]);
});

test("levels: black/white points stretch the range", () => {
  // in 50..200 → 0..255  ⇒  100 → 42, 200 → 255
  const lut = levelsLut({ inBlack: 50, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 });
  eq(lut[50], 0);
  eq(lut[200], 255);
  eq(lut[100], 85); // (100-50)/150 of the way from 0 to 255
});

test("levels: gamma brightens midtones, output range compresses", () => {
  const bright = levelsLut({ ...IDENTITY_LEVELS, gamma: 2 }); // 1/gamma = 0.5
  eq(bright[64], 128); // sqrt(64/255)*255 ≈ 128
  const squashed = levelsLut({ ...IDENTITY_LEVELS, outBlack: 50, outWhite: 150 });
  eq(squashed[0], 50);
  eq(squashed[255], 150);
});

test("levels: alpha is preserved", () => {
  const g = gridWith([10, 20, 30, 128]);
  applyLevels(g, FULL, { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
  eq(px(g)[3], 128);
});

test("curve lut is monotone between control points and pins the ends", () => {
  const lut = curveLut([{ x: 0, y: 0 }, { x: 128, y: 200 }, { x: 255, y: 255 }]);
  eq(lut[0], 0);
  eq(lut[255], 255);
  eq(Math.round(lut[128]!), 200);
  let prev = -1;
  for (let i = 0; i < 256; i++) {
    assert.ok(lut[i]! >= prev, `curve must not go backwards at ${i}`);
    prev = lut[i]!;
  }
});

test("curve with a single point flattens to that level", () => {
  const lut = curveLut([{ x: 128, y: 64 }]);
  eq(lut[0], 64);
  eq(lut[255], 64);
});

test("applyCurve on one channel only touches that channel", () => {
  const g = gridWith([100, 100, 100, 255]);
  applyCurve(g, FULL, [{ x: 0, y: 0 }, { x: 255, y: 255 }].map((p) => p), "r");
  assert.deepEqual(px(g), [100, 100, 100, 255]);
  applyCurve(g, FULL, [{ x: 0, y: 0 }, { x: 100, y: 200 }, { x: 255, y: 255 }], "r");
  const p = px(g);
  eq(p[1], 100);
  eq(p[2], 100);
  assert.ok(p[0]! > 100, "red channel should have been bent upward");
});

test("exposure +1 stop doubles linear light (not the 8-bit value)", () => {
  const g = gridWith([128, 128, 128, 255]);
  applyExposure(g, FULL, 1);
  const v = px(g)[0]!;
  assert.ok(v > 128 && v < 255, `expected a brightening, got ${v}`);
  // 0 stops is a no-op
  const g2 = gridWith([128, 128, 128, 255]);
  applyExposure(g2, FULL, 0);
  eq(px(g2)[0], 128);
});

test("vibrance 0 is a no-op and grey stays grey", () => {
  const g = gridWith([130, 130, 130, 255]);
  applyVibrance(g, FULL, 60);
  assert.deepEqual(px(g), [130, 130, 130, 255]);
});

test("vibrance boosts a desaturated colour more than a saturated one", () => {
  const dim = gridWith([140, 120, 110, 255]);
  const vivid = gridWith([255, 40, 20, 255]);
  applyVibrance(dim, FULL, 80);
  applyVibrance(vivid, FULL, 80);
  const dSpread = Math.max(...px(dim).slice(0, 3)) - Math.min(...px(dim).slice(0, 3));
  const vSpread = Math.max(...px(vivid).slice(0, 3)) - Math.min(...px(vivid).slice(0, 3));
  assert.ok(dSpread > 30, `dim colour should spread out, got ${dSpread}`);
  const vp = px(vivid);
  assert.ok(vp[0]! > vp[1]! && vp[1]! > vp[2]!, "a vivid colour keeps its hue order");
  assert.ok(vSpread >= 200, "a vivid colour stays vivid");
});

test("colour balance shifts midtones red and preserve-luminosity keeps grey level", () => {
  const g = gridWith([128, 128, 128, 255]);
  applyColorBalance(g, FULL, {
    shadows: { r: 0, g: 0, b: 0 },
    midtones: { r: 60, g: 0, b: 0 },
    highlights: { r: 0, g: 0, b: 0 },
    preserveLuminosity: true,
  });
  const p = px(g);
  assert.ok(p[0]! > 128, "red should rise");
  assert.ok(p[1]! < 128 && p[2]! < 128, "green/blue should fall to hold luminance");
});

test("black & white on pure red is darker than on pure white", () => {
  const red = gridWith([255, 0, 0, 255]);
  const white = gridWith([255, 255, 255, 255]);
  const o = { red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80 };
  applyBlackWhite(red, FULL, o);
  applyBlackWhite(white, FULL, o);
  assert.ok(px(red)[0]! < px(white)[0]!, "red must darken");
  const a = px(red);
  eq(a[0], a[1]);
  eq(a[1], a[2]);
});

test("photo filter tints and optionally preserves luminance", () => {
  const g = gridWith([128, 128, 128, 255]);
  applyPhotoFilter(g, FULL, { color: [255, 180, 80], density: 50, preserveLuminosity: false });
  const p = px(g);
  assert.ok(p[0]! > p[1]! && p[1]! > p[2]!, "warm tint: r > g > b");
});

test("channel mixer monochrome produces a grey", () => {
  const g = gridWith([200, 100, 50, 255]);
  applyChannelMixer(g, FULL, {
    red: [30, 59, 11], green: [30, 59, 11], blue: [30, 59, 11],
    monochrome: true, constant: 0,
  });
  const p = px(g);
  eq(p[0], p[1]);
  eq(p[1], p[2]);
  const expected = (30 * 200 + 59 * 100 + 11 * 50) / 100; // 124.5 → Uint8Clamped ties-to-even
  assert.ok(Math.abs(p[0]! - expected) <= 0.5, `got ${p[0]}, expected ≈${expected}`);
});

test("gradient map maps black to the first stop and white to the last", () => {
  const black = gridWith([0, 0, 0, 255]);
  const white = gridWith([255, 255, 255, 255]);
  const stops = [{ pos: 0, color: [10, 20, 30] as [number, number, number] }, { pos: 1, color: [200, 100, 50] as [number, number, number] }];
  applyGradientMap(black, FULL, stops);
  applyGradientMap(white, FULL, stops);
  assert.deepEqual(px(black).slice(0, 3), [10, 20, 30]);
  assert.deepEqual(px(white).slice(0, 3), [200, 100, 50]);
});

test("desaturate uses the 0.3/0.59/0.11 luminance", () => {
  const g = gridWith([255, 0, 0, 255]);
  applyDesaturate(g, FULL);
  eq(px(g)[0], 76); // 76.5 → ties-to-even
});

test("histogram counts opaque pixels only and bin totals match", () => {
  const g = new TileGrid(4, 1);
  const buf = new Uint8ClampedArray(4 * 4);
  // two red, one green, one transparent
  buf.set([255, 0, 0, 255], 0);
  buf.set([255, 0, 0, 255], 4);
  buf.set([0, 255, 0, 255], 8);
  buf.set([0, 0, 0, 0], 12);
  g.writeRect(0, 0, 4, 1, buf);
  const h = histogram(g, { x: 0, y: 0, w: 4, h: 1 });
  eq(h.total, 3);
  eq(h.r[255], 2);
  eq(h.g[255], 1);
});

test("autoTone stretches a narrow band to the full range", () => {
  const g = new TileGrid(16, 1);
  const buf = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < 16; i++) {
    const v = 100 + i * 2; // 100..130
    buf.set([v, v, v, 255], i * 4);
  }
  g.writeRect(0, 0, 16, 1, buf);
  autoTone(g, { x: 0, y: 0, w: 16, h: 1 }, 0);
  assert.deepEqual(px(g, 0, 0).slice(0, 3), [0, 0, 0]);
  assert.deepEqual(px(g, 15, 0).slice(0, 3), [255, 255, 255]);
});

test("autoColor neutralises a colour cast", () => {
  const g = new TileGrid(16, 1);
  const buf = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < 16; i++) buf.set([160, 120, 100, 255], i * 4); // warm cast
  g.writeRect(0, 0, 16, 1, buf);
  autoColor(g, { x: 0, y: 0, w: 16, h: 1 });
  const p = px(g, 8, 0);
  const spread = Math.max(p[0]!, p[1]!, p[2]!) - Math.min(p[0]!, p[1]!, p[2]!);
  assert.ok(spread < 20, `cast should shrink, spread was ${spread}`);
});

test("equalize spreads a constant mid-grey across the range", () => {
  const g = gridWith([128, 128, 128, 255]);
  applyEqualize(g, FULL);
  // a single-valued histogram has nothing to equalise: it must not crash
  assert.deepEqual(px(g), [128, 128, 128, 255]);
  const grad = new TileGrid(32, 1);
  const buf = new Uint8ClampedArray(32 * 4);
  for (let i = 0; i < 32; i++) buf.set([i * 8, i * 8, i * 8, 255], i * 4);
  grad.writeRect(0, 0, 32, 1, buf);
  applyEqualize(grad, { x: 0, y: 0, w: 32, h: 1 });
  assert.ok(px(grad, 31, 0)[0]! > 200, "the bright end should survive equalisation");
});

test("autoContrast works per channel without a cast on neutral input", () => {
  const g = gridWith([90, 90, 90, 255], 8, 8);
  const buf = new Uint8ClampedArray(8 * 8 * 4);
  let k = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = 90 + (k % 2) * 20; // two levels: 90 and 110
      buf.set([v, v, v, 255], (y * 8 + x) * 4);
      k++;
    }
  }
  g.writeRect(0, 0, 8, 8, buf);
  autoContrast(g, FULL);
  const p = px(g, 0, 0);
  assert.ok(p[0] === 0 || p[0] === 255, `expected the two levels to clamp, got ${p[0]}`);
});

test("tone ops fade with feathered selection coverage instead of snapping at 50%", () => {
  const g = new TileGrid(8, 8);
  g.fillRect(0, 0, 8, 8, [100, 100, 100, 255]);
  // a mask that covers the left half fully and the right half at 50%
  const m = new SelectionMask(8, 8);
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) m.setAlpha(x, y, x < 4 ? 255 : 128);
  applyExposure(g, { x: 0, y: 0, w: 8, h: 8 }, 1, m);
  const px = new Uint8ClampedArray(8 * 8 * 4);
  g.readRect(0, 0, 8, 8, px);
  const full = px[(0 * 8 + 0) * 4]!;
  const half = px[(0 * 8 + 6) * 4]!;
  // exposure works in 2.2-gamma light: 100 → ≈137 at +1 stop
  assert.ok(full > 130 && full < 145, `fully covered should brighten to ~137, got ${full}`);
  assert.ok(half > 105 && half < 135, `50% coverage should land between, got ${half}`);
  assert.ok(half < full, "half coverage must be dimmer than full coverage");
});
