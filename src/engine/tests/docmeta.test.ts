import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PRESETS,
  MAX_DIM,
  dimensionsToPixels,
  imageSizeMb,
  pxToUnit,
  sanitisePresets,
  unitToPx,
  jsonImportRefusal,
  imageImportRefusal,
} from "../docmeta.ts";
import { eq } from "./helpers.ts";

// assert.equal/ok narrow `let` variables in closures to literals and can turn a
// later comparison into `never` (see history.test.ts), so keep this local helper.
function close(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);
}

test("unitToPx covers every print unit at 300 ppi", () => {
  eq(unitToPx(1, "px", 300), 1);
  eq(unitToPx(1, "in", 300), 300);
  close(unitToPx(1, "cm", 300), 300 / 2.54);
  close(unitToPx(1, "mm", 300), 300 / 25.4);
  close(unitToPx(1, "pt", 300), 300 / 72);
  close(unitToPx(1, "pica", 300), 50);
});

test("pxToUnit is the exact inverse for every unit", () => {
  for (const unit of ["px", "in", "cm", "mm", "pt", "pica"] as const) {
    const px = unitToPx(3.5, unit, 240);
    close(pxToUnit(px, unit, 240), 3.5);
  }
});

test("pxToUnit survives a zero resolution instead of dividing by zero", () => {
  eq(pxToUnit(42, "in", 0), 42);
});

test("the reference 19 × 13 in preset at 300 ppi becomes 5700 × 3900 px", () => {
  const [w, h] = dimensionsToPixels(19, 13, "in", 300);
  eq(w, 5700);
  eq(h, 3900);
});

test("dimensionsToPixels clamps to MAX_DIM and never returns 0", () => {
  const [w, h] = dimensionsToPixels(500, 0, "in", 300);
  eq(w, MAX_DIM);
  eq(h, 1);
  const [nw, nh] = dimensionsToPixels(-5, Number.NaN, "px", 300);
  eq(nw, 1);
  eq(nh, 1);
});

test("imageSizeMb reports one decimal below 10 MB and whole MB above", () => {
  eq(imageSizeMb(1000, 1000), "3.8 MB"); // 4 MB in binary mebibytes
  eq(imageSizeMb(2048, 2048), "16 MB");
});

test("A4 preset converts to the expected pixel canvas", () => {
  const a4 = BUILTIN_PRESETS.find((p) => p.name.startsWith("A4"));
  assert.ok(a4, "A4 preset must exist");
  const [w, h] = dimensionsToPixels(a4!.w, a4!.h, a4!.unit, a4!.dpi);
  eq(w, Math.round((210 * 300) / 25.4));
  eq(h, Math.round((297 * 300) / 25.4));
});

test("the default preset stays small enough to open instantly", () => {
  const first = BUILTIN_PRESETS[0]!;
  const [w, h] = dimensionsToPixels(first.w, first.h, first.unit, first.dpi);
  assert.ok(w * h <= 4_000_000, `default preset is ${w}×${h}, too large for a default`);
});

test("sanitisePresets drops malformed entries and duplicate names", () => {
  const out = sanitisePresets([
    { name: "Good", w: 8, h: 6, unit: "in", dpi: 300 },
    { name: "Good", w: 8, h: 6, unit: "in", dpi: 300 }, // duplicate name
    { name: "", w: 8, h: 6, unit: "in", dpi: 300 }, // empty name
    { name: "Zero", w: 0, h: 6, unit: "in", dpi: 300 }, // bad width
    { name: "BadUnit", w: 8, h: 6, unit: "furlong", dpi: 300 }, // unknown unit
    { name: "NoDpi", w: 8, h: 6, unit: "in", dpi: 0 }, // bad resolution
    null,
    "nope",
  ]);
  eq(out.length, 1);
  eq(out[0]!.name, "Good");
});

test("sanitisePresets cuts a hostile list down to the cap", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, w: 1, h: 1, unit: "px", dpi: 72 }));
  eq(sanitisePresets(many).length, 40);
  eq(sanitisePresets("not a list").length, 0);
});

test("a project file over the JSON ceiling is refused by name", () => {
  // Parsing allocates before structure is validated, so the limit has to be
  // cheaper to check than the parse. 256 MB of tiny objects killed a renderer.
  assert.equal(jsonImportRefusal(64 * 1024 * 1024), null);
  const refusal = jsonImportRefusal(256 * 1024 * 1024);
  assert.ok(refusal !== null && refusal.includes("256 MB"));
  assert.ok(jsonImportRefusal(65 * 1024 * 1024) !== null);
});

test("a picture larger than the canvas limit is refused before it is copied", () => {
  assert.equal(imageImportRefusal(8000, 6000), null);
  const tooWide = imageImportRefusal(20000, 400);
  assert.match(String(tooWide), /up to 16384 px per side/);
  assert.match(String(tooWide), /20000 x 400/);
  assert.equal(imageImportRefusal(20000, 400) !== null, true);
  assert.match(String(imageImportRefusal(0, 10)), /usable size/);
});
