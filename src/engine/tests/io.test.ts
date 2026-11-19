import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, maskAt, setMaskAt, type TextLayerMeta } from "../document.ts";
import { stampDab } from "../paint.ts";
import { serializeProject, deserializeProject } from "../io.ts";
import { eq } from "./helpers.ts";

/** unknown-typed helper: keeps strict narrowing from collapsing literals */
test("project round-trip preserves pixels and layer properties", () => {
  const doc = new Document(600, 600);
  const bg = doc.addBackground("Background");
  void bg;
  const l1 = doc.addLayer("Layer 1");
  stampDab(l1.grid, { x: 30, y: 30, radius: 10, hardness: 0.8, alpha: 1, color: [255, 0, 0], mode: "normal" });
  stampDab(l1.grid, { x: 300, y: 300, radius: 40, hardness: 0.5, alpha: 0.7, color: [0, 255, 0], mode: "normal" });
  const l2 = doc.addLayer("Layer 2");
  l2.grid.fillRect(100, 100, 200, 50, [0, 0, 255, 255]);
  l2.opacity = 0.5;
  l2.blendMode = "multiply";
  l2.visible = false;

  const json = serializeProject(doc, "roundtrip test");
  const text = JSON.stringify(json);
  const restored = deserializeProject(JSON.parse(text));

  assert.equal(restored.width, 600);
  assert.equal(restored.height, 600);
  assert.deepEqual(restored.layers.map((l) => l.name), ["Background", "Layer 1", "Layer 2"]);
  const a = doc.composite();
  const b = restored.composite();
  assert.deepEqual(b, a);
  const r2 = restored.layers[2]!;
  assert.equal(r2.opacity, 0.5);
  assert.equal(r2.blendMode, "multiply");
  assert.equal(r2.visible, false);
});

test("project with an empty layer round-trips (no tiles stored)", () => {
  const doc = new Document(300, 200);
  doc.addBackground("Background");
  const empty = doc.addLayer("Empty");
  void empty;
  const json = serializeProject(doc);
  assert.equal(json.layers[1]!.tiles.length, 0);
  const restored = deserializeProject(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(restored.composite(), doc.composite());
});

test("deserialize rejects foreign or malformed files", () => {
  assert.throws(() => deserializeProject(null));
  assert.throws(() => deserializeProject({ format: "nope", version: 1, width: 10, height: 10, layers: [] }));
  assert.throws(() => deserializeProject({ format: "guazzo-project", version: 99, width: 10, height: 10, layers: [] }));
});

test("deserialize rejects files above the 16384px canvas limit", () => {
  // a third-party/crafted project above MAX_DIM would allocate gigabytes of
  // tile buffers and then render blank — refuse it instead
  assert.throws(
    () => deserializeProject({ format: "guazzo-project", version: 1, width: 20000, height: 10, layers: [] }),
    /too large/,
  );
  assert.throws(
    () => deserializeProject({ format: "guazzo-project", version: 1, width: 10, height: 20000, layers: [] }),
    /too large/,
  );
  // exactly at the cap is fine (tiles are sparse — an empty 16384² doc is cheap)
  const ok = deserializeProject({ format: "guazzo-project", version: 1, width: 16384, height: 16384, layers: [] });
  eq(ok.width, 16384);
});

test("deserialize tolerates junk tiles without failing the file", () => {
  const doc = new Document(300, 200);
  doc.addBackground("Background");
  const json = serializeProject(doc);
  json.layers[0]!.tiles.push({ tx: 999, ty: 999, data: "AAAA" });
  json.layers[0]!.tiles.push({ tx: 0, ty: 0, data: "zzz-not-base64" });
  const restored = deserializeProject(json);
  assert.deepEqual(restored.composite(), doc.composite());
});

test("text-layer recipe round-trips (click-to-re-edit survives save/load)", () => {
  const doc = new Document(300, 200);
  const layer = doc.addLayer("Text: hi");
  layer.grid.fillRect(10, 10, 40, 16, [255, 0, 0, 255]);
  layer.textData = {
    lines: [
      [{ text: "hi", bold: true, italic: false, underline: false, strike: false, font: "Georgia" }],
      [
        { text: "there", bold: false, italic: true, underline: false, strike: false, font: "Arial" },
        { text: "!", bold: false, italic: false, underline: true, strike: false, font: "Arial" },
      ],
    ],
    x: 10, y: 10, w: 40, h: 16, size: 48, color: [255, 0, 0],
  };
  const restored = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc))));
  const r = restored.layers[0]!.textData!;
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines[0], [{ text: "hi", bold: true, italic: false, underline: false, strike: false, font: "Georgia" }]);
  assert.deepEqual(r.lines[1], [
    { text: "there", bold: false, italic: true, underline: false, strike: false, font: "Arial" },
    { text: "!", bold: false, italic: false, underline: true, strike: false, font: "Arial" },
  ]);
  assert.equal(r.size, 48);
  assert.deepEqual(r.color, [255, 0, 0]);
  assert.equal(r.x, 10);
  // legacy v0.3.x file (flat segs) → loads as one line
  const legacy = serializeProject(doc);
  legacy.layers[0]!.text = {
    segs: [{ text: "old", bold: false, italic: false, underline: false, strike: false, font: "Arial" }],
    x: 1, y: 2, w: 30, h: 12, size: 24, color: [1, 2, 3],
  } as unknown as TextLayerMeta; // legacy v0.3.x flat-segs shape
  const rl = deserializeProject(legacy).layers[0]!.textData!;
  assert.equal(rl.lines.length, 1);
  assert.deepEqual(rl.lines[0], [{ text: "old", bold: false, italic: false, underline: false, strike: false, font: "Arial" }]);
  // junk recipe → dropped, pixels kept
  const json2 = serializeProject(doc);
  json2.layers[0]!.text = { lines: "junk", x: "no" } as unknown as TextLayerMeta;
  const restored2 = deserializeProject(json2);
  assert.equal(restored2.layers[0]!.textData, undefined);
  assert.deepEqual(restored2.composite(), doc.composite());
});

// ---- masks, adjustment layers and fill layers survive a round-trip --------

test("adjustment and fill layers round-trip with their recipes", () => {
  const doc = new Document(24, 24);
  doc.addBackground();
  const adj = doc.addAdjustLayer({
    kind: "levels",
    levels: { inBlack: 10, inWhite: 240, gamma: 1.2, outBlack: 5, outWhite: 250 },
  });
  adj.opacity = 0.75;
  const fill = doc.addFillLayer([12, 34, 56]);
  fill.blendMode = "screen";
  fill.clipToBelow = true;

  const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc, "layers"))));
  eq(back.layers.length, 3);
  eq(back.layers[1]!.kind, "adjust");
  eq(back.layers[1]!.adjust?.kind, "levels");
  eq(back.layers[1]!.adjust?.levels?.gamma, 1.2);
  eq(back.layers[1]!.opacity, 0.75);
  eq(back.layers[2]!.kind, "fill");
  assert.deepEqual(back.layers[2]!.fill?.color, [12, 34, 56]);
  eq(back.layers[2]!.blendMode, "screen");
  eq(back.layers[2]!.clipToBelow, true);
  assert.deepEqual(back.composite(), doc.composite());
});

test("a layer mask survives a round-trip byte for byte", () => {
  const doc = new Document(20, 20);
  doc.addBackground();
  const top = doc.addLayer("top");
  top.grid.fillRect(0, 0, 20, 20, [255, 0, 0, 255]);
  const mask = doc.attachMask(top);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) setMaskAt(mask, x, y, 0);

  const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc, "m"))));
  const m = back.layers[1]!.mask;
  assert.ok(m, "mask restored");
  eq(maskAt(m, 2, 2), 0);
  eq(maskAt(m, 15, 2), 255);
  assert.deepEqual(back.composite(), doc.composite());
});

test("a project without masks or adjustment layers still loads", () => {
  const doc = new Document(8, 8);
  doc.addBackground();
  const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc))));
  eq(back.layers[0]!.kind, "pixel");
  eq(back.layers[0]!.mask, undefined);
  eq(back.layers[0]!.adjust, undefined);
});

test("flat group ids survive a project round-trip and junk is dropped", () => {
  const doc = new Document(64, 64);
  const a = doc.addLayer("A");
  const b = doc.addLayer("B");
  a.groupId = "G2";
  b.groupId = "G2";
  b.clipToBelow = true;
  const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc))));
  eq(back.layers[0]!.groupId, "G2");
  eq(back.layers[1]!.groupId, "G2");
  eq(back.layers[1]!.clipToBelow, true);
  // a corrupt id is ignored rather than breaking the file
  const raw = JSON.parse(JSON.stringify(serializeProject(doc))) as { layers: Array<{ group?: unknown }> };
  raw.layers[0]!.group = 42;
  raw.layers[1]!.group = "x".repeat(40);
  const back2 = deserializeProject(raw);
  eq(back2.layers[0]!.groupId, undefined);
  eq(back2.layers[1]!.groupId, undefined);
});
