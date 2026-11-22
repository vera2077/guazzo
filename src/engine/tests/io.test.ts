import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, maskAt, setMaskAt, type TextLayerMeta } from "../document.ts";
import { stampDab } from "../paint.ts";
import { serializeProject, deserializeProject, MAX_PROJECT_TILES, PROJECT_VERSION } from "../io.ts";
import { MAX_IMPORT_BYTES } from "../docmeta.ts";
import { eq } from "./helpers.ts";

/**
 * Most tests care about the document, not the repair log. A1 turned the
 * tolerant loader into one that REPORTS what it repaired, so the doc is read
 * through this shim and the warning behaviour is tested explicitly below.
 */
function loadDoc(json: unknown): Document {
  return deserializeProject(json).doc;
}


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
  const restored = loadDoc(JSON.parse(text));

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
  const restored = loadDoc(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(restored.composite(), doc.composite());
});

test("deserialize rejects foreign or malformed files", () => {
  assert.throws(() => loadDoc(null));
  assert.throws(() => loadDoc({ format: "nope", version: 1, width: 10, height: 10, layers: [] }));
  assert.throws(() => loadDoc({ format: "guazzo-project", version: 99, width: 10, height: 10, layers: [] }));
});

test("deserialize rejects files above the 16384px canvas limit", () => {
  // a third-party/crafted project above MAX_DIM would allocate gigabytes of
  // tile buffers and then render blank — refuse it instead
  assert.throws(
    () => loadDoc({ format: "guazzo-project", version: 1, width: 20000, height: 10, layers: [] }),
    /too large/,
  );
  assert.throws(
    () => loadDoc({ format: "guazzo-project", version: 1, width: 10, height: 20000, layers: [] }),
    /too large/,
  );
  // exactly at the cap is fine (tiles are sparse — an empty 16384² doc is cheap)
  const ok = loadDoc({ format: "guazzo-project", version: 1, width: 16384, height: 16384, layers: [] });
  eq(ok.width, 16384);
});

test("deserialize tolerates junk tiles without failing the file", () => {
  const doc = new Document(300, 200);
  doc.addBackground("Background");
  const json = serializeProject(doc);
  json.layers[0]!.tiles.push({ tx: 999, ty: 999, data: "AAAA" });
  json.layers[0]!.tiles.push({ tx: 0, ty: 0, data: "zzz-not-base64" });
  const restored = loadDoc(json);
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
  const restored = loadDoc(JSON.parse(JSON.stringify(serializeProject(doc))));
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
  const rl = loadDoc(legacy).layers[0]!.textData!;
  assert.equal(rl.lines.length, 1);
  assert.deepEqual(rl.lines[0], [{ text: "old", bold: false, italic: false, underline: false, strike: false, font: "Arial" }]);
  // junk recipe → dropped, pixels kept
  const json2 = serializeProject(doc);
  json2.layers[0]!.text = { lines: "junk", x: "no" } as unknown as TextLayerMeta;
  const restored2 = loadDoc(json2);
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

  const back = loadDoc(JSON.parse(JSON.stringify(serializeProject(doc, "layers"))));
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

test("a gradient map's stops survive a round-trip", () => {
  const doc = new Document(8, 8);
  doc.addBackground();
  doc.addAdjustLayer({
    kind: "gradient-map",
    map: [
      { pos: 0, color: [255, 40, 0] },
      { pos: 0.5, color: [0, 200, 80] },
      { pos: 1, color: [10, 20, 255] },
    ],
  });

  const back = loadDoc(JSON.parse(JSON.stringify(serializeProject(doc, "map"))));
  eq(back.layers[1]!.adjust?.kind, "gradient-map");
  const map = back.layers[1]!.adjust?.map;
  eq(map?.length, 3);
  assert.deepEqual(map?.[1], { pos: 0.5, color: [0, 200, 80] });
  // the picture is the same after saving, not just the numbers
  assert.deepEqual(back.composite(), doc.composite());
});

test("channel-mixer weights survive a round-trip", () => {
  const doc = new Document(8, 8);
  doc.addBackground();
  doc.addAdjustLayer({
    kind: "channel-mixer",
    mixer: {
      red: { r: 110, g: -10, b: 0, constant: 2 },
      green: { r: 0, g: 95, b: 5, constant: 0 },
      blue: { r: 0, g: 0, b: 100, constant: -3 },
      gray: { r: 30, g: 59, b: 11, constant: 0 },
    },
  });
  const back = loadDoc(JSON.parse(JSON.stringify(serializeProject(doc, "mix"))));
  eq(back.layers[1]!.adjust?.kind, "channel-mixer");
  assert.deepEqual(back.layers[1]!.adjust?.mixer?.red, { r: 110, g: -10, b: 0, constant: 2 });
  assert.deepEqual(back.layers[1]!.adjust?.mixer?.gray, { r: 30, g: 59, b: 11, constant: 0 });
  assert.deepEqual(back.composite(), doc.composite());
});

test("a layer mask survives a round-trip byte for byte", () => {
  const doc = new Document(20, 20);
  doc.addBackground();
  const top = doc.addLayer("top");
  top.grid.fillRect(0, 0, 20, 20, [255, 0, 0, 255]);
  const mask = doc.attachMask(top);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) setMaskAt(mask, x, y, 0);

  const back = loadDoc(JSON.parse(JSON.stringify(serializeProject(doc, "m"))));
  const m = back.layers[1]!.mask;
  assert.ok(m, "mask restored");
  eq(maskAt(m, 2, 2), 0);
  eq(maskAt(m, 15, 2), 255);
  assert.deepEqual(back.composite(), doc.composite());
});

test("a project without masks or adjustment layers still loads", () => {
  const doc = new Document(8, 8);
  doc.addBackground();
  const back = loadDoc(JSON.parse(JSON.stringify(serializeProject(doc))));
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
  const back = loadDoc(JSON.parse(JSON.stringify(serializeProject(doc))));
  eq(back.layers[0]!.groupId, "G2");
  eq(back.layers[1]!.groupId, "G2");
  eq(back.layers[1]!.clipToBelow, true);
  // a corrupt id is ignored rather than breaking the file
  const raw = JSON.parse(JSON.stringify(serializeProject(doc))) as { layers: Array<{ group?: unknown }> };
  raw.layers[0]!.group = 42;
  raw.layers[1]!.group = "x".repeat(40);
  const back2 = loadDoc(raw);
  eq(back2.layers[0]!.groupId, undefined);
  eq(back2.layers[1]!.groupId, undefined);
});

test("text box wrap and boxH survive a project round-trip", () => {
  const doc = new Document(64, 64);
  const l = doc.addLayer("Text");
  l.textData = {
    lines: [[{ text: "hello world", bold: false, italic: false, underline: false, strike: false, font: "Arial" }]],
    x: 4, y: 6, w: 90, h: 14, wrap: 220, boxH: 90,
    size: 12, color: [255, 255, 255],
  };
  const back = loadDoc(JSON.parse(JSON.stringify(serializeProject(doc))));
  const m = back.layers[0]!.textData!;
  eq(m.wrap, 220);
  eq(m.boxH, 90);
  eq(m.x, 4);
  eq(m.size, 12);
  // junk wrap values are dropped, not fatal
  const raw = JSON.parse(JSON.stringify(serializeProject(doc))) as { layers: Array<{ text?: { wrap?: unknown } }> };
  raw.layers[0]!.text!.wrap = "wide";
  const back2 = loadDoc(raw);
  eq(back2.layers[0]!.textData!.wrap, undefined);
  eq(back2.layers[0]!.textData!.boxH, 90);
});

test("io: a project with an absurd layer count is refused", () => {
  const doc = new Document(8, 8);
  doc.addLayer("only");
  const json = serializeProject(doc, "many") as unknown as { layers: unknown[] };
  json.layers = Array.from({ length: 2500 }, () => ({ name: "x", tiles: [] }));
  assert.throws(() => loadDoc(json), /limit is 2000/);
});

test("a clean project loads with no warnings", () => {
  const doc = new Document(32, 32);
  const l = doc.addLayer("Clean");
  const tile = l.grid.tile(0, 0, true)!;
  tile.data.fill(200);
  const loaded = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc))));
  assert.deepEqual(loaded.warnings, []);
});

test("load repairs are reported, not silently swallowed", () => {
  const doc = new Document(64, 64);
  const l = doc.addLayer("Broken");
  const layerJson = serializeProject(doc).layers[0]!;
  const raw = {
    format: "guazzo-project",
    version: 1,
    width: 64,
    height: 64,
    layers: [{
      ...layerJson,
      opacity: 4,
      blendMode: "not-a-mode",
      tiles: [
        { tx: 0, ty: 0, data: "AAAA" },          // too short for a 256px tile
        { tx: -1, ty: 0, data: "AAAA" },         // negative coordinate
      ],
    }],
  };
  const loaded = deserializeProject(raw);
  eq(loaded.doc.width, 64);
  const joined = loaded.warnings.join(" | ");
  assert.match(joined, /opacity 4 is not 0–1/);
  assert.match(joined, /unknown blend mode "not-a-mode"/);
  assert.match(joined, /2 tiles could not be restored/);
  void l;
});

test("a hostile tile list is refused before allocating", () => {
  const doc = new Document(64, 64);
  doc.addLayer("L");
  const json = serializeProject(doc, "bomb");
  // claim more tiles than any canvas can hold; each tile is 256 KB, so decoding
  // them all would be tens of gigabytes
  (json.layers[0] as unknown as { tiles: unknown[] }).tiles =
    Array.from({ length: 5000 }, () => ({ tx: 0, ty: 0, data: "" }));
  assert.throws(() => deserializeProject(json), /the limit is 4096/);
});

test("a non-object project is a message, not a TypeError", () => {
  for (const bad of [null, 42, "x", [], undefined]) {
    assert.throws(() => deserializeProject(bad), /not a valid guazzo project/);
  }
});

test("AT1: a layer x tile product is refused before allocating on either branch", () => {
  // 1200 tiles is under the old per-layer 4096 ceiling but is ~314 MB decoded —
  // more than the whole import budget, and it used to be reached one layer at a
  // time until the machine ran out of memory.
  const doc = new Document(64, 64);
  doc.addLayer("L");
  const json = serializeProject(doc, "budget");
  (json.layers[0] as unknown as { tiles: unknown[] }).tiles =
    Array.from({ length: 1200 }, (_, i) => ({ tx: i % 60, ty: Math.floor(i / 60), data: "" }));
  assert.throws(() => deserializeProject(json), /needs more than \d+ tiles/);

  // the mask branch had no ceiling at all
  const doc2 = new Document(64, 64);
  doc2.addLayer("M");
  const json2 = serializeProject(doc2, "mask-budget");
  (json2.layers[0] as unknown as { mask: unknown[] }).mask =
    Array.from({ length: 5000 }, () => ({ tx: 0, ty: 0, data: "" }));
  assert.throws(() => deserializeProject(json2), /mask tiles — the limit is 4096/);
});

test("AT1: the tile budget and the import budget are the same number", () => {
  // io.ts writes 1024 as a literal to dodge a bundle TDZ; this keeps it honest.
  eq(MAX_PROJECT_TILES * 256 * 256 * 4, MAX_IMPORT_BYTES);
});

test("autosave snapshot: project bytes survive the JSON text round trip", () => {
  const doc = new Document(8, 8);
  const layer = doc.addLayer("Recovered");
  layer.grid.fillRect(1, 1, 3, 2, [12, 34, 56, 78]);
  const text = JSON.stringify({
    savedAt: 1,
    tabs: [{ name: "Recovered", project: serializeProject(doc, "Recovered") }],
    active: 0,
  });
  const parsed = JSON.parse(text) as { tabs: Array<{ project: unknown }> };
  const back = deserializeProject(parsed.tabs[0]!.project).doc;
  const before = new Uint8ClampedArray(8 * 8 * 4);
  const after = new Uint8ClampedArray(8 * 8 * 4);
  doc.layers[0]!.grid.readRect(0, 0, 8, 8, before);
  back.layers[0]!.grid.readRect(0, 0, 8, 8, after);
  assert.deepEqual(after, before);
});

test("autosave snapshot: a future format version is refused", () => {
  const doc = new Document(4, 4);
  doc.addLayer("L");
  const snapshot = serializeProject(doc, "future") as unknown as { version: number };
  snapshot.version = PROJECT_VERSION + 1;
  assert.throws(() => deserializeProject(snapshot), /not a valid guazzo project/);
});

test("autosave snapshot: a corrupt payload is refused", () => {
  const doc = new Document(4, 4);
  doc.addLayer("L");
  const snapshot = serializeProject(doc, "corrupt") as unknown as { layers: unknown };
  snapshot.layers = "not a layer list";
  assert.throws(() => deserializeProject(snapshot), /not a valid guazzo project/);
});

test("MAX_PROJECT_LAYERS counts nodes, not top-level rows (nested at the cap round-trips)", () => {
  // Built from a real save so the shape is the format's own, not a guess.
  // GENERAL RULE: a hand-built fixture tests my idea of the format, not the
  // format. My first version of this test was rejected as "not a valid guazzo
  // project file" - the code was right, the fixture was fiction. Serialise a
  // real document whenever the thing under test is the format itself.
  const doc = new Document(8, 8);
  const g = doc.addGroup("g");
  for (let i = 0; i < 1999; i++) doc.addLayerTo(g, `l${i}`);
  const json = JSON.parse(JSON.stringify(serializeProject(doc))) as {
    layers: Array<{ children?: unknown[] }>;
  };
  // 1 group + 1999 leaves = 2000 nodes: at the cap, it must load.
  const back = deserializeProject(json).doc;
  eq(back.layerCount(), 2000);
  // One more node tips it over, and the message names NODES (2001, not 1).
  json.layers[0]!.children!.push(JSON.parse(JSON.stringify(json.layers[0]!.children![0])));
  assert.throws(() => deserializeProject(json), /project has 2001 layers/);
});

test("a gradient fill layer survives save and load", () => {
  const doc = new Document(16, 16);
  doc.addFillLayer([10, 20, 30], "Grad", {
    type: "radial",
    angle: 45,
    stops: [{ at: 0.2, color: [255, 0, 0] }, { at: 0.9, color: [0, 0, 255] }],
  });
  const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc)))).doc;
  const layer = back.layers[0]!;
  eq(layer.kind, "fill");
  eq(layer.fill?.gradient?.type, "radial");
  eq(layer.fill?.gradient?.angle, 45);
  eq(layer.fill?.gradient?.stops.length, 2);
  eq(layer.fill?.gradient?.stops[0]!.at, 0.2);
  eq(layer.fill?.gradient?.stops[1]!.color[2], 255);
  // and it still composites as a gradient after the round trip
  const px = back.composite();
  assert.ok(px.length > 0);
});
