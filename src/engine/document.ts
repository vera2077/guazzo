/**
 * document.ts — layer stack + reference compositor.
 *
 * Layers are ordered bottom → top (index 0 paints first).
 * compositeRect is the single source of truth for what the document
 * looks like; the browser viewport layers caching/GPU tricks on top of
 * it, and node tests call it directly.
 */

import { TileGrid } from "./tile.ts";
import { compositePixel, overNormal, type BlendMode, LAYER_BLEND_MODES } from "./blend.ts";
import { gridBBox } from "./transform.ts";
import { compileAdjust, type AdjustSpec, type CompiledAdjust, adjustLabel } from "./adjustfn.ts";
import { TILE } from "./tile.ts";
import type { SelectionMask } from "./mask.ts";

let nextLayerId = 1;

/** one run of text with a single style (engine-side copy; the UI mirrors this) */
export interface TextSeg {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  font: string;
}

/** text layers keep their recipe so clicking them reopens a live editor */
export interface TextLayerMeta {
  /** styled runs, one array per line of text */
  lines: TextSeg[][];
  /** top-left of the rasterized box, doc coords */
  x: number;
  y: number;
  /** rasterized content footprint, doc px (differs from the box when wrapped) */
  w: number;
  h: number;
  /** box width the text wraps at, doc px; undefined = no wrapping (auto width) */
  wrap?: number;
  /** box height when the user dragged a top/bottom handle, doc px; undefined = auto (content height) */
  boxH?: number;
  /** font size at commit time */
  size: number;
  color: [number, number, number];
  /** paragraph alignment inside the box (defaults to left when absent) */
  align?: "left" | "center" | "right" | "justify";
}

export type LayerKind = "pixel" | "adjust" | "fill" | "group";

export interface Layer {
  id: number;
  name: string;
  kind: LayerKind;
  /** pixel/alpha data; adjustment and fill layers keep an empty grid so
   *  every call site can still ask for one without a branch */
  grid: TileGrid;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  locked: boolean;
  /** set by the text tool; survives project save/load */
  textData?: TextLayerMeta;
  /** flat visual grouping only — the stack stays flat, this just tints and
   *  bands rows that belong together so "fake groups" are discoverable */
  groupId?: string;
  /**
   * Photoshop's group default. An ISOLATED group (passThrough false) composites
   * its children into a scratch buffer and blends that once, so the group's own
   * opacity and blend mode apply to the subtree as a whole. A PASS-THROUGH group
   * lets each child blend against the backdrop individually and ignores the
   * group's own opacity/blend — so a Multiply child differs between the two.
   */
  passThrough?: boolean;
  /**
   * PSD fidelity step 1: a REAL group node. Photoshop's layer tree carries
   * opacity and blend mode per group, and psd.ts used to drop the node because
   * the model had nowhere to put it. Children live here, not in `layers`, so
   * every existing flat walk keeps working; `allLayers()` gives the flattened
   * view for code that needs to see everything (indexing, rename, search).
   */
  children?: Layer[];
  /** grey mask: R channel holds coverage (0 hides, 255 reveals). An
   *  unallocated tile means "reveal everything", so a fresh mask is free. */
  mask?: TileGrid;
  /** clip this layer to the alpha of the stack below it */
  clipToBelow?: boolean;
  /**
   * AP2: mask POLARITY. Default (undefined) means "unallocated tile reveals";
   * a mask written from a selection sets this so an unallocated tile HIDES.
   * Without the flag the only way to say "hidden everywhere except here" was to
   * materialise every tile — 1 GiB at 16384^2 — and it also replaced a
   * hand-painted mask instead of intersecting it.
   */
  maskHide?: boolean;
  /** adjustment layers: what to do to the backdrop */
  adjust?: AdjustSpec;
  /** fill layers: a flat colour covering the whole canvas */
  fill?: { color: [number, number, number] };
}

/**
 * Copy every layer *recipe* field from `src` onto `dst`.
 *
 * Single source of truth for "what a Layer is" beyond pixels: the field
 * list must stay in sync with `serializeLayer` in io.ts (whatever the
 * project format can save must survive geometry ops) — both read exactly
 * name/kind/visible/opacity/blendMode/locked/adjust/fill/mask/clip/group.
 * Pixel data (grid), masks and text metadata are NOT copied here: every
 * geometry path transforms those with its own mapping.
 */
export function cloneLayerMeta(dst: Layer, src: Layer): void {
  dst.name = src.name;
  dst.kind = src.kind;
  dst.visible = src.visible;
  dst.opacity = src.opacity;
  dst.blendMode = src.blendMode;
  dst.locked = src.locked;
  if (src.adjust) dst.adjust = JSON.parse(JSON.stringify(src.adjust)) as AdjustSpec;
  if (src.fill) dst.fill = { color: [src.fill.color[0], src.fill.color[1], src.fill.color[2]] };
  dst.clipToBelow = src.clipToBelow;
  dst.groupId = src.groupId;
}

/**
 * Mask coverage at a doc pixel, 0..255 (255 = fully revealed).
 *
 * Storage is inverted on purpose: the R channel holds how much is
 * *hidden*, so a freshly allocated (all-zero) tile means "reveal
 * everything" and a new mask costs nothing to create or extend.
 */
export function maskAt(
  mask: TileGrid | undefined,
  x: number,
  y: number,
  empty = 255,
): number {
  if (!mask) return empty;
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const t = mask.tile(tx, ty, false);
  if (!t) return empty;
  return 255 - t.data[((y - ty * TILE) * TILE + (x - tx * TILE)) * 4]!;
}

/** write mask coverage at a doc pixel; allocates the tile on demand */
export function setMaskAt(mask: TileGrid, x: number, y: number, value: number): void {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const t = mask.tile(tx, ty, true);
  if (!t) return;
  const v = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  const hidden = 255 - v;
  const i = ((y - ty * TILE) * TILE + (x - tx * TILE)) * 4;
  t.data[i] = hidden;
  t.data[i + 1] = hidden;
  t.data[i + 2] = hidden;
  t.data[i + 3] = 255;
  t.version++;
}

/**
 * Paint into a layer mask with a soft round dab.
 *
 * `value` is the new coverage at the dab centre (255 reveals, 0 hides);
 * the brush's soft edge blends toward the existing coverage. Like
 * `stampDab` it only touches tiles that already cover the dab, so a
 * masked layer keeps its sparse storage.
 */
/**
 * Write a selection into a layer mask.
 *
 * AL5: a mask that comes from a selection must HIDE everything the selection
 * excludes. `attachMask()` starts fully revealed (an unallocated tile reads as
 * hidden = 0), and the previous writer only touched the selection's bounding
 * box — so outside that box the layer stayed visible and "Layer mask" produced
 * the inverse of what it promised.
 *
 * The dense write is the correct-and-simple half of the handoff-7 choice: a
 * selection is not the same shape as a mask, and "hidden everywhere except here"
 * cannot be expressed sparsely without giving Layer a polarity flag. The cost is
 * one tile per 256×256 area, which the caller accepts for now.
 *
 * `priorDefault` is the coverage an unallocated pixel already carries under the
 * mask's current polarity (255 for reveal, 0 for hide). A merge into a hide-
 * polarity mask must not treat its untouched pixels as revealed.
 */
export function fillMaskFromSelection(
  mask: TileGrid,
  sel: SelectionMask,
  hideOutside = true,
  priorDefault = 255,
): boolean {
  const box = sel.bbox();
  if (!box) return hideOutside;
  const bw = Math.min(mask.width, box.x + box.w) - Math.max(0, box.x);
  const bh = Math.min(mask.height, box.y + box.h) - Math.max(0, box.y);
  if (bw < 1 || bh < 1) return hideOutside;
  const bx0 = Math.max(0, box.x);
  const by0 = Math.max(0, box.y);
  // AP2: intersect with whatever the user painted, and say "everything outside
  // is hidden" through the layer's polarity (`layer.maskHide`) instead of a
  // canvas-wide fill. Only the tiles the selection touches are touched here, and
  // an unallocated tile inside that box has to be seeded HIDDEN (r=g=b=255), or
  // its untouched pixels would read as revealed (coverage 255 - 0).
  //
  // Perf: one tile at a time, with a 64 KB scratch instead of a bbox-wide copy
  // of the prior coverage (268 MB for a select-all on a 16k document). The
  // prior values must be read before the seed writes hidden into the same tile,
  // which is why the scratch is captured per tile rather than per pixel.
  const tile = new Uint8Array(TILE * TILE);
  const tx0 = Math.floor(bx0 / TILE), ty0 = Math.floor(by0 / TILE);
  const tx1 = Math.floor((bx0 + bw - 1) / TILE), ty1 = Math.floor((by0 + bh - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const ox = tx * TILE, oy = ty * TILE;
      for (let yy = 0; yy < TILE; yy++) {
        const gy = oy + yy;
        for (let xx = 0; xx < TILE; xx++) {
          tile[yy * TILE + xx] = maskAt(mask, ox + xx, gy, priorDefault);
        }
      }
      for (let yy = 0; yy < TILE; yy++) {
        const gy = oy + yy;
        for (let xx = 0; xx < TILE; xx++) {
          const gx = ox + xx;
          const prior = tile[yy * TILE + xx]!;
          const inside = gx >= bx0 && gy >= by0 && gx < bx0 + bw && gy < by0 + bh;
          if (!inside) {
            // Every pixel of the touched tiles that is OUTSIDE the selection
            // must read hidden, or a partially covered tile would reveal its
            // uncovered remainder (maskAt() only says "unallocated" for tiles
            // that do not exist at all).
            if (hideOutside && gx < mask.width && gy < mask.height && prior > 127) {
              setMaskAt(mask, gx, gy, 0);
            }
            continue;
          }
          const next = Math.min(prior, sel.alphaAt(gx, gy));
          // Under hide polarity every pixel of the box carries its own coverage,
          // so write even when the value happens to equal the reveal default.
          if (hideOutside || next !== prior) setMaskAt(mask, gx, gy, next);
        }
      }
    }
  }
  // The caller must apply this to the layer: an unallocated tile now means hidden.
  return hideOutside;
}


export function paintMaskDab(
  mask: TileGrid,
  d: { x: number; y: number; radius: number; hardness: number; alpha: number; value: number },
): { x: number; y: number; w: number; h: number } | null {
  const r = Math.max(0.5, d.radius);
  const x0 = Math.max(0, Math.floor(d.x - r));
  const y0 = Math.max(0, Math.floor(d.y - r));
  const x1 = Math.min(mask.width, Math.ceil(d.x + r));
  const y1 = Math.min(mask.height, Math.ceil(d.y + r));
  if (x1 <= x0 || y1 <= y0) return null;
  const hard = Math.min(0.999, Math.max(0, d.hardness));
  const inner = r * hard;
  let touched = false;
  const txa = Math.floor(x0 / TILE), txaEnd = Math.floor((x1 - 1) / TILE);
  const tya = Math.floor(y0 / TILE), tyaEnd = Math.floor((y1 - 1) / TILE);
  for (let ty = tya; ty <= tyaEnd; ty++) {
    for (let tx = txa; tx <= txaEnd; tx++) {
      const bx = tx * TILE, by = ty * TILE;
      // a missing tile means "reveal everything"; painting reveal over reveal
      // changes nothing, so only allocate when the dab actually hides
      const existing = mask.tile(tx, ty, false);
      const revealsOnly = d.value >= 254.5;
      if (!existing && revealsOnly) continue;
      const tile = existing ?? mask.tile(tx, ty, true);
      if (!tile) continue;
      const cx = Math.max(x0, bx) - bx, cy = Math.max(y0, by) - by;
      const cw = Math.min(x1, bx + TILE) - bx - cx;
      const ch = Math.min(y1, by + TILE) - by - cy;
      let wrote = false;
      for (let yy = 0; yy < ch; yy++) {
        for (let xx = 0; xx < cw; xx++) {
          const gx = bx + cx + xx, gy = by + cy + yy;
          const dx = gx + 0.5 - d.x, dy = gy + 0.5 - d.y;
          const dist = Math.hypot(dx, dy);
          if (dist > r) continue;
          let wgt = 1;
          if (dist > inner) {
            const q = (dist - inner) / Math.max(1e-6, r - inner);
            wgt = 1 - q * q * (3 - 2 * q);
          }
          const k = wgt * d.alpha;
          if (k <= 0) continue;
          const i = ((cy + yy) * TILE + cx + xx) * 4;
          const cur = 255 - tile.data[i]!; // coverage before
          const next = cur + (d.value - cur) * k;
          const hidden = 255 - Math.max(0, Math.min(255, Math.round(next)));
          tile.data[i] = hidden;
          tile.data[i + 1] = hidden;
          tile.data[i + 2] = hidden;
          tile.data[i + 3] = 255;
          wrote = true;
        }
      }
      if (wrote) {
        touched = true;
        tile.version++;
      }
    }
  }
  return touched ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** multiply a layer's pixels by its mask and drop the mask (Apply Mask) */
export function bakeLayerMask(layer: Layer, width: number, height: number): void {
  if (!layer.mask) return;
  const mask = layer.mask;
  layer.grid.forEachTileInRect(0, 0, width, height, (tile, cx, cy, cw, ch, bx, by) => {
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx, gy = by + cy + yy;
        const m = maskAt(mask, gx, gy, layer.maskHide ? 0 : 255) / 255;
        if (m >= 1) continue;
        const i = ((cy + yy) * TILE + cx + xx) * 4;
        tile.data[i + 3] = tile.data[i + 3]! * m;
      }
    }
    tile.version++;
  });
  layer.grid.touch(); // the bake wrote pixels without going through a primitive
  layer.mask = undefined;
}

/** a mask that reveals everything (stored sparsely, so it costs nothing) */
export function createLayerMask(width: number, height: number, onWrite?: () => void): TileGrid {
  return new TileGrid(width, height, onWrite);
}

/** The one place a layer's default field list is written; group/pixel differ
 *  only in `kind` and `children`, so a new field added here reaches both. */
function makeLayer(id: number, name: string, kind: LayerKind, width: number, height: number, onWrite?: () => void): Layer {
  return {
    id,
    name,
    kind,
    grid: new TileGrid(width, height, onWrite),
    visible: true,
    opacity: 1,
    blendMode: "normal",
    locked: false,
  };
}

function newLayer(id: number, name: string, width: number, height: number, onWrite?: () => void): Layer {
  return makeLayer(id, name, "pixel", width, height, onWrite);
}

function newGroup(id: number, name: string, width: number, height: number, onWrite?: () => void): Layer {
  const g = makeLayer(id, name, "group", width, height, onWrite);
  g.children = [];
  return g;
}

export class Document {
  readonly width: number;
  readonly height: number;
  readonly layers: Layer[] = []; // bottom → top

  /**
   * bumped by every pixel primitive on any grid this document owns; the flat
   * cache and the preview key read it instead of trusting per-site booleans.
   * Structural changes (opacity, order, visibility) bump it too, through the
   * shell's `structureChanged()`.
   */
  revision = 0;
  readonly writeHook = (): void => { this.revision++; };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** add a layer on top; returns it */
  addLayer(name?: string): Layer {
    const layer: Layer = {
      id: nextLayerId++,
      name: name ?? `Layer ${nextLayerId - 1}`,
      kind: "pixel",
      grid: new TileGrid(this.width, this.height, this.writeHook),
      visible: true,
      opacity: 1,
      blendMode: "normal",
      locked: false,
    };
    this.layers.push(layer);
    return layer;
  }

  removeLayer(layer: Layer): void {
    const i = this.layers.indexOf(layer);
    if (i >= 0) this.layers.splice(i, 1);
  }

  moveLayer(layer: Layer, toIndex: number): void {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.layers.splice(Math.max(0, Math.min(this.layers.length, toIndex)), 0, layer);
  }

  /** flat fill for new documents (white background layer) */
  /** an adjustment layer that filters everything beneath it */
  addAdjustLayer(spec: AdjustSpec): Layer {
    const layer: Layer = {
      id: nextLayerId++,
      name: adjustLabel(spec),
      kind: "adjust",
      grid: new TileGrid(this.width, this.height, this.writeHook),
      visible: true,
      opacity: 1,
      blendMode: "normal",
      locked: false,
      adjust: spec,
    };
    this.layers.push(layer);
    return layer;
  }

  /** a flat colour layer (Photoshop's Solid Colour fill layer) */
  addFillLayer(color: [number, number, number], name = "Solid Colour"): Layer {
    const layer: Layer = {
      id: nextLayerId++,
      name,
      kind: "fill",
      grid: new TileGrid(this.width, this.height, this.writeHook),
      visible: true,
      opacity: 1,
      blendMode: "normal",
      locked: false,
      fill: { color },
    };
    this.layers.push(layer);
    return layer;
  }
  /** A group node: no pixels of its own, an empty grid like adjust/fill layers. */
  addGroup(name = "Group"): Layer {
    const layer = this.addLayer(name);
    layer.kind = "group";
    layer.children = [];
    return layer;
  }

  /** Attach a new pixel layer INSIDE an existing group. */
  addLayerTo(parent: Layer, name = "Layer"): Layer {
    if (parent.kind !== "group") throw new Error("addLayerTo: parent is not a group");
    const layer = newLayer(nextLayerId++, name, this.width, this.height, this.writeHook);
    (parent.children ??= []).push(layer);
    return layer;
  }

  /** Attach a nested group inside an existing group. */
  addGroupTo(parent: Layer, name = "Group"): Layer {
    if (parent.kind !== "group") throw new Error("addGroupTo: parent is not a group");
    const layer = newGroup(nextLayerId++, name, this.width, this.height, this.writeHook);
    (parent.children ??= []).push(layer);
    return layer;
  }


  /**
   * Is this layer anywhere in the document — top level OR inside a group?
   * Five call sites used `doc.layers.includes(activeLayer)` as a guard, which is
   * silently false for a group child: brush/text/transform/delete then did
   * nothing and looked broken. `layers` is the top-level stack; membership is
   * a different question.
   */
  inDocument(layer: Layer | null | undefined): boolean {
    if (!layer) return false;
    return this.parentOf(layer) !== undefined;
  }

  /** undefined = not in this document; null = top level; Layer = its group. */
  parentOf(layer: Layer | null | undefined): Layer | null | undefined {
    if (!layer) return undefined;
    if (this.layers.includes(layer)) return null;
    const walk = (list: readonly Layer[]): Layer | undefined => {
      for (const l of list) {
        const kids = l.children;
        if (!kids || kids.length === 0) continue;
        if (kids.includes(layer)) return l;
        const deeper = walk(kids);
        if (deeper) return deeper;
      }
      return undefined;
    };
    return walk(this.layers);
  }

  /**
   * Insert a node under `parent` (null = top level) at `index`. The ONE way to
   * put a layer into the tree; the six add sites resolve here instead of poking
   * `doc.layers`, which is how they got wrong for group children in the first
   * place. Photoshop's rule for a NEW layer, which all six sites want: insert as
   * a SIBLING of the active layer, directly above it; with no active layer, at
   * the ROOT. That sentence is the whole rule - not six special cases.
   */
  insertLayer(parent: Layer | null, layer: Layer, index: number): void {
    // A node may exist in exactly one place. Without this, a stale spot inserts the
    // SAME object twice and every later walk visits it twice. Refuse with both facts
    // instead of returning quietly - the next stale spot must say what it is.
    // (Restored after the session-container merge dropped it: the guard was written on
    // feat/panel and their version of this file won the merge region.)
    if (this.inDocument(layer)) {
      throw new Error(
        `insertLayer: "${layer.name}" is already in the document - detach it with removeLayerFrom before inserting`,
      );
    }
    if (parent && parent !== layer && this.within(layer, parent)) {
      throw new Error(
        `insertLayer: cannot insert "${layer.name}" into its own descendant "${parent.name}"`,
      );
    }
    const list = parent ? (parent.children ??= []) : this.layers;
    const at = Math.max(0, Math.min(index, list.length));
    list.splice(at, 0, layer);
  }

  /** Detach a node (and, implicitly, its whole subtree) from its parent. */
  removeLayerFrom(parent: Layer | null, layer: Layer): void {
    const list = parent ? parent.children : this.layers;
    if (!list) return;
    const at = list.indexOf(layer);
    if (at >= 0) list.splice(at, 1);
  }

  /** Is `node` inside `ancestor`'s subtree (or the node itself)? */
  private within(ancestor: Layer, node: Layer): boolean {
    if (ancestor === node) return true;
    for (const kid of ancestor.children ?? []) {
      if (this.within(kid, node)) return true;
    }
    return false;
  }

  /**
   * The ONLY move primitive. Expresses a parent change as well as a reorder:
   * same-parent reorder is the case where the parents are equal, so a command
   * that captures both parent paths cannot be right in one direction only.
   *
   * Two rules that bite otherwise:
   *  - a group may not move into its own descendant (a one-drag accident that
   *    produces a tree which recurses forever the first time it composites);
   *  - remove-then-insert shifts the destination when moving FORWARD inside one
   *    parent (fromIndex < toIndex means the target index is one lower after
   *    removal). Handling it here, with tests in both directions, is the only
   *    way that off-by-one does not reach a document.
   */
  moveLayerTo(
    fromParent: Layer | null,
    layer: Layer,
    fromIndex: number,
    toParent: Layer | null,
    toIndex: number,
  ): void {
    if (toParent && this.within(layer, toParent)) {
      throw new Error("moveLayer: cannot move a group into its own descendant");
    }
    const from = fromParent ? fromParent.children : this.layers;
    if (!from || from.indexOf(layer) !== fromIndex) {
      throw new Error("moveLayer: source index does not match the tree");
    }
    this.removeLayerFrom(fromParent, layer);
    const to = toParent ? (toParent.children ??= []) : this.layers;
    let at = Math.max(0, Math.min(toIndex, to.length + 1));
    if (fromParent === toParent && fromIndex < toIndex) at -= 1;
    to.splice(Math.max(0, Math.min(at, to.length)), 0, layer);
  }

  /**
   * The denominator for "Layer k of N", and the row count the panel renders.
   * DECISION: N counts TOTAL NODES (groups AND leaves), not leaves alone, because
   * the panel draws one row per node and a status bar that disagreed with the row
   * count would be wrong for every document containing a group.
   */
  layerCount(): number {
    return this.allLayers().length;
  }

  /** Flat position for a layer number, depth-first — groups count as layers. */
  layerNumber(layer: Layer): number {
    return this.allLayers().indexOf(layer);
  }

  /** Depth-first view of every layer, groups before their children. */
  allLayers(): Layer[] {
    const out: Layer[] = [];
    const walk = (list: readonly Layer[]): void => {
      for (const l of list) {
        out.push(l);
        if (l.children && l.children.length > 0) walk(l.children);
      }
    };
    walk(this.layers);
    return out;
  }


  /** give a layer a mask that starts fully revealed */
  attachMask(layer: Layer): TileGrid {
    if (!layer.mask) layer.mask = createLayerMask(this.width, this.height, this.writeHook);
    return layer.mask;
  }

  addBackground(name = "Background"): Layer {
    const l = this.addLayer(name);
    l.grid.fillRect(0, 0, this.width, this.height, [255, 255, 255, 255]);
    return l;
  }

  /**
   * Compiled adjustment recipes, keyed by the layer OBJECT and invalidated by a
   * serialised snapshot of its recipe.
   *
   * `compileAdjust` builds LUTs (and for curves a monotone spline) — real work
   * for one pointwise pass. It used to run once per `compositeRect` call, i.e.
   * several times per frame while a slider is dragged, always producing the
   * same tables. A WeakMap keeps the entry alive only while the layer exists.
   */
  private readonly adjustCache = new WeakMap<Layer, { key: string; compiled: CompiledAdjust }>();

  private adjustFor(layer: Layer): CompiledAdjust {
    const spec = layer.adjust ?? { kind: "levels" as const };
    const key = JSON.stringify(spec);
    const hit = this.adjustCache.get(layer);
    if (hit && hit.key === key) return hit.compiled;
    const compiled = compileAdjust(spec);
    this.adjustCache.set(layer, { key, compiled });
    return compiled;
  }

  /**
   * Composite a doc-space rect of the whole stack into `out` (w*h*4
   * straight RGBA). `out` is filled with transparent black first.
   */
  compositeRect(x: number, y: number, w: number, h: number, out: Uint8ClampedArray): void {
    if (out.length < w * h * 4) throw new Error("compositeRect: buffer too small");
    out.fill(0);
    this.compositeLayers(this.layers, x, y, w, h, out);
  }

  /**
   * PSD fidelity step 1: the compositor walks a LIST of layers, so a group can
   * hand its children to the same code. A group composites its subtree into a
   * scratch buffer first and is then blended as one source — that is what makes
   * "group opacity" mean one thing instead of N children each at 50 %.
   *
   * Public because the Layers panel draws a group's thumbnail from exactly this
   * walk: `compositeLayers(children)` over transparency is the group's content,
   * and a second thumbnail-only compositor would drift from the canvas. `out`
   * must be zero-filled by the caller; `compositeRect` does that for the whole
   * stack.
   */
  compositeLayers(
    list: readonly Layer[], x: number, y: number, w: number, h: number, out: Uint8ClampedArray,
  ): void {
    // Float64 on purpose: adjustment closures must see raw doubles so the
    // byte store rounds identically to the destructive ops (float32 turns
    // .49999 float dust into exact .5 and flips ties-to-even).
    const px = new Float64Array(3);
    for (const layer of list) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const op = layer.opacity;
      const mode: BlendMode =
        LAYER_BLEND_MODES.includes(layer.blendMode) ? layer.blendMode : "normal";

      // Groups: composite the subtree, then blend the result as ONE source.
      // Using the same `list` walk means nesting costs a scratch buffer, not a
      // second implementation of the compositor.
      if (layer.kind === "group" && layer.passThrough === true) {
        // Pass-through: no scratch, no group opacity, no group blend. Each child
        // sees the accumulated backdrop, exactly like Photoshop's default group.
        this.compositeLayers(layer.children ?? [], x, y, w, h, out);
        continue;
      }
      if (layer.kind === "group") {
        const kids = layer.children ?? [];
        if (kids.length === 0) continue;
        const src = new Uint8ClampedArray(w * h * 4);
        this.compositeLayers(kids, x, y, w, h, src);
        for (let yy = 0; yy < h; yy++) {
          const gy = y + yy;
          if (gy < 0 || gy >= this.height) continue;
          for (let xx = 0; xx < w; xx++) {
            const gx = x + xx;
            if (gx < 0 || gx >= this.width) continue;
            const sp = (yy * w + xx) * 4;
            let sa = src[sp + 3]! * op * (maskAt(layer.mask, gx, gy, layer.maskHide ? 0 : 255) / 255);
            if (sa <= 0) continue;
            const dp = sp;
            const da = out[dp + 3]!;
            if (layer.clipToBelow) sa = sa * (da / 255);
            if (sa <= 0) continue;
            if (mode === "normal") {
              overNormal(src[sp]!, src[sp + 1]!, src[sp + 2]!, sa, out, dp);
            } else {
              compositePixel(mode, src[sp]!, src[sp + 1]!, src[sp + 2]!, sa, out[dp]!, out[dp + 1]!, out[dp + 2]!, da, out, dp, gx, gy);
            }
          }
        }
        continue;
      }

      // Adjustment layers transform whatever is already underneath, which
      // is pointwise, so doing it per rect (not per tile) is exact.
      if (layer.kind === "adjust") {
        const adj = this.adjustFor(layer);
        for (let yy = 0; yy < h; yy++) {
          const gy = y + yy;
          if (gy < 0 || gy >= this.height) continue;
          for (let xx = 0; xx < w; xx++) {
            const gx = x + xx;
            if (gx < 0 || gx >= this.width) continue;
            const dp = (yy * w + xx) * 4;
            const a = out[dp + 3]!;
            if (a === 0) continue;
            const r0 = out[dp]!, g0 = out[dp + 1]!, b0 = out[dp + 2]!;
            let nr: number, ng: number, nb: number;
            if (adj.rgb) {
              adj.rgb(r0, g0, b0, px);
              nr = px[0]!; ng = px[1]!; nb = px[2]!;
            } else {
              nr = adj.lr![r0]!; ng = adj.lg![g0]!; nb = adj.lb![b0]!;
            }
            // mask + opacity decide how much of the adjustment sticks.
            // A clipping mask also limits it to the backdrop's coverage: the
            // audit (R3) caught that clipping an adjustment layer was silently
            // ignored, so a clipped Levels still filtered the whole document.
            let m = (maskAt(layer.mask, gx, gy, layer.maskHide ? 0 : 255) / 255) * op;
            if (layer.clipToBelow) m *= a / 255;
            if (m >= 1) {
              out[dp] = nr; out[dp + 1] = ng; out[dp + 2] = nb;
            } else if (m > 0) {
              out[dp] = r0 + (nr - r0) * m;
              out[dp + 1] = g0 + (ng - g0) * m;
              out[dp + 2] = b0 + (nb - b0) * m;
            }
          }
        }
        continue;
      }

      // Fill layers are an unbounded flat colour; only the mask cuts them.
      if (layer.kind === "fill") {
        const col = layer.fill?.color ?? [255, 255, 255];
        for (let yy = 0; yy < h; yy++) {
          const gy = y + yy;
          if (gy < 0 || gy >= this.height) continue;
          for (let xx = 0; xx < w; xx++) {
            const gx = x + xx;
            if (gx < 0 || gx >= this.width) continue;
            let sa = 255 * op * (maskAt(layer.mask, gx, gy, layer.maskHide ? 0 : 255) / 255);
            if (sa <= 0) continue;
            const dp = (yy * w + xx) * 4;
            if (layer.clipToBelow) sa = sa * (out[dp + 3]! / 255);
            if (sa <= 0) continue;
            const da = out[dp + 3]!;
            if (mode === "normal") {
              overNormal(col[0], col[1], col[2], sa, out, dp);
            } else {
              compositePixel(mode, col[0], col[1], col[2], sa, out[dp]!, out[dp + 1]!, out[dp + 2]!, da, out, dp, gx, gy);
            }
          }
        }
        continue;
      }

      const hasMask = !!layer.mask;
      layer.grid.forEachTileInRect(x, y, w, h, (tile, cx, cy, cw, ch, bx, by) => {
        const td = tile.data;
        const normal = mode === "normal";
        for (let yy = 0; yy < ch; yy++) {
          for (let xx = 0; xx < cw; xx++) {
            const gx = bx + cx + xx, gy = by + cy + yy;
            const tp = ((cy + yy) * TILE + cx + xx) * 4;
            const sr = td[tp]!, sg = td[tp + 1]!, sb = td[tp + 2]!;
            let sa = td[tp + 3]!;
            if (sa === 0) continue;
            if (op < 1) sa = sa * op;
            if (hasMask) sa = sa * (maskAt(layer.mask, gx, gy, layer.maskHide ? 0 : 255) / 255);
            if (sa === 0) continue;
            const dp = ((gy - y) * w + (gx - x)) * 4;
            const da = out[dp + 3]!;
            // clipping: only show where the stack below is opaque
            if (layer.clipToBelow) {
              sa = sa * (da / 255);
              if (sa === 0) continue;
            }
            if (normal) {
              // one implementation of source-over, shared with plane.ts and the merge path
              overNormal(sr, sg, sb, sa, out, dp);
            } else {
              compositePixel(mode, sr, sg, sb, sa, out[dp]!, out[dp + 1]!, out[dp + 2]!, da, out, dp, gx, gy);
            }
          }
        }
      });
    }
  }

  /** composite the entire document */
  composite(out?: Uint8ClampedArray): Uint8ClampedArray {
    const buf = out ?? new Uint8ClampedArray(this.width * this.height * 4);
    this.compositeRect(0, 0, this.width, this.height, buf);
    return buf;
  }
}

/** composite `src` (with its blend mode + opacity) onto `dst`'s pixels in
 *  place — the pixel half of Merge Down. Coverage = union of both bboxes;
 *  `dst` pixels outside the union stay untouched. Returns the merged bbox
 *  or null when both layers are empty. */
export function mergeLayerInto(src: Layer, dst: Layer): { x: number; y: number; w: number; h: number } | null {
  const a = gridBBox(dst.grid), b = gridBBox(src.grid);
  const bb = a && b
    ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
        h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) }
    : (a ?? b);
  if (!bb) return null;
  const n = bb.w * bb.h * 4;
  const base = new Uint8ClampedArray(n);
  dst.grid.readRect(bb.x, bb.y, bb.w, bb.h, base);
  const top = new Uint8ClampedArray(n);
  src.grid.readRect(bb.x, bb.y, bb.w, bb.h, top);
  const op = src.opacity;
  const mode = src.blendMode;
  const mask = src.mask;
  for (let i = 0; i < n; i += 4) {
    const px = bb.x + ((i >> 2) % bb.w);
    const py = bb.y + Math.floor(i / 4 / bb.w);
    const m = mask ? maskAt(mask, px, py, src.maskHide ? 0 : 255) / 255 : 1;
    if (m <= 0) continue;
    const sa = top[i + 3]! * op * m;
    if (sa <= 0) continue; // transparent top pixel: base shows through
    compositePixel(mode, top[i]!, top[i + 1]!, top[i + 2]!, sa,
      base[i]!, base[i + 1]!, base[i + 2]!, base[i + 3]!, base, i, px, py);
  }
  dst.grid.writeRect(bb.x, bb.y, bb.w, bb.h, base);
  return bb;
}
