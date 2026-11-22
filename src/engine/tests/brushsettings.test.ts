// Brush Settings: the recipe, its clamps, and the dabs it produces.
//
// The point of these tests is the dynamics, not the dialog. A brush panel that
// stores numbers and then stamps one dab per cursor position is the failure
// mode this file exists to catch — so every assertion counts dabs, measures
// spread, or replays a seed rather than checking that a field was written.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BRUSH_SETTINGS, brushRandom, cloneBrushSettings, dabVariation,
  grainAt, grainTexture, normalizeBrushSettings, type BrushSettings,
} from "../brushsettings.ts";

const base = {
  x: 100, y: 100, radius: 20, alpha: 255,
  color: [10, 20, 30] as const,
  pressure: 1, tilt: 0,
};

function settings(patch: (s: BrushSettings) => void): BrushSettings {
  const s = cloneBrushSettings(DEFAULT_BRUSH_SETTINGS);
  patch(s);
  return s;
}

test("normalize: junk becomes the default rather than NaN in a stroke", () => {
  const s = normalizeBrushSettings({ tip: { size: "wide", hardness: 900 }, scattering: { count: -3 }, noise: "lots" });
  assert.equal(s.tip.size, DEFAULT_BRUSH_SETTINGS.tip.size);
  assert.equal(s.tip.hardness, 100, "hardness is a percentage and is clamped");
  assert.equal(s.scattering.count, 1, "a negative count would stamp nothing");
  assert.equal(s.noise, 0);
  assert.equal(normalizeBrushSettings(null).tip.spacing, DEFAULT_BRUSH_SETTINGS.tip.spacing);
});

test("defaults: no dynamics switched on and a 25 % spacing", () => {
  const s = normalizeBrushSettings(DEFAULT_BRUSH_SETTINGS);
  for (const on of [s.shape.on, s.scattering.on, s.texture.on, s.colour.on, s.transfer.on, s.wetEdges, s.buildUp]) {
    assert.equal(on, false);
  }
  assert.equal(s.noise, 0, "noise is a percentage, not a toggle");
  assert.equal(s.tip.spacing, 25);
  assert.equal(s.scattering.count, 1);
});

test("scatter: Count 3 stamps three dabs from one cursor position", () => {
  const s = settings((x) => {
    x.scattering.on = true;
    x.scattering.count = 3;
  });
  const dabs = dabVariation(s, base, brushRandom(7));
  assert.equal(dabs.length, 3);
  // same position for all three only when scatter is zero
  assert.ok(dabs.every((d) => d.x === 100 && d.y === 100));
});

test("both axes: scatter moves y only when Both Axes is ticked", () => {
  const flat = settings((s) => {
    s.scattering.on = true;
    s.scattering.scatter = 100;
    s.scattering.bothAxes = false;
  });
  const oneAxis = dabVariation(flat, base, brushRandom(3));
  assert.equal(oneAxis.length, 1);
  assert.notEqual(oneAxis[0]!.x, 100, "x must move");
  assert.equal(oneAxis[0]!.y, 100, "y must stay on the stroke");

  const both = settings((s) => {
    s.scattering.on = true;
    s.scattering.scatter = 100;
    s.scattering.bothAxes = true;
  });
  // one sample could land on the axis by chance; twelve cannot
  const moved = Array.from({ length: 12 }, (_, i) =>
    dabVariation(both, base, brushRandom(100 + i))[0]!).filter((d) => d.y !== 100);
  assert.ok(moved.length > 0, "with Both Axes, some dab must leave the stroke line");
});

test("size jitter stays inside the minimum-diameter floor", () => {
  const s = settings((x) => {
    x.shape.on = true;
    x.shape.sizeJitter = 100;
    x.shape.minDiameter = 10;
  });
  const floor = (20 * 10) / 50;
  for (let i = 0; i < 40; i++) {
    const d = dabVariation(s, base, brushRandom(i))[0]!;
    assert.ok(d.radius >= floor - 1e-9, `radius ${d.radius} below the floor ${floor}`);
    assert.ok(d.radius <= 20 + 1e-9, `radius ${d.radius} above the tip size`);
  }
});

test("pressure control bounds how far size jitter can shrink a dab", () => {
  // Photoshop semantics: Size Jitter is the variance, Control is the input that
  // modulates it. At 20 % pressure the jitter itself is only 20 %, so the dab
  // cannot collapse to the floor the way it can at full pressure.
  const on = settings((s) => {
    s.shape.on = true;
    s.shape.sizeJitter = 100;
    s.shape.sizeControl = "pressure";
    s.shape.minDiameter = 10;
  });
  const radii = (pressure: number) => Array.from({ length: 60 }, (_, i) =>
    dabVariation(on, { ...base, pressure }, brushRandom(i))[0]!.radius);
  const lightMin = Math.min(...radii(0.2));
  const heavyMin = Math.min(...radii(1));
  assert.ok(lightMin >= 20 * 0.8 - 1e-9, `light pressure shrank to ${lightMin}`);
  assert.ok(heavyMin <= 20 * 0.2 + 1e-9, `full pressure only reached ${heavyMin}`);
  assert.ok(lightMin > heavyMin, "light pressure must jitter less than full pressure");

  const off = settings((s) => {
    s.shape.on = true;
    s.shape.sizeJitter = 100;
    s.shape.sizeControl = "off";
  });
  // with no control input the jitter is full-scale regardless of the pen
  const quiet = Math.min(...Array.from({ length: 60 }, (_, i) =>
    dabVariation(off, { ...base, pressure: 0.1 }, brushRandom(i))[0]!.radius));
  assert.ok(quiet <= 20 * 0.2 + 1e-9, "Off must not weaken the jitter");
});

test("a seed replays the same dabs", () => {
  const s = settings((x) => {
    x.scattering.on = true;
    x.scattering.count = 3;
    x.scattering.scatter = 60;
    x.shape.on = true;
    x.shape.angleJitter = 40;
    x.colour.on = true;
    x.colour.hue = 20;
  });
  const a = dabVariation(s, base, brushRandom(42));
  const b = dabVariation(s, base, brushRandom(42));
  assert.deepEqual(a, b, "a stroke that cannot be replayed cannot be tested");
});

test("grain: deterministic texture with values in 0..1", () => {
  const fine = grainTexture("fine");
  assert.equal(fine.length, 64 * 64);
  assert.deepEqual(grainTexture("fine"), fine, "the same grain must not shimmer between strokes");
  assert.notDeepEqual(grainTexture("coarse"), fine);
  for (const kind of ["fine", "coarse", "chalk"] as const) {
    const tex = grainTexture(kind);
    const v = grainAt(tex, 12, 30, 1, 1, false);
    assert.ok(v >= 0 && v <= 1, `${kind} produced ${v}`);
    assert.equal(grainAt(tex, 12, 30, 1, 1, false), v, "sampling must be stable");
  }
  const tex = grainTexture("fine");
  assert.equal(grainAt(tex, 3, 3, 1, 0, false), 1, "depth 0 leaves the dab alone");
  // depth is a percentage: at 100 the grain is fully applied, so Invert flips it
  assert.ok(Math.abs(grainAt(tex, 3, 3, 1, 100, true) - (1 - grainAt(tex, 3, 3, 1, 100, false))) < 1e-9,
    "Invert flips the grain at full depth");
  assert.ok(grainAt(tex, 3, 3, 1, 50, false) > 0.5, "half depth leaves the dab mostly visible");
});

test("colour jitter keeps hue inside the wheel and alpha in range", () => {
  const s = settings((x) => {
    x.colour.on = true;
    x.colour.hue = 60;
    x.colour.saturation = 50;
    x.colour.brightness = 40;
    x.colour.purity = 0;
  });
  for (let i = 0; i < 20; i++) {
    const d = dabVariation(s, base, brushRandom(i))[0]!;
    for (const c of d.color) assert.ok(c >= 0 && c <= 255, `channel ${c} out of range`);
    assert.ok(d.alpha >= 0 && d.alpha <= 255);
  }
});
