import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../document.ts";
import { deserializeProject, serializeProject } from "../io.ts";

function fill(layer: { grid: any }, rgba: [number, number, number, number]): void {
  const [r, gg, b, a] = rgba;
  layer.grid.fillRect(0, 0, 8, 8, [r, gg, b, a]);
}

test("groups exist in the model and hold children off the top-level stack", () => {
  const doc = new Document(8, 8);
  const g = doc.addGroup("Group 1");
  assert.equal(g.kind, "group");
  assert.deepEqual(doc.layers.map((l) => l.name), ["Group 1"]);
  const inner = doc.addLayerTo(g, "Inner");
  assert.equal(inner.kind, "pixel");
  assert.equal(doc.layers.length, 1, "a child is not a top-level layer");
  assert.equal(g.children?.length, 1);
  assert.deepEqual(doc.allLayers().map((l) => l.name), ["Group 1", "Inner"]);
});

test("a group composites its children", () => {
  const doc = new Document(8, 8);
  const g = doc.addGroup("G");
  const inner = doc.addLayerTo(g, "red");
  fill(inner, [255, 0, 0, 255]);
  const px = doc.composite();
  assert.deepEqual([px[0], px[1], px[2], px[3]], [255, 0, 0, 255]);
});

test("group opacity applies once, to the composited group", () => {
  const doc = new Document(8, 8);
  const bg = doc.addLayer("bg");
  fill(bg, [255, 255, 255, 255]);
  const g = doc.addGroup("G");
  g.opacity = 0.5;
  const inner = doc.addLayerTo(g, "red");
  fill(inner, [255, 0, 0, 255]);
  const px = doc.composite();
  // 50% red over white: r=255, g=b~128 (not 255/0 from double-applied opacity)
  assert.ok(Math.abs(px[1]! - 128) <= 2, `green should be ~128, got ${px[1]}`);
  assert.ok(px[0]! === 255 || Math.abs(px[0]! - 255) <= 1, "red stays saturated");
});

test("group blend mode styles the composite, and hidden groups hide children", () => {
  const doc = new Document(8, 8);
  const bg = doc.addLayer("bg");
  fill(bg, [200, 200, 200, 255]);
  const g = doc.addGroup("mul");
  g.blendMode = "multiply";
  const inner = doc.addLayerTo(g, "grey");
  fill(inner, [128, 128, 128, 255]);
  const px = doc.composite();
  assert.ok(Math.abs(px[0]! - 100) <= 2, `multiply should give ~100, got ${px[0]}`);

  g.visible = false;
  const hidden = doc.composite();
  assert.equal(hidden[0], 200, "a hidden group takes its whole subtree with it");
});

test("groups nest, and the inner group's own opacity still counts", () => {
  const doc = new Document(8, 8);
  const bg = doc.addLayer("bg");
  fill(bg, [255, 255, 255, 255]);
  const outer = doc.addGroup("outer");
  const middle = doc.addGroupTo(outer, "middle");
  const innerGroup = doc.addGroupTo(middle, "inner");
  innerGroup.opacity = 0.5;
  const leaf = doc.addLayerTo(innerGroup, "leaf");
  fill(leaf, [0, 0, 0, 255]);
  const px = doc.composite();
  assert.ok(Math.abs(px[0]! - 128) <= 3, `nested 50% black over white ~128, got ${px[0]}`);
});

test("a group mask clips its children", () => {
  const doc = new Document(8, 8);
  const bg = doc.addLayer("bg");
  fill(bg, [255, 255, 255, 255]);
  const g = doc.addGroup("G");
  const inner = doc.addLayerTo(g, "red");
  fill(inner, [255, 0, 0, 255]);
  const mask = doc.attachMask(g);
  for (let x = 0; x < 8; x++) mask.fillRect(x, 0, 1, 4, [255, 255, 255, 255]); // top half hidden
  const px = doc.composite();
  assert.equal(px[1], 255, "masked-out area keeps the backdrop");
  const bottom = (5 * 8 + 0) * 4;
  assert.ok(Math.abs(px[bottom + 1]! - 0) <= 2, "unmasked area shows the child");
});

test("a project round-trip keeps the tree, group opacity and blend mode", () => {
  const doc = new Document(8, 8);
  const bg = doc.addLayer("bg");
  fill(bg, [255, 255, 255, 255]);
  const outer = doc.addGroup("outer");
  outer.opacity = 0.5;
  outer.blendMode = "multiply";
  const innerGroup = doc.addGroupTo(outer, "inner");
  const leaf = doc.addLayerTo(innerGroup, "leaf");
  fill(leaf, [0, 0, 0, 255]);

  const json = serializeProject(doc, "tree");
  const back = deserializeProject(json);
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.doc.layers.map((l) => l.name), ["bg", "outer"]);
  const g = back.doc.layers[1]!;
  assert.equal(g.kind, "group");
  assert.equal(g.opacity, 0.5);
  assert.equal(g.blendMode, "multiply");
  assert.equal(g.children?.[0]?.kind, "group");
  assert.equal(g.children?.[0]?.children?.[0]?.kind, "pixel");
  assert.deepEqual(back.doc.composite(), doc.composite(), "the tree composites the same after a round trip");
});

// ---------------------------------------------------------------------------
// Pass-through vs isolation. This pair is the ONLY fixture that proves which
// one is implemented: a Multiply child inside a 50 % group gives 164 when the
// group is isolated (child composites over nothing inside the scratch, then the
// scratch blends at 50 %) and 100 when it passes through (the child multiplies
// the real backdrop at full strength).
// ---------------------------------------------------------------------------
test("pass-through: a group lets its children blend against the backdrop", () => {
  const build = (passThrough: boolean): Document => {
    const doc = new Document(8, 8);
    const bg = doc.addLayer("bg");
    bg.grid.fillRect(0, 0, 8, 8, [200, 200, 200, 255]);
    const g = doc.addGroup("g");
    g.opacity = 0.5;
    const child = doc.addLayerTo(g, "child");
    child.blendMode = "multiply";
    child.grid.fillRect(0, 0, 8, 8, [128, 128, 128, 255]);
    if (passThrough) g.passThrough = true;
    return doc;
  };
  const isolated = build(false).composite();
  const passed = build(true).composite();
  const at = (px: Uint8ClampedArray): number => px[(4 * 8 + 4) * 4] ?? 0;
  assert.ok(Math.abs(at(isolated) - 164) <= 3, `isolated ${at(isolated)}`);
  assert.ok(Math.abs(at(passed) - 100) <= 3, `pass-through ${at(passed)}`);
  assert.notEqual(at(isolated), at(passed), "the two modes must differ");
});

test("membership: inDocument/parentOf/layerNumber see group children", () => {
  const doc = new Document(4, 4);
  const bg = doc.addLayer("bg");
  const g = doc.addGroup("g");
  const kid = doc.addLayerTo(g, "kid");
  assert.equal(doc.inDocument(kid), true);
  const stranger = new Document(4, 4).addLayer("stranger");
  assert.equal(doc.inDocument(stranger), false);
  assert.equal(doc.parentOf(bg), null);
  assert.equal(doc.parentOf(kid), g);
  assert.equal(doc.parentOf(g), null);
  assert.ok(doc.layerNumber(g) >= 0);
  assert.equal(doc.layerNumber(kid), doc.layerNumber(g) + 1);
});

test("passThrough survives a project round-trip (reopening must not change the picture)", () => {
  const doc = new Document(8, 8);
  const bg = doc.addLayer("bg");
  bg.grid.fillRect(0, 0, 8, 8, [200, 200, 200, 255]);
  const g = doc.addGroup("g");
  g.opacity = 0.5;
  g.passThrough = true;
  const child = doc.addLayerTo(g, "child");
  child.blendMode = "multiply";
  child.grid.fillRect(0, 0, 8, 8, [128, 128, 128, 255]);
  const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(doc)))).doc;
  const rg = back.layers.find((l) => l.name === "g");
  assert.ok(rg, "the group came back");
  assert.equal(rg!.passThrough, true, "passThrough survived");
  assert.deepEqual(back.composite(), doc.composite(), "same picture after reopening");
});

test("the layer count and the depth-first number agree (status bar vs panel rows)", () => {
  const doc = new Document(4, 4);
  doc.addLayer("bg");
  const g = doc.addGroup("g");
  doc.addLayerTo(g, "kid");
  doc.addGroupTo(g, "inner");
  // N counts every node the panel draws a row for: bg, g, kid, inner.
  assert.equal(doc.layerCount(), 4);
  assert.equal(doc.layerCount(), doc.allLayers().length);
  // and the number of the last node matches the denominator the status bar shows
  const nodes = doc.allLayers();
  assert.equal(doc.layerNumber(nodes[nodes.length - 1]!), doc.layerCount() - 1);
});
