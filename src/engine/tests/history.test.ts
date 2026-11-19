/**
 * history.test.ts — hybrid undo: dirty-tile stroke snapshots + commands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { History, StrokeSession, propertyCommand, layerAddCommand, layerRemoveCommand, layerMoveCommand, type HistoryEntry } from "../history.ts";
import { TileGrid } from "../tile.ts";
import { Document } from "../document.ts";
import { stampDab } from "../paint.ts";
import { eq } from "./helpers.ts";

function readAll(grid: TileGrid): Uint8ClampedArray {
  const out = new Uint8ClampedArray(grid.width * grid.height * 4);
  grid.readRect(0, 0, grid.width, grid.height, out);
  return out;
}

test("interleaved undo: property + layer-add + stroke compose in order", () => {
  // The review asked for one integration test where DIFFERENT entry types
  // are pushed in sequence — each undo must peel exactly one step, restoring
  // the precise document state (layer count, metadata, pixels) it had.
  const doc = new Document(64, 64);
  const bg = doc.addLayer("BG");
  bg.grid.fillRect(0, 0, 64, 64, [255, 255, 255, 255]);
  const afterBg = doc.composite();

  const h = new History(50);
  // 1. property on the background
  const beforeOpacity = bg.opacity;
  bg.opacity = 0.5;
  h.push(propertyCommand("Opacity 50%", (v) => { bg.opacity = v as number; }, beforeOpacity, 0.5));
  // 2. new layer
  const nl = doc.addLayer("L2");
  h.push(layerAddCommand(doc, nl, 1));
  // 3. stroke on the new layer
  const s = new StrokeSession();
  stampDab(nl.grid, { x: 32, y: 32, radius: 8, hardness: 1, alpha: 1, color: [255, 0, 0], mode: "normal" }, s);
  h.push(s.finish(nl.grid, "Paint")!);

  eq(h.position, 3);
  eq(doc.layers.length, 2);

  // peel in reverse
  eq(h.undo(), true); // stroke
  eq(doc.layers.length, 2); // layer still there
  const afterStrokeUndo = doc.composite();
  eq(afterStrokeUndo[0], 255); // bg white survives at 50% over transparent
  eq(h.undo(), true); // layer add
  eq(doc.layers.length, 1);
  eq(h.undo(), true); // opacity
  eq(bg.opacity, beforeOpacity);
  assert.deepEqual(doc.composite(), afterBg); // byte-exact original

  // replay forward: all three steps reappear in order
  eq(h.redo(), true);
  eq(bg.opacity, 0.5);
  eq(h.redo(), true);
  eq(doc.layers.length, 2);
  eq(h.redo(), true); // stroke back
  const px = new Uint8ClampedArray(64 * 64 * 4);
  doc.compositeRect(24, 24, 16, 16, px);
  let red = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) red++;
  assert.ok(red > 100, `stroke pixels must be back, got ${red} covered`);
});

test("stroke undo restores exact pixels across tile boundaries", () => {
  const grid = new TileGrid(600, 600); // 3×3 tiles; dab spans the 256-px boundary
  grid.fillRect(10, 10, 100, 100, [10, 20, 30, 255]);
  const original = readAll(grid);

  const s = new StrokeSession();
  stampDab(grid, { x: 250, y: 250, radius: 40, hardness: 0.8, alpha: 1, color: [255, 0, 0], mode: "normal" }, s);
  stampDab(grid, { x: 300, y: 260, radius: 40, hardness: 0.8, alpha: 1, color: [255, 0, 0], mode: "normal" }, s);
  const entry = s.finish(grid, "Paint");
  assert.ok(entry, "finish should produce an entry");

  const painted = readAll(grid);
  assert.notDeepEqual(painted, original, "stroke must change pixels");

  entry!.undo();
  assert.deepEqual(readAll(grid), original, "undo must restore the exact before-state");

  entry!.redo();
  assert.deepEqual(readAll(grid), painted, "redo must restore the exact after-state");
});

test("stroke session snapshots only touched tiles", () => {
  const grid = new TileGrid(600, 600);
  const s = new StrokeSession();
  stampDab(grid, { x: 30, y: 30, radius: 10, hardness: 1, alpha: 1, color: [0, 255, 0], mode: "normal" }, s);
  const entry = s.finish(grid);
  assert.ok(entry);
  // one dab at (30,30) r=10 touches exactly one tile
  assert.equal(grid.allocated, 1);
});

test("empty stroke finish returns null", () => {
  const grid = new TileGrid(100, 100);
  const s = new StrokeSession();
  // dab fully outside the grid → nothing noted
  stampDab(grid, { x: -50, y: -50, radius: 5, hardness: 1, alpha: 1, color: [0, 0, 0], mode: "normal" }, s);
  assert.equal(s.finish(grid), null);
});

// Non-assertion comparison helper. Needed because @types/node 26 types
// strictEqual as `asserts actual is T` AND plain `v === N` narrowing never
// resets across closure mutation of captured `v` (undo/redo write v inside
// closures), so successive comparisons narrow v to never. `unknown` params
// defeat narrowing at the call site.
test("History push/undo/redo with redo-tail truncation", () => {
  const h = new History(10);
  let v: number = 0;
  const mk = (label: string, delta: number) => ({
    label,
    undo: () => { v -= delta; },
    redo: () => { v += delta; },
  });
  // caller applies the initial action itself; push records it
  v += 1; h.push(mk("a", 1));
  v += 2; h.push(mk("b", 2));
  v += 3; h.push(mk("c", 3));
  // note: use eq(), NOT assert.equal(v, N) / assert.ok(v === N) — see helper above.
  eq(v, 6);
  assert.deepEqual(h.labels, ["a", "b", "c"]);

  assert.ok(h.undo()); eq(v, 3);
  assert.ok(h.undo()); eq(v, 1);
  assert.ok(h.redo()); eq(v, 3);
  // new action clears the redo tail
  v += 9; h.push(mk("d", 9));
  eq(v, 12);
  assert.ok(!h.canRedo, "redo tail must be gone after a new push");
  assert.deepEqual(h.labels, ["a", "b", "d"]);
  assert.ok(h.undo()); eq(v, 3);
  assert.ok(h.undo()); eq(v, 1);
  assert.ok(h.undo()); eq(v, 0);
  assert.ok(!h.undo(), "nothing left to undo past the start");
});

test("History limit evicts the oldest entry", () => {
  const h = new History(2);
  let v = 0;
  v += 1; h.push({ label: "a", undo: () => { v -= 1; }, redo: () => { v += 1; } });
  v += 2; h.push({ label: "b", undo: () => { v -= 2; }, redo: () => { v += 2; } });
  v += 4; h.push({ label: "c", undo: () => { v -= 4; }, redo: () => { v += 4; } });
  assert.deepEqual(h.labels, ["b", "c"], "oldest entry evicted at limit");
  assert.equal(h.position, 2);
  assert.ok(h.undo()); assert.equal(v, 3);
  assert.ok(h.undo()); assert.equal(v, 1);
  assert.ok(!h.undo(), "evicted entry must not be undoable");
});

test("History jumpTo walks both directions", () => {
  const h = new History(10);
  const mk = (n: number) => ({ label: `e${n}`, undo: () => {}, redo: () => {} });
  h.push(mk(1)); h.push(mk(2)); h.push(mk(3));
  h.jumpTo(1);
  assert.equal(h.position, 1);
  assert.ok(h.canRedo);
  h.jumpTo(3);
  assert.equal(h.position, 3);
  h.jumpTo(0);
  assert.equal(h.position, 0);
  assert.ok(!h.canUndo);
});

test("propertyCommand restores the before value", () => {
  const obj = { opacity: 1 };
  const before = obj.opacity;
  obj.opacity = 0.5;
  const h = new History(10);
  h.push(propertyCommand("Opacity", (v) => { obj.opacity = v as number; }, before, obj.opacity));
  h.undo();
  assert.equal(obj.opacity, 1);
  h.redo();
  assert.equal(obj.opacity, 0.5);
});

test("layerAddCommand / layerRemoveCommand round-trip", () => {
  const doc = new Document(64, 64);
  const bg = doc.addLayer("Background");
  const l1 = doc.addLayer("Layer 1");
  const h = new History(10);

  // add
  const l2 = doc.addLayer("Layer 2");
  h.push(layerAddCommand(doc, l2, 2));
  assert.equal(doc.layers.length, 3);
  h.undo();
  assert.deepEqual(doc.layers.map((l) => l.name), ["Background", "Layer 1"]);
  h.redo();
  assert.deepEqual(doc.layers.map((l) => l.name), ["Background", "Layer 1", "Layer 2"]);

  // remove (not the one we just re-added, to test index restore)
  const removedAt = doc.layers.indexOf(l1);
  doc.removeLayer(l1);
  h.push(layerRemoveCommand(doc, l1, removedAt));
  assert.deepEqual(doc.layers.map((l) => l.name), ["Background", "Layer 2"]);
  h.undo();
  assert.deepEqual(doc.layers.map((l) => l.name), ["Background", "Layer 1", "Layer 2"], "index must be restored exactly");
  h.redo();
  assert.deepEqual(doc.layers.map((l) => l.name), ["Background", "Layer 2"]);

  void bg;
});

test("layerMoveCommand restores order", () => {
  const doc = new Document(64, 64);
  doc.addLayer("A");
  doc.addLayer("B");
  const c = doc.addLayer("C");
  const h = new History(10);
  const from = doc.layers.indexOf(c);
  doc.moveLayer(c, 0);
  h.push(layerMoveCommand(doc, c, from, 0));
  assert.deepEqual(doc.layers.map((l) => l.name), ["C", "A", "B"]);
  h.undo();
  assert.deepEqual(doc.layers.map((l) => l.name), ["A", "B", "C"]);
  h.redo();
  assert.deepEqual(doc.layers.map((l) => l.name), ["C", "A", "B"]);
});

test("undo of a paint stroke via full History stack", () => {
  const doc = new Document(600, 600);
  const layer = doc.addLayer("L");
  const before = doc.composite();

  const s = new StrokeSession();
  stampDab(layer.grid, { x: 250, y: 250, radius: 40, hardness: 0.8, alpha: 1, color: [255, 0, 0], mode: "normal" }, s);
  const entry = s.finish(layer.grid, "Paint");
  assert.ok(entry);
  const h = new History(10);
  h.push(entry!);

  const afterPaint = doc.composite();
  assert.notDeepEqual(afterPaint, before);
  h.undo();
  assert.deepEqual(doc.composite(), before, "undo through History must restore the composite");
  h.redo();
  assert.deepEqual(doc.composite(), afterPaint);
});

test("history evicts by BYTES as well as count (handoff-2 N)", () => {
  // bytes is OMITTED for metadata entries (the real producer contract);
  // `0 ?? META_BYTES` would keep 0 — nullish, not falsy.
  const mk = (label: string, bytes?: number): HistoryEntry => ({
    label,
    bytes,
    undo() { /* no-op */ },
    redo() { /* no-op */ },
  });
  const h = new History(10, 6000); // tiny byte budget, generous count
  for (const [i, n] of [2000, 2000, 2000, 2000].entries()) {
    h.push(mk(String.fromCharCode(97 + i)!, n));
  }
  // 4 × 2000 = 8000 > 6000 → oldest evicted until under budget (3 entries)
  assert.deepEqual(h.labels, ["b", "c", "d"]);
  eq(h.position, 3);
  eq(h.canUndo, true);
  // metadata entries count as META_BYTES, not 0
  const h2 = new History(100, 2048);
  for (let i = 0; i < 3; i++) h2.push(mk(`meta${i}`));
  assert.ok(h2.bytes > 0 && h2.bytes <= 4096, `meta bytes counted, got ${h2.bytes}`);
  // floor: a single oversized entry always survives
  const h3 = new History(10, 100);
  h3.push(mk("huge", 999_999));
  eq(h3.labels.length, 1);
  // redo-tail truncation releases its bytes
  const h4 = new History(10, 6000);
  h4.push(mk("a", 2000));
  h4.push(mk("b", 2000));
  h4.push(mk("c", 2000));
  h4.undo();
  h4.undo();
  const beforeBytes = h4.bytes;
  h4.push(mk("d", 2000)); // drops redo tail b,c then may evict a
  assert.ok(h4.bytes <= beforeBytes, `bytes after push ${h4.bytes} vs ${beforeBytes}`);
  assert.ok(!h4.labels.includes("c"), "redo tail was truncated");
});
