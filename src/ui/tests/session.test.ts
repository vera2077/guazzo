// The session owns the live undo stack: one stack per open tab, and the
// session points at the one that is open now. These tests are the contract the
// old bare global could not state — a tab switch adopts that tab's stack, undo
// and redo run it, and the panel's numbers come from the same object.
//
// It also owns the panel-visibility rule (panel slice item 1). panelRows() is a
// pure function so the reveal rule — a selected descendant of a collapsed group
// must still be drawn — is tested before any rendering code exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DocSession, panelRows } from "../session.ts";
import { Document } from "../../engine/document.ts";
import type { HistoryEntry } from "../../engine/history.ts";

function entry(log: string[], label: string): HistoryEntry {
  return { label, undo: () => log.push(`undo:${label}`), redo: () => log.push(`redo:${label}`) };
}

test("SB1: push records one undoable step and the session reports it", () => {
  const log: string[] = [];
  const session = new DocSession();
  assert.equal(session.canUndo, false);
  assert.equal(session.canRedo, false);
  session.push(entry(log, "Paint"));
  assert.equal(session.canUndo, true);
  assert.equal(session.canRedo, false);
  assert.deepEqual(session.labels, ["Paint"]);
  assert.equal(session.position, 1);
});

test("SB1: undo and redo move the same stack and run the closures once each", () => {
  const log: string[] = [];
  const session = new DocSession();
  session.push(entry(log, "Paint"));
  assert.equal(session.undo(), true);
  assert.equal(session.undo(), false);
  assert.deepEqual(log, ["undo:Paint"]);
  assert.equal(session.canRedo, true);
  assert.equal(session.redo(), true);
  assert.equal(session.redo(), false);
  assert.deepEqual(log, ["undo:Paint", "redo:Paint"]);
});

test("SB1: a new edit clears the redo tail (position is the redo boundary)", () => {
  const log: string[] = [];
  const session = new DocSession();
  session.push(entry(log, "A"));
  session.push(entry(log, "B"));
  session.undo();
  assert.equal(session.canRedo, true);
  session.push(entry(log, "C"));
  assert.equal(session.canRedo, false);
  assert.deepEqual(session.labels, ["A", "C"]);
  assert.deepEqual(log, ["undo:B"]);
});

test("SB1: adopt swaps the stack a tab switch hands over, not the session", () => {
  const log: string[] = [];
  const session = new DocSession();
  session.push(entry(log, "tab-1"));
  const other = new DocSession();
  other.push(entry(log, "tab-2"));
  session.adopt(other.current, new Set());
  assert.deepEqual(session.labels, ["tab-2"]);
  assert.equal(session.position, 1);
  session.undo();
  assert.deepEqual(log, ["undo:tab-2"]);
});

test("SB1: jumpTo and clear address the adopted stack", () => {
  const log: string[] = [];
  const session = new DocSession();
  session.push(entry(log, "A"));
  session.push(entry(log, "B"));
  session.jumpTo(0);
  assert.equal(session.position, 0);
  assert.deepEqual(log, ["undo:B", "undo:A"]);
  session.clear();
  assert.equal(session.canUndo, false);
  assert.deepEqual(session.labels, []);
});

test("panel rows: reverse per level keeps a group's children under the group", () => {
  const doc = new Document(8, 8);
  const bottom = doc.addLayer("bottom");
  const group = doc.addGroup("group");
  const low = doc.addLayerTo(group, "low child");
  const high = doc.addLayerTo(group, "high child");
  const top = doc.addLayer("top");

  const rows = panelRows(doc, top, new Set());
  assert.deepEqual(
    rows.map((r) => [r.node.name, r.depth]),
    [
      ["top", 0],
      ["group", 0],
      ["high child", 1],
      ["low child", 1],
      ["bottom", 0],
    ],
  );
  // `[...allLayers()].reverse()` would put the children above the group and
  // ahead of `top`; identity checks pin each row to the node it names.
  assert.equal(rows[1]!.node, group);
  assert.equal(rows[2]!.node, high);
  assert.equal(rows[3]!.node, low);
  assert.equal(rows[4]!.node, bottom);

  // Pure: a second call is the same view and mutates neither the doc nor the set.
  const again = panelRows(doc, top, new Set());
  assert.deepEqual(
    again.map((r) => [r.node.name, r.depth]),
    rows.map((r) => [r.node.name, r.depth]),
  );
  assert.equal(doc.layers.length, 3);
});

test("panel rows: a collapsed group keeps its row and hides its children", () => {
  const doc = new Document(8, 8);
  doc.addLayer("bottom");
  const group = doc.addGroup("group");
  doc.addLayerTo(group, "low child");
  doc.addLayerTo(group, "high child");
  const top = doc.addLayer("top");

  const rows = panelRows(doc, top, new Set([group.id]));
  assert.deepEqual(
    rows.map((r) => r.node.name),
    ["top", "group", "bottom"],
  );
  assert.ok(rows.some((r) => r.node === group), "the collapsed group must keep its own row");
  assert.ok(!rows.some((r) => r.node.name.endsWith("child")), "children must not be drawn");
});

test("panel rows: the grandchild under collapsed groups reveals both ancestors", () => {
  const doc = new Document(8, 8);
  const outer = doc.addGroup("outer");
  const inner = doc.addGroupTo(outer, "inner");
  const leaf = doc.addLayerTo(inner, "leaf");
  const siblingLeaf = doc.addLayerTo(inner, "sibling leaf");
  const other = doc.addGroup("other collapsed");
  const hidden = doc.addLayerTo(other, "hidden");
  assert.equal(doc.parentOf(inner), outer);
  assert.equal(doc.parentOf(leaf), inner);

  // Both ancestors of the active leaf are collapsed, and so is an unrelated
  // group: only the ancestors may be revealed.
  const collapsed = new Set([outer.id, inner.id, other.id]);

  // Precondition: with nothing selected the tree really is collapsed, so the
  // assertion below cannot pass by accident.
  assert.deepEqual(
    panelRows(doc, null, collapsed).map((r) => r.node.name),
    ["other collapsed", "outer"],
  );

  const rows = panelRows(doc, leaf, collapsed);
  assert.deepEqual(
    rows.map((r) => [r.node.name, r.depth]),
    [
      ["other collapsed", 0],
      ["outer", 0],
      ["inner", 1],
      ["sibling leaf", 2],
      ["leaf", 2],
    ],
  );
  assert.ok(rows.some((r) => r.node === outer), "the grandparent group must appear");
  assert.ok(rows.some((r) => r.node === inner), "the parent group must appear");
  assert.ok(rows.some((r) => r.node === leaf), "the active layer must be visible");
  assert.equal(rows[3]!.node, siblingLeaf);
  assert.equal(rows[4]!.node, leaf);
  assert.ok(!rows.some((r) => r.node === hidden), "a collapsed sibling stays collapsed");
  assert.equal(collapsed.size, 3, "revealing is a view decision; it must not mutate the collapse set");

  // Revealing ancestors is not "expanding everything": a collapsed ACTIVE
  // group shows its own row but none of its children.
  assert.deepEqual(
    panelRows(doc, inner, collapsed).map((r) => [r.node.name, r.depth]),
    [
      ["other collapsed", 0],
      ["outer", 0],
      ["inner", 1],
    ],
  );
});

test("panel collapse: the set is keyed by layer id, so a reorder keeps the fold", () => {
  const doc = new Document(8, 8);
  const bottom = doc.addLayer("bottom");
  const top = doc.addLayer("top");
  const session = new DocSession();

  assert.equal(session.isCollapsed(top.id), false);
  assert.equal(session.toggleCollapsed(top.id), true, "the first click folds");
  assert.equal(session.toggleCollapsed(top.id), false, "a second click must unfold, not re-fold");
  // put the fold back for the reorder
  session.setCollapsed(top.id, true);

  // The fold follows the layer, not the row index it happened to occupy.
  doc.moveLayerTo(null, top, 1, null, 0);
  assert.equal(session.isCollapsed(top.id), true);
  assert.equal(session.isCollapsed(bottom.id), false);
  assert.deepEqual([...session.collapsed], [top.id]);

  // The same ids drive panelRows(); a stale index would fold the wrong row.
  assert.deepEqual(
    panelRows(doc, bottom, session.collapsed).map((r) => r.node.name),
    ["bottom", "top"],
  );
});

test("panel collapse: adopt carries the tab's ids as a copy", () => {
  const session = new DocSession();
  session.setCollapsed(3, true);
  session.setCollapsed(9, true);

  const other = new DocSession();
  other.push(entry([], "tab-2"));
  const fromTab = new Set([42]);
  session.adopt(other.current, fromTab);

  assert.deepEqual([...session.collapsed], [42], "the adopted tab's folds replace the old ones");
  assert.equal(session.isCollapsed(3), false);

  // A copy, not an alias: the tab slot cannot mutate the live session, and a
  // fold in this tab cannot leak back into the slot it came from (the B2 bug).
  fromTab.add(7);
  assert.equal(session.isCollapsed(7), false);
  session.setCollapsed(8, true);
  assert.equal(fromTab.has(8), false);
  assert.equal(fromTab.size, 2);
});


