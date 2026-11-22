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

test("defaultAdjustSpec + adjustLabel cover all 16 kinds", () => {
  const kinds: AdjustKind[] = [
    "brightness-contrast", "levels", "curves", "exposure", "vibrance", "hue-sat",
    "color-balance", "black-white", "photo-filter", "invert", "posterize",
    "threshold", "desaturate", "gradient-map", "channel-mixer", "selective-colour",
  ];
  eq(kinds.length, 16);
  for (const kind of kinds) {
    const spec = defaultAdjustSpec(kind);
    eq(spec.kind, kind);
    assert.notEqual(adjustLabel(spec), "Adjustment", `adjustLabel(${kind})`);
    // every default must compile without throwing
    compileAdjust(spec);
  }
});
