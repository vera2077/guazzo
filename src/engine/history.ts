/**
 * history.ts — hybrid undo/redo.
 *
 * Two kinds of entries share one stack:
 *  - command entries for document structure & property changes (add/remove
 *    layer, visibility, opacity, blend mode, reorder);
 *  - dirty-tile snapshot entries for raster strokes: a StrokeSession notes
 *    every tile right before its first mutation in the stroke, captures the
 *    after-image at stroke end, and the before/after pair becomes a single
 *    undoable "Paint"/"Erase" entry. Memory cost is proportional to the
 *    touched tiles only (GIMP-style dirty-tile undo).
 */

/*
 * AUDIT (PSD fidelity step 1) — why the layer commands are next.
 *
 * layerAddCommand / layerRemoveCommand / layerMoveCommand still take a FLAT
 * top-level index and touch `doc.layers` alone. That is not a call-site bug; it
 * is a defect in the command:
 *
 *   add:    undo splices out of doc.layers, so a group CHILD is never found and
 *           undo silently does nothing; redo re-inserts at the top level.
 *   remove: undo splices back into doc.layers at `index`, so an undone child
 *           returns as a top-level sibling.
 *   move:   doc.moveLayer works on the flat stack, so a child cannot move at all
 *           and same-parent reorder is the only case that happens to work.
 *
 * The symptom is a flat index; the defect is that the command does not know the
 * tree. A silent no-op in undo is the worst place to discover it: tree and
 * picture disagree afterwards, and nothing reports it.
 *
 * Agreed fix: ONE move primitive that can express a parent change —
 * doc.moveLayer(fromParent, fromIndex, toParent, toIndex), same-parent reorder
 * being the special case where the parents are equal — plus insert/remove that
 * take a parent. Record { parent, index } in every command, detach a whole
 * SUBTREE on removal (deleting a group and undoing it must restore the children),
 * and charge HistoryEntry.bytes the subtree's tiles, or eviction underestimates a
 * large group deletion and the 512 MB budget quietly becomes false.
 *
 * Nothing feeds allLayers() into a buffer or a file today (only numbering and
 * counting), so the wrong order is latent rather than live — which is why the
 * exporter needs a test pinning TREE order:
 *   grep -rn "allLayers()" src --include=*.ts
 */

import { TILE, TileGrid, type Tile } from "./tile.ts";
import type { Document, Layer } from "./document.ts";

export interface HistoryEntry {
  label: string;
  /**
   * Approximate retained memory (bytes) — snapshot entries report the real
   * before/after tile images, commands omit it and count as META_BYTES.
   * Drives the byte-budgeted eviction in History.push.
   */
  bytes?: number;
  undo(): void;
  redo(): void;
}

/** soft cap on retained undo memory (512 MB); one entry always survives */
export const MAX_HISTORY_BYTES = 512 * 1024 * 1024;
/** cost assumed for a metadata-only entry (label + closures) */
const META_BYTES = 1024;

const TILE_KEY_STEP = 1 << 16;

export class History {
  private entries: HistoryEntry[] = [];
  private index = 0; // entries below index are applied; entries[index] is next redo
  private totalBytes = 0;
  private edits = 0;
  readonly limit: number;
  readonly maxBytes: number;

  constructor(limit = 100, maxBytes = MAX_HISTORY_BYTES) {
    this.limit = Math.max(1, limit);
    this.maxBytes = Math.max(1, maxBytes);
  }

  /** retained memory estimate (bytes), for status/debug display */
  get bytes(): number { return this.totalBytes; }

  /** drop every entry without touching the document (context-menu Clear History) */
  clear(): void {
    this.entries.length = 0;
    this.index = 0;
    this.totalBytes = 0;
  }

  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index < this.entries.length; }
  /** number of applied entries; also the state id for jumpTo */
  get position(): number { return this.index; }
  get labels(): string[] { return this.entries.map((e) => e.label); }

  /**
   * AQ3: a counter that only ever goes UP, one step per push. `position` cannot be
   * used as a change key: eviction increments and decrements the same index, so
   * after the first eviction `new History(3).position` is 3 forever and anything
   * keyed on it stops noticing edits exactly when a long session needs it most.
   */
  get editEpoch(): number { return this.edits; }

  /**
   * RECORDS an entry; the mutation is the caller's. push() never applies the
   * command, so a caller that pushes without mutating first records a change that
   * did not happen - and the failure surfaces later as a lie about the document.
   */
  push(entry: HistoryEntry): void {
    this.edits++;
    // any new action drops the redo tail (its memory goes with it)
    for (let i = this.index; i < this.entries.length; i++) {
      this.totalBytes -= this.entries[i]!.bytes ?? META_BYTES;
    }
    this.entries.length = this.index;
    this.entries.push(entry);
    this.totalBytes += entry.bytes ?? META_BYTES;
    this.index++;
    // evict oldest under BOTH budgets; one entry always survives even when a
    // single snapshot exceeds maxBytes (refusing the undo would be worse)
    while (this.entries.length > this.limit ||
           (this.totalBytes > this.maxBytes && this.entries.length > 1)) {
      this.totalBytes -= this.entries[0]!.bytes ?? META_BYTES;
      this.entries.shift();
      this.index--;
    }
  }

  undo(): boolean {
    if (this.index <= 0) return false;
    this.index--;
    this.entries[this.index]!.undo();
    return true;
  }

  redo(): boolean {
    if (this.index >= this.entries.length) return false;
    this.entries[this.index]!.redo();
    this.index++;
    return true;
  }

  /** jump to the state with `target` entries applied (0 = document start) */
  jumpTo(target: number): void {
    const t = Math.max(0, Math.min(this.entries.length, target));
    while (this.index > t && this.undo()) { /* keep undoing */ }
    while (this.index < t && this.redo()) { /* keep redoing */ }
  }
}

// ---------------------------------------------------------------------------
// raster strokes: dirty-tile snapshots
// ---------------------------------------------------------------------------

interface TileSnap {
  tx: number;
  ty: number;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

export class StrokeSession {
  private snaps = new Map<number, TileSnap>();

  /**
   * paint.ts calls this immediately before the first mutation of tile
   * (tx,ty) within the stroke. Safe to call repeatedly: only the first
   * call per tile records the before-image.
   */
  noteTile(tx: number, ty: number, tile: Tile): void {
    const key = ty * TILE_KEY_STEP + tx;
    if (!this.snaps.has(key)) {
      this.snaps.set(key, { tx, ty, before: tile.data.slice(), after: tile.data });
    }
  }

  /**
   * Capture after-images and produce one undoable entry.
   * Returns null when nothing was noted (e.g. a fully clipped stroke).
   */
  finish(grid: TileGrid, label = "Paint"): HistoryEntry | null {
    if (this.snaps.size === 0) return null;
    for (const s of this.snaps.values()) {
      const t = grid.tile(s.tx, s.ty, false);
      if (!t) return null; // noted tiles must stay allocated
      s.after = t.data.slice();
    }
    const list = [...this.snaps.values()];
    let bytes = 0;
    for (const s of list) bytes += s.before.length + s.after.length;
    return {
      label,
      bytes,
      undo() {
        for (const s of list) {
          const t = grid.tile(s.tx, s.ty, true)!;
          t.data.set(s.before);
          t.version++;
        }
      },
      redo() {
        for (const s of list) {
          const t = grid.tile(s.tx, s.ty, true)!;
          t.data.set(s.after);
          t.version++;
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// structural / property commands
// ---------------------------------------------------------------------------

/** generic property change; caller applies the new value itself before pushing */
export function propertyCommand(
  label: string,
  apply: (value: unknown) => void,
  before: unknown,
  after: unknown,
): HistoryEntry {
  return {
    label,
    undo: () => apply(before),
    redo: () => apply(after),
  };
}

/** add-layer command; index = position in doc.layers at add time (top = length-1) */
export interface LayerSpot { parent: Layer | null; index: number }

/**
 * Add a node and record WHERE it went, not a flat index. The old commands kept
 * `doc.layers.length - 1` and re-inserted at the top level, so a group child was
 * never found on undo (silent no-op) and came back as a top-level sibling.
 * Bytes: an add or a remove charges the SUBTREE it detaches or restores; a move
 * charges nothing, because it changed no pixels and must not evict real undo
 * steps to pay for a reorder.
 */
function subtreeBytes(layer: Layer): number {
  let n = layer.grid.allocated * TILE * TILE * 4;
  const m = layer.mask;
  if (m) n += m.allocated * TILE * TILE * 4;
  for (const kid of layer.children ?? []) n += subtreeBytes(kid);
  return n;
}

export function layerAddCommand(doc: Document, layer: Layer, spot: LayerSpot): HistoryEntry {
  return {
    label: `Add ${layer.name}`,
    bytes: subtreeBytes(layer),
    undo: () => doc.removeLayerFrom(spot.parent, layer),
    redo: () => doc.insertLayer(spot.parent, layer, spot.index),
  };
}

export function layerRemoveCommand(doc: Document, layer: Layer, spot: LayerSpot): HistoryEntry {
  return {
    label: `Delete ${layer.name}`,
    bytes: subtreeBytes(layer),
    undo: () => doc.insertLayer(spot.parent, layer, spot.index),
    redo: () => doc.removeLayerFrom(spot.parent, layer),
  };
}

export function layerMoveCommand(
  doc: Document,
  layer: Layer,
  from: LayerSpot,
  to: LayerSpot,
): HistoryEntry {
  return {
    label: `Reorder ${layer.name}`,
    bytes: 0,
    // Remove-then-insert by SPOT, which is what a reorder means and what the
    // old flat command did at the top level. Using moveLayerTo here would apply
    // its forward-shift compensation to an already-computed destination.
    undo: () => {
      doc.removeLayerFrom(to.parent, layer);
      doc.insertLayer(from.parent, layer, from.index);
    },
    redo: () => {
      doc.removeLayerFrom(from.parent, layer);
      doc.insertLayer(to.parent, layer, to.index);
    },
  };
}

/**
 * Snapshot-based entry for whole-layer raster mutations (adjustments,
 * filters): capture before-images of all allocated tiles, run the mutation,
 * capture after-images (including newly allocated tiles), undo/redo by
 * restoring the images. Tiles the mutation created revert to zeroed
 * (equivalent to their unallocated state) on undo.
 */
export function layerOpCommand(layer: Layer, label: string, mutate: () => void): HistoryEntry | null {
  const before = captureTiles(layer.grid);
  mutate();
  return snapshotCommand(layer.grid, label, before);
}

/**
 * Same, but only the tiles under `rect` are snapshotted. Heavy whole-layer ops
 * on a large document used to copy every tile twice; bounded ops (shape drags,
 * fills, healing) know their rect up front and stay cheap.
 */
/**
 * A text layer is pixels PLUS a recipe (`textData`), and the two must move
 * together: undoing a text edit that restored only tiles would leave the recipe
 * describing content that no longer exists (re-opening the box resurrects the
 * undone text, and undoing "Clear text" leaves the layer un-re-editable).
 * Snapshots the tiles and a structural copy of the recipe around `mutate`.
 */
export function textOpCommand(layer: Layer, label: string, mutate: () => void): HistoryEntry | null {
  const beforeTiles = captureTiles(layer.grid);
  const beforeText = layer.textData ? cloneTextRecipe(layer.textData) : undefined;
  mutate();
  const entry = snapshotCommand(layer.grid, label, beforeTiles);
  const recipeChanged = JSON.stringify(beforeText) !== JSON.stringify(layer.textData);
  if (entry && !recipeChanged && tilesEqual(beforeTiles, captureTiles(layer.grid))) {
    // nothing changed at all: an open-and-close must not burn a history slot
    return null;
  }
  if (!entry) {
    // pixels may be byte-identical (e.g. re-aligning to the same width) while
    // the recipe still changed; such an op must stay undoable
    if (!recipeChanged) return null;
    const after = layer.textData ? cloneTextRecipe(layer.textData) : undefined;
    return {
      label,
      undo: () => { layer.textData = beforeText ? cloneTextRecipe(beforeText) : undefined; },
      redo: () => { layer.textData = after ? cloneTextRecipe(after) : undefined; },
    };
  }
  const afterText = layer.textData ? cloneTextRecipe(layer.textData) : undefined;
  const pixelUndo = entry.undo, pixelRedo = entry.redo;
  return {
    label,
    undo: () => { pixelUndo(); layer.textData = beforeText ? cloneTextRecipe(beforeText) : undefined; },
    redo: () => { layer.textData = afterText ? cloneTextRecipe(afterText) : undefined; pixelRedo(); },
  };
}

/** byte comparison of two tile snapshots (used to drop no-diff commits) */
function tilesEqual(a: TileImages, b: TileImages): boolean {
  if (a.size !== b.size) return false;
  for (const [key, bytes] of a) {
    const other = b.get(key);
    if (!other || other.length !== bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== other[i]) return false;
  }
  return true;
}

/** structural copy of a text recipe (lines are nested arrays of segment objects) */
function cloneTextRecipe(meta: NonNullable<Layer["textData"]>): NonNullable<Layer["textData"]> {
  return { ...meta, lines: meta.lines.map(l => l.map(seg => ({ ...seg }))) };
}

export function layerOpCommandIn(
  layer: Layer,
  label: string,
  mutate: () => void,
  rect: { x: number; y: number; w: number; h: number },
): HistoryEntry | null {
  const before = captureTilesIn(layer.grid, rect.x, rect.y, rect.w, rect.h);
  mutate();
  return snapshotCommand(layer.grid, label, before, rect);
}

/** tile key → pixel image, the unit of raster undo */
export type TileImages = Map<number, Uint8ClampedArray>;

const tileKey = (tx: number, ty: number): number => ty * (1 << 16) + tx;
const keyX = (k: number): number => k % (1 << 16);
const keyY = (k: number): number => (k - keyX(k)) / (1 << 16);

/** before-images of every allocated tile */
/** Snapshot only the tiles intersecting a rect: bounded-memory for big documents. */
export function captureTilesIn(grid: TileGrid, x: number, y: number, w: number, h: number): TileImages {
  const out: TileImages = new Map();
  grid.forEachTileInRect(x, y, w, h, (t, _cx, _cy, _cw, _ch, bx, by) => {
    out.set(tileKey(Math.floor(bx / TILE), Math.floor(by / TILE)), t.data.slice());
  });
  return out;
}

export function captureTiles(grid: TileGrid): TileImages {
  const out: TileImages = new Map();
  grid.forEachTile((t, tx, ty) => out.set(tileKey(tx, ty), t.data.slice()));
  return out;
}

function restoreTiles(grid: TileGrid, images: TileImages): void {
  for (const [k, data] of images) {
    const t = grid.tile(keyX(k), keyY(k), true);
    if (!t) continue; // unreachable with create=true, but keeps types honest
    t.data.set(data);
    t.version++;
  }
}

/**
 * Entry from an already-captured before-state plus the grid as it is now.
 * Used by the Move tool, whose drag applies its effect live and only wants
 * one undoable step when the pointer is released.
 */
/**
 * A mask edit that also changes the layer's hide/reveal polarity. The tile
 * snapshot alone cannot undo `maskHide`, so the two move together here.
 */
export function maskSelectionCommand(
  layer: Layer,
  grid: TileGrid,
  label: string,
  before: TileImages,
  beforeHide: boolean,
  afterHide: boolean,
): HistoryEntry | null {
  const snapshot = snapshotCommand(grid, label, before);
  if (!snapshot && beforeHide === afterHide) return null;
  return {
    label,
    bytes: snapshot?.bytes ?? 0,
    undo: () => {
      layer.maskHide = beforeHide;
      snapshot?.undo();
    },
    redo: () => {
      layer.maskHide = afterHide;
      snapshot?.redo();
    },
  };
}

export function snapshotCommand(grid: TileGrid, label: string, before: TileImages, rect?: { x: number; y: number; w: number; h: number }): HistoryEntry | null {
  const after = rect ? captureTilesIn(grid, rect.x, rect.y, rect.w, rect.h) : captureTiles(grid);
  if (before.size === 0 && after.size === 0) return null; // no-op
  const keys = new Set<number>(before.keys());
  for (const k of after.keys()) keys.add(k);
  let bytes = 0;
  for (const d of before.values()) bytes += d.length;
  for (const d of after.values()) bytes += d.length;
  return {
    label,
    bytes,
    undo: () => {
      // tiles the op allocated had no before-image: revert to zeroed
      for (const k of keys) {
        if (before.has(k)) continue;
        const t = grid.tile(keyX(k), keyY(k), false);
        if (t) {
          t.data.fill(0);
          t.version++;
        }
      }
      restoreTiles(grid, before);
    },
    redo: () => restoreTiles(grid, after),
  };
}
