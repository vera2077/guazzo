import assert from "node:assert/strict";
import { test } from "node:test";
import { Document, setMaskAt } from "../document.ts";
import { parseCube } from "../lookuptable.ts";
import { buildPsd, buildPsdForExport, psdAdjustmentRecord, psdBlendName, psdExportLoss } from "../psdexport.ts";
import { psdToDocument, type PsdLike } from "../psd.ts";
import { emptyImportReport } from "../importreport.ts";
import { gridBBox } from "../transform.ts";
import { curveLut } from "../tone.ts";
import { eq } from "./helpers.ts";
import { loadAgPsd } from "./agpsd.ts";

// real ag-psd bytes, same loader as psd.test.ts (./agpsd.ts: resolve first,
// pnpm store path only as this sandbox's fallback; positional canvas shims)
const ag = loadAgPsd();

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

test("gradient map exports solid colour stops and round-trips through ag-psd", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "gradient-map",
    map: [
      { pos: 1, color: [0, 0, 255] },
      { pos: 0, color: [255, 0, 0] },
    ],
  });
  // the record must be sorted and know its own coordinates, or Photoshop
  // opens the layer as an identity ramp
  assert.deepEqual(buildPsd(doc).children[0]!.adjustment, {
    type: "gradient map",
    gradientType: "solid",
    colorStops: [
      { color: { r: 255, g: 0, b: 0 }, location: 0, midpoint: 0.5 },
      { color: { r: 0, g: 0, b: 255 }, location: 1, midpoint: 0.5 },
    ],
  });

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const read = ag.readPsd(bytes, { useImageData: true }) as {
    children?: { name: string; adjustment?: Record<string, unknown> }[];
  };
  const rec = read.children?.find((layer) => layer.name === "Gradient Map")?.adjustment as {
    type?: string;
    gradientType?: string;
    colorStops?: { color: { r: number; g: number; b: number }; location: number }[];
  };
  eq(rec?.type, "gradient map");
  eq(rec?.gradientType, "solid");
  eq(rec?.colorStops?.length, 2);
  assert.deepEqual(rec?.colorStops?.[0]?.color, { r: 255, g: 0, b: 0 });
  eq(rec?.colorStops?.[0]?.location, 0);
  eq(rec?.colorStops?.[1]?.location, 1);
});

test("a gradient map with fewer than two stops is not representable", () => {
  // A one-stop record is not a gradient Photoshop accepts, and writing one
  // would open as an identity ramp — a silent lie. The layer must instead
  // take the whole-document composite fallback with an admission.
  eq(psdAdjustmentRecord({ kind: "gradient-map", map: [{ pos: 0, color: [1, 2, 3] }] }), null);
  eq(psdAdjustmentRecord({ kind: "gradient-map" }), null);

  const doc = new Document(8, 8);
  doc.addLayer("BG");
  doc.addAdjustLayer({ kind: "gradient-map", map: [{ pos: 0, color: [1, 2, 3] }] });
  const out = buildPsdForExport(doc, "Guazzo composite");
  eq(out.psd.children.length, 1);
  assert.ok(out.admission.includes("gradient-map"), out.admission);
});

test("channel mixer exports its per-channel weights and round-trips", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "channel-mixer",
    mixer: {
      red: { r: 120, g: -20, b: 0, constant: 3 },
      green: { r: 0, g: 100, b: 0, constant: 0 },
      blue: { r: 0, g: 0, b: 80, constant: -4 },
    },
  });
  assert.deepEqual(buildPsd(doc).children[0]!.adjustment, {
    type: "channel mixer",
    red: { red: 120, green: -20, blue: 0, constant: 3 },
    green: { red: 0, green: 100, blue: 0, constant: 0 },
    blue: { red: 0, green: 0, blue: 80, constant: -4 },
  });

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const read = ag.readPsd(bytes, { useImageData: true }) as {
    children?: { name: string; adjustment?: Record<string, unknown> }[];
  };
  const rec = read.children?.find((layer) => layer.name === "Channel Mixer")?.adjustment as {
    type?: string; red?: { red: number; green: number; constant: number };
  };
  eq(rec?.type, "channel mixer");
  eq(rec?.red?.red, 120);
  eq(rec?.red?.green, -20);
  eq(rec?.red?.constant, 3);
});

test("colour lookup exports its cube and reads back as the same table", () => {
  const cube = `TITLE "Swap"
LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`;
  const parsed = parseCube(cube, "swap.cube");
  assert.ok(parsed.table, parsed.error ?? "parse");
  const doc = new Document(8, 8);
  doc.addAdjustLayer({ kind: "color-lookup", lookup: parsed.table! });

  const adj = buildPsd(doc).children[0]!.adjustment as {
    type: string; lutFormat?: string; lut3DFileData?: Uint8Array; name?: string;
  };
  eq(adj.type, "color lookup");
  eq(adj.lutFormat, "cube");
  assert.ok(adj.lut3DFileData instanceof Uint8Array);
  const text = new TextDecoder().decode(adj.lut3DFileData!);
  assert.match(text, /LUT_3D_SIZE 2/);

  // Through the real writer and reader, then back into a document.
  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const report = emptyImportReport();
  const back = psdToDocument(ag.readPsd(bytes, { useImageData: true }) as PsdLike, report);
  const lookup = back.layers[0]!.adjust?.lookup;
  assert.ok(lookup, "the lookup table survived the round trip");
  eq(lookup!.size, 2);
  eq(report.avoided.length, 0);
});

test("a gradient fill exports live and comes back with its stops and angle", () => {
  const doc = new Document(32, 32);
  doc.addFillLayer([0, 0, 0], "Gradient Fill", {
    type: "linear",
    angle: 270,
    stops: [
      { at: 0, color: [255, 0, 0] },
      { at: 0.5, color: [0, 255, 0] },
      { at: 1, color: [0, 0, 255] },
    ],
  });

  const out = buildPsd(doc).children[0]!;
  const vf = out.vectorFill as { type: string; angle: number; style: string; colorStops: Array<{ location: number }> };
  eq(vf.type, "solid");
  eq(vf.style, "linear");
  eq(vf.angle, 90); // Guazzo 270 is Photoshop 90
  eq(vf.colorStops.length, 3);

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const report = emptyImportReport();
  const back = psdToDocument(ag.readPsd(bytes, { useImageData: true }) as PsdLike, report);
  eq(report.avoided.length, 0);
  const layer = back.layers[0]!;
  eq(layer.kind, "fill");
  const grad = layer.fill?.gradient;
  assert.ok(grad, "the gradient survived as a live fill");
  eq(grad!.type, "linear");
  eq(grad!.angle, 270);
  assert.deepEqual(grad!.stops.map((st) => st.at), [0, 0.5, 1]);
  assert.deepEqual(grad!.stops[2]!.color, [0, 0, 255]);
});

test("layer styles export as a live recipe and come back unflattened", () => {
  const doc = new Document(48, 48);
  const layer = doc.addLayer("Styled");
  layer.grid.fillRect(16, 16, 12, 12, [220, 40, 40, 255]);
  layer.effects = {
    dropShadow: [{ enabled: true, color: { r: 0, g: 0, b: 0 }, opacity: 0.6, angle: 90, distance: 6, size: 2 }],
    stroke: [{ enabled: true, color: { r: 0, g: 200, b: 0 }, opacity: 1, size: 3, fillType: "color" }],
  };

  const out = buildPsd(doc).children[0]!;
  assert.ok(out.effects, "the recipe is written, not baked");
  eq((out.effects as { dropShadow: Array<{ distance: { value: number } }> }).dropShadow[0]!.distance.value, 6);

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const report = emptyImportReport();
  const back = psdToDocument(ag.readPsd(bytes, { useImageData: true }) as PsdLike, report);

  eq(report.avoided.length, 0);
  const fx = back.layers[0]!.effects;
  assert.ok(fx, "the style was carried, not baked into pixels");
  eq(fx!.dropShadow![0]!.distance, 6);
  eq(fx!.stroke![0]!.size, 3);
  assert.deepEqual(fx!.stroke![0]!.color, { r: 0, g: 200, b: 0 });

  // The picture must be the style, not the style baked twice.
  const original = doc.composite();
  const again = back.composite();
  let diff = 0;
  for (let i = 0; i < original.length; i++) diff = Math.max(diff, Math.abs(original[i]! - again[i]!));
  assert.ok(diff <= 2, `composite drifted by ${diff}`);
});

test("selective colour exports its ranges and round-trips through ag-psd", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "selective-colour",
    selective: { mode: "absolute", ranges: { reds: { c: 40, m: -10, y: 0, k: 5 }, whites: { c: 0, m: 0, y: -6, k: 0 } } },
  });
  assert.deepEqual(buildPsd(doc).children[0]!.adjustment, {
    type: "selective color",
    mode: "absolute",
    reds: { c: 40, m: -10, y: 0, k: 5 },
    whites: { c: 0, m: 0, y: -6, k: 0 },
  });

  const bytes = new Uint8Array(ag.writePsd(buildPsd(doc)));
  const read = ag.readPsd(bytes, { useImageData: true }) as {
    children?: { name: string; adjustment?: Record<string, unknown> }[];
  };
  const rec = read.children?.find((layer) => layer.name === "Selective Colour")?.adjustment as {
    type?: string; mode?: string; reds?: { c: number; m: number; k: number };
  };
  eq(rec?.type, "selective color");
  eq(rec?.mode, "absolute");
  eq(rec?.reds?.c, 40);
  eq(rec?.reds?.m, -10);
  eq(rec?.reds?.k, 5);
});

test("monochrome channel mixer writes the gray channel and is not a loss", () => {
  const doc = new Document(8, 8);
  doc.addAdjustLayer({
    kind: "channel-mixer",
    mixer: {
      red: { r: 100, g: 0, b: 0, constant: 0 },
      green: { r: 0, g: 100, b: 0, constant: 0 },
      blue: { r: 0, g: 0, b: 100, constant: 0 },
      gray: { r: 30, g: 59, b: 11, constant: 0 },
    },
  });
  const adj = buildPsd(doc).children[0]!.adjustment as Record<string, unknown>;
  eq(adj.monochrome, true);
  assert.deepEqual(adj.gray, { red: 30, green: 59, blue: 11, constant: 0 });
  // it is representable, so nothing may be admitted as lost
  assert.deepEqual(psdExportLoss(doc).blocked.length, 0);
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

  // Counting the call is the invariant; a wall-clock bound fails on a loaded
  // machine while measuring the scheduler rather than the behaviour.
  const realComposite = doc.composite.bind(doc);
  let composites = 0;
  (doc as unknown as { composite: typeof realComposite }).composite = (...args) => {
    composites += 1;
    return realComposite(...args);
  };
  const loss = psdExportLoss(doc);
  eq(loss.blocked.length, 1);
  eq(composites, 0);
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
  const compRow = {
    shadowInput: 10,
    highlightInput: 240,
    shadowOutput: 5,
    highlightOutput: 250,
    midtoneInput: 1.8,
  };
  // Four rows, as Photoshop writes them: composite, red, green, blue. A
  // channel row without its own edit repeats the composite row.
  assert.deepEqual(buildPsd(doc).children[1]!.adjustment, {
    type: "levels",
    channels: [compRow, compRow, compRow, compRow],
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

test("levels per-channel rows survive a round trip", () => {
  const doc = gradientBackdrop();
  const red = { inBlack: 10, inWhite: 200, gamma: 1.4, outBlack: 0, outWhite: 255 };
  doc.addAdjustLayer({
    kind: "levels",
    levels: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 },
    levelsChannels: { r: red },
  });
  const { back, avoided } = exportAndImport(doc);
  const imported = back.layers[1]!;
  eq(imported.kind, "adjust");
  assert.deepEqual(imported.adjust?.levelsChannels?.r, red);
  // the untouched channels are "same as composite", which is stored as absent
  eq(imported.adjust?.levelsChannels?.g, undefined);
  eq(imported.adjust?.levelsChannels?.b, undefined);
  eq(avoided.length, 0);
  assert.deepEqual(back.composite(), doc.composite());
});

test("exposure offset and gamma survive a round trip", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({ kind: "exposure", stops: 0.6, exposureOffset: 0.05, exposureGamma: 1.8 });
  const { back, avoided } = exportAndImport(doc);
  const a = back.layers[1]!.adjust;
  eq(a?.kind, "exposure");
  // the record holds float32s, so compare with the precision it can keep
  assert.ok(Math.abs((a?.exposureOffset ?? 0) - 0.05) < 1e-6);
  assert.ok(Math.abs((a?.exposureGamma ?? 0) - 1.8) < 1e-6);
  eq(avoided.length, 0);
  assert.deepEqual(back.composite(), doc.composite());
});

test("vibrance saturation survives a round trip", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({ kind: "vibrance", amount: 30, vibranceSaturation: -20 });
  const { back, avoided } = exportAndImport(doc);
  const a = back.layers[1]!.adjust;
  eq(a?.kind, "vibrance");
  eq(a?.amount, 30);
  eq(a?.vibranceSaturation, -20);
  eq(avoided.length, 0);
  assert.deepEqual(back.composite(), doc.composite());
});

test("levels gamma is quantised to the record's hundredths", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({
    kind: "levels",
    levels: { inBlack: 0, inWhite: 255, gamma: 1.855, outBlack: 0, outWhite: 255 },
  });
  const row = {
    shadowInput: 0,
    highlightInput: 255,
    shadowOutput: 0,
    highlightOutput: 255,
    midtoneInput: 1.86,
  };
  assert.deepEqual(buildPsd(doc).children[1]!.adjustment, {
    type: "levels",
    channels: [row, row, row, row],
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
      {
        name: "Mixer",
        adjustment: {
          type: "channel mixer",
          red: { red: 100, green: 0, blue: 0, constant: 0 },
          green: { red: 0, green: 100, blue: 0, constant: 0 },
          blue: { red: 0, green: 0, blue: 100, constant: 0 },
        },
      },
      { name: "Map", adjustment: { type: "gradient map", gradientType: "noise" } },
      { name: "Lookup", adjustment: { type: "color lookup", lookupType: "3dlut" } },
      { name: "Selective", adjustment: { type: "selective color", mode: "relative" } },
    ],
  } as PsdLike, report);
  eq(back.layers.length, 4);
  // channel mixer, selective colour and a solid gradient map are live kinds
  // now; only the noise gradient and the colour lookup may be admitted
  eq(back.layers[0]!.adjust?.kind, "channel-mixer");
  eq(back.layers[3]!.adjust?.kind, "selective-colour");
  eq(report.avoided.length, 2);
  assert.match(report.avoided[0]!.detail, /noise gradient/);
  assert.match(report.avoided[1]!.detail, /colour lookup/);
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

test("per-run size and colour are written into the PSD type record", () => {
  const doc = new Document(200, 100);
  const layer = doc.addLayer("Mixed");
  layer.textData = {
    lines: [[
      { text: "Big ", bold: false, italic: false, underline: false, strike: false, font: "Arial", size: 48, color: [255, 0, 0] },
      { text: "small", bold: false, italic: false, underline: false, strike: false, font: "Arial" },
    ]],
    x: 10, y: 10, w: 120, h: 40,
    size: 24, color: [10, 20, 30],
  };
  layer.grid.fillRect(10, 10, 100, 40, [1, 2, 3, 255]);

  const psd = buildPsd(doc);
  const live = psd.children[0]!.text;
  assert.ok(live);
  eq(live.styleRuns.length, 2);
  eq(live.styleRuns[0]!.style.fontSize, 48);
  assert.deepEqual(live.styleRuns[0]!.style.fillColor, { r: 255, g: 0, b: 0 });
  eq(live.styleRuns[1]!.style.fontSize, 24);
  assert.deepEqual(live.styleRuns[1]!.style.fillColor, { r: 10, g: 20, b: 30 });

  // and the bytes carry them back
  const read = ag.readPsd(new Uint8Array(ag.writePsd(psd)), { useImageData: true }) as PsdLike;
  const recipe = psdToDocument(read, emptyImportReport()).allLayers()[0]!.textData;
  assert.ok(recipe);
  eq(recipe.lines[0]![0]!.size, 48);
  assert.deepEqual(recipe.lines[0]![0]!.color, [255, 0, 0]);
  eq(recipe.lines[0]![1]!.size, undefined);
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

test("every adjustment field is carried, not admitted", () => {
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

  // Levels, exposure and vibrance no longer admit anything: the fields are
  // model values now, so the test asserts the numbers rather than a message.
  const levels = back.layers[0]!.adjust;
  eq(levels?.levelsChannels?.r?.inBlack, 1);
  const exposure = back.layers[1]!.adjust;
  eq(exposure?.exposureOffset, 0.5);
  eq(exposure?.exposureGamma, 1.2);
  const vibrance = back.layers[2]!.adjust;
  eq(vibrance?.vibranceSaturation, 5);

  // Nothing left to admit: colorize, the per-range bands and the tint are
  // model values now, so the test asserts them instead of a message.
  eq(report.avoided.length, 0);
  eq(back.layers[3]!.adjust?.hueRanges?.reds?.saturation, 20);
  assert.deepEqual(back.layers[4]!.adjust?.blackWhiteTint, [10, 20, 30]);
});

test("hue/saturation colorize round trips through its own block", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({ kind: "hue-sat", colorize: true, hue: 210, saturation: 55, lightness: -10 });
  const record = buildPsd(doc).children[1]!.adjustment as {
    colorize?: boolean;
    colorization?: { hue: number; saturation: number; lightness: number };
    master: { hue: number; saturation: number; lightness: number };
  };
  eq(record.colorize, true);
  assert.deepEqual(record.colorization, { hue: 210, saturation: 55, lightness: -10 });
  // The master triple is zeroed in colorize mode so re-import cannot apply the
  // same hue twice.
  assert.deepEqual(record.master, { hue: 0, saturation: 0, lightness: 0 });

  const { back, avoided } = exportAndImport(doc);
  eq(avoided.length, 0);
  const a = back.layers[1]!.adjust;
  eq(a?.colorize, true);
  eq(a?.hue, 210);
  eq(a?.saturation, 55);
  eq(a?.lightness, -10);
  assert.deepEqual(back.composite(), doc.composite());
});

test("hue/saturation per-range bands keep their window", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({
    kind: "hue-sat",
    hue: 0,
    saturation: 0,
    lightness: 0,
    hueRanges: {
      reds: { a: 315, b: 345, c: 15, d: 45, hue: -40, saturation: 25, lightness: 5 },
      blues: { a: 195, b: 225, c: 255, d: 285, hue: 20, saturation: -15, lightness: 0 },
    },
  });
  const record = buildPsd(doc).children[1]!.adjustment as Record<string, unknown>;
  assert.deepEqual(record.reds, { a: 315, b: 345, c: 15, d: 45, hue: -40, saturation: 25, lightness: 5 });

  const { back, avoided } = exportAndImport(doc);
  eq(avoided.length, 0);
  const ranges = back.layers[1]!.adjust?.hueRanges;
  assert.deepEqual(ranges?.reds, { a: 315, b: 345, c: 15, d: 45, hue: -40, saturation: 25, lightness: 5 });
  assert.deepEqual(ranges?.blues, { a: 195, b: 225, c: 255, d: 285, hue: 20, saturation: -15, lightness: 0 });
  eq(ranges?.greens, undefined);
  assert.deepEqual(back.composite(), doc.composite());
});

test("black & white tint round trips", () => {
  const doc = gradientBackdrop();
  doc.addAdjustLayer({
    kind: "black-white",
    blackWhite: { r: 40, g: 60, b: 50, c: 70, m: 30, y: 20 },
    blackWhiteTint: [112, 66, 20],
  });
  const record = buildPsd(doc).children[1]!.adjustment as {
    useTint: boolean;
    tintColor?: { r: number; g: number; b: number };
  };
  eq(record.useTint, true);
  assert.deepEqual(record.tintColor, { r: 112, g: 66, b: 20 });

  const { back, avoided } = exportAndImport(doc);
  eq(avoided.length, 0);
  assert.deepEqual(back.layers[1]!.adjust?.blackWhiteTint, [112, 66, 20]);
  assert.deepEqual(back.composite(), doc.composite());
});
