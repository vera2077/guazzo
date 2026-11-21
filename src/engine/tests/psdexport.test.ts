import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { Document, setMaskAt } from "../document.ts";
import { buildPsd, buildPsdForExport, psdBlendName, psdExportLoss } from "../psdexport.ts";
import { psdToDocument, type PsdLike } from "../psd.ts";
import { emptyImportReport } from "../importreport.ts";
import { gridBBox } from "../transform.ts";
import { curveLut } from "../tone.ts";
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
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "curves",
    curves: {
      // rgb is deliberately not identity: channel 0 must be the identity
      // curve, not the rgb knots, or Photoshop would apply rgb twice.
      rgb: [{ x: 0, y: 0 }, { x: 128, y: 90 }, { x: 255, y: 255 }],
      r: [{ x: 0, y: 0 }, { x: 128, y: 140 }, { x: 255, y: 250 }],
    },
  });
  const out = buildPsd(doc).children[0]!;
  assert.deepEqual(out.adjustment, {
    type: "curves",
    channels: [
      [{ input: 0, output: 0 }, { input: 255, output: 255 }],
      [{ input: 0, output: 0 }, { input: 128, output: 140 }, { input: 255, output: 250 }],
      // green and blue have no override, so they carry the non-identity rgb
      // fallback. With identity rgb this branch would be invisible.
      [{ input: 0, output: 0 }, { input: 128, output: 90 }, { input: 255, output: 255 }],
      [{ input: 0, output: 0 }, { input: 128, output: 90 }, { input: 255, output: 255 }],
    ],
  });
});

test("duplicate curve inputs keep the last knot", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "curves",
    curves: {
      rgb: [{ x: 0, y: 0 }, { x: 128, y: 10 }, { x: 128, y: 200 }, { x: 255, y: 255 }],
    },
  });
  const out = buildPsd(doc).children[0]!;
  assert.deepEqual(out.adjustment, {
    type: "curves",
    channels: [[
      { input: 0, output: 0 },
      { input: 128, output: 200 },
      { input: 255, output: 255 },
    ]],
  });
});

test("brightness/contrast exports the modern flag and survives bytes", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({ kind: "brightness-contrast", brightness: 30, contrast: -20 });
  assert.deepEqual(buildPsd(doc).children[0]!.adjustment, {
    type: "brightness/contrast",
    brightness: 30,
    contrast: -20,
    useLegacy: false,
  });

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const read = ag.readPsd(bytes, { useImageData: true }) as {
    children?: { name: string; adjustment?: Record<string, unknown> }[];
  };
  const adj = read.children?.find((layer) => layer.name === "Brightness/Contrast")?.adjustment;
  eq(adj?.type, "brightness/contrast");
  eq(adj?.brightness, 30);
  eq(adj?.contrast, -20);
  // ag-psd may omit the modern flag rather than return false; only `true`
  // would mean the legacy brit block won.
  assert.notEqual(adj?.useLegacy, true);
});

test("photo filter exports its RGB colour, density and luminosity flag", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "photo-filter",
    photoFilter: { color: [236, 138, 0], density: 25, preserveLuminosity: false },
  });
  assert.deepEqual(buildPsd(doc).children[0]!.adjustment, {
    type: "photo filter",
    color: { r: 236, g: 138, b: 0 },
    density: 25,
    preserveLuminosity: false,
  });

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const read = ag.readPsd(bytes, { useImageData: true }) as {
    children?: { name: string; adjustment?: Record<string, unknown> }[];
  };
  const adj = read.children?.find((layer) => layer.name === "Photo Filter")?.adjustment;
  eq(adj?.type, "photo filter");
  assert.deepEqual(adj?.color, { r: 236, g: 138, b: 0 });
  eq(adj?.density, 25);
  eq(adj?.preserveLuminosity, false);
});

test("color balance maps the three ranges to the record's channel names", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "color-balance",
    colorBalance: {
      shadows: { r: -10, g: 20, b: 30 },
      midtones: { r: 11, g: -22, b: 33 },
      highlights: { r: 44, g: 55, b: -66 },
      preserveLuminosity: true,
    },
  });
  assert.deepEqual(buildPsd(doc).children[0]!.adjustment, {
    type: "color balance",
    shadows: { cyanRed: -10, magentaGreen: 20, yellowBlue: 30 },
    midtones: { cyanRed: 11, magentaGreen: -22, yellowBlue: 33 },
    highlights: { cyanRed: 44, magentaGreen: 55, yellowBlue: -66 },
    preserveLuminosity: true,
  });

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const read = ag.readPsd(bytes, { useImageData: true }) as {
    children?: { name: string; adjustment?: Record<string, unknown> }[];
  };
  const adj = read.children?.find((layer) => layer.name === "Colour Balance")?.adjustment;
  eq(adj?.type, "color balance");
  assert.deepEqual(adj?.shadows, { cyanRed: -10, magentaGreen: 20, yellowBlue: 30 });
  assert.deepEqual(adj?.midtones, { cyanRed: 11, magentaGreen: -22, yellowBlue: 33 });
  assert.deepEqual(adj?.highlights, { cyanRed: 44, magentaGreen: 55, yellowBlue: -66 });
  eq(adj?.preserveLuminosity, true);
});

test("black & white exports six weights and never a tint", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "black-white",
    blackWhite: { r: 40, g: 60, b: 50, c: 70, m: 30, y: 20 },
  });
  assert.deepEqual(buildPsd(doc).children[0]!.adjustment, {
    type: "black & white",
    reds: 40,
    yellows: 20,
    greens: 60,
    cyans: 70,
    blues: 50,
    magentas: 30,
    useTint: false,
  });

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const read = ag.readPsd(bytes, { useImageData: true }) as {
    children?: { name: string; adjustment?: Record<string, unknown> }[];
  };
  const adj = read.children?.find((layer) => layer.name === "Black & White")?.adjustment;
  eq(adj?.type, "black & white");
  eq(adj?.reds, 40);
  eq(adj?.yellows, 20);
  eq(adj?.greens, 60);
  eq(adj?.cyans, 70);
  eq(adj?.blues, 50);
  eq(adj?.magentas, 30);
  eq(adj?.useTint, false);
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

test("a document with one unrepresentable layer exports as a single composite", () => {
  const doc = new Document(8, 8);
  doc.addLayer("BG").grid.fillRect(0, 0, 8, 8, [10, 20, 30, 255]);
  doc.addAdjustLayer({ kind: "desaturate" });

  const { psd, admission } = buildPsdForExport(doc, "Composite");
  eq(psd.children.length, 1);
  const only = psd.children[0]!;
  assert.ok(only.imageData);
  assert.deepEqual(Array.from(only.imageData.data), Array.from(doc.composite()));
  eq(admission, "a single flattened image because 1 layer has no live PSD record (desaturate)");
});

test("export loss counts the root group, not the child that blocks it", () => {
  const doc = new Document(8, 8);
  const group = doc.addGroup("Group A");
  const adjustment = doc.addAdjustLayer({ kind: "invert" });
  doc.attachMask(adjustment);
  doc.moveLayerTo(null, adjustment, doc.layers.indexOf(adjustment), group, 0);

  const loss = psdExportLoss(doc);
  eq(loss.blocked.length, 1);
  eq(loss.blocked[0], group);
  eq(loss.notes.length, 0);
  eq(
    loss.admission,
    "a single flattened image because 1 layer has no live PSD record (group)",
  );
  assert.doesNotMatch(loss.admission, /adjustment|invert/i);
});

test("export loss does not composite an 8192² document", () => {
  const doc = new Document(8192, 8192);
  doc.addLayer("A");
  doc.addLayer("B");
  doc.addAdjustLayer({ kind: "desaturate" });

  const started = performance.now();
  const loss = psdExportLoss(doc);
  const elapsed = performance.now() - started;
  eq(loss.blocked.length, 1);
  assert.ok(elapsed < 20, `psdExportLoss took ${elapsed.toFixed(1)} ms (must not composite)`);
});

test("pixel, invert and curves export as three record-bearing layers", () => {
  const doc = new Document(8, 8);
  doc.addLayer("BG").grid.fillRect(0, 0, 8, 8, [10, 20, 30, 255]);
  doc.addAdjustLayer({ kind: "invert" });
  doc.addAdjustLayer({
    kind: "curves",
    curves: { rgb: [{ x: 0, y: 0 }, { x: 128, y: 90 }, { x: 255, y: 255 }] },
  });

  const { psd, admission } = buildPsdForExport(doc, "Composite");
  eq(admission, "");
  eq(psd.children.length, 3);
  assert.ok(psd.children[0]!.imageData);
  assert.deepEqual(psd.children[1]!.adjustment, { type: "invert" });
  assert.deepEqual(psd.children[2]!.adjustment, {
    type: "curves",
    channels: [[
      { input: 0, output: 0 },
      { input: 128, output: 90 },
      { input: 255, output: 255 },
    ]],
  });
  eq(psd.children[1]!.__flattened, undefined);
});

test("solid fill layers export as live colour content and import back live", () => {
  const doc = new Document(8, 8);
  doc.addFillLayer([12, 34, 56], "Solid");
  const { psd, admission } = buildPsdForExport(doc, "Composite");
  eq(admission, "");
  eq(psd.children.length, 1);
  assert.deepEqual(psd.children[0]!.vectorFill, {
    type: "color",
    color: { r: 12, g: 34, b: 56 },
  });
  eq(psd.children[0]!.imageData, undefined);

  const bytes = new Uint8Array(ag.writePsd(psd));
  const read = ag.readPsd(bytes, { useImageData: true }) as PsdLike;
  assert.deepEqual(read.children![0]!.vectorFill, {
    type: "color",
    color: { r: 12, g: 34, b: 56 },
  });
  const report = emptyImportReport();
  const back = psdToDocument(read, report);
  eq(back.layers[0]!.kind, "fill");
  assert.deepEqual(back.layers[0]!.fill?.color, [12, 34, 56]);
  eq(report.avoided.length, 0);
  assert.deepEqual(back.composite(), doc.composite());
});

test("a masked fill is not representable and exports as one composite", () => {
  const doc = new Document(8, 8);
  const fill = doc.addFillLayer([12, 34, 56], "Masked fill");
  setMaskAt(doc.attachMask(fill), 0, 0, 0);
  const { psd, admission } = buildPsdForExport(doc, "Composite");
  eq(psd.children.length, 1);
  assert.ok(psd.children[0]!.imageData);
  assert.deepEqual(psd.children[0]!.imageData!.data, doc.composite());
  eq(admission, "a single flattened image because 1 layer has no live PSD record (fill)");
});

test("gradient fills are admitted instead of pretending they are solid", () => {
  const report = emptyImportReport();
  const back = psdToDocument({
    width: 8,
    height: 8,
    children: [{
      name: "Gradient",
      left: 0, top: 0, right: 8, bottom: 8,
      vectorFill: { type: "solid" },
    }],
  }, report);
  eq(back.layers[0]!.kind, "pixel");
  eq(report.avoided.length, 1);
  eq(report.avoided[0]!.feature, "fill");
  eq(report.avoided[0]!.detail, "gradient fill is rasterised; the live fill recipe is not carried");
});

test("contrast is clamped to Photoshop's -50..100 at the record boundary", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({ kind: "brightness-contrast", brightness: 0, contrast: -100 });
  assert.deepEqual(buildPsd(doc).children[0]!.adjustment, {
    type: "brightness/contrast",
    brightness: 0,
    contrast: -50,
    useLegacy: false,
  });
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

function gradientBackdrop(): Document {
  const doc = new Document(8, 8);
  const bg = doc.addLayer("BG");
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      data[i] = 16 + x * 28;
      data[i + 1] = 40 + y * 24;
      data[i + 2] = 220 - x * 20;
      data[i + 3] = 255;
    }
  }
  bg.grid.writeRect(0, 0, 8, 8, data);
  return doc;
}

function exportAndImport(doc: Document): { back: Document; avoided: ReturnType<typeof emptyImportReport>["avoided"] } {
  const { psd, admission } = buildPsdForExport(doc, "Composite");
  eq(admission, "");
  const bytes = new Uint8Array(ag.writePsd(psd));
  const read = ag.readPsd(bytes, { useImageData: true }) as PsdLike;
  const report = emptyImportReport();
  return { back: psdToDocument(read, report), avoided: report.avoided };
}

test("levels exports the composite channel and its gamma exponent", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({
    kind: "levels",
    levels: { inBlack: 10, inWhite: 240, gamma: 1.8, outBlack: 5, outWhite: 250 },
  });
  assert.deepEqual(buildPsd(doc).children[1]!.adjustment, {
    type: "levels",
    channels: [{
      shadowInput: 10,
      highlightInput: 240,
      shadowOutput: 5,
      highlightOutput: 250,
      midtoneInput: 1.8,
    }],
  });

  const { back, avoided } = exportAndImport(doc);
  const imported = back.layers[1]!;
  eq(imported.kind, "adjust");
  eq(imported.adjust?.kind, "levels");
  // The byte record stores the exponent in hundredths; 1.8 is exact there.
  eq(imported.adjust?.levels?.gamma, 1.8);
  eq(avoided.length, 0);
  assert.deepEqual(back.composite(), doc.composite());
});

test("levels gamma is quantised to the record's hundredths", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({
    kind: "levels",
    levels: { inBlack: 0, inWhite: 255, gamma: 1.855, outBlack: 0, outWhite: 255 },
  });
  assert.deepEqual(buildPsd(doc).children[1]!.adjustment, {
    type: "levels",
    channels: [{
      shadowInput: 0,
      highlightInput: 255,
      shadowOutput: 0,
      highlightOutput: 255,
      midtoneInput: 1.86,
    }],
  });

  const { back, avoided } = exportAndImport(doc);
  eq(back.layers[1]!.adjust?.levels?.gamma, 1.86);
  eq(avoided.length, 0);
  // The file cannot carry 1.855; the imported document must match the rounded
  // recipe, not a model value that was never written.
  const quantised = gradientBackdrop();
  quantised.addAdjustLayer({
    kind: "levels",
    levels: { inBlack: 0, inWhite: 255, gamma: 1.86, outBlack: 0, outWhite: 255 },
  });
  assert.deepEqual(back.composite(), quantised.composite());
});

test("exposure exports stops with offset and gamma set to their no-op values", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({ kind: "exposure", stops: 0.75 });
  assert.deepEqual(buildPsd(doc).children[1]!.adjustment, {
    type: "exposure",
    exposure: 0.75,
    offset: 0,
    gamma: 1,
  });

  const { back, avoided } = exportAndImport(doc);
  eq(back.layers[1]!.adjust?.kind, "exposure");
  eq(back.layers[1]!.adjust?.stops, 0.75);
  eq(avoided.length, 0);
  assert.deepEqual(back.composite(), doc.composite());
});

test("vibrance exports its amount and writes saturation as the no-op zero", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({ kind: "vibrance", amount: 40 });
  assert.deepEqual(buildPsd(doc).children[1]!.adjustment, {
    type: "vibrance",
    vibrance: 40,
    saturation: 0,
  });

  const { back, avoided } = exportAndImport(doc);
  eq(back.layers[1]!.adjust?.kind, "vibrance");
  eq(back.layers[1]!.adjust?.amount, 40);
  eq(avoided.length, 0);
  assert.deepEqual(back.composite(), doc.composite());
});

test("hue/saturation exports the master channel in model units", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({ kind: "hue-sat", hue: 30, saturation: 20, lightness: -10 });
  assert.deepEqual(buildPsd(doc).children[1]!.adjustment, {
    type: "hue/saturation",
    master: { hue: 30, saturation: 20, lightness: -10 },
  });

  const { back, avoided } = exportAndImport(doc);
  eq(back.layers[1]!.adjust?.kind, "hue-sat");
  eq(back.layers[1]!.adjust?.hue, 30);
  eq(back.layers[1]!.adjust?.saturation, 20);
  eq(back.layers[1]!.adjust?.lightness, -10);
  eq(avoided.length, 0);
  assert.deepEqual(back.composite(), doc.composite());
});

test("invert, threshold and posterize import back into live recipes", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({ kind: "invert" });
  doc.addAdjustLayer({ kind: "threshold", thresholdLevel: 77 });
  doc.addAdjustLayer({ kind: "posterize", posterizeLevels: 5 });

  const { back, avoided } = exportAndImport(doc);
  eq(avoided.length, 0);
  assert.deepEqual(back.layers.map((l) => l.adjust?.kind), [undefined, "invert", "threshold", "posterize"]);
  assert.deepEqual(back.composite(), doc.composite());
});

test("brightness, photo filter, color balance and black & white import back", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({ kind: "brightness-contrast", brightness: 30, contrast: -20 });
  doc.addAdjustLayer({
    kind: "photo-filter",
    photoFilter: { color: [236, 138, 0], density: 25, preserveLuminosity: false },
  });
  doc.addAdjustLayer({
    kind: "color-balance",
    colorBalance: {
      shadows: { r: 10, g: -5, b: 2 },
      midtones: { r: -3, g: 8, b: -7 },
      highlights: { r: 4, g: -2, b: 12 },
      preserveLuminosity: true,
    },
  });
  doc.addAdjustLayer({
    kind: "black-white",
    blackWhite: { r: 40, g: 60, b: 40, c: 60, m: 20, y: 80 },
  });

  const { back, avoided } = exportAndImport(doc);
  eq(avoided.length, 0);
  assert.deepEqual(
    back.layers.slice(1).map((l) => l.adjust?.kind),
    ["brightness-contrast", "photo-filter", "color-balance", "black-white"],
  );
  assert.deepEqual(back.composite(), doc.composite());
});

test("curves import folds composite and per-channel curves once, within one level", () => {
  const report = emptyImportReport();
  const back = psdToDocument({
    width: 8,
    height: 8,
    children: [{
      name: "Curves",
      adjustment: {
        type: "curves",
        channels: [
          [{ input: 0, output: 0 }, { input: 255, output: 128 }],
          [{ input: 0, output: 0 }, { input: 255, output: 64 }],
        ],
      },
    }],
  } as PsdLike, report);
  const curves = back.layers[0]!.adjust?.curves;
  assert.ok(curves);
  assert.deepEqual(curves.rgb, [{ x: 0, y: 0 }, { x: 255, y: 255 }]);
  eq(curves.r?.[0]?.x, 0);
  eq(curves.r?.[curves.r.length - 1]?.x, 255);
  const imported = curveLut(curves.r!);
  const composite = curveLut([{ x: 0, y: 0 }, { x: 255, y: 128 }]);
  const red = curveLut([{ x: 0, y: 0 }, { x: 255, y: 64 }]);
  let worst = 0;
  for (let i = 0; i < 256; i++) worst = Math.max(worst, Math.abs(imported[i]! - red[composite[i]!]!));
  assert.ok(worst <= 1, `folded curve should stay within one level, got ${worst}`);
  assert.ok(curves.r!.length <= 32);
  eq(report.avoided.length, 0);
});

test("curves import keeps the file's knots instead of expanding them to a LUT", () => {
  const psd = {
    width: 8,
    height: 8,
    children: [{
      name: "Curves",
      adjustment: {
        type: "curves",
        channels: [[
          { input: 0, output: 10 },
          { input: 255, output: 245 },
        ]],
      },
    }],
  };
  const bytes = new Uint8Array(ag.writePsd(psd));
  const read = ag.readPsd(bytes, { useImageData: true }) as PsdLike;
  const back = psdToDocument(read);
  const curves = back.layers[0]!.adjust?.curves;
  assert.ok(curves);
  // A two-knot file is a two-knot model: the editor can draw it and a drag
  // grabs one of two points, not one of 256.
  assert.deepEqual(curves.rgb, [{ x: 0, y: 10 }, { x: 255, y: 245 }]);
});

test("curves import keeps a four-knot S-curve as four knots", () => {
  const psd = {
    width: 8,
    height: 8,
    children: [{
      name: "Curves",
      adjustment: {
        type: "curves",
        channels: [[
          { input: 0, output: 0 },
          { input: 64, output: 80 },
          { input: 192, output: 200 },
          { input: 255, output: 255 },
        ]],
      },
    }],
  };
  const bytes = new Uint8Array(ag.writePsd(psd));
  const read = ag.readPsd(bytes, { useImageData: true }) as PsdLike;
  const back = psdToDocument(read);
  const curves = back.layers[0]!.adjust?.curves;
  assert.ok(curves);
  assert.deepEqual(curves.rgb, [
    { x: 0, y: 0 },
    { x: 64, y: 80 },
    { x: 192, y: 200 },
    { x: 255, y: 255 },
  ]);
});

test("curves with only the pencil values still import as a curve", () => {
  const report = emptyImportReport();
  const values = Array.from({ length: 256 }, (_, i) => 255 - i);
  const back = psdToDocument({
    width: 8,
    height: 8,
    children: [{ name: "Pencil", adjustment: { type: "curves", values: [values] } }],
  } as PsdLike, report);
  const curves = back.layers[0]!.adjust?.curves;
  assert.ok(curves);
  // The pencil table is simplified to knots; evaluate the model's spline at
  // the sampled x values rather than assuming one knot per byte.
  const lut = curveLut(curves.rgb);
  eq(lut[10], 245);
  eq(lut[255], 0);
  assert.ok(curves.rgb.length < 256);
  eq(report.avoided.length, 0);
});

test("dense curves export as a pencil table and import within one level", () => {
  const doc = gradientBackdrop();
  const dense = [{ x: 0, y: 0 }];
  for (let i = 1; i < 19; i++) {
    const x = Math.round((i * 255) / 19);
    dense.push({ x, y: Math.round(255 * Math.pow(x / 255, 1.8)) });
  }
  dense.push({ x: 255, y: 255 });
  doc.addAdjustLayer({ kind: "curves", curves: { rgb: dense } });

  const record = buildPsd(doc).children[1]!.adjustment;
  assert.ok(record && record.type === "curves" && "values" in record);
  eq("channels" in record, false);
  eq(record.values.length, 4);
  eq(record.values[0]!.length, 256);
  assert.notDeepEqual(record.values[0], record.values[1]);
  assert.deepEqual(record.values[1], record.values[2]);
  assert.deepEqual(record.values[2], record.values[3]);

  const { back, avoided } = exportAndImport(doc);
  eq(avoided.length, 0);
  const a = back.composite();
  const b = doc.composite();
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  // The pencil table is exact in the file; import simplifies the LUT to a
  // knot set, so one level of quantisation is the documented tolerance.
  assert.ok(worst <= 1, `dense curve round trip drifted by ${worst}`);
  const curves = back.layers[1]!.adjust?.curves;
  assert.ok(curves);
  assert.ok(curves.rgb.length <= 32);
});

test("legacy brightness/contrast is admitted by name, not ignored", () => {
  const report = emptyImportReport();
  const back = psdToDocument({
    width: 8,
    height: 8,
    children: [{
      name: "Brightness",
      adjustment: { type: "brightness/contrast", brightness: 20, contrast: 10, useLegacy: true },
    }],
  } as PsdLike, report);
  eq(back.layers[0]!.adjust?.kind, "brightness-contrast");
  assert.match(report.avoided[0]!.detail, /legacy brightness\/contrast/);
});

test("unmapped Photoshop records are admitted by their actual feature", () => {
  const report = emptyImportReport();
  const back = psdToDocument({
    width: 8,
    height: 8,
    children: [
      { name: "Mixer", adjustment: { type: "channel mixer", monochrome: true } },
      { name: "Map", adjustment: { type: "gradient map", gradientType: "solid" } },
      { name: "Lookup", adjustment: { type: "color lookup", lookupType: "3dlut" } },
      { name: "Selective", adjustment: { type: "selective color", mode: "relative" } },
    ],
  } as PsdLike, report);
  eq(back.layers.length, 4);
  eq(report.avoided.length, 4);
  assert.match(report.avoided[0]!.detail, /channel mixer/);
  assert.match(report.avoided[1]!.detail, /gradient map/);
  assert.match(report.avoided[2]!.detail, /color lookup/);
  assert.match(report.avoided[3]!.detail, /selective color/);
});

test("a text layer exports as a live type record and imports back as a recipe", () => {
  const doc = new Document(200, 100);
  const layer = doc.addLayer("Headline");
  const seg = (text: string, over: Partial<{ bold: boolean; italic: boolean; font: string }> = {}) => ({
    text, bold: false, italic: false, underline: false, strike: false, font: "Arial", ...over,
  });
  layer.textData = {
    lines: [
      [seg("Hi ", { bold: true }), seg("there", { italic: true, font: "Georgia" })],
      [seg("Next")],
    ],
    x: 37, y: 19, w: 120, h: 40, wrap: 200, boxH: 70,
    size: 24, color: [10, 20, 30], align: "center",
  };
  layer.grid.fillRect(37, 19, 120, 40, [1, 2, 3, 255]);

  const { psd, admission } = buildPsdForExport(doc, "Flattened");
  eq(admission, "");
  const live = psd.children[0]!.text;
  assert.ok(live);
  eq(live.text, "Hi there\rNext");
  eq(live.style.fontSize, 24);
  eq(live.paragraphStyle.justification, "center");
  assert.deepEqual(live.styleRuns.map(r => r.length), [3, 5, 1, 4]);
  eq(live.styleRuns[0]!.style.fauxBold, true);
  eq(live.styleRuns[1]!.style.fauxItalic, true);
  eq(live.styleRuns[1]!.style.font.name, "Georgia");
  assert.deepEqual(live.boxBounds, [37, 19, 200, 70]);
  eq(live.bounds.right.value - live.bounds.left.value, 200);

  const bytes = ag.writePsd(psd);
  const read = ag.readPsd(new Uint8Array(bytes), { useImageData: true }) as PsdLike;
  const report = emptyImportReport();
  const back = psdToDocument(read, report);
  const recipe = back.allLayers()[0]!.textData;
  assert.ok(recipe);
  eq(recipe.lines.length, 2);
  eq(recipe.lines[0]!.map(s => s.text).join(""), "Hi there");
  eq(recipe.lines[1]!.map(s => s.text).join(""), "Next");
  eq(recipe.lines[0]![0]!.bold, true);
  eq(recipe.lines[0]![1]!.italic, true);
  eq(recipe.lines[0]![1]!.font, "Georgia");
  eq(recipe.size, 24);
  assert.deepEqual(recipe.color, [10, 20, 30]);
  eq(recipe.align, "center");
  eq(recipe.wrap, 200);
  eq(recipe.boxH, 70);
  eq(report.avoided.length, 0);
  assert.deepEqual(report.substitutedFonts, []);
});

test("a text recipe that cannot be written is admitted and its pixels are kept", () => {
  const doc = new Document(20, 20);
  const layer = doc.addLayer("Broken Text");
  layer.grid.fillRect(2, 2, 4, 3, [9, 8, 7, 255]);
  layer.textData = {
    lines: [[{ text: "Hi", bold: false, italic: false, underline: false, strike: false, font: "Arial" }]],
    x: 2, y: 2, w: 4, h: 3, size: 0, color: [0, 0, 0],
  };
  const { psd, admission } = buildPsdForExport(doc, "Flattened");
  eq(psd.children.length, 1);
  eq(psd.children[0]!.text, undefined);
  assert.match(admission, /text recipe for “Broken Text” could not be written; pixels kept/);
});

test("a broken text recipe inside a group names the full layer path once", () => {
  const doc = new Document(20, 20);
  const group = doc.addGroup("Type");
  const inner = doc.addGroupTo(group, "Cover");
  const layer = doc.addLayerTo(inner, "Headline");
  layer.textData = {
    lines: [[{ text: "Hi", bold: false, italic: false, underline: false, strike: false, font: "Arial" }]],
    x: 0, y: 0, w: 4, h: 3, size: 0, color: [0, 0, 0],
  };
  const loss = psdExportLoss(doc);
  eq(loss.notes.length, 1);
  eq(loss.notes[0],
    "text recipe for “Type / Cover / Headline” could not be written; pixels kept");
  assert.match(buildPsdForExport(doc, "Flattened").admission, /Type \/ Cover \/ Headline/);
});

function roundTripComposite(doc: Document): { back: Document; admission: string } {
  const { psd, admission } = buildPsdForExport(doc, "Flattened");
  const bytes = ag.writePsd(psd);
  const read = ag.readPsd(new Uint8Array(bytes), { useImageData: true }) as PsdLike;
  return { back: psdToDocument(read, emptyImportReport()), admission };
}

function maskedPixelDocument(hide: boolean): Document {
  const doc = new Document(512, 16);
  const layer = doc.addLayer("Masked");
  layer.grid.fillRect(0, 0, 512, 16, [200, 60, 20, 255]);
  const mask = doc.attachMask(layer);
  layer.maskHide = hide;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 512; x++) {
      // Both polarities describe the same picture: left hidden, right revealed.
      // The hiding half stays unallocated when maskHide is true, so the export
      // has to ask maskAt() for the hidden default — not just read stored pixels.
      if (hide && x >= 256) setMaskAt(mask, x, y, 255);
      if (!hide && x < 256) setMaskAt(mask, x, y, 0);
      if (!hide && x >= 256) setMaskAt(mask, x, y, 255);
    }
  }
  return doc;
}

test("mask polarity survives PSD export: hidden pixels stay hidden in both polarities", () => {
  for (const hide of [false, true]) {
    const doc = maskedPixelDocument(hide);
    const before = doc.composite();
    const { back, admission } = roundTripComposite(doc);
    eq(admission, "");
    assert.deepEqual(back.composite(), before, `maskHide=${hide}`);
  }
});

function maskedLayerDocument(kind: "adjust" | "fill", hide: boolean): Document {
  const doc = new Document(16, 8);
  doc.addLayer("Base").grid.fillRect(0, 0, 16, 8, [100, 100, 100, 255]);
  const layer = kind === "adjust"
    ? doc.addAdjustLayer({ kind: "invert" })
    : doc.addFillLayer([220, 40, 40], "Fill");
  const mask = doc.attachMask(layer);
  layer.maskHide = hide;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      if (hide && x >= 8) setMaskAt(mask, x, y, 255);
      if (!hide && x < 8) setMaskAt(mask, x, y, 0);
    }
  }
  return doc;
}

test("a masked adjustment and a masked fill both round-trip as the same picture", () => {
  for (const kind of ["adjust", "fill"] as const) {
    for (const hide of [false, true]) {
      const doc = maskedLayerDocument(kind, hide);
      const before = doc.composite();
      const { back, admission } = roundTripComposite(doc);
      assert.match(admission, /flattened image/);
      assert.deepEqual(back.composite(), before, `${kind} maskHide=${hide}`);
    }
  }
});

test("nested groups export as children and keep their pass-through", () => {
  const doc = new Document(8, 8);
  doc.addLayer("Base").grid.fillRect(0, 0, 8, 8, [80, 90, 100, 255]);
  const outer = doc.addGroup("Shapes");
  outer.passThrough = true;
  const inner = doc.addGroupTo(outer, "Inner");
  inner.passThrough = true;
  doc.addLayerTo(inner, "Child").grid.fillRect(1, 1, 6, 6, [220, 40, 40, 255]);
  doc.addLayer("Top").grid.fillRect(0, 0, 2, 2, [10, 20, 30, 255]);

  const { psd, admission } = buildPsdForExport(doc, "Flattened");
  eq(admission, "");
  const groupOut = psd.children.find((c) => c.name === "Shapes");
  assert.ok(groupOut);
  eq(groupOut.blendMode, "pass through");
  eq(groupOut.children?.[0]?.name, "Inner");
  eq(groupOut.children?.[0]?.children?.[0]?.name, "Child");

  const read = ag.readPsd(new Uint8Array(ag.writePsd(psd)), { useImageData: true }) as PsdLike;
  const back = psdToDocument(read, emptyImportReport());
  const backOuter = back.layers.find((l) => l.name === "Shapes");
  assert.ok(backOuter);
  eq(backOuter.kind, "group");
  eq(backOuter.passThrough, true);
  const backInner = backOuter.children?.[0];
  assert.ok(backInner);
  eq(backInner.name, "Inner");
  eq(backInner.passThrough, true);
  eq(back.parentOf(backInner), backOuter);
  const backChild = backInner.children?.[0];
  assert.ok(backChild);
  eq(backChild.name, "Child");
  eq(back.parentOf(backChild), backInner);
  assert.deepEqual(back.composite(), doc.composite());
});

test("partial adjustment fields are admitted by name on import", () => {
  const report = emptyImportReport();
  const back = psdToDocument({
    width: 8,
    height: 8,
    children: [
      {
        name: "Levels",
        adjustment: {
          type: "levels",
          channels: [
            { shadowInput: 0, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 },
            { shadowInput: 1, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 },
          ],
        },
      },
      {
        name: "Exposure",
        adjustment: { type: "exposure", exposure: 1, offset: 0.5, gamma: 1.2 },
      },
      { name: "Vibrance", adjustment: { type: "vibrance", vibrance: 10, saturation: 5 } },
      {
        name: "Hue",
        adjustment: {
          type: "hue/saturation",
          master: { hue: 10, saturation: 0, lightness: 0 },
          reds: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 20, lightness: 0 },
        },
      },
      {
        name: "Tinted",
        adjustment: { type: "black & white", useTint: true, tintColor: { r: 10, g: 20, b: 30 } },
      },
    ],
  } as PsdLike, report);
  eq(back.layers.length, 5);
  eq(report.avoided.length, 5);
  assert.match(report.avoided[0]!.detail, /per-channel levels/);
  assert.match(report.avoided[1]!.detail, /offset 0\.5, gamma 1\.2/);
  assert.match(report.avoided[2]!.detail, /saturation 5/);
  assert.match(report.avoided[3]!.detail, /colorize and per-range/);
  assert.match(report.avoided[4]!.detail, /black & white tint/);
});
