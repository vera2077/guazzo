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
import type { HistoryEntry, LayerSpot } from "../engine/history.ts";
import { layerAddCommand, layerMoveCommand } from "../engine/history.ts";
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

// ---- tree moves (drag reparent + the row context menu) ---------------------

export type DropZone = "before" | "after" | "inside";

/**
 * Which third of a row the pointer is over. The middle of a GROUP is the only
 * "inside" target; a leaf's middle is still a sibling drop (after the leaf), so
 * every row has a predictable insertion point. An empty group has no middle
 * band worth distinguishing: anywhere on it means "put it inside".
 */
export function dropZoneAt(
  clientY: number,
  rect: { top: number; height: number },
  isGroup: boolean,
  hasChildren: boolean,
): DropZone {
  const h = rect.height > 0 ? rect.height : 1;
  const rel = Math.max(0, Math.min(1, (clientY - rect.top) / h));
  if (isGroup && (!hasChildren || (rel >= 1 / 3 && rel <= 2 / 3))) return "inside";
  return rel < 0.5 ? "before" : "after";
}

/** is `node` equal to `branch` or somewhere below it? */
function branchContains(document: Document, branch: Layer, node: Layer): boolean {
  let at: Layer | null | undefined = node;
  while (at) {
    if (at === branch) return true;
    at = document.parentOf(at);
    if (at === undefined) return false;
  }
  return false;
}

/**
 * A drop is legal only when both ends are in the document and the destination
 * is neither the moving node nor one of its descendants. `moveLayerTo` keeps its
 * own cycle guard for defence in depth; this check is what lets the panel show
 * a no-drop cursor instead of throwing out of a drag handler.
 */
export function canMoveLayer(document: Document, moving: Layer, toParent: Layer | null): boolean {
  if (document.parentOf(moving) === undefined) return false;
  if (toParent === null) return true;
  if (document.parentOf(toParent) === undefined) return false;
  return toParent !== moving && !branchContains(document, moving, toParent);
}

/** destination spot for dropping `moving` on `target` in `zone`, or null */
export function dropSpot(
  document: Document,
  moving: Layer,
  target: Layer,
  zone: DropZone,
): LayerSpot | null {
  if (target === moving) return null;
  const targetParent = document.parentOf(target);
  if (targetParent === undefined) return null;
  if (zone === "inside") {
    if (target.kind !== "group" || !canMoveLayer(document, moving, target)) return null;
    return { parent: target, index: target.children?.length ?? 0 };
  }
  if (!canMoveLayer(document, moving, targetParent)) return null;
  const list = targetParent ? (targetParent.children ?? []) : document.layers;
  const at = list.indexOf(target);
  if (at < 0) return null;
  return { parent: targetParent, index: zone === "before" ? at : at + 1 };
}

/**
 * Move to a pre-removal splice index. `moveLayerTo` expects the destination the
 * caller would write into the OLD list (it compensates when moving forward
 * inside one parent); the history command wants the FINAL spot. Do that maths
 * once here, refuse a no-op, and return the one command the caller pushes.
 */
export function moveLayerToSpot(
  document: Document,
  moving: Layer,
  toParent: Layer | null,
  toIndex: number,
): { entry: HistoryEntry; to: LayerSpot } | null {
  const fromParent = document.parentOf(moving);
  if (fromParent === undefined) return null;
  if (!canMoveLayer(document, moving, toParent)) return null;
  const fromList = fromParent ? (fromParent.children ?? []) : document.layers;
  const fromIndex = fromList.indexOf(moving);
  if (fromIndex < 0) return null;
  const toList = toParent ? (toParent.children ?? []) : document.layers;
  const at = Math.max(0, Math.min(toIndex, toList.length));
  let final = at;
  if (fromParent === toParent && fromIndex < at) final -= 1;
  if (fromParent === toParent && final === fromIndex) return null;
  document.moveLayerTo(fromParent, moving, fromIndex, toParent, at);
  return {
    entry: layerMoveCommand(
      document,
      moving,
      { parent: fromParent, index: fromIndex },
      { parent: toParent, index: final },
    ),
    to: { parent: toParent, index: final },
  };
}

export function moveLayerNode(
  document: Document,
  moving: Layer,
  target: Layer,
  zone: DropZone,
): { entry: HistoryEntry; to: LayerSpot } | null {
  const spot = dropSpot(document, moving, target, zone);
  if (!spot) return null;
  return moveLayerToSpot(document, moving, spot.parent, spot.index);
}

/** "Group A / Inner" — a group's name with enough ancestors to disambiguate it */
export function groupPath(document: Document, group: Layer): string {
  const names: string[] = [];
  let at: Layer | null | undefined = group;
  while (at) {
    names.unshift(at.name);
    at = document.parentOf(at);
    if (at === undefined) break;
  }
  return names.join(" / ");
}

/**
 * Move-out destination: a group child becomes the next sibling of the group in
 * the grandparent list. Null when the node is already a root.
 */
export function moveOutSpot(document: Document, layer: Layer): LayerSpot | null {
  const parent = document.parentOf(layer);
  if (!parent) return null;
  const grand = document.parentOf(parent);
  if (grand === undefined) return null;
  const list = grand ? (grand.children ?? []) : document.layers;
  const at = list.indexOf(parent);
  if (at < 0) return null;
  return { parent: grand, index: at + 1 };
}
