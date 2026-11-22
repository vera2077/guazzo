import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PRESSURE,
  curveIsFlat,
  isDefaultPressure,
  loadPressureSettings,
  normalizeCurve,
  normalizePressureSettings,
  pressureAt,
  pressureResponse,
  savePressureSettings,
} from "../pressure.ts";

test("a default size curve reproduces the old 0.35 + 0.65 p mapping", () => {
  assert.equal(pressureAt(DEFAULT_PRESSURE.size, 0), 0);
  assert.equal(pressureAt(DEFAULT_PRESSURE.size, 0.5), 0.5);
  assert.equal(pressureAt(DEFAULT_PRESSURE.size, 1), 1);
  assert.equal(0.35 + 0.65 * pressureAt(DEFAULT_PRESSURE.size, 0.25), 0.5125);
});

test("opacity and flow default to flat, so pressure changes nothing until asked", () => {
  for (const p of [0, 0.1, 0.5, 0.9, 1]) {
    const r = pressureResponse(DEFAULT_PRESSURE, p);
    assert.equal(r.opacity, 1);
    assert.equal(r.flow, 1);
    assert.equal(r.size, p);
  }
  assert.ok(curveIsFlat(DEFAULT_PRESSURE.opacity));
  assert.ok(isDefaultPressure(DEFAULT_PRESSURE));
});

test("knots are joined with straight lines and clamped outside 0..1", () => {
  const curve: [number, number, number] = [0, 1, 0.2];
  const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(pressureAt(curve, 0), 0);
  near(pressureAt(curve, 0.25), 0.5);
  near(pressureAt(curve, 0.5), 1);
  near(pressureAt(curve, 0.75), 0.6);
  near(pressureAt(curve, 1), 0.2);
  near(pressureAt(curve, -1), 0);
  near(pressureAt(curve, 4), 0.2);
  near(pressureAt([0.3, 0.3, 0.3], 0.7), 0.3);
});

test("a flat curve ignores pressure entirely", () => {
  const flat: [number, number, number] = [0.4, 0.4, 0.4];
  for (const p of [0, 0.3, 0.8, 1]) assert.equal(pressureAt(flat, p), 0.4);
});

test("junk is replaced knot by knot, never with a NaN", () => {
  assert.deepEqual(normalizeCurve(undefined, [0, 0.5, 1]), [0, 0.5, 1]);
  assert.deepEqual(normalizeCurve([], [0, 0.5, 1]), [0, 0.5, 1]);
  assert.deepEqual(normalizeCurve("curve", [0, 0.5, 1]), [0, 0.5, 1]);
  assert.deepEqual(normalizeCurve([-1, 0.5, 2], [0, 0.5, 1]), [0, 0.5, 1]);
  assert.deepEqual(normalizeCurve([0, Number.NaN, 1], [0, 0.5, 1]), [0, 0.5, 1]);
  assert.deepEqual(normalizeCurve([0, 0.25, 1], [0, 0.5, 1]), [0, 0.25, 1]);
  assert.deepEqual(normalizeCurve([0, 0.25], [0, 0.5, 1]), [0, 0.5, 1]);
  const bad = normalizePressureSettings({ size: "x", opacity: [2, 2, 2], flow: null });
  assert.deepEqual(bad.size, [0, 0.5, 1]);
  assert.deepEqual(bad.opacity, [1, 1, 1]);
  assert.deepEqual(bad.flow, [1, 1, 1]);
});

test("settings round-trip through storage and a hostile or broken store falls back", () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => void map.set(k, v),
  };
  const bent = { size: [0.1, 0.6, 0.9] as [number, number, number], opacity: [0, 1, 1] as [number, number, number], flow: [1, 1, 1] as [number, number, number] };
  savePressureSettings(bent, store);
  assert.deepEqual(loadPressureSettings(store), bent);

  map.set("guazzo.pressure.v1", "{not json");
  assert.deepEqual(loadPressureSettings(store), DEFAULT_PRESSURE);
  // each knot is sanitised on its own: valid numbers clamp, the bad one keeps
  // the default knot rather than poisoning the whole curve
  map.set("guazzo.pressure.v1", JSON.stringify({ size: [5, -5, "x"] }));
  assert.deepEqual(loadPressureSettings(store).size, [1, 0, 1]);

  const throws = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadPressureSettings(throws), DEFAULT_PRESSURE);
  savePressureSettings(DEFAULT_PRESSURE, throws); // must not throw
});
