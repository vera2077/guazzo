import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../../engine/document.ts";
import {
  addGroupNode,
  canDeleteLayer,
  canUngroupLayer,
  groupLayerNode,
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
