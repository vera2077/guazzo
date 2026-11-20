/**
 * session.ts — the live editing session: history ownership, plus the Layers
 * panel's collapse set and the visibility rule that reads it (panel slice).
 *
 * Every content change already flows through one History stack per open tab;
 * the shell used to own that stack as a bare global and hand it to the tab
 * module through read/write adapters. This module is the object that owns it
 * instead, so the stack (and the undo/redo contract built on it) has one named
 * owner rather than a global that every function reaches for.
 *
 * Deliberately narrow: doc, activeLayer, flat, selection and view state still
 * live in the shell and move here in later slices, one at a time. The stack and
 * the collapse set are per tab, so `adopt()` is what a tab switch calls — the
 * session always points at the state of the document that is open right now.
 */

import { History, type HistoryEntry } from "../engine/history.ts";
import type { Document, Layer } from "../engine/document.ts";

/** One row the Layers panel draws: a node and how far it is indented. */
export interface PanelRow {
  readonly node: Layer;
  readonly depth: number;
}

/**
 * The Layers panel's visible rows, topmost-first, as a pure function.
 *
 * `collapsed` holds layer IDS, not indices: a move or a delete changes an
 * index, not the identity the user collapsed. The panel's `deps.rows()` calls
 * this; the panel itself never decides what is visible.
 *
 * The reveal rule is the reason this is a pure function instead of render code:
 * `activeLayer` can be a descendant of a collapsed group (picked on the
 * canvas, created by Ctrl+T, or restored with a project). A group on that path
 * is force-expanded, because a panel that selects a row it does not draw is
 * worse than a flat one. Only ANCESTORS are revealed — a collapsed sibling
 * stays collapsed, and a collapsed active group keeps its own children hidden.
 */
export function panelRows(
  doc: Document,
  activeLayer: Layer | null,
  collapsed: ReadonlySet<number>,
): PanelRow[] {
  // The active node's ancestors, by id. parentOf() is the tree's own answer,
  // so no second parent map can disagree with Document.
  const reveal = new Set<number>();
  if (activeLayer) {
    let parent = doc.parentOf(activeLayer);
    while (parent) {
      reveal.add(parent.id);
      parent = doc.parentOf(parent);
    }
  }

  const rows: PanelRow[] = [];
  // Reverse per level: Document stores bottom → top and the panel draws the
  // topmost row first. Reversing the flattened list would put children above
  // their parent and under the wrong group.
  const walk = (list: readonly Layer[], depth: number): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i]!;
      rows.push({ node, depth });
      const kids = node.children;
      if (kids && kids.length > 0 && (!collapsed.has(node.id) || reveal.has(node.id))) {
        walk(kids, depth + 1);
      }
    }
  };
  walk(doc.layers, 0);
  return rows;
}

export class DocSession {
  private stack: History;

  /**
   * Folded-shut groups, by layer ID. IDs and not indices: a move changes an
   * index, and folding the wrong group after a reorder is the kind of bug the
   * panel shows but never explains. panelRows() reads this set; the panel does
   * not own a second copy.
   */
  private collapsedIds = new Set<number>();

  constructor(history: History = new History(100)) {
    this.stack = history;
  }

  /** the stack of the open tab (the tab module keeps one of these per slot) */
  get current(): History {
    return this.stack;
  }

  /** the folded groups of the open tab; live, so a tab slot must adopt() it */
  get collapsed(): ReadonlySet<number> {
    return this.collapsedIds;
  }

  isCollapsed(id: number): boolean {
    return this.collapsedIds.has(id);
  }

  setCollapsed(id: number, folded: boolean): void {
    if (folded) this.collapsedIds.add(id);
    else this.collapsedIds.delete(id);
  }

  /** the chevron: returns the new state so the caller can announce it */
  toggleCollapsed(id: number): boolean {
    const folded = !this.collapsedIds.has(id);
    this.setCollapsed(id, folded);
    return folded;
  }

  /**
   * Select-time reveal: the ancestors of `layer` are unfolded, permanently.
   *
   * `panelRows()` also force-expands that path, but that is a drawing rule, not
   * a state change: the chevron would still say "folded" while its children
   * were on screen. The owner calls this before a panel render so the set and
   * the rows agree. Only ancestors are touched; unrelated groups keep their
   * folds, and folding an ancestor again while the selection is inside it will
   * be undone by the next reveal (the active row must stay visible).
   */
  revealFor(doc: Document, layer: Layer | null): void {
    let parent = layer ? doc.parentOf(layer) : null;
    while (parent) {
      this.collapsedIds.delete(parent.id);
      parent = doc.parentOf(parent);
    }
  }

  /**
   * A tab switch: the session now speaks for that document's stack AND its
   * folded groups. The set is copied rather than aliased, so the tab slot
   * cannot mutate the live session and the next document cannot inherit this
   * one's folds. `collapsed` is required on purpose: an optional argument would
   * let a new call site forget it and look right until the second tab.
   */
  adopt(history: History, collapsed: ReadonlySet<number>): void {
    this.stack = history;
    this.collapsedIds = new Set(collapsed);
  }

  push(entry: HistoryEntry): void {
    this.stack.push(entry);
  }

  undo(): boolean {
    return this.stack.undo();
  }

  redo(): boolean {
    return this.stack.redo();
  }

  jumpTo(position: number): void {
    this.stack.jumpTo(position);
  }

  clear(): void {
    this.stack.clear();
  }

  get canUndo(): boolean {
    return this.stack.canUndo;
  }

  get canRedo(): boolean {
    return this.stack.canRedo;
  }

  get position(): number {
    return this.stack.position;
  }

  get labels(): readonly string[] {
    return this.stack.labels;
  }

  get editEpoch(): number {
    return this.stack.editEpoch;
  }

  get bytes(): number {
    return this.stack.bytes;
  }
}
