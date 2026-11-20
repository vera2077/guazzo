import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { Document, setMaskAt } from "../document.ts";
import { buildPsd, psdBlendName } from "../psdexport.ts";
import { psdToDocument, type PsdLike } from "../psd.ts";
import { gridBBox } from "../transform.ts";
import { eq } from "./helpers.ts";

// real ag-psd bytes, same harness as psd.test.ts (real .pnpm path: sandbox
// junctions are not followed by node resolution; positional canvas shims)
const require = createRequire(import.meta.url);
const ag = require("../../../node_modules/.pnpm/ag-psd@34.2.1/node_modules/ag-psd/dist/index.js") as {
  writePsd: (psd: unknown, options?: unknown) => ArrayBuffer;
  readPsd: (buf: Uint8Array, options?: unknown) => unknown;
  initializeCanvas: (createCanvas: unknown, createImageData: unknown) => void;
};
ag.initializeCanvas(
  (w: number, h: number) => ({ width: w, height: h, getContext: () => null, addEventListener() {}, removeEventListener() {}, style: {} }),
  (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
);

test("blend mode names are written the way Photoshop spells them", () => {
  eq(psdBlendName("color-burn"), "color burn");
  eq(psdBlendName("linear-dodge"), "linear dodge");
  eq(psdBlendName("normal"), "normal");
});

test("layers export a tile-aligned bounding box, never the whole canvas by accident", () => {
  const doc = new Document(600, 600);
  const layer = doc.addLayer("Patch");
  layer.grid.fillRect(300, 300, 6, 4, [255, 0, 0, 255]);
  const psd = buildPsd(doc);
  eq(psd.width, 600);
  eq(psd.height, 600);
  const patch = psd.children[0]!;
  // the bbox is the allocated TILE extent (256 px aligned), not the 6×4 ink:
  // tiles are the unit of allocation, so anything finer would read unallocated
  // pixels into the file.
  eq(patch.left, 256);
  eq(patch.top, 256);
  eq(patch.right, 512);
  eq(patch.bottom, 512);
  eq(patch.imageData?.width, 256);
  eq(patch.imageData?.height, 256);
  const at = (x: number, y: number): number => patch.imageData!.data[(y * 256 + x) * 4]!;
  eq(at(300 - 256, 300 - 256), 255);
  eq(at(0, 0), 0);
});

test("layer opacity, visibility and blend mode survive into the PSD object", () => {
  const doc = new Document(20, 20);
  const layer = doc.addLayer("Blended");
  layer.opacity = 0.5;
  layer.visible = false;
  layer.blendMode = "multiply";
  layer.grid.fillRect(0, 0, 4, 4, [10, 20, 30, 255]);
  const out = buildPsd(doc).children[0]!;
  eq(out.opacity, 0.5);
  eq(out.hidden, true);
  eq(out.blendMode, "multiply");
});

test("an empty layer exports a zero rect instead of a buffer", () => {
  const doc = new Document(32, 32);
  doc.addLayer("Empty");
  const out = buildPsd(doc).children[0]!;
  eq(out.left, 0);
  eq(out.right, 0);
  eq(out.imageData, undefined);
});

test("an adjustment kind without a record still falls back to the flatten hook", () => {
  const doc = new Document(16, 16);
  doc.addAdjustLayer({ kind: "desaturate" });
  const adj = doc.layers[0]!;
  eq(adj.kind, "adjust");
  // desaturate has no Photoshop adjustment-layer record: without a hook it
  // cannot be represented
  eq(buildPsd(doc).children.length, 0);
  // with one, it becomes pixels
  const data = new Uint8ClampedArray(4 * 4 * 4).fill(90);
  const withHook = buildPsd(doc, () => ({ x: 2, y: 2, w: 4, h: 4, data }));
  eq(withHook.children.length, 1);
  const flat = withHook.children[0]!;
  eq(flat.left, 2);
  eq(flat.imageData?.width, 4);
  eq(flat.__flattened, true);
  eq(flat.blendMode, "normal");
});

test("invert, threshold and posterize export as live adjustment records", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({ kind: "invert" });
  const threshold = doc.addAdjustLayer({ kind: "threshold", thresholdLevel: 77 });
  threshold.opacity = 0.5;
  threshold.visible = false;
  doc.addAdjustLayer({ kind: "posterize", posterizeLevels: 5 });

  const psd = buildPsd(doc);
  eq(psd.children.length, 3);
  assert.deepEqual(psd.children[0]!.adjustment, { type: "invert" });
  assert.deepEqual(psd.children[1]!.adjustment, { type: "threshold", level: 77 });
  assert.deepEqual(psd.children[2]!.adjustment, { type: "posterize", levels: 5 });
  eq(psd.children[1]!.opacity, 0.5);
  eq(psd.children[1]!.hidden, true);
  for (const child of psd.children) {
    eq(child.imageData, undefined);
    eq(child.__flattened, undefined);
  }
});

test("threshold levels are clamped to Photoshop's 1–255 range", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({ kind: "threshold", thresholdLevel: 0 });
  doc.addAdjustLayer({ kind: "threshold", thresholdLevel: 999 });
  const low = buildPsd(doc).children[0]!;
  const high = buildPsd(doc).children[1]!;
  assert.deepEqual(low.adjustment, { type: "threshold", level: 1 });
  assert.deepEqual(high.adjustment, { type: "threshold", level: 255 });
});

test("curve knots export in Photoshop's 0–255 channel layout", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "curves",
    curves: { rgb: [{ x: 0, y: 0 }, { x: 64, y: 80 }, { x: 255, y: 255 }] },
  });
  const out = buildPsd(doc).children[0]!;
  assert.deepEqual(out.adjustment, {
    type: "curves",
    channels: [[
      { input: 0, output: 0 },
      { input: 64, output: 80 },
      { input: 255, output: 255 },
    ]],
  });
});

test("per-channel curves use an identity composite and the effective channel knots", () => {
  const identity = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "curves",
    curves: {
      rgb: identity,
      r: [{ x: 0, y: 0 }, { x: 128, y: 140 }, { x: 255, y: 250 }],
      b: [{ x: 0, y: 12 }, { x: 255, y: 240 }],
    },
  });
  const out = buildPsd(doc).children[0]!;
  assert.deepEqual(out.adjustment, {
    type: "curves",
    channels: [
      [{ input: 0, output: 0 }, { input: 255, output: 255 }],
      [{ input: 0, output: 0 }, { input: 128, output: 140 }, { input: 255, output: 250 }],
      [{ input: 0, output: 0 }, { input: 255, output: 255 }],
      [{ input: 0, output: 12 }, { input: 255, output: 240 }],
    ],
  });
});

test("a curve with fewer than two knots falls back to flattening", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({ kind: "curves", curves: { rgb: [{ x: 0, y: 0 }] } });
  eq(buildPsd(doc).children.length, 0);
  const data = new Uint8ClampedArray(4 * 4 * 4).fill(50);
  const withHook = buildPsd(doc, () => ({ x: 0, y: 0, w: 4, h: 4, data }));
  eq(withHook.children.length, 1);
  eq(withHook.children[0]!.__flattened, true);
});

test("curves survive real PSD bytes with their knots intact", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "curves",
    curves: {
      rgb: [{ x: 0, y: 0 }, { x: 192, y: 170 }, { x: 255, y: 255 }],
      r: [{ x: 0, y: 0 }, { x: 128, y: 140 }, { x: 255, y: 250 }],
    },
  });
  const psd = buildPsd(doc);
  const bytes = new Uint8Array(ag.writePsd(psd));
  type ReadAdjustment = { type: string; channels?: { input: number; output: number }[][] };
  type ReadLayer = { name: string; adjustment?: ReadAdjustment };
  const read = ag.readPsd(bytes, { useImageData: true }) as { children?: ReadLayer[] };
  const byName = new Map((read.children ?? []).map((layer) => [layer.name, layer]));
  assert.deepEqual(byName.get("Curves")?.adjustment, {
    type: "curves",
    channels: [
      [{ input: 0, output: 0 }, { input: 255, output: 255 }],
      [{ input: 0, output: 0 }, { input: 128, output: 140 }, { input: 255, output: 250 }],
      [{ input: 0, output: 0 }, { input: 192, output: 170 }, { input: 255, output: 255 }],
      [{ input: 0, output: 0 }, { input: 192, output: 170 }, { input: 255, output: 255 }],
    ],
  });
});

test("adjustment records survive real PSD bytes", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({ kind: "invert" });
  doc.addAdjustLayer({ kind: "threshold", thresholdLevel: 77 });
  doc.addAdjustLayer({ kind: "posterize", posterizeLevels: 5 });

  // PSD-level round trip only: the Guazzo importer still admits every
  // adjustment record until slice step 5, so the recipe does not survive a
  // full Guazzo save/open loop yet.
  // No flatten hook: this test would fail if the exporter still flattened the
  // three kinds instead of writing their records.
  const psd = buildPsd(doc);
  const bytes = new Uint8Array(ag.writePsd(psd));
  type ReadAdjustment = { type: string; levels?: number; level?: number };
  type ReadLayer = { name: string; adjustment?: ReadAdjustment };
  const read = ag.readPsd(bytes, { useImageData: true }) as { children?: ReadLayer[] };
  const byName = new Map((read.children ?? []).map((layer) => [layer.name, layer]));
  assert.deepEqual(byName.get("Invert")?.adjustment, { type: "invert" });
  assert.deepEqual(byName.get("Threshold")?.adjustment, { type: "threshold", level: 77 });
  assert.deepEqual(byName.get("Posterize")?.adjustment, { type: "posterize", levels: 5 });
});

test("a layer that overflows the canvas still exports canvas-sized pixels", () => {
  const doc = new Document(10, 10);
  const layer = doc.addLayer("Overflow");
  layer.grid.fillRect(-4, -4, 20, 20, [1, 2, 3, 255]);
  const out = buildPsd(doc).children[0]!;
  eq(out.left, 0);
  eq(out.top, 0);
  eq(out.right, 10);
  eq(out.bottom, 10);
  eq(out.imageData?.width, 10);
  eq(out.imageData?.height, 10);
  const box = gridBBox(layer.grid);
  eq(box?.x, 0);
});

test("layer masks are baked into the exported alpha (symmetric with import)", () => {
  const doc = new Document(6, 4);
  const masked = doc.addLayer("Masked");
  masked.grid.fillRect(1, 1, 3, 2, [255, 0, 0, 255]);
  const mask = doc.attachMask(masked);
  setMaskAt(mask, 3, 1, 0); // hide the right column of the patch
  setMaskAt(mask, 3, 2, 0);
  const out = buildPsd(doc).children[0]!;
  const data = out.imageData!.data;
  // hidden pixel: alpha 0 (and zeroed rgb); revealed pixel: intact
  const at = (x: number, y: number): number => (y * 6 + x) * 4;
  eq(data[at(3, 1) + 3], 0);
  eq(data[at(3, 2) + 3], 0);
  eq(data[at(1, 1) + 3], 255);
  eq(data[at(1, 1)], 255);
});

test("clipToBelow exports as a PSD clipping layer", () => {
  const doc = new Document(6, 4);
  doc.addLayer("Base").grid.fillRect(1, 1, 2, 2, [255, 0, 0, 255]);
  const fillL = doc.addFillLayer([0, 128, 255], "Fill");
  fillL.clipToBelow = true;
  const psd = buildPsd(doc, (layer) => {
    if (layer.kind !== "fill") return null;
    const d = new Uint8ClampedArray(6 * 4 * 4);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = layer.fill!.color[0]; d[i + 1] = layer.fill!.color[1];
      d[i + 2] = layer.fill!.color[2]; d[i + 3] = 255;
    }
    return { x: 0, y: 0, w: 6, h: 4, data: d };
  });
  eq(psd.children[1]!.clipping, true);
  eq(psd.children[0]!.clipping, false);
});

test("masked + clipped document round-trips through real PSD bytes", () => {
  const doc = new Document(6, 4);
  doc.addLayer("BG").grid.fillRect(0, 0, 6, 4, [255, 255, 255, 255]);
  const masked = doc.addLayer("Masked");
  masked.grid.fillRect(1, 1, 3, 2, [255, 0, 0, 255]);
  const mask = doc.attachMask(masked);
  setMaskAt(mask, 3, 1, 0);
  setMaskAt(mask, 3, 2, 0);
  const fillL = doc.addFillLayer([0, 128, 255], "Fill");
  fillL.clipToBelow = true;

  const psd = buildPsd(doc, (layer) => {
    if (layer.kind !== "fill") return null;
    const d = new Uint8ClampedArray(6 * 4 * 4);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = layer.fill!.color[0]; d[i + 1] = layer.fill!.color[1];
      d[i + 2] = layer.fill!.color[2]; d[i + 3] = 255;
    }
    return { x: 0, y: 0, w: 6, h: 4, data: d };
  });

  // the real byte path: write → parse → rebuild → composite must match
  const bytes = new Uint8Array(ag.writePsd(psd));
  const read = ag.readPsd(bytes, { useImageData: true }) as PsdLike;
  const back = psdToDocument(read);
  eq(back.layers.length, 3);
  eq(back.layers[2]!.clipToBelow, true);
  eq(back.layers[2]!.visible, true);
  assert.deepEqual(back.composite(), doc.composite());
});
