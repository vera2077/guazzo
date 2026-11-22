/**
 * adjustfn.test.ts — every one of the 13 adjustment kinds, plus cross-checks.
 *
 * An adjustment LAYER must produce the same pixels as the equivalent
 * destructive command applied to the backdrop — that equivalence is the
 * whole point of the layer, and the review found four silent drifts
 * (threshold, color-balance, black-white, photo-filter) where the two
 * paths disagreed. These tests pin the fix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCube } from "../lookuptable.ts";
import { TileGrid } from "../tile.ts";
import { Document } from "../document.ts";
import { applyAdjustment } from "../adjust.ts";
import {
  applyCurve,
  applyLevels,
  applyExposure,
  applyVibrance,
  applyColorBalance,
  applyBlackWhite,
  applyPhotoFilter,
  applyGradientMap,
  type MapStop,
  type CurvePoint,
  type LevelsOptions,
} from "../tone.ts";
import {
  compileAdjust,
  defaultAdjustSpec,
  adjustLabel,
  type AdjustSpec,
  type AdjustKind,
} from "../adjustfn.ts";
import { eq } from "./helpers.ts";

/** 4×4 opaque test pattern: primaries, off-primaries, a ramp, odd hues */
const PATTERN: number[][] = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128],
  [200, 50, 50], [50, 200, 50], [50, 50, 200], [240, 10, 10],
  [0, 0, 0], [64, 64, 64], [128, 128, 128], [255, 255, 255],
  [30, 200, 230], [230, 30, 200], [200, 230, 30], [90, 90, 240],
];

function patternGrid(): TileGrid {
  const grid = new TileGrid(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const [r, g, b] = PATTERN[y * 4 + x] as [number, number, number];
      grid.fillRect(x, y, 1, 1, [r, g, b, 255]);
    }
  }
  return grid;
}

function viaTone(fn: (grid: TileGrid) => void): Uint8ClampedArray {
  const grid = patternGrid();
  fn(grid);
  const out = new Uint8ClampedArray(4 * 4 * 4);
  grid.readRect(0, 0, 4, 4, out);
  return out;
}

/** the same pattern as a one-layer document with an adjustment layer on top */
function viaLayer(spec: AdjustSpec): Uint8ClampedArray {
  const doc = new Document(4, 4);
  // a fresh Document has ZERO layers — addLayer creates the backdrop
  const bg = doc.addLayer("BG");
  bg.grid = patternGrid();
  doc.addAdjustLayer(spec);
  return doc.composite();
}

const RECT = { x: 0, y: 0, w: 4, h: 4 };

test("brightness-contrast compiles to the documented combined LUT", () => {
  // one pass: (v − 128)·(1 + contrast/100) + 128 + brightness·2.55
  const c = compileAdjust({ kind: "brightness-contrast", brightness: 20, contrast: 25 });
  eq(c.lr![0], 19);     // (0−128)·1.25 + 128 + 51 = 19
  eq(c.lr![64], 99);    // (64−128)·1.25 + 128 + 51 = 99
  eq(c.lr![128], 179);  // 0·1.25 + 128 + 51 = 179
  eq(c.lr![255], 255);  // 337.75 clamped
  eq(c.lg![64], 99);    // same table on all channels
  eq(c.lb![64], 99);
});

test("levels: adjustment layer == applyLevels", () => {
  const o: LevelsOptions = { inBlack: 20, inWhite: 200, gamma: 1.2, outBlack: 5, outWhite: 250 };
  assert.deepEqual(
    viaLayer({ kind: "levels", levels: o }),
    viaTone((g) => applyLevels(g, RECT, o)),
  );
});

test("levels: a per-channel row overrides only that channel", () => {
  const comp: LevelsOptions = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
  const red: LevelsOptions = { inBlack: 0, inWhite: 128, gamma: 1, outBlack: 0, outWhite: 255 };
  const c = compileAdjust({ kind: "levels", levels: comp, levelsChannels: { r: red } });
  // inWhite 128 on the red row: 128 → 255 on red, untouched on green and blue
  eq(c.lr![128], 255);
  eq(c.lg![128], 128);
  eq(c.lb![128], 128);
  // and the override must not leak below the white point either
  eq(c.lr![64], 128);
  eq(c.lg![64], 64);
});

test("exposure: offset and gamma act in linear light and default to identity", () => {
  const flat = compileAdjust({ kind: "exposure", stops: 0 });
  for (const v of [0, 17, 64, 128, 200, 255]) {
    assert.ok(Math.abs(flat.lr![v]! - v) <= 1, `identity at ${v}: ${flat.lr![v]}`);
  }
  const lifted = compileAdjust({ kind: "exposure", stops: 0, exposureOffset: 0.1 });
  const id = compileAdjust({ kind: "exposure", stops: 0 });
  assert.ok(lifted.lr![64]! > id.lr![64]!);
  // gamma is applied in linear light: a gamma of 2 lifts midtones, it does not
  // clip highlights, and 255 stays 255.
  const bright = compileAdjust({ kind: "exposure", stops: 0, exposureGamma: 2 });
  assert.ok(bright.lr![64]! > id.lr![64]!);
  eq(bright.lr![255], 255);
});

test("vibrance: the saturation slider desaturates fully at -100", () => {
  const out = viaLayer({ kind: "vibrance", amount: 0, vibranceSaturation: -100 });
  for (let i = 0; i < 16; i++) {
    const o = i * 4;
    eq(out[o], out[o + 1]);
    eq(out[o + 1], out[o + 2]);
    // and it lands on the luminance, not on zero (compositing rounds; allow
    // one level rather than pin the rounding mode of a canvas)
    const luma = 0.3 * PATTERN[i]![0]! + 0.59 * PATTERN[i]![1]! + 0.11 * PATTERN[i]![2]!;
    assert.ok(Math.abs(out[o]! - luma) <= 1, `luma ${luma} vs ${out[o]}`);
  }
});

test("curves: adjustment layer == applyCurve", () => {
  const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 64, y: 180 }, { x: 255, y: 255 }];
  assert.deepEqual(
    viaLayer({ kind: "curves", curves: { rgb: points } }),
    viaTone((g) => applyCurve(g, RECT, points)),
  );
});

test("exposure: adjustment layer == applyExposure (±4 EV clamp included)", () => {
  assert.deepEqual(
    viaLayer({ kind: "exposure", stops: 1 }),
    viaTone((g) => applyExposure(g, RECT, 1)),
  );
  assert.deepEqual(
    viaLayer({ kind: "exposure", stops: -1.5 }),
    viaTone((g) => applyExposure(g, RECT, -1.5)),
  );
});

test("invert: adjustment layer == applyAdjustment invert", () => {
  assert.deepEqual(
    viaLayer({ kind: "invert" }),
    viaTone((g) => applyAdjustment(g, 0, 0, 4, 4, { kind: "invert", amount: 0 })),
  );
});

test("posterize: adjustment layer == applyAdjustment posterize", () => {
  // levels 2 and 4 keep the step an integer so both rounding paths agree
  assert.deepEqual(
    viaLayer({ kind: "posterize", posterizeLevels: 4 }),
    viaTone((g) => applyAdjustment(g, 0, 0, 4, 4, { kind: "posterize", amount: 4 })),
  );
  assert.deepEqual(
    viaLayer({ kind: "posterize", posterizeLevels: 2 }),
    viaTone((g) => applyAdjustment(g, 0, 0, 4, 4, { kind: "posterize", amount: 2 })),
  );
});

test("threshold: one luminance decision per pixel (drift fix pin)", () => {
  // the old implementation thresholded each CHANNEL independently, so
  // (200,50,50) came out red; Photoshop and adjust.ts decide once on luma.
  const c = compileAdjust({ kind: "threshold", thresholdLevel: 128 });
  const out = new Float64Array(3);
  c.rgb!(200, 50, 50, out);
  eq(out[0], 0); // luma 91.5 < 128 → black
  eq(out[1], 0);
  eq(out[2], 0);
  c.rgb!(200, 200, 200, out);
  eq(out[0], 255); // luma 200 ≥ 128 → white
  assert.deepEqual(
    viaLayer({ kind: "threshold", thresholdLevel: 128 }),
    viaTone((g) => applyAdjustment(g, 0, 0, 4, 4, { kind: "threshold", amount: 128 })),
  );
});

test("desaturate: adjustment layer == applyAdjustment grayscale", () => {
  assert.deepEqual(
    viaLayer({ kind: "desaturate" }),
    viaTone((g) => applyAdjustment(g, 0, 0, 4, 4, { kind: "grayscale", amount: 0 })),
  );
});

test("hue-sat rotation == applyAdjustment hue 120 (red → green)", () => {
  // saturation/lightness zero: pure hue rotation, both HSL implementations
  assert.deepEqual(
    viaLayer({ kind: "hue-sat", hue: 120, saturation: 0, lightness: 0 }),
    viaTone((g) => applyAdjustment(g, 0, 0, 4, 4, { kind: "hue", amount: 120 })),
  );
  const c = compileAdjust({ kind: "hue-sat", hue: 120, saturation: 0, lightness: 0 });
  const out = new Float64Array(3);
  c.rgb!(255, 0, 0, out);
  eq(out[0], 0);
  eq(out[1], 255);
  eq(out[2], 0);
});

test("vibrance: adjustment layer == applyVibrance", () => {
  assert.deepEqual(
    viaLayer({ kind: "vibrance", amount: 40 }),
    viaTone((g) => applyVibrance(g, RECT, 40)),
  );
  assert.deepEqual(
    viaLayer({ kind: "vibrance", amount: -30 }),
    viaTone((g) => applyVibrance(g, RECT, -30)),
  );
});

test("color-balance: adjustment layer == applyColorBalance (drift fix pin)", () => {
  // the old closure scaled shifts ×1.275 and preserved luminosity by RATIO;
  // tone.ts (the dialogs) uses the raw slider sum and an additive luma delta
  const o = {
    shadows: { r: 20, g: 0, b: -15 },
    midtones: { r: -10, g: 25, b: 0 },
    highlights: { r: 0, g: -20, b: 30 },
    preserveLuminosity: true,
  };
  assert.deepEqual(
    viaLayer({ kind: "color-balance", colorBalance: o }),
    viaTone((g) => applyColorBalance(g, RECT, o)),
  );
  assert.deepEqual(
    viaLayer({ kind: "color-balance", colorBalance: { ...o, preserveLuminosity: false } }),
    viaTone((g) => applyColorBalance(g, RECT, { ...o, preserveLuminosity: false })),
  );
});

test("black-white: adjustment layer == applyBlackWhite (drift fix pin)", () => {
  // the old closure mixed raw channels; Photoshop (and tone.ts) weight each
  // pixel's hue PRESENCE and average the six band sliders against neutral 60
  const o = { red: 40, yellow: 60, green: 60, cyan: 60, blue: 20, magenta: 80 };
  const bw = { r: 40, y: 60, g: 60, c: 60, b: 20, m: 80 };
  assert.deepEqual(
    viaLayer({ kind: "black-white", blackWhite: bw }),
    viaTone((g) => applyBlackWhite(g, RECT, o)),
  );
});

test("photo-filter: adjustment layer == applyPhotoFilter (drift fix pin)", () => {
  // the old closure SCREENED the filter colour; Photoshop (and tone.ts)
  // lerps toward it and preserves luminosity by default
  const o = { color: [236, 138, 0] as [number, number, number], density: 60, preserveLuminosity: true };
  assert.deepEqual(
    viaLayer({ kind: "photo-filter", photoFilter: o }),
    viaTone((g) => applyPhotoFilter(g, RECT, o)),
  );
  assert.deepEqual(
    viaLayer({ kind: "photo-filter", photoFilter: { ...o, preserveLuminosity: false } }),
    viaTone((g) => applyPhotoFilter(g, RECT, { ...o, preserveLuminosity: false })),
  );
});

test("gradient-map: adjustment layer == applyGradientMap (drift fix pin)", () => {
  // The layer compiles to a 256-entry LUT indexed by rounded luma; the
  // destructive path interpolates in floats. They may differ by one level
  // after rounding, never by more — anything larger means one path changed.
  const stops: MapStop[] = [
    { pos: 0, color: [255, 0, 0] },
    { pos: 1, color: [0, 0, 255] },
  ];
  const layer = viaLayer({ kind: "gradient-map", map: stops });
  const tone = viaTone((g) => applyGradientMap(g, RECT, stops));
  for (let i = 0; i < layer.length; i++) {
    assert.ok(
      Math.abs(layer[i]! - tone[i]!) <= 1,
      `byte ${i}: layer ${layer[i]} vs tone ${tone[i]}`,
    );
  }
});

test("gradient-map: endpoints are the stop colours, not the luma", () => {
  const redToBlue: MapStop[] = [
    { pos: 0, color: [255, 0, 0] },
    { pos: 1, color: [0, 0, 255] },
  ];
  const c = compileAdjust({ kind: "gradient-map", map: redToBlue });
  // black is the first stop, white the last, and the midpoint is half-way
  // between them in ALU, not a desaturated grey
  const at = (r: number, g: number, b: number): [number, number, number] => {
    const out = new Float64Array(3);
    c.rgb!(r, g, b, out);
    return [out[0]!, out[1]!, out[2]!];
  };
  assert.deepEqual(at(0, 0, 0), [255, 0, 0]);
  assert.deepEqual(at(255, 255, 255), [0, 0, 255]);
  const mid = at(128, 128, 128);
  assert.ok(mid[0] > 100 && mid[0] < 155, `mid red ${mid[0]}`);
  assert.ok(mid[2] > 100 && mid[2] < 155, `mid blue ${mid[2]}`);
});

test("gradient-map: stops that do not start at 0 or 1 hold their end colours", () => {
  const stops: MapStop[] = [
    { pos: 0.2, color: [10, 20, 30] },
    { pos: 0.8, color: [200, 210, 220] },
  ];
  const c = compileAdjust({ kind: "gradient-map", map: stops });
  const out = new Float64Array(3);
  c.rgb!(0, 0, 0, out);
  assert.deepEqual([out[0]!, out[1]!, out[2]!], [10, 20, 30]);
  c.rgb!(255, 255, 255, out);
  assert.deepEqual([out[0]!, out[1]!, out[2]!], [200, 210, 220]);
});

test("channel-mixer: identity keeps every channel, and the mix reads the ORIGINAL pixels", () => {
  const out = (spec: AdjustSpec, r: number, g: number, b: number): number[] => {
    const px = new Float64Array(3);
    compileAdjust(spec).rgb!(r, g, b, px);
    return [px[0]!, px[1]!, px[2]!];
  };
  const identity: NonNullable<AdjustSpec["mixer"]> = {
    red: { r: 100, g: 0, b: 0, constant: 0 },
    green: { r: 0, g: 100, b: 0, constant: 0 },
    blue: { r: 0, g: 0, b: 100, constant: 0 },
  };
  assert.deepEqual(out({ kind: "channel-mixer", mixer: identity }, 200, 100, 50), [200, 100, 50]);

  // green ← 100% of the source red: if the closure mixed successively, red
  // would already be gone by the time green is computed, and this would be 0.
  const swapLike: NonNullable<AdjustSpec["mixer"]> = {
    red: { r: 100, g: 0, b: 0, constant: 0 },
    green: { r: 100, g: 0, b: 0, constant: 0 },
    blue: { r: 0, g: 0, b: 100, constant: 0 },
  };
  assert.deepEqual(out({ kind: "channel-mixer", mixer: swapLike }, 200, 100, 50), [200, 200, 50]);

  // monochrome turns all three channels into the gray mix
  const mono: NonNullable<AdjustSpec["mixer"]> = {
    ...identity,
    gray: { r: 30, g: 59, b: 11, constant: 0 },
  };
  const grey = out({ kind: "channel-mixer", mixer: mono }, 255, 0, 0);
  eq(grey[0], grey[1]);
  eq(grey[1], grey[2]);
  assert.ok(Math.abs(grey[0]! - 76.5) <= 1, `luma of red ${grey[0]}`);
});

test("selective colour moves the range the pixel belongs to and no other", () => {
  const selective = { mode: "absolute" as const, ranges: { reds: { c: 50, m: 0, y: 0, k: 0 } } };
  const fn = compileAdjust({ kind: "selective-colour", selective });
  const buf = new Float64Array(3);
  const at = (r: number, g: number, b: number): number[] => {
    fn.rgb?.(r, g, b, buf);
    return [buf[0]!, buf[1]!, buf[2]!];
  };

  const adjusted = at(255, 0, 0);
  assert.ok(Math.abs(adjusted[0]! - 128) <= 1, `red ${adjusted[0]}`);
  eq(adjusted[1], 0);

  // A blue pixel is not in Reds, so the same recipe must leave it alone.
  const blue = at(0, 0, 255);
  eq(blue[0], 0);
  eq(blue[2], 255);

  const grey = at(128, 128, 128);
  eq(grey[0], 128);
  eq(grey[2], 128);
});

test("a colour lookup maps through its table, and an empty one is identity", () => {
  // 2×2×2 cube that swaps red and blue: red input must come out blue.
  const swap = parseCube(`LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`);
  assert.ok(swap.table, swap.error ?? "parse");
  const fn = compileAdjust({ kind: "color-lookup", lookup: swap.table! });
  const buf = new Float64Array(3);
  fn.rgb?.(255, 0, 0, buf);
  eq(buf[2], 255);
  eq(buf[0], 0);

  const none = compileAdjust({ kind: "color-lookup" });
  none.rgb?.(12, 34, 56, buf);
  eq(buf[0], 12);
  eq(buf[1], 34);
  eq(buf[2], 56);
});

test("defaultAdjustSpec + adjustLabel cover all 17 kinds", () => {
  const kinds: AdjustKind[] = [
    "brightness-contrast", "levels", "curves", "exposure", "vibrance", "hue-sat",
    "color-balance", "black-white", "photo-filter", "invert", "posterize",
    "threshold", "desaturate", "gradient-map", "channel-mixer", "selective-colour",
    "color-lookup",
  ];
  eq(kinds.length, 17);
  for (const kind of kinds) {
    const spec = defaultAdjustSpec(kind);
    eq(spec.kind, kind);
    assert.notEqual(adjustLabel(spec), "Adjustment", `adjustLabel(${kind})`);
    // every default must compile without throwing
    compileAdjust(spec);
  }
});

test("hue-sat colorize: grey becomes the master hue, lightness keeps the tone", () => {
  const c = compileAdjust({ kind: "hue-sat", colorize: true, hue: 0, saturation: 100 });
  const out = new Float64Array(3);
  // A neutral grey has no hue of its own; Colorize must not care.
  c.rgb!(128, 128, 128, out);
  eq(out[0], 255);
  // HSL round-tripping rounds to bytes, so "zero" is really "at most one".
  assert.ok(out[1]! <= 2 && out[2]! <= 2, `pure red, got ${out[1]},${out[2]}`);

  const dark = new Float64Array(3);
  c.rgb!(32, 32, 32, dark);
  assert.ok(dark[0]! > 40 && dark[0]! < 90, `a dark grey stays dark (got ${dark[0]})`);
  assert.ok(dark[1]! < 4 && dark[2]! < 4);
});

test("hue-sat per-range band moves inside its window and leaves other hues alone", () => {
  const c = compileAdjust({
    kind: "hue-sat",
    hue: 0,
    saturation: 0,
    lightness: 0,
    hueRanges: {
      reds: { a: 315, b: 345, c: 15, d: 45, hue: -60, saturation: 50, lightness: 0 },
    },
  });
  const red = new Float64Array(3);
  c.rgb!(255, 0, 0, red);
  // 0° sits inside reds' full-strength window: -60° lands on magenta, and +50%
  // saturation cannot exceed the 1.0 it already has.
  eq(red[0], 255);
  eq(red[1], 0);
  eq(red[2], 255);

  const green = new Float64Array(3);
  c.rgb!(0, 255, 0, green);
  // 120° is outside the window, so the band must not touch it.
  eq(green[0], 0);
  eq(green[1], 255);
  eq(green[2], 0);
});

test("black & white tint paints the grey and keeps its lightness", () => {
  const bw = { r: 60, g: 60, b: 60, c: 60, m: 60, y: 60 };
  const plain = compileAdjust({ kind: "black-white", blackWhite: bw });
  const tinted = compileAdjust({
    kind: "black-white",
    blackWhite: bw,
    blackWhiteTint: [255, 0, 0],
  });
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  plain.rgb!(128, 128, 128, a);
  tinted.rgb!(128, 128, 128, b);
  eq(a[0], 128);
  eq(b[0], 255);
  assert.ok(b[1]! <= 2, `red tint keeps no green (got ${b[1]})`);
  assert.ok(b[2]! < 4, `red tint leaves no blue (got ${b[2]})`);
});
