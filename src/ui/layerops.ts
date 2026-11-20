/**
 * Layer mutations the shell's dialogs perform, named so tests can drive the
 * handler instead of re-implementing it.
 *
 * Opacity is a structural change: it moves no tile, so no primitive bumps the
 * document revision. The function therefore does both halves of the declared
 * contract — bump the revision the preview key reads, and invalidate the flat
 * cache — in one place the dialog and the test share.
 *
 * The group authoring set lives here for the same reason: a tree edit has one
 * undo entry, and that entry must be testable without a browser. These
 * functions mutate the tree and return the entry; the caller pushes it and
 * repaints.
 */
import type { Document, Layer } from "../engine/document.ts";
import type { HistoryEntry } from "../engine/history.ts";
import { layerAddCommand } from "../engine/history.ts";
import type { FlatCache } from "./flatcache.ts";

/** clamp a percentage and apply it; false when the value did not change */
export function setLayerOpacity(layer: Layer, percent: number, doc: Document, cache: FlatCache): boolean {
  const next = Math.max(0, Math.min(100, Math.round(percent))) / 100;
  if (next === layer.opacity) return false;
  layer.opacity = next;
  doc.revision++;
  cache.invalidate();
  return true;
}

/** "Group 1", "Group 2", … — the first number not already used in the tree. */
export function nextGroupName(doc: Document): string {
  const used = new Set(doc.allLayers().map((layer) => layer.name));
  let n = 1;
  while (used.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

/** total nodes in a subtree, including the layer itself */
export function subtreeCount(layer: Layer): number {
  let n = 1;
  for (const kid of layer.children ?? []) n += subtreeCount(kid);
  return n;
}

/**
 * Deleting a group deletes its whole subtree, so the old "more than one layer"
 * guard is not enough: the only root group with children counts as several
 * nodes, and removing it would leave the document with no layers at all.
 */
export function canDeleteLayer(doc: Document, layer: Layer): boolean {
  return doc.layerCount() > subtreeCount(layer);
}

/**
 * Ungrouping an empty root group would leave the document with no layers at
 * all. A group with any child survives the move (the children become roots),
 * so the node count is the whole test.
 */
export function canUngroupLayer(doc: Document, group: Layer): boolean {
  return group.kind === "group" && doc.layerCount() > 1;
}

/**
 * Create an empty group at a sibling position and return its add command.
 * `Document.addGroup()` always appends to the root; detaching it first is what
 * lets one command represent both the insert and its undo.
 */
export function addGroupNode(
  doc: Document,
  parent: Layer | null,
  index: number,
): { group: Layer; entry: HistoryEntry } {
  const list = parent ? (parent.children ?? []) : doc.layers;
  const at = Math.max(0, Math.min(index, list.length));
  const group = doc.addGroup(nextGroupName(doc));
  doc.removeLayerFrom(null, group);
  doc.insertLayer(parent, group, at);
  return { group, entry: layerAddCommand(doc, group, { parent, index: at }) };
}

/**
 * Wrap one node (and its whole subtree) in a new group at its own position.
 *
 * The group is inserted ABOVE the node first, then the node moves inside. The
 * undo side reverses exactly that sequence, so a group child comes back to its
 * old parent and index rather than to the root — the defect the old flat
 * add/remove commands had.
 */
export function groupLayerNode(doc: Document, layer: Layer): { group: Layer; entry: HistoryEntry } {
  const parent = doc.parentOf(layer);
  if (parent === undefined) throw new Error(`groupLayerNode: "${layer.name}" is not in the document`);
  const list = parent ? (parent.children ?? []) : doc.layers;
  const index = list.indexOf(layer);
  if (index < 0) throw new Error(`groupLayerNode: "${layer.name}" has no slot in its parent`);

  const group = doc.addGroup(nextGroupName(doc));
  doc.removeLayerFrom(null, group);
  doc.insertLayer(parent, group, index + 1);
  doc.removeLayerFrom(parent, layer);
  doc.insertLayer(group, layer, 0);

  const entry: HistoryEntry = {
    label: `Group ${layer.name}`,
    undo: () => {
      doc.removeLayerFrom(group, layer);
      doc.insertLayer(parent, layer, index + 1);
      doc.removeLayerFrom(parent, group);
    },
    redo: () => {
      doc.insertLayer(parent, group, index + 1);
      doc.removeLayerFrom(parent, layer);
      doc.insertLayer(group, layer, 0);
    },
  };
  return { group, entry };
}

/**
 * Move every child out at the group's own index, then remove the empty group.
 * The undo side rebuilds the group in place before returning the children to
 * it, so nested groups keep their own children intact.
 */
export function ungroupLayerNode(
  doc: Document,
  group: Layer,
): { children: Layer[]; entry: HistoryEntry } {
  if (group.kind !== "group") throw new Error(`ungroupLayerNode: "${group.name}" is not a group`);
  const parent = doc.parentOf(group);
  if (parent === undefined) throw new Error(`ungroupLayerNode: "${group.name}" is not in the document`);
  const list = parent ? (parent.children ?? []) : doc.layers;
  const index = list.indexOf(group);
  if (index < 0) throw new Error(`ungroupLayerNode: "${group.name}" has no slot in its parent`);

  const children = [...(group.children ?? [])];
  for (let i = 0; i < children.length; i++) {
    doc.removeLayerFrom(group, children[i]!);
    doc.insertLayer(parent, children[i]!, index + i);
  }
  doc.removeLayerFrom(parent, group);

  const entry: HistoryEntry = {
    label: `Ungroup ${group.name}`,
    undo: () => {
      doc.insertLayer(parent, group, index);
      for (let i = 0; i < children.length; i++) {
        doc.removeLayerFrom(parent, children[i]!);
        doc.insertLayer(group, children[i]!, i);
      }
    },
    redo: () => {
      for (let i = 0; i < children.length; i++) {
        doc.removeLayerFrom(group, children[i]!);
        doc.insertLayer(parent, children[i]!, index + i);
      }
      doc.removeLayerFrom(parent, group);
    },
  };
  return { children, entry };
}
