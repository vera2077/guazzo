/**
 * psd.test.ts — stage-1 PSD import: full roundtrip through ag-psd's own
 * writer/reader (real Photoshop bytes in, Pigment Document out).
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
import { psdToDocument, type PsdLike } from "../psd.ts";

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

test("psdToDocument: groups flatten in place; hidden group drops subtree", () => {
  const read = roundtrip({
    width: 4, height: 4, children: [
      {
        name: "G", children: [
          { name: "A", imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(50) } },
          { name: "B", imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(150) } },
        ],
      },
      {
        name: "H", hidden: true, children: [
          { name: "C", imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(250) } },
        ],
      },
    ],
  });
  const doc = psdToDocument(read);
  assert.deepEqual(doc.layers.map((l) => l.name), ["A", "B"]); // G and H are containers; C dropped
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

test("psdToDocument: empty psd yields an empty document", () => {
  const read = roundtrip({ width: 3, height: 3, children: [] });
  const doc = psdToDocument(read);
  assert.equal(doc.width, 3);
  assert.equal(doc.layers.length, 0);
});
