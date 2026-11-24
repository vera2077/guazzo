// Healing Brush with a sampled source — deterministic texture transfer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TileGrid } from "../tile.ts";
import { SelectionMask } from "../mask.ts";
import { healFromSource } from "../heal.ts";
import { eq } from "./helpers.ts";

const W = 64;
const H = 64;
const SRC = { x: 4, y: 4 };
const DST = { x: 40, y: 40, w: 12, h: 12 };

/** Flat destination patch elsewhere, striped source patch to sample from. */
function build(): TileGrid {
  const g = new TileGrid(W, H);
  g.fillRect(0, 0, W, H, [120, 120, 120, 255]); // flat destination shading
  for (let x = SRC.x; x < SRC.x + 12; x++) {
    const v = x % 2 === 0 ? 230 : 30; // vertical light/dark stripes
    g.fillRect(x, SRC.y, 1, 12, [v, v, v, 255]);
  }
  return g;
}

function px(g: TileGrid, x: number, y: number): [number, number, number, number] {
  const out = new Uint8ClampedArray(4);
  g.readRect(x, y, 1, 1, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

function snapshot(): number[] {
  const g = build();
  healFromSource(g, DST, null, SRC.x, SRC.y, 1);
  const out = new Uint8ClampedArray(DST.w * DST.h * 4);
  g.readRect(DST.x, DST.y, DST.w, DST.h, out);
  return [...out];
}

test("copies striped source texture into the flat destination", () => {
  const g = build();
  const touched = healFromSource(g, DST, null, SRC.x, SRC.y, 1);
  assert.ok(touched, "a valid in-bounds rect should report the rect it touched");
  eq(touched!.x, 40);
  eq(touched!.y, 40);
  eq(touched!.w, 12);
  eq(touched!.h, 12);

  // These two assertions fail if the source pixels are ignored: dest x=40
  // samples source x=4 (light stripe 230) and x=41 samples source x=5 (dark 30).
  const light = px(g, 40, 45)[0]!;
  const dark = px(g, 41, 45)[0]!;
  assert.ok(light - dark > 60, `expected source stripes in destination, got ${light} then ${dark}`);

  const vals: number[] = [];
  for (let x = 40; x < 52; x++) vals.push(px(g, x, 45)[0]!);
  const mean = vals.reduce((p, c) => p + c, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((p, c) => p + (c - mean) ** 2, 0) / vals.length);
  assert.ok(sd > 30, `destination stayed flat (sd ${sd.toFixed(1)})`);
  eq(px(g, 45, 45)[3], 255); // destination alpha/coverage unchanged
});

test("strength 0 is a strict no-op", () => {
  const g = build();
  const before = new Uint8ClampedArray(W * H * 4);
  g.readRect(0, 0, W, H, before);
  healFromSource(g, DST, null, SRC.x, SRC.y, 0);
  const after = new Uint8ClampedArray(W * H * 4);
  g.readRect(0, 0, W, H, after);
  assert.deepEqual([...after], [...before]);
});

test("the mask blocks painting outside the selection", () => {
  const g = build();
  const mask = new SelectionMask(W, H);
  mask.selectRect(40, 40, 6, 12); // only the left half of DST is selected
  healFromSource(g, DST, mask, SRC.x, SRC.y, 1);
  assert.ok(px(g, 42, 45)[0]! > 140, "selected pixels should receive source texture");
  eq(px(g, 46, 45)[0], 120); // unselected pixels stay byte-identical
  eq(px(g, 46, 45)[3], 255);
});

test("an out-of-bounds rect returns null", () => {
  const g = build();
  eq(healFromSource(g, { x: 500, y: 500, w: 10, h: 10 }, null, SRC.x, SRC.y, 1), null);
});

test("the same input produces the same output", () => {
  assert.deepEqual(snapshot(), snapshot());
});
