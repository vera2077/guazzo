/**
 * smartfilters.test.ts — the buffer-returning smart filter path.
 *
 * These are behavioural, not "it did not crash": each effect test compares a
 * filtered render against an unfiltered render of the same source, so a stub
 * that ignored the filter list (or always skipped it) fails an assertion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSmartFiltered, type SmartFilterSpec } from "../smartfilters.ts";
import type { SmartSource } from "../smart.ts";

function solidSource(w: number, h: number, v: number): SmartSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** high-frequency 0/255 checkerboard — blur must collapse its contrast */
function checkerSource(n: number): SmartSource {
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      const v = (x + y) % 2 === 0 ? 255 : 0;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
  return { width: n, height: n, data };
}

/** soft vertical edge: left half `lo`, right half `hi` (both mid-tone) */
function stepSource(w: number, h: number, lo: number, hi: number): SmartSource {
  const s = solidSource(w, h, lo);
  for (let y = 0; y < h; y++) {
    for (let x = w / 2; x < w; x++) {
      const o = (y * w + x) * 4;
      s.data[o] = hi; s.data[o + 1] = hi; s.data[o + 2] = hi;
    }
  }
  return s;
}

/** sum of absolute red-channel differences across horizontal/vertical neighbours */
function contrast(buf: Uint8ClampedArray, w: number, h: number): number {
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x + 1 < w) sum += Math.abs(buf[i]! - buf[(y * w + x + 1) * 4]!);
      if (y + 1 < h) sum += Math.abs(buf[i]! - buf[((y + 1) * w + x) * 4]!);
    }
  }
  return sum;
}

test("a 1x2 source upscaled into a small rect produces full alpha", () => {
  const source: SmartSource = {
    width: 1,
    height: 2,
    data: new Uint8ClampedArray([200, 100, 50, 255, 30, 60, 90, 255]),
  };
  const out = renderSmartFiltered(source, { x: 0, y: 0, w: 8, h: 8 }, []);
  assert.equal(out.length, 8 * 8 * 4);
  for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255);
});

test("a disabled filter and amount 0 are strict no-ops", () => {
  const source = checkerSource(8);
  const rect = { x: 0, y: 0, w: 8, h: 8 };
  const base = renderSmartFiltered(source, rect, []);

  const disabled = renderSmartFiltered(source, rect, [
    { kind: "blur", amount: 100, enabled: false },
    { kind: "sharpen", amount: 100, enabled: false },
    { kind: "emboss", amount: 100, enabled: false },
    { kind: "noise", amount: 100, enabled: false },
  ]);
  assert.deepEqual(Array.from(disabled), Array.from(base));

  const zero = renderSmartFiltered(source, rect, [
    { kind: "blur", amount: 0, enabled: true },
    { kind: "sharpen", amount: 0, enabled: true },
    { kind: "emboss", amount: 0, enabled: true },
    { kind: "noise", amount: 0, enabled: true },
  ]);
  assert.deepEqual(Array.from(zero), Array.from(base));

  // Guard against a stub that ignores the whole filter list: a real filter
  // must change at least one byte.
  const blurred = renderSmartFiltered(source, rect, [{ kind: "blur", amount: 100, enabled: true }]);
  assert.notDeepEqual(Array.from(blurred), Array.from(base));
});

test("a blur reduces a checkerboard's contrast", () => {
  const source = checkerSource(8);
  const rect = { x: 0, y: 0, w: 8, h: 8 };
  const plain = renderSmartFiltered(source, rect, []);
  const blurred = renderSmartFiltered(source, rect, [{ kind: "blur", amount: 100, enabled: true }]);
  const before = contrast(plain, 8, 8);
  const after = contrast(blurred, 8, 8);
  assert.ok(after < before * 0.5, `blur should cut contrast sharply (plain ${before}, blurred ${after})`);
});

test("sharpen increases edge contrast", () => {
  const source = stepSource(8, 8, 110, 150);
  const rect = { x: 0, y: 0, w: 8, h: 8 };
  const plain = renderSmartFiltered(source, rect, []);
  const sharp = renderSmartFiltered(source, rect, [{ kind: "sharpen", amount: 100, enabled: true }]);
  const edge = (buf: Uint8ClampedArray): number =>
    Math.abs(buf[(3 * 8 + 3) * 4]! - buf[(3 * 8 + 4) * 4]!);
  const before = edge(plain);
  const after = edge(sharp);
  assert.equal(before, 40);
  assert.ok(after > before + 10, `sharpen should widen the step (before ${before}, after ${after})`);
});

test("the original source data is unchanged by every filter kind", () => {
  const source = checkerSource(8);
  const before = Array.from(source.data);
  renderSmartFiltered(source, { x: 0, y: 0, w: 8, h: 8 }, [
    { kind: "blur", amount: 80, enabled: true },
    { kind: "sharpen", amount: 60, enabled: true },
    { kind: "emboss", amount: 70, enabled: true },
    { kind: "noise", amount: 50, enabled: true },
  ]);
  assert.deepEqual(Array.from(source.data), before);
});

test("filters are deterministic, preserve alpha, and run in the given order", () => {
  const source = checkerSource(8);
  const rect = { x: 0, y: 0, w: 8, h: 8 };
  const specs: SmartFilterSpec[] = [
    { kind: "blur", amount: 60, enabled: true },
    { kind: "sharpen", amount: 40, enabled: true },
    { kind: "emboss", amount: 80, enabled: true },
    { kind: "noise", amount: 30, enabled: true },
  ];
  const a = renderSmartFiltered(source, rect, specs);
  const b = renderSmartFiltered(source, rect, specs);
  assert.deepEqual(Array.from(a), Array.from(b));
  for (let i = 3; i < a.length; i += 4) assert.equal(a[i], 255);

  // Dither then blur is not the same as blur then dither.
  const noiseThenBlur = renderSmartFiltered(source, rect, [
    { kind: "noise", amount: 60, enabled: true },
    { kind: "blur", amount: 100, enabled: true },
  ]);
  const blurThenNoise = renderSmartFiltered(source, rect, [
    { kind: "blur", amount: 100, enabled: true },
    { kind: "noise", amount: 60, enabled: true },
  ]);
  assert.notDeepEqual(Array.from(noiseThenBlur), Array.from(blurThenNoise));
});
