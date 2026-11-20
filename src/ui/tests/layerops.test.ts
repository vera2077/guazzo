import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../../engine/document.ts";
import {
  addGroupNode,
  canDeleteLayer,
  canMoveLayer,
  canUngroupLayer,
  dropSpot,
  dropZoneAt,
  groupLayerNode,
  groupPath,
  moveLayerNode,
  moveOutSpot,
  nextGroupName,
  subtreeCount,
  ungroupLayerNode,
} from "../layerops.ts";

function names(doc: Document): string[] {
  return doc.layers.map((layer) => layer.name);
}

test("group authoring: Group Layers wraps a node in place and undo restores the order", () => {
  const doc = new Document(8, 8);
  const bottom = doc.addLayer("bottom");
  const middle = doc.addLayer("middle");
  doc.addLayer("top");

  const { group, entry } = groupLayerNode(doc, middle);
  assert.deepEqual(names(doc), ["bottom", "Group 1", "top"]);
  assert.deepEqual(group.children?.map((layer) => layer.name), ["middle"]);
  assert.equal(doc.parentOf(middle), group);

  entry.undo();
  assert.deepEqual(names(doc), ["bottom", "middle", "top"]);
  assert.equal(doc.parentOf(middle), null);
  assert.equal(bottom.children, undefined);

  entry.redo();
  assert.deepEqual(names(doc), ["bottom", "Group 1", "top"]);
  assert.equal(doc.parentOf(middle), group);
});

test("group authoring: wrapping a group child keeps it under the same parent", () => {
  const doc = new Document(8, 8);
  const outer = doc.addGroup("outer");
  const child = doc.addLayerTo(outer, "child");
  const { group, entry } = groupLayerNode(doc, child);

  assert.equal(doc.parentOf(group), outer);
  assert.equal(doc.parentOf(child), group);
  assert.deepEqual(outer.children?.map((layer) => layer.name), ["Group 1"]);

  entry.undo();
  assert.equal(doc.parentOf(child), outer);
  assert.deepEqual(outer.children?.map((layer) => layer.name), ["child"]);
});

test("group authoring: New Group inserts at the requested sibling slot", () => {
  const doc = new Document(8, 8);
  doc.addLayer("bottom");
  doc.addLayer("top");

  const { group, entry } = addGroupNode(doc, null, 1);
  assert.deepEqual(names(doc), ["bottom", "Group 1", "top"]);
  assert.equal(group.kind, "group");

  entry.undo();
  assert.deepEqual(names(doc), ["bottom", "top"]);
  entry.redo();
  assert.deepEqual(names(doc), ["bottom", "Group 1", "top"]);
});

test("group authoring: Ungroup moves the whole subtree out, and undo rebuilds it", () => {
  const doc = new Document(8, 8);
  doc.addLayer("bottom");
  const group = doc.addGroup("Group 1");
  doc.addLayerTo(group, "child A");
  doc.addLayerTo(group, "child B");
  doc.addLayer("top");

  const { children, entry } = ungroupLayerNode(doc, group);
  assert.deepEqual(children.map((layer) => layer.name), ["child A", "child B"]);
  assert.deepEqual(names(doc), ["bottom", "child A", "child B", "top"]);
  assert.equal(doc.inDocument(group), false);

  entry.undo();
  assert.deepEqual(names(doc), ["bottom", "Group 1", "top"]);
  assert.deepEqual(group.children?.map((layer) => layer.name), ["child A", "child B"]);

  entry.redo();
  assert.deepEqual(names(doc), ["bottom", "child A", "child B", "top"]);
  assert.equal(group.children?.length, 0);
});

test("group authoring: Ungroup keeps a nested group intact", () => {
  const doc = new Document(8, 8);
  const group = doc.addGroup("Group 1");
  doc.addLayerTo(group, "through");
  const inner = doc.addGroupTo(group, "inner");
  doc.addLayerTo(inner, "deep");

  const { entry } = ungroupLayerNode(doc, group);
  assert.deepEqual(names(doc), ["through", "inner"]);
  assert.deepEqual(inner.children?.map((layer) => layer.name), ["deep"]);

  entry.undo();
  assert.deepEqual(group.children?.map((layer) => layer.name), ["through", "inner"]);
});

test("group authoring: names and subtree counts follow the tree", () => {
  const doc = new Document(8, 8);
  doc.addGroup("Group 1");
  const outer = doc.addGroup("Group 2");
  const inner = doc.addGroupTo(outer, "inner");
  doc.addLayerTo(inner, "leaf");

  assert.equal(nextGroupName(doc), "Group 3");
  assert.equal(subtreeCount(outer), 3);
  assert.equal(subtreeCount(inner), 2);
});

test("group authoring: deleting a group is refused when it is the whole document", () => {
  const doc = new Document(8, 8);
  const only = doc.addGroup("Group 1");
  const child = doc.addLayerTo(only, "leaf");

  // The group is two nodes, so a node-count guard of "more than one" would let
  // this through and leave the document with no layers at all.
  assert.equal(canDeleteLayer(doc, only), false);
  // Its child can go: the group itself is still a valid, empty container.
  assert.equal(canDeleteLayer(doc, child), true);

  const solo = new Document(8, 8);
  const single = solo.addLayer("only");
  assert.equal(canDeleteLayer(solo, single), false);
});

test("group authoring: ungrouping the only empty group would empty the document", () => {
  const solo = new Document(8, 8);
  const empty = solo.addGroup("Group 1");
  assert.equal(canUngroupLayer(solo, empty), false);

  // With one child the child becomes the document; that is a valid ungroup.
  const parent = new Document(8, 8);
  const group = parent.addGroup("Group 1");
  parent.addLayerTo(group, "leaf");
  assert.equal(canUngroupLayer(parent, group), true);

  // A plain layer is not a group to begin with.
  const leafDoc = new Document(8, 8);
  const leaf = leafDoc.addLayer("leaf");
  assert.equal(canUngroupLayer(leafDoc, leaf), false);
});

test("drop zones: edges are siblings, only a group's middle is inside", () => {
  const rect = { top: 100, height: 30 };
  assert.equal(dropZoneAt(101, rect, false, false), "before");
  assert.equal(dropZoneAt(114, rect, false, false), "before");
  assert.equal(dropZoneAt(116, rect, false, false), "after");
  assert.equal(dropZoneAt(129, rect, false, false), "after");

  // A populated group reserves its middle third for "append as child".
  assert.equal(dropZoneAt(101, rect, true, true), "before");
  assert.equal(dropZoneAt(115, rect, true, true), "inside");
  assert.equal(dropZoneAt(129, rect, true, true), "after");
  // With no children every part of the group is the only sensible target.
  assert.equal(dropZoneAt(101, rect, true, false), "inside");
});

test("drop validation refuses the moving node and its own descendants", () => {
  const doc = new Document(8, 8);
  const outer = doc.addGroup("outer");
  const inner = doc.addGroupTo(outer, "inner");
  const leaf = doc.addLayerTo(inner, "leaf");
  const other = doc.addGroup("other");

  assert.equal(canMoveLayer(doc, outer, other), true);
  assert.equal(canMoveLayer(doc, outer, null), true);
  assert.equal(canMoveLayer(doc, outer, outer), false);
  assert.equal(canMoveLayer(doc, outer, inner), false);
  assert.equal(canMoveLayer(doc, outer, leaf), false);
  // The refusal path itself, not only the boolean: an illegal drop must come
  // back null so the row can show a no-drop cursor instead of reaching
  // moveLayerTo and throwing out of the drag handler.
  assert.equal(dropSpot(doc, outer, leaf, "inside"), null);
  assert.equal(moveLayerNode(doc, outer, leaf, "inside"), null);

  const stray = new Document(8, 8).addLayer("stray");
  assert.equal(canMoveLayer(doc, stray, other), false);
});

test("drag drop: a root layer appends inside a group, one undo puts it back", () => {
  const doc = new Document(8, 8);
  doc.addLayer("bottom");
  const group = doc.addGroup("Group A");
  doc.addLayerTo(group, "child A");
  doc.addLayerTo(group, "child B");
  const top = doc.addLayer("top");
  const before = doc.layerCount();

  const moved = moveLayerNode(doc, top, group, "inside");
  assert.ok(moved);
  assert.equal(doc.parentOf(top), group);
  assert.deepEqual(group.children?.map((layer) => layer.name), ["child A", "child B", "top"]);
  assert.equal(doc.layerCount(), before);
  assert.deepEqual(moved.to, { parent: group, index: 2 });

  moved.entry.undo();
  assert.equal(doc.parentOf(top), null);
  assert.deepEqual(names(doc), ["bottom", "Group A", "top"]);
  assert.equal(doc.layerCount(), before);
});

test("drag drop: before/after use the final post-removal sibling index", () => {
  const doc = new Document(8, 8);
  const a = doc.addLayer("a");
  const b = doc.addLayer("b");
  const c = doc.addLayer("c");

  const forward = moveLayerNode(doc, a, c, "before");
  assert.ok(forward);
  assert.deepEqual(names(doc), ["b", "a", "c"]);
  assert.deepEqual(forward.to, { parent: null, index: 1 });
  forward.entry.redo();
  assert.deepEqual(names(doc), ["b", "a", "c"]);
  forward.entry.undo();
  assert.deepEqual(names(doc), ["a", "b", "c"]);

  const backward = moveLayerNode(doc, c, a, "before");
  assert.ok(backward);
  assert.deepEqual(names(doc), ["c", "a", "b"]);
  assert.deepEqual(backward.to, { parent: null, index: 0 });
  backward.entry.undo();
  assert.deepEqual(names(doc), ["a", "b", "c"]);

  // Dropping a node back where it already is changes nothing and records nothing.
  assert.equal(moveLayerNode(doc, b, a, "after"), null);
});

test("drag drop: a group child can move out to the group's next sibling slot", () => {
  const doc = new Document(8, 8);
  doc.addLayer("bottom");
  const group = doc.addGroup("Group A");
  const child = doc.addLayerTo(group, "child");
  doc.addLayer("top");

  const out = moveOutSpot(doc, child);
  assert.deepEqual(out, { parent: null, index: 2 });
  assert.ok(out);
  const moved = moveLayerNode(doc, child, group.children![0]!, "after");
  // The target is the node itself; a direct move-out uses the spot instead.
  assert.equal(moved, null);

  // Same destination expressed through the sibling drop: after the group itself.
  const sibling = moveLayerNode(doc, child, group, "after");
  assert.ok(sibling);
  assert.deepEqual(names(doc), ["bottom", "Group A", "child", "top"]);
  sibling.entry.undo();
  assert.equal(doc.parentOf(child), group);

  assert.equal(groupPath(doc, group), "Group A");
});
