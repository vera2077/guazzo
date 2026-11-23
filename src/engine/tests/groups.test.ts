import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../document.ts";
import { deserializeProject, serializeProject } from "../io.ts";
import { stampDab } from "../paint.ts";
import { transformLayer } from "../transform.ts";
import { History, layerMoveCommand, layerRemoveCommand } from "../history.ts";


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
    // Opacity 1 so the pair isolates the ONE difference: whether the child
    // blends against the backdrop or against a scratch buffer. A pass-through
    // group that gains opacity is promoted to isolated (the next test).
    g.opacity = passThrough ? 1 : 0.5;
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

test("promotion: a pass-through group honours opacity and a mask", () => {
  const build = (): Document => {
    const doc = new Document(8, 8);
    const bg = doc.addLayer("bg");
    bg.grid.fillRect(0, 0, 8, 8, [200, 200, 200, 255]);
    const g = doc.addGroup("g");
    g.passThrough = true;
    g.opacity = 0.5;
    const child = doc.addLayerTo(g, "child");
    child.blendMode = "multiply";
    child.grid.fillRect(0, 0, 8, 8, [128, 128, 128, 255]);
    return doc;
  };
  const px = build().composite();
  const at = px[(4 * 8 + 4) * 4] ?? 0;
  // 164 is the isolated answer: the panel offers opacity, so it must act.
  assert.ok(Math.abs(at - 164) <= 3, `promoted pass-through ${at}`);
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

test("moveLayerTo: a group cannot move into its own descendant", () => {
  const doc = new Document(4, 4);
  const g = doc.addGroup("g");
  const kid = doc.addGroupTo(g, "kid");
  const grand = doc.addLayerTo(kid, "grand");
  assert.throws(
    () => doc.moveLayerTo(null, g, 0, kid, 0),
    /cannot move a group into its own descendant/,
  );
  // the refused move left the tree untouched
  assert.equal(doc.inDocument(grand), true);
  assert.equal(doc.parentOf(g), null);
});

test("moveLayerTo: same-parent move forward and backward keeps the order right", () => {
  const doc = new Document(4, 4);
  const a = doc.addLayer("a");
  doc.addLayer("b");
  doc.addLayer("c");
  // forward: a from 0 to 3 -> [b, c, a] (naive remove-then-insert gives [b, a, c])
  doc.moveLayerTo(null, a, 0, null, 3);
  assert.deepEqual(doc.layers.map((l) => l.name), ["b", "c", "a"]);
  // backward: a from 2 to 0 -> [a, b, c]
  doc.moveLayerTo(null, a, 2, null, 0);
  assert.deepEqual(doc.layers.map((l) => l.name), ["a", "b", "c"]);
  assert.equal(doc.layers.length, 3);
});

test("moveLayerTo: a child moves out to the root and back in", () => {
  const doc = new Document(4, 4);
  const g = doc.addGroup("g");
  const kid = doc.addLayerTo(g, "kid");
  doc.moveLayerTo(g, kid, 0, null, 0);
  assert.equal(doc.parentOf(kid), null);
  assert.equal(g.children?.length ?? 0, 0);
  doc.moveLayerTo(null, kid, 0, g, 0);
  assert.equal(doc.parentOf(kid), g);
});

// ---------------------------------------------------------------------------
// Child-operation tests (DoD row 2). These are the operations that used to bail
// silently because `doc.layers.includes(child)` is false for a group child. They
// run at the engine level; the UI half arrives with the panel.
// ---------------------------------------------------------------------------
test("child op: painting targets the child's grid, not its parent's", () => {
  const doc = new Document(16, 16);
  const g = doc.addGroup("g");
  const kid = doc.addLayerTo(g, "kid");
  const before = doc.composite()[0 * 4 + 3];
  stampDab(kid.grid, { x: 8, y: 8, radius: 4, hardness: 1, color: [255, 0, 0], alpha: 1, mode: "normal" });
  const after = doc.composite();
  assert.equal(before, 0, "the child started empty");
  assert.ok((after[(8 * 16 + 8) * 4 + 3] ?? 0) > 0, "the dab landed in the composite");
  assert.equal(g.grid.allocated, 0, "the group has no pixels of its own");
});

test("child op: transforming a child moves its pixels and leaves the parent alone", () => {
  const doc = new Document(16, 16);
  const g = doc.addGroup("g");
  const kid = doc.addLayerTo(g, "kid");
  kid.grid.fillRect(2, 2, 4, 4, [255, 0, 0, 255]);
  transformLayer(kid, { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 6, dy: 0 });
  const px = doc.composite();
  const at = (x: number, y: number): number => px[(y * 16 + x) * 4 + 3] ?? 0;
  assert.equal(at(3, 3), 0, "the old position is empty");
  assert.ok(at(9, 3) > 0, "the moved position is painted");
  assert.equal(g.grid.allocated, 0);
});

// NOT WRITTEN YET: "child op: deleting a child and undoing restores it INSIDE its
// group". The first version blew up with RangeError: Array buffer allocation
// failed after ~54 s, which is a real signal, not a flaky test: layerRemoveCommand
// charges subtreeBytes and the History then evicts, so something in that path
// allocates from the byte count. It belongs with the history slice, with the
// eviction budget in view - not papered over here.

test("guard: insertLayer refuses the two ways a node exists twice", () => {
  // No history, no painting, no document bigger than 64px: this test cannot
  // abort, and it is the contract the stale-spot bugs violated.
  const doc = new Document(64, 64);
  const g = doc.addGroup("g");
  const inner = doc.addLayerTo(g, "inner");
  assert.throws(() => doc.insertLayer(null, inner, 0), /already in the document/);
  // A node that is its own parent trips the "already in the document" check first;
  // the descendant guard covers the case where the ancestor is a DIFFERENT node.
  assert.throws(() => doc.insertLayer(g, g, 0), /already in the document|own descendant/);
  assert.throws(() => doc.insertLayer(inner, g, 0), /own descendant|already in the document/);
  assert.strictEqual(doc.layerCount(), 2);
  assert.strictEqual(doc.parentOf(inner), g);
});

test("row 2: delete/undo/redo a group child is stable across cycles", () => {
  const doc = new Document(1024, 1024);
  const g = doc.addGroup("g");
  const kids = [0, 1, 2].map((i) => doc.addLayerTo(g, `kid${i}`));
  for (const k of kids) k.grid.fillRect(0, 0, 64, 64, [40, 80, 160, 255]);
  const total = doc.layerCount();
  assert.strictEqual(total, 4);
  const target = kids[1]!;
  const h = new History();
  // History.push RECORDS an entry; it never executes it. Every real caller mutates
  // first (deleteActiveLayer: removeLayerFrom then pushHist). Pushing alone left the
  // layer attached, so the next assertion compared a Layer against undefined - and
  // formatting THAT failure inspected a 1024 TileGrid, which was the 60 s and the
  // exit 134. One line of mutation, and the cycle assertions were always right.
  doc.removeLayerFrom(g, target);
  h.push(layerRemoveCommand(doc, target, { parent: g, index: 1 }));
  // assert.ok, not strictEqual: a boolean failure message cannot print a document.
  assert.ok(doc.parentOf(target) === undefined, "detached");
  assert.strictEqual(doc.layerCount(), 3);
  for (let cycle = 0; cycle < 3; cycle++) {
    h.undo();
    assert.ok(doc.parentOf(target) === g, `cycle ${cycle}: back inside its group`);
    assert.strictEqual(doc.layerCount(), total, `cycle ${cycle}: no node was duplicated`);
    assert.deepEqual((g.children ?? []).map((l) => l.name), ["kid0", "kid1", "kid2"]);
    h.redo();
    assert.ok(doc.parentOf(target) === undefined, `cycle ${cycle}: removed again`);
    assert.strictEqual(doc.layerCount(), 3, `cycle ${cycle}: redo removed it once`);
  }
});

test("row 3: raise/lower keeps a child among its own siblings", () => {
  // The shell's moveLayer now resolves parentOf + moveLayerTo; this is the same call
  // chain at engine level, so a flat index cannot pass it.
  const doc = new Document(64, 64);
  const g = doc.addGroup("g");
  const kids = [0, 1, 2].map((i) => doc.addLayerTo(g, `kid${i}`));
  const h = new History();
  const from = { parent: g, index: 0 };
  const to = { parent: g, index: 2 };
  doc.moveLayerTo(g, kids[0]!, from.index, g, to.index);
  h.push(layerMoveCommand(doc, kids[0]!, from, to));
  // moveLayerTo compensates the remove-then-insert shift for a same-parent forward
  // move, so "index 2" lands the node at the position it occupied relative to its
  // siblings - [kid1, kid0, kid2], not appended last. That is the documented rule and
  // this assertion pins it rather than my assumption.
  assert.deepEqual((g.children ?? []).map((l) => l.name), ["kid1", "kid0", "kid2"]);
  assert.strictEqual(doc.layerCount(), 4); // still one group + three children
  h.undo();
  assert.deepEqual((g.children ?? []).map((l) => l.name), ["kid0", "kid1", "kid2"]);
  assert.strictEqual(doc.layerCount(), 4);
});

test("a group's scratch is bounded to its content, and still lands in the right place", () => {
  // The scratch used to be a full-canvas buffer per group. With 256 px tiles a
  // 1024² document where the group's content sits in the last tile exercises
  // the bounded path: the scratch is 256², not 1024², so the write mapping has
  // to carry the offset. A bounds bug moves the picture; a full-canvas buffer
  // is 1 GiB at 16384², so both halves are worth pinning.
  const doc = new Document(1024, 1024);
  const g = doc.addGroup("Corner");
  const inner = doc.addLayerTo(g, "red");
  const red = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) { red[i * 4] = 255; red[i * 4 + 3] = 255; }
  inner.grid.writeRect(900, 904, 4, 4, red);
  const out = doc.composite();
  const at = (x: number, y: number): number => out[(y * 1024 + x) * 4 + 3]!;
  assert.equal(at(901, 905), 255, "the group's content must land at its own coordinates");
  assert.equal(at(0, 0), 0, "nothing outside the content rect may be painted");
  assert.equal(out[(905 * 1024 + 901) * 4]!, 255, "the red channel must survive");
});

test("an adjustment child keeps the group's full rect", () => {
  // An adjustment reads the backdrop under every pixel, so bounding the
  // scratch to the sibling tiles would change the picture: this is the guard
  // that groupContentRect must return null for it.
  const doc = new Document(32, 32);
  const base = doc.addLayer("base");
  base.grid.writeRect(0, 0, 32, 32, new Uint8ClampedArray(32 * 32 * 4).fill(200));
  const g = doc.addGroup("Adjusted");
  doc.addLayerTo(g, "top").grid.writeRect(0, 0, 2, 2, new Uint8ClampedArray(2 * 2 * 4).fill(255));
  const adj = doc.addAdjustLayer({ kind: "invert" });
  doc.moveLayerTo(null, adj, doc.layers.indexOf(adj), g, 0);
  const out = doc.composite();
  assert.equal(out[(20 * 32 + 20) * 4]!, 200, "the group's adjustment only sees its own subtree");
});
