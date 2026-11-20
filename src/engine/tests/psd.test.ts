/**
 * psd.test.ts — stage-1 PSD import: full roundtrip through ag-psd's own
 * writer/reader (real Photoshop bytes in, Guazzo Document out).
 *
 * ag-psd is loaded via its REAL .pnpm path with createRequire: the sandbox's
 * node_modules junctions are not followed by node resolution, but the real
 * path lets ag-psd's internal `require('pako')` walk up into
 * .pnpm/node_modules (a real directory) and resolve.
 * initializeCanvas takes POSITIONAL (createCanvas, createImageData) args.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkPsdHeader, psdToDocument, type PsdLayerLike, type PsdLike, type PsdTextLike } from "../psd.ts";
import { emptyImportReport } from "../importreport.ts";
import { deserializeProject, serializeProject } from "../io.ts";

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

/** write a psd object to real bytes and parse it back the way main.ts will */
function roundtrip(psd: unknown): PsdLike {
  const bytes = new Uint8Array(ag.writePsd(psd));
  return ag.readPsd(bytes, { useImageData: true }) as PsdLike;
}

test("psdToDocument refuses documents above the 16384px canvas limit", () => {
  // Photoshop allows 300000px; we do not — a silent clamp would render a
  // partial document, so the import throws and the UI shows the reason
  assert.throws(
    () => psdToDocument({ width: 20000, height: 4, children: [] }),
    /too large/,
  );
});

test("psdToDocument: roundtrip preserves size, stacking, props, pixels", () => {
  const read = roundtrip({
    width: 6, height: 4, children: [
      { name: "BG", imageData: { width: 6, height: 4, data: new Uint8ClampedArray(6 * 4 * 4).fill(255) } },
      {
        name: "L1", blendMode: "multiply", opacity: 0.5, left: 1, top: 1, right: 4, bottom: 3,
        imageData: { width: 3, height: 2, data: new Uint8ClampedArray(3 * 2 * 4).fill(200) },
      },
    ],
  });
  const doc = psdToDocument(read);

  assert.equal(doc.width, 6);
  assert.equal(doc.height, 4);
  // stacking: psd children[0] is bottom; doc.layers[0] is bottom
  assert.deepEqual(doc.layers.map((l) => l.name), ["BG", "L1"]);

  const l1 = doc.layers[1]!;
  assert.equal(l1.blendMode, "multiply");
  assert.ok(Math.abs(l1.opacity - 0.5) < 0.005); // psd stores 8-bit opacity (128/255)
  assert.equal(l1.visible, true);

  // pixel placement: L1 occupies (1,1)..(4,3) with the 200-gray content
  const p = new Uint8ClampedArray(4);
  doc.layers[1]!.grid.readRect(1, 1, 1, 1, p);
  assert.deepEqual(Array.from(p), [200, 200, 200, 200]);
  doc.layers[1]!.grid.readRect(0, 0, 1, 1, p);
  assert.deepEqual(Array.from(p), [0, 0, 0, 0]); // outside the layer rect: transparent

  // composite is sane: opaque white BG with multiply-gray over part of it
  const comp = doc.composite();
  const at = (x: number, y: number) => Array.from(comp.slice((y * 6 + x) * 4, (y * 6 + x) * 4 + 4));
  assert.deepEqual(at(0, 0), [255, 255, 255, 255]); // BG only
  const inside = at(2, 1);
  const ir = inside[0]!;
  assert.ok(inside[3] === 255, "fully opaque composite");
  assert.ok(ir < 255 && ir > 200, `multiply darkens white: ${ir}`);
});

test("psdToDocument: hidden layer becomes invisible", () => {
  const read = roundtrip({
    width: 4, height: 4, children: [
      { name: "A", hidden: false, imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) } },
      { name: "B", hidden: true, imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(100) } },
    ],
  });
  const doc = psdToDocument(read);
  assert.equal(doc.layers[0]!.visible, true);
  assert.equal(doc.layers[1]!.visible, false);
  // composite: hidden B must not contribute
  const comp = doc.composite();
  assert.deepEqual(Array.from(comp.slice(0, 4)), [255, 255, 255, 255]);
});

test("psdToDocument: unknown blend mode falls back to normal", () => {
  const read = roundtrip({
    width: 4, height: 4, children: [
      { name: "X", blendMode: "quadratic-funk", imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) } },
    ],
  });
  const doc = psdToDocument(read);
  assert.equal(doc.layers[0]!.blendMode, "normal");
});

test("psdToDocument: groups become real nodes; a hidden group keeps its subtree", () => {
  const opaque = (v: number): Uint8ClampedArray => {
    const d = new Uint8ClampedArray(64);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    return d;
  };
  const read = roundtrip({
    width: 4, height: 4, children: [
      {
        name: "G", children: [
          { name: "A", imageData: { width: 4, height: 4, data: opaque(50) } },
          { name: "B", imageData: { width: 4, height: 4, data: opaque(150) } },
        ],
      },
      {
        name: "H", hidden: true, children: [
          { name: "C", imageData: { width: 4, height: 4, data: opaque(250) } },
        ],
      },
    ],
  });
  const doc = psdToDocument(read);
  assert.deepEqual(doc.layers.map((l) => l.name), ["G", "H"]);
  assert.equal(doc.layers[0]!.kind, "group");
  assert.deepEqual(doc.layers[0]!.children?.map((l) => l.name), ["A", "B"]);
  assert.equal(doc.layers[1]!.kind, "group");
  assert.equal(doc.layers[1]!.visible, false);
  assert.deepEqual(doc.layers[1]!.children?.map((l) => l.name), ["C"]);
  // H is hidden, so only G's two children contribute; B sits above A.
  const comp = doc.composite();
  assert.deepEqual(Array.from(comp.slice(0, 4)), [150, 150, 150, 255]);
});

test("psdToDocument: nested groups keep their parent and the depth-first order", () => {
  const read = roundtrip({
    width: 2, height: 2, children: [
      {
        name: "outer", children: [
          { name: "bottom", imageData: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(10) } },
          {
            name: "inner", children: [
              { name: "top", imageData: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) } },
            ],
          },
        ],
      },
    ],
  });
  const doc = psdToDocument(read);
  const outer = doc.layers[0]!;
  assert.equal(outer.name, "outer");
  assert.equal(outer.children?.[0]!.name, "bottom");
  const inner = outer.children?.[1]!;
  assert.equal(inner.kind, "group");
  assert.equal(doc.parentOf(inner.children![0]!)?.name, "inner");
  assert.deepEqual(doc.allLayers().map((l) => l.name), ["outer", "bottom", "inner", "top"]);
});

test("import: a pass-through group keeps passThrough and multiplies against the backdrop", () => {
  const backdrop = {
    name: "backdrop", left: 0, top: 0, right: 1, bottom: 1,
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([200, 120, 60, 255]) },
  };
  const multiplyChild = {
    name: "mult", blendMode: "multiply", left: 0, top: 0, right: 1, bottom: 1,
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 200, 255, 255]) },
  };
  // Same content twice: once flat, once inside a group. A pass-through group
  // is transparent to the blender, so the two composites must agree byte for byte.
  const flat = psdToDocument(roundtrip({
    width: 1, height: 1, children: [backdrop, multiplyChild],
  }));
  const grouped = psdToDocument(roundtrip({
    width: 1, height: 1, children: [backdrop, { name: "G", children: [multiplyChild] }],
  }));

  const group = grouped.layers[1]!;
  assert.equal(group.kind, "group");
  assert.equal(group.passThrough, true);
  assert.equal(group.blendMode, "normal");
  assert.deepEqual(group.children?.map((l) => l.name), ["mult"]);
  assert.deepEqual(Array.from(grouped.composite()), Array.from(flat.composite()));
});

test("psdToDocument: black raster mask hides the masked pixels", () => {
  const layerData = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < layerData.length; i += 4) {
    layerData[i] = 255; layerData[i + 1] = 0; layerData[i + 2] = 0; layerData[i + 3] = 255; // opaque red
  }
  const maskData = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < maskData.length; i += 4) {
    maskData[i] = 0; maskData[i + 1] = 0; maskData[i + 2] = 0; maskData[i + 3] = 255; // black mask = hide
  }
  const read = roundtrip({
    width: 4, height: 4, children: [
      {
        name: "M", left: 0, top: 0, right: 4, bottom: 4,
        imageData: { width: 4, height: 4, data: layerData },
        mask: { left: 0, top: 0, right: 4, bottom: 4, imageData: { width: 4, height: 4, data: maskData } },
      },
    ],
  });
  const doc = psdToDocument(read);
  const p = new Uint8ClampedArray(4);
  doc.layers[0]!.grid.readRect(0, 0, 1, 1, p);
  assert.deepEqual(Array.from(p), [0, 0, 0, 0]); // mask baked: alpha 0

  // and a WHITE mask keeps the layer visible (roundtrip of the probe)
  const white = new Uint8ClampedArray(16 * 4).fill(255);
  const read2 = roundtrip({
    width: 4, height: 4, children: [
      {
        name: "M2", left: 0, top: 0, right: 4, bottom: 4,
        imageData: { width: 4, height: 4, data: layerData },
        mask: { left: 0, top: 0, right: 4, bottom: 4, imageData: { width: 4, height: 4, data: white } },
      },
    ],
  });
  const doc2 = psdToDocument(read2);
  doc2.layers[0]!.grid.readRect(0, 0, 1, 1, p);
  assert.deepEqual(Array.from(p), [255, 0, 0, 255]);
});

test("checkPsdHeader: a 200 KB file claiming 30000² is refused before any parse", () => {
  // AG3: the whole point is that this check runs on the 26-byte header, so the
  // "file" here is only a header — exactly what openPsdFile slices off first.
  const header = new Uint8Array(26);
  header.set([0x38, 0x42, 0x50, 0x53], 0); // '8BPS'
  const view = new DataView(header.buffer);
  view.setUint16(4, 1, false); // version
  view.setUint16(12, 3, false); // channels (2 bytes, NOT 4 — writing 4 clobbers height)
  view.setUint32(14, 30000, false); // height
  view.setUint32(18, 30000, false); // width
  view.setUint16(22, 8, false); // depth
  view.setUint16(24, 3, false); // colour mode
  assert.throws(() => checkPsdHeader(header), /psd: document is too large \(30000 × 30000/);

  // A header inside the limit reports the dimensions the parse will use.
  view.setUint32(14, 640, false);
  view.setUint32(18, 480, false);
  assert.deepEqual(checkPsdHeader(header), { width: 480, height: 640 });

  // Not a PSD at all: no opinion, so the parser reports its own error.
  const notPsd = new Uint8Array(26);
  assert.equal(checkPsdHeader(notPsd), null);
  assert.equal(checkPsdHeader(new Uint8Array(4)), null);
});

test("psdToDocument: empty psd yields an empty document", () => {
  const read = roundtrip({ width: 3, height: 3, children: [] });
  const doc = psdToDocument(read);
  assert.equal(doc.width, 3);
  assert.equal(doc.layers.length, 0);
});

test("import report: baked layer effects are admitted", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [{
      name: "FX",
      left: 0, top: 0,
      imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(200) },
      effects: { solidFill: [{ color: { r: 255, g: 0, b: 0 }, opacity: 1 }] },
    }],
  };
  const report = emptyImportReport();
  psdToDocument(psd, report);
  assert.equal(report.layers, 1);
  assert.equal(report.groups, 0);
  assert.equal(report.avoided.length, 1);
  assert.equal(report.avoided[0]!.path, "FX");
  assert.equal(report.avoided[0]!.feature, "effect");
  assert.match(report.avoided[0]!.detail, /baked into pixels/);
});

test("import report: a plain import leaves avoided empty", () => {
  const psd: PsdLike = {
    width: 4, height: 4, children: [{
      name: "Plain",
      imageData: { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) },
    }],
  };
  const report = emptyImportReport();
  psdToDocument(psd, report);
  assert.equal(report.layers, 1);
  assert.equal(report.groups, 0);
  assert.deepEqual(report.avoided, []);
  assert.deepEqual(report.substitutedFonts, []);
});

test("import report: text becomes a live recipe while placed layers are admitted", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [{
      name: "Folder",
      children: [
        {
          name: "Headline",
          imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
          text: { text: "Hello", style: { font: { name: "Arial" } } },
        },
        {
          name: "Logo",
          imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
          placedLayer: { id: "abc", external: false, type: "raster" },
        },
      ],
    }],
  };
  const report = emptyImportReport();
  const doc = psdToDocument(psd, report);
  assert.equal(report.layers, 2);
  assert.equal(report.groups, 1);
  assert.deepEqual(report.avoided.map(a => a.feature), ["smart-object"]);
  assert.equal(report.avoided[0]!.path, "Folder / Logo");
  assert.deepEqual(report.substitutedFonts, []);
  const headline = doc.allLayers().find(layer => layer.name === "Headline")!;
  assert.equal(headline.textData?.lines[0]?.[0]?.text, "Hello");
  assert.equal(headline.textData?.lines[0]?.[0]?.font, "Arial");
});

test("psd text import carries style runs, geometry, colour and alignment", () => {
  const psd: PsdLike = {
    width: 20, height: 10, children: [{
      name: "Headline",
      left: 2, top: 3, right: 18, bottom: 9,
      imageData: { width: 16, height: 6, data: new Uint8ClampedArray(16 * 6 * 4).fill(255) },
      text: {
        text: "Hi\nThere",
        style: {
          font: { name: "Arial-BoldMT" }, fontSize: 20, fauxBold: true,
          fillColor: { r: 10, g: 20, b: 30 },
        },
        styleRuns: [{ length: 2, style: { fauxItalic: true } }],
        paragraphStyle: { justification: "center" },
      },
    }],
  };
  const report = emptyImportReport();
  const doc = psdToDocument(psd, report);
  const text = doc.allLayers()[0]!.textData!;
  assert.equal(text.x, 2);
  assert.equal(text.y, 3);
  assert.equal(text.w, 16);
  assert.equal(text.h, 6);
  assert.equal(text.size, 20);
  assert.deepEqual(text.color, [10, 20, 30]);
  assert.equal(text.align, "center");
  assert.equal(text.lines.length, 2);
  assert.deepEqual(text.lines[0], [{
    text: "Hi", bold: true, italic: true, underline: false, strike: false, font: "Arial",
  }]);
  assert.deepEqual(text.lines[1], [{
    text: "There", bold: true, italic: false, underline: false, strike: false, font: "Arial",
  }]);
  assert.deepEqual(report.avoided, []);
});

test("psd text import treats CR and CRLF as paragraph breaks", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [{
      name: "Text",
      imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
      text: { text: "a\rb\r\nc", style: { font: { name: "Arial" } } },
    }],
  };
  const text = psdToDocument(psd).allLayers()[0]!.textData!;
  assert.deepEqual(text.lines.map(line => line.map(seg => seg.text).join("")), ["a", "b", "c"]);
});

test("imported text keeps its recipe through project save/load", () => {
  const psd: PsdLike = {
    width: 20, height: 10, children: [{
      name: "Text",
      left: 2, top: 3, right: 18, bottom: 9,
      imageData: { width: 16, height: 6, data: new Uint8ClampedArray(16 * 6 * 4).fill(255) },
      text: {
        text: "Hi\nThere",
        style: { font: { name: "Arial" }, fontSize: 20, fillColor: { r: 10, g: 20, b: 30 } },
        paragraphStyle: { justification: "right" },
      },
    }],
  };
  const imported = psdToDocument(psd);
  const restored = deserializeProject(JSON.parse(JSON.stringify(serializeProject(imported)))).doc;
  const text = restored.allLayers()[0]!.textData!;
  assert.deepEqual(text.lines.map(line => line.map(seg => seg.text)), [["Hi"], ["There"]]);
  assert.equal(text.size, 20);
  assert.deepEqual(text.color, [10, 20, 30]);
  assert.equal(text.align, "right");
  assert.equal(text.x, 2);
  assert.equal(text.y, 3);
});

test("psd text import survives real PSD bytes", () => {
  const read = roundtrip({
    width: 12, height: 8, children: [{
      name: "Text",
      left: 1, top: 2, right: 11, bottom: 7,
      imageData: { width: 10, height: 5, data: new Uint8ClampedArray(10 * 5 * 4).fill(255) },
      text: {
        text: "Hi",
        style: { font: { name: "Arial" }, fontSize: 18, fillColor: { r: 5, g: 6, b: 7 } },
        paragraphStyle: { justification: "center" },
      },
    }],
  });
  const report = emptyImportReport();
  const doc = psdToDocument(read, report);
  const text = doc.allLayers()[0]!.textData!;
  assert.equal(text.lines[0]?.[0]?.text, "Hi");
  assert.equal(text.size, 18);
  assert.deepEqual(text.color, [5, 6, 7]);
  assert.equal(text.align, "center");
  assert.deepEqual(report.avoided, []);
});

test("psd text import substitutes a missing font once, not once per layer", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [
      {
        name: "One",
        imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
        text: { text: "One", style: { font: { name: "MissingFont" } } },
      },
      {
        name: "Two",
        imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
        text: { text: "Two", style: { font: { name: "MissingFont" } } },
      },
    ],
  };
  const report = emptyImportReport();
  const doc = psdToDocument(psd, report, { resolveFont: () => null });
  assert.deepEqual(report.substitutedFonts, ["MissingFont"]);
  assert.deepEqual(report.avoided, []);
  assert.deepEqual(doc.allLayers().map(layer => layer.textData?.lines[0]?.[0]?.font), ["Arial", "Arial"]);
});

test("psd text import admits per-run size and colour changes", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [{
      name: "Text",
      imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
      text: {
        text: "Hi",
        style: { font: { name: "Arial" }, fontSize: 20, fillColor: { r: 10, g: 20, b: 30 } },
        styleRuns: [{
          length: 2,
          style: { fontSize: 30, fillColor: { r: 200, g: 20, b: 30 } },
        }],
      },
    }],
  };
  const report = emptyImportReport();
  const text = psdToDocument(psd, report).allLayers()[0]!.textData!;
  assert.equal(text.size, 20);
  assert.deepEqual(text.color, [10, 20, 30]);
  const admission = report.avoided.find(a => a.feature === "text-style-runs");
  assert.ok(admission);
  assert.equal(admission.path, "Text");
  assert.match(admission.detail, /editing the text will re-render it in one style/);
});

test("psd text import refuses an axis-aligned recipe for rotated text", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [{
      name: "Rotated",
      imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
      text: {
        text: "Hi",
        style: { font: { name: "Arial" } },
        transform: [0.8660254, 0.5, -0.5, 0.8660254, 0, 0],
      },
    }],
  };
  const report = emptyImportReport();
  const layer = psdToDocument(psd, report).allLayers()[0]!;
  assert.equal(layer.textData, undefined);
  assert.deepEqual(report.avoided.map(a => a.feature), ["text-transform"]);
});

test("psd text import keeps the recipe when the transform is translation only", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [{
      name: "Moved",
      imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
      text: {
        text: "Hi",
        style: { font: { name: "Arial" } },
        transform: [1, 0, 0, 1, 5, 7],
      },
    }],
  };
  const report = emptyImportReport();
  const layer = psdToDocument(psd, report).allLayers()[0]!;
  assert.equal(layer.textData?.lines[0]?.[0]?.text, "Hi");
  assert.deepEqual(report.avoided, []);
});

test("psd text import admits warp, path and vertical writing", () => {
  const layer = (name: string, text: PsdTextLike): PsdLayerLike => ({
    name,
    imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
    text,
  });
  const psd: PsdLike = {
    width: 8, height: 8, children: [
      layer("Warped", { text: "W", style: { font: { name: "Arial" } }, warp: { style: "arc" } }),
      layer("Path", { text: "P", style: { font: { name: "Arial" } }, textOnPath: { type: "path" } }),
      layer("Vertical", { text: "V", style: { font: { name: "Arial" } }, orientation: "vertical" }),
    ],
  };
  const report = emptyImportReport();
  const doc = psdToDocument(psd, report);
  assert.deepEqual(report.avoided.map(a => a.feature), ["text-warp", "text-on-path", "text-vertical"]);
  assert.deepEqual(doc.allLayers().map(l => l.textData), [undefined, undefined, undefined]);
});

test("psd text import carries the box wrap width and admits a missing one", () => {
  const psd: PsdLike = {
    width: 200, height: 80, children: [
      {
        name: "Boxed",
        imageData: { width: 120, height: 40, data: new Uint8ClampedArray(120 * 40 * 4).fill(255) },
        text: {
          text: "Hi", style: { font: { name: "Arial" } },
          shapeType: "box", boxBounds: [37, 19, 120, 40],
        },
      },
      {
        name: "NoWidth",
        imageData: { width: 120, height: 40, data: new Uint8ClampedArray(120 * 40 * 4).fill(255) },
        text: { text: "Hi", style: { font: { name: "Arial" } }, shapeType: "box" },
      },
    ],
  };
  const report = emptyImportReport();
  const doc = psdToDocument(psd, report);
  assert.equal(doc.allLayers()[0]!.textData?.wrap, 120);
  assert.equal(doc.allLayers()[1]!.textData?.wrap, undefined);
  assert.deepEqual(report.avoided.map(a => a.feature), ["text-wrap"]);
});

test("psd text import admits justification and paragraph runs", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [{
      name: "Text",
      imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
      text: {
        text: "Hi",
        style: { font: { name: "Arial" } },
        paragraphStyle: { justification: "justify-center" },
        paragraphStyleRuns: [{ length: 2, style: { justification: "center" } }],
      },
    }],
  };
  const report = emptyImportReport();
  const text = psdToDocument(psd, report).allLayers()[0]!.textData!;
  assert.equal(text.align, "justify");
  assert.deepEqual(report.avoided.map(a => a.feature), ["text-justify", "text-paragraph-runs"]);
});

test("psd text import admits baked effects that editing cannot recreate", () => {
  const psd: PsdLike = {
    width: 8, height: 8, children: [{
      name: "Text",
      imageData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
      effects: { solidFill: [{ color: { r: 255, g: 0, b: 0 }, opacity: 1 }] },
      text: { text: "Hi", style: { font: { name: "Arial" } } },
    }],
  };
  const report = emptyImportReport();
  const text = psdToDocument(psd, report).allLayers()[0]!.textData!;
  assert.equal(text.lines[0]?.[0]?.text, "Hi");
  assert.ok(report.avoided.some(a => a.feature === "text-effects"));
});
