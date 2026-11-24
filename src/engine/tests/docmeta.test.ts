import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PRESETS,
  MAX_DIM,
  MAX_JSON_BYTES,
  dimensionsToPixels,
  imageSizeMb,
  sniffImageSize,
  pxToUnit,
  sanitisePresets,
  unitToPx,
  jsonImportRefusal,
  jsonShapeRefusal,
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
  assert.equal(jsonImportRefusal(MAX_JSON_BYTES), null);
  const refusal = jsonImportRefusal(MAX_JSON_BYTES + 1024 * 1024);
  assert.ok(refusal !== null && refusal.includes("192 MB"));
});

test("a picture larger than the canvas limit is refused before it is copied", () => {
  assert.equal(imageImportRefusal(8000, 6000), null);
  const tooWide = imageImportRefusal(20000, 400);
  assert.match(String(tooWide), /up to 16384 px per side/);
  assert.match(String(tooWide), /20000 x 400/);
  // A per-side ceiling is not an area ceiling: 10000 x 10000 is 400 MB of pixels
  // from a few KB of PNG (sec-r6).
  const tooBig = imageImportRefusal(10000, 10000);
  assert.match(String(tooBig), /megapixels/);
  assert.equal(imageImportRefusal(9000, 8000) !== null, true);
  assert.equal(imageImportRefusal(20000, 400) !== null, true);
  assert.match(String(imageImportRefusal(0, 10)), /usable size/);
});

test("a raster header is read before the decoder allocates anything", () => {
  // PNG IHDR: signature, length, "IHDR", width, height (big-endian).
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  png.set([0, 0, 0x4e, 0x20, 0, 0, 0x27, 0x10], 16); // 20000 x 10000
  assert.deepEqual(sniffImageSize(png), { width: 20000, height: 10000 });

  // GIF screen descriptor is little-endian.
  const gif = new Uint8Array(10);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02], 0);
  assert.deepEqual(sniffImageSize(gif), { width: 0x0320, height: 0x0258 });

  // BMP: "BM", DIB size 40, width/height as i32 little-endian.
  const bmp = new Uint8Array(30);
  bmp.set([0x42, 0x4d], 0);
  bmp.set([40, 0, 0, 0], 14);
  bmp.set([0x40, 0x01, 0, 0], 18); // 320
  bmp.set([0xf0, 0x00, 0, 0], 22); // 240
  assert.deepEqual(sniffImageSize(bmp), { width: 320, height: 240 });

  // JPEG: SOI, APP0 skip, then SOF0 with height at +5 and width at +7.
  const jpg = new Uint8Array(26);
  jpg.set([0xff, 0xd8], 0);
  jpg.set([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 2);
  jpg.set([0xff, 0xc0, 0x00, 0x11, 0x08], 8);
  jpg.set([0x02, 0x58, 0x03, 0x20], 13); // 600 x 800
  const got = sniffImageSize(jpg);
  assert.deepEqual(got, { width: 800, height: 600 });

  assert.equal(sniffImageSize(new Uint8Array([1, 2, 3, 4])), null);
});

test("a WebP header is read before decode, including the extended canvas size", () => {
  const vp8x = new Uint8Array(32);
  vp8x.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
  vp8x.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const w = 20000 - 1, h = 8000 - 1;
  vp8x[24] = w & 0xff; vp8x[25] = (w >> 8) & 0xff; vp8x[26] = (w >> 16) & 0xff;
  vp8x[27] = h & 0xff; vp8x[28] = (h >> 8) & 0xff; vp8x[29] = (h >> 16) & 0xff;
  assert.deepEqual(sniffImageSize(vp8x), { width: 20000, height: 8000 });
  assert.ok(imageImportRefusal(20000, 8000), "a WebP that large must be refused");
});

test("jsonShapeRefusal: a file of brackets is refused before it is parsed", () => {
  // 190 MB of "[[],[],…]" parses into tens of millions of arrays: the size cap
  // alone does not bound the shape.
  const bomb = "[".repeat(4_000_001);
  assert.match(jsonShapeRefusal(bomb) ?? "", /more than 4,000,000 elements/);
  // One array, four million scalars: the bracket count alone called this small
  // enough to parse, and JSON.parse then allocated every element (sec-r30 #5).
  const flat = "[1" + ",1".repeat(4_000_001) + "]";
  assert.match(jsonShapeRefusal(flat) ?? "", /more than 4,000,000 elements/);
  assert.equal(jsonShapeRefusal('{"version":1,"layers":[]}'), null);
});
