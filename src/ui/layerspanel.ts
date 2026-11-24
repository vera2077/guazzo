/**
 * layerspanel.ts — the Layers panel (props block, rows, action strip).
 *
 * Extracted from main.ts (handoff-5 AF3): this was the last panel still built by
 * a 320-line function inside an 8300-line module, reaching into a dozen globals.
 * The panel now receives one deps object, so what it can touch is visible in its
 * signature instead of by grepping for `activeLayer`.
 *
 *   NOTE: it USED to say the stack was deliberately flat and that groups
 *   were only a colour band. That is no longer true: `Layer.children` is a real
 *   container and the project loader can produce it today. Read this file as a
 *   tree walk; the G1-G6 band is a COLOUR TAG only (a PERSISTED but purely
 *   visual marker), never a second grouping concept. Two grouping ideas in one
 *   panel is how "two counts that disagree" starts.
 * nested container, and clipping is a one-bit flag on a layer.
 */
import { compileAdjust } from "../engine/adjustfn.ts";
import type { BlendMode } from "../engine/blend.ts";
import { LAYER_BLEND_MODES } from "../engine/blend.ts";
import type { Document, Layer } from "../engine/document.ts";
import { fillPatternColourAt } from "../engine/fillpattern.ts";
import { gridBBox } from "../engine/transform.ts";
import { iconSvg, setIcon, type IconName } from "./icons.ts";
import { dropZoneAt, type DropZone } from "./layerops.ts";
import type { PanelRow } from "./session.ts";

export const THUMB_W = 26;
export const THUMB_H = 20;

/** the existing thumbnail cap: a 6000×4000 crop must not become a 24 MP read */
const THUMB_CAP = 1024 * 1024;

interface SourceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** cap a source crop around its centre, so drawing a thumb never reads the doc */
export function capSourceRect(rect: SourceRect): SourceRect {
  if (rect.w * rect.h <= THUMB_CAP) return rect;
  const k = Math.sqrt((rect.w * rect.h) / THUMB_CAP);
  const w = Math.max(1, Math.round(rect.w / k));
  const h = Math.max(1, Math.round(rect.h / k));
  return {
    x: Math.round(rect.x + (rect.w - w) / 2),
    y: Math.round(rect.y + (rect.h - h) / 2),
    w,
    h,
  };
}

/**
 * The doc-space crop a group's thumbnail needs: the union of what its children
 * actually paint. Pixel children contribute their grid bbox, groups recurse,
 * and fill/adjust children cover the whole canvas (they are unclipped planes,
 * so cropping them to a sibling's bbox would hide the thing being previewed).
 * Hidden children contribute nothing — the composite skips them too.
 */
export function groupSourceRect(
  children: readonly Layer[],
  docW: number,
  docH: number,
): SourceRect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (r: SourceRect): void => {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  };
  const walk = (list: readonly Layer[]): void => {
    for (const child of list) {
      if (!child.visible || child.opacity <= 0) continue;
      if (child.kind === "pixel") {
        const bb = gridBBox(child.grid);
        if (bb && bb.w > 0 && bb.h > 0) add(bb);
      } else if (child.kind === "group") {
        walk(child.children ?? []);
      } else {
        add({ x: 0, y: 0, w: docW, h: docH });
      }
    }
  };
  walk(children);
  if (x0 === Infinity) return null;
  const x = Math.max(0, x0);
  const y = Math.max(0, y0);
  const w = Math.min(docW, x1) - x;
  const h = Math.min(docH, y1) - y;
  if (w <= 0 || h <= 0) return null;
  return capSourceRect({ x, y, w, h });
}

/**
 * Cheap change token for a group's thumbnail. `doc.revision` covers pixel
 * writes anywhere in the document; the layer walk covers the structural bits
 * a revision bump may not have seen yet (a reorder is a revision bump, but a
 * visibility/opacity change is only guaranteed to repaint). The token is small
 * on purpose: the expensive part is the composite, not this walk.
 */
function groupSignature(group: Layer, doc: Document): string {
  const parts: string[] = [String(doc.revision)];
  const walk = (layer: Layer): void => {
    parts.push([
      layer.id,
      layer.kind,
      layer.visible ? 1 : 0,
      layer.opacity,
      layer.blendMode,
      layer.clipToBelow ? 1 : 0,
      layer.mask ? 1 : 0,
      layer.groupId ?? "",
      layer.fill?.color?.join(",") ?? "",
    ].join(":"));
    if (layer.kind === "group") for (const child of layer.children ?? []) walk(child);
  };
  for (const child of group.children ?? []) walk(child);
  return parts.join("|");
}

const groupThumbCache = new WeakMap<Layer, { signature: string; canvas: HTMLCanvasElement }>();

function blankThumb(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = THUMB_W;
  cv.height = THUMB_H;
  cv.className = "thumb";
  return cv;
}

/** scale a straight-RGBA crop into the 26×20 slot */
function drawThumbBuffer(
  cv: HTMLCanvasElement,
  buf: Uint8ClampedArray<ArrayBuffer>,
  sw: number,
  sh: number,
): void {
  const c2 = cv.getContext("2d");
  if (!c2) return;
  const src = document.createElement("canvas");
  src.width = sw;
  src.height = sh;
  src.getContext("2d")!.putImageData(new ImageData(buf, sw, sh), 0, 0);
  const s = Math.min(THUMB_W / sw, THUMB_H / sh);
  const dw = Math.max(1, Math.round(sw * s));
  const dh = Math.max(1, Math.round(sh * s));
  c2.imageSmoothingEnabled = true;
  c2.drawImage(src, Math.round((THUMB_W - dw) / 2), Math.round((THUMB_H - dh) / 2), dw, dh);
}

/**
 * A group row's thumbnail is the group's CONTENT, not a white square: composite
 * its children with the document's own list walker (the same one the canvas
 * uses), capped to the existing 1 MP crop. The result is cached by layer
 * object and change token, so a render at an unchanged revision does not walk
 * twenty subtrees again. An empty group stays transparent and shows the CSS
 * checkerboard through the canvas.
 */
function groupThumb(group: Layer, doc: Document): HTMLCanvasElement {
  const signature = groupSignature(group, doc);
  const hit = groupThumbCache.get(group);
  if (hit && hit.signature === signature) return hit.canvas;
  const cv = blankThumb();
  const children = group.children ?? [];
  const rect = groupSourceRect(children, doc.width, doc.height);
  if (rect && children.length > 0) {
    const buf = new Uint8ClampedArray(rect.w * rect.h * 4);
    doc.compositeLayers(children, rect.x, rect.y, rect.w, rect.h, buf);
    drawThumbBuffer(cv, buf, rect.w, rect.h);
  }
  groupThumbCache.set(group, { signature, canvas: cv });
  return cv;
}

/** the palette a colour tag cycles through; it never affects the layer tree */
// Text is painted in these colours on --panel-3 (#2f343f); three of the old
// values measured 3.65:1, 3.90:1 and 3.94:1, under the 4.5:1 floor for text.
export const TAG_COLOURS = ["#8fb2ff", "#f2b33d", "#4ec98b", "#ff8a80", "#c3a0ff", "#3dc3d4"];

export function tagColour(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TAG_COLOURS[h % TAG_COLOURS.length]!;
}

/** G1..G6 then none — fixed ids, so neighbouring rows share a tint by construction */
export function nextTagId(current?: string): string | undefined {
  if (!current) return "G1";
  const n = Number(current.slice(1));
  if (Number.isFinite(n) && n >= 1 && n < TAG_COLOURS.length) return `G${n + 1}`;
  return undefined;
}

/**
 * One badge per kind. A Record makes a fifth Layer kind a compile error instead
 * of silently falling back to the fill label.
 */
const LAYER_BADGE: Record<Layer["kind"], string> = {
  pixel: "",
  adjust: "adj",
  fill: "fill",
  group: "grp",
};

export type PaintTarget = "pixel" | "mask";

export interface LayersPanelDeps {
  /** scroll container holding the props block and the rows */
  body: HTMLElement;
  /** footer strip of action buttons */
  strip: HTMLElement;
  /** the visible rows, ordered and indented by the owner (panelRows) */
  rows(): readonly PanelRow[];
  /**
   * Unfold the ancestors of the active node. panelRows() can force a path open
   * for one render, but the chevron and the next render read the fold set; the
   * owner keeps that set, so the panel asks it before drawing.
   */
  reveal(): void;
  /** the document, for a group thumbnail's children composite */
  doc(): Document;
  active(): Layer;
  setActive(layer: Layer): void;
  /** folded group ids, so the chevron can say what state it is in */
  collapsed(): ReadonlySet<number>;
  toggleCollapsed(layer: Layer): void;
  paintTarget(): PaintTarget;
  setPaintTarget(target: PaintTarget): void;
  hasSelection(): boolean;
  /** push one undoable property change (main.ts wraps propertyCommand) */
  undoable(label: string, apply: (v: unknown) => void, before: unknown, after: unknown): void;
  /** mark the composite dirty and repaint */
  repaint(): void;
  /** re-run this panel (row click, rename, mask target switch) */
  rerender(): void;
  refreshHistory(): void;
  refreshOptions(): void;
  menu(ev: MouseEvent, layer: Layer): void;
  // panel actions
  addLayer(): void;
  duplicateLayer(): void;
  deleteLayer(): void;
  mergeDown(): void;
  flatten(): void;
  enterTransform(): void;
  cancelTransform(): void;
  addMask(): void;
  loadMask(): void;
  applyMask(): void;
  deleteMask(): void;
  addAdjust(): void;
  /** +1 raises the active layer among its own siblings, -1 lowers it */
  moveLayer(delta: -1 | 1): void;
  /**
   * Pre-flight for a drag: may `moving` land on `target` in `zone`? The owner
   * checks the document (parentOf + cycle) so an illegal drop shows a no-drop
   * cursor instead of throwing out of the drag handler.
   */
  canDropLayer(moving: Layer, target: Layer, zone: DropZone): boolean;
  /** Commit a drag as one move command. */
  dropLayer(moving: Layer, target: Layer, zone: DropZone): void;
  /**
   * A drop the owner refused (cycle, wrong kind). The cursor alone says
   * nothing to a keyboard or screen-reader user, so the owner reports it once
   * per gesture in the status line (D5, uiux-r32).
   */
  onRefused?: () => void;
}

export interface LayersPanel {
  render(): void;
}

export function layerThumb(layer: Layer): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = THUMB_W;
  cv.height = THUMB_H;
  cv.className = "thumb";
  const c2 = cv.getContext("2d");
  if (!c2) return cv;
  if (layer.kind === "pixel") {
    // bbox-based: the old tile-centre sample missed any content smaller than
    // half a tile (text, small shapes) — those thumbnails rendered blank.
    const bb = gridBBox(layer.grid);
    if (bb && bb.w > 0 && bb.h > 0) {
      const { x, y, w, h } = capSourceRect(bb);
      const buf = new Uint8ClampedArray(w * h * 4);
      layer.grid.readRect(x, y, w, h, buf);
      drawThumbBuffer(cv, buf, w, h);
    }
  } else if (layer.kind === "adjust") {
    // X6: an adjustment layer used to be one flat blue rectangle — two different
    // Curves layers looked identical. Render what the adjustment DOES to a mid
    // grey ramp instead: the thumbnail becomes a preview.
    const gr = c2.createLinearGradient(0, 0, THUMB_W, 0);
    try {
      const compiled = compileAdjust(layer.adjust ?? { kind: "levels" });
      const out = new Float64Array(3);
      for (let i = 0; i <= 8; i++) {
        const v = Math.round((i / 8) * 255);
        if (compiled.rgb) {
          compiled.rgb(v, v, v, out);
          gr.addColorStop(i / 8, `rgb(${Math.round(out[0]!)},${Math.round(out[1]!)},${Math.round(out[2]!)})`);
        } else {
          const r = compiled.lr ? compiled.lr[v]! : v;
          const g = compiled.lg ? compiled.lg[v]! : v;
          const b = compiled.lb ? compiled.lb[v]! : v;
          gr.addColorStop(i / 8, `rgb(${r},${g},${b})`);
        }
      }
      c2.fillStyle = gr;
    } catch {
      c2.fillStyle = "rgba(127,178,255,.55)";
    }
    c2.fillRect(0, 0, THUMB_W, THUMB_H);
  } else {
    const col = layer.fill?.color ?? [255, 255, 255];
    const gradient = layer.fill?.gradient;
    const pattern = layer.fill?.pattern;
    if (pattern) {
      // Draw the real cells, so two patterns never look like one flat colour.
      const size = Math.max(2, Math.round(pattern.size / 4));
      for (let y = 0; y < THUMB_H; y += size) {
        for (let x = 0; x < THUMB_W; x += size) {
          const c = fillPatternColourAt(pattern, x * 4, y * 4);
          c2.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
          c2.fillRect(x, y, size, size);
        }
      }
    } else if (gradient && gradient.stops.length >= 2) {
      const rad = (gradient.angle * Math.PI) / 180;
      const cx = THUMB_W / 2;
      const cy = THUMB_H / 2;
      const span = Math.abs(Math.cos(rad)) * THUMB_W + Math.abs(Math.sin(rad)) * THUMB_H;
      const dx = Math.cos(rad) * (span / 2);
      const dy = Math.sin(rad) * (span / 2);
      const g = c2.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
      for (const stop of gradient.stops) {
        const c = stop.color;
        g.addColorStop(Math.min(1, Math.max(0, stop.at)), `rgb(${c[0]},${c[1]},${c[2]})`);
      }
      c2.fillStyle = g;
      c2.fillRect(0, 0, THUMB_W, THUMB_H);
    } else {
      c2.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      c2.fillRect(0, 0, THUMB_W, THUMB_H);
    }
  }
  if (layer.mask) {
    // a chip in the corner, so a masked layer is readable at a glance
    c2.fillStyle = "rgba(255,255,255,.85)";
    c2.fillRect(0, 0 + THUMB_H - 3, 3, 3);
  }
  return cv;
}

/**
 * The layer directly below row `at` — the next sibling in the same parent, or
 * undefined at the bottom of a group. Descendants of `at` sit between the two
 * rows and must be skipped, which a flat `rows[at + 1]` cannot know. Used for
 * the clipping band: a row is a clip-base when the layer below it clips up.
 */
export function layerBelowRow(rows: readonly PanelRow[], at: number): Layer | undefined {
  const depth = rows[at]!.depth;
  for (let i = at + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.depth === depth) return row.node;
    if (row.depth < depth) return undefined;
  }
  return undefined;
}

export function buildLayersPanel(deps: LayersPanelDeps): LayersPanel {
  function render(): void {
    deps.reveal();
    const body = deps.body;
    const keepScroll = body.scrollTop;
    body.innerHTML = "";

    const activeLayer = deps.active();

    // ---- active-layer properties (blend mode + opacity, both undoable) ----
    const props = document.createElement("div");
    props.className = "stack";

    const blendRow = document.createElement("div");
    blendRow.className = "inline-row";
    const blendLab = document.createElement("span");
    blendLab.textContent = "Blend";
    blendLab.className = "label";
    blendLab.style.width = "42px";
    const blend = document.createElement("select");
    for (const m of LAYER_BLEND_MODES) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m.replace(/-/g, " ").replace(/^\w|\s\w/g, s => s.toUpperCase());
      blend.appendChild(o);
    }
    blend.value = activeLayer.blendMode;
    blend.style.cssText = "flex:1;min-width:0";
    blend.addEventListener("change", () => {
      const layer = deps.active(); // captured: undo must target this layer
      const before = layer.blendMode;
      const after = blend.value as BlendMode;
      layer.blendMode = after;
      deps.undoable(
        `Blend ${before} → ${after}`,
        (v) => { layer.blendMode = v as BlendMode; deps.repaint(); },
        before, after,
      );
      deps.repaint();
      deps.refreshHistory();
    });
    blendRow.append(blendLab, blend);
    props.appendChild(blendRow);

    const opRow = document.createElement("div");
    opRow.className = "inline-row";
    const opLab = document.createElement("span");
    opLab.textContent = "Opacity";
    opLab.className = "label";
    opLab.style.width = "42px";
    const opRange = document.createElement("input");
    opRange.type = "range";
    opRange.min = "0";
    opRange.max = "100";
    opRange.value = String(Math.round(activeLayer.opacity * 100));
    opRange.style.flex = "1";
    opRange.setAttribute("aria-label", "Layer opacity");
    const opVal = document.createElement("span");
    opVal.textContent = `${Math.round(activeLayer.opacity * 100)}%`;
    opVal.className = "value";
    // captured once: a tab switch mid-drag must not retarget the edit
    const opLayer = activeLayer;
    let before: number | null = null;
    opRange.addEventListener("pointerdown", () => { before = opLayer.opacity; });
    opRange.addEventListener("input", () => {
      // keyboard arrows fire input/change without pointerdown, so seed lazily
      if (before === null) before = opLayer.opacity;
      opLayer.opacity = Number(opRange.value) / 100;
      opVal.textContent = `${Number(opRange.value)}%`;
      deps.repaint();
    });
    opRange.addEventListener("change", () => {
      // a keyboard edit never saw pointerdown, so fall back to the layer's value
      const b = before ?? opLayer.opacity;
      before = null;
      const layer = opLayer; // captured: undo must target this layer
      const a = layer.opacity;
      if (a === b) return;
      deps.undoable(
        `Opacity ${Math.round(a * 100)}%`,
        (v) => { layer.opacity = v as number; deps.repaint(); },
        b, a,
      );
      deps.refreshHistory();
    });
    opRow.append(opLab, opRange, opVal);
    props.appendChild(opRow);

    // ---- paint target: the pixels or the layer mask ------------------------
    if (activeLayer.mask) {
      const tRow = document.createElement("div");
      tRow.className = "inline-row";
      const tLab = document.createElement("span");
      tLab.className = "label";
      tLab.textContent = "Edit";
      tLab.style.width = "42px";
      const mk = (label: string, target: PaintTarget): HTMLButtonElement => {
        const b = document.createElement("button");
        b.className = "btn subtle" + (deps.paintTarget() === target ? " primary" : "");
        b.textContent = label;
        // These are toggles; without aria-pressed a screen reader hears two
        // buttons and no state (uiux-r28 #4).
        b.dataset.act = `paint-${target}`;
        b.setAttribute("aria-pressed", deps.paintTarget() === target ? "true" : "false");
        b.addEventListener("click", () => {
          deps.setPaintTarget(target);
          deps.rerender();
          deps.refreshOptions();
          const again = body.querySelector(`[data-act="paint-${target}"]`) as HTMLElement | null;
          (again ?? deps.strip)?.focus?.();
        });
        return b;
      };
      const applyBtn = document.createElement("button");
      applyBtn.className = "btn subtle";
      applyBtn.textContent = "Apply";
      applyBtn.title = "Bake the mask into the pixels and drop it";
      applyBtn.addEventListener("click", () => deps.applyMask());
      const delBtn = document.createElement("button");
      delBtn.className = "btn subtle icon";
      setIcon(delBtn, "trash", 13);
      delBtn.title = "Delete the mask";
      delBtn.addEventListener("click", () => deps.deleteMask());
      const editGroup = document.createElement("span");
      editGroup.className = "edit-group";
      editGroup.setAttribute("role", "group");
      editGroup.setAttribute("aria-label", `${activeLayer.name} paint target`);
      editGroup.append(mk("Pixels", "pixel"), mk("Mask", "mask"));
      tRow.append(tLab, editGroup, applyBtn, delBtn);
      props.appendChild(tRow);
    }
    body.appendChild(props);

    // ---- the tree ----------------------------------------------------------
    // The props block stays outside the tree: a tree owns treeitems, not selects.
    const rowList = document.createElement("div");
    rowList.className = "layer-rows";
    rowList.setAttribute("role", "tree");
    rowList.setAttribute("aria-label", "Layers");
    body.appendChild(rowList);

    const focusRow = (id: number): void => {
      const el = deps.body.querySelector(`[data-layer-id="${id}"]`) as HTMLElement | null;
      el?.focus();
    };
    let dragLayer: Layer | null = null;
    let dropRow: HTMLElement | null = null;
    const clearDropMarks = (): void => {
      dropRow?.classList.remove("drop-before", "drop-after", "drop-inside", "drop-illegal");
      dropRow = null;
    };

    // ---- layer rows (topmost first) ----------------------------------------
    // The owner hands us rows; this loop only draws them. Indenting by depth is
    // the panel's job, deciding what is on screen is not (deps.rows()).
    const rows = deps.rows();
    for (let at = 0; at < rows.length; at++) {
      const { node: layer, depth } = rows[at]!;
      const row = document.createElement("div");
      const below = layerBelowRow(rows, at);
      row.className = "row" + (layer === activeLayer ? " active" : "")
        + (layer.clipToBelow ? " clipped" : "")
        + (below?.clipToBelow ? " clip-base" : "");
      row.title = layer.name + (layer.clipToBelow ? " (clipped to the layer below)" : "");
      row.dataset.layerId = String(layer.id);
      row.setAttribute("data-layer-id", String(layer.id));
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      row.setAttribute("aria-selected", layer === activeLayer ? "true" : "false");
      row.style.paddingLeft = `${8 + depth * 14}px`;
      // Roving tabindex: one tab stop for the whole tree, so reaching layer 30
      // does not mean pressing Tab 30 times. Arrow keys move within it.
      row.tabIndex = layer === activeLayer ? 0 : -1;
      const hasChildren = layer.kind === "group" && (layer.children?.length ?? 0) > 0;
      if (layer.kind === "group") {
        row.setAttribute("aria-expanded", String(!deps.collapsed().has(layer.id)));
      }
      const selectAndFocus = (node: Layer): void => {
        deps.setActive(node);
        deps.rerender();
        deps.refreshOptions();
        focusRow(node.id);
      };
      row.addEventListener("keydown", (e) => {
        // The twisty is its own button inside the row: Enter/Space there must
        // fold, not select. Only keys aimed at the row itself select.
        if (e.target !== row) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); return; }
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
          e.preventDefault();
          const nextAt = e.key === "Home" ? 0
            : e.key === "End" ? rows.length - 1
            : at + (e.key === "ArrowUp" ? -1 : 1);
          const next = rows[nextAt]?.node;
          if (next) selectAndFocus(next);
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          if (hasChildren && !deps.collapsed().has(layer.id)) {
            deps.toggleCollapsed(layer);
            deps.rerender();
            focusRow(layer.id);
            return;
          }
          const parent = deps.doc().parentOf(layer);
          if (parent) selectAndFocus(parent);
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          if (!hasChildren) return;
          if (deps.collapsed().has(layer.id)) {
            deps.toggleCollapsed(layer);
            deps.rerender();
            focusRow(layer.id);
            return;
          }
          const first = layer.children?.[0];
          if (first) selectAndFocus(first);
        }
      });
      // a group's twisty: the only control whose whole job is the panel's
      // visibility, so it toggles the session's set instead of a local flag.
      // The row owns the keyboard in a tree, so the button is mouse-only.
      if (hasChildren) {
        const folded = deps.collapsed().has(layer.id);
        const chev = document.createElement("button");
        chev.type = "button";
        chev.className = "layer-chev";
        chev.innerHTML = iconSvg(folded ? "chevron-right" : "chevron-down", 12);
        chev.tabIndex = -1;
        chev.setAttribute("aria-hidden", "true");
        chev.title = folded ? "Expand group" : "Collapse group";
        chev.addEventListener("click", (e) => {
          e.stopPropagation(); // folding is not selecting
          deps.toggleCollapsed(layer);
          deps.rerender();
          // Rebuilt rows are new nodes; without this the next arrow key goes to
          // <body> instead of the row that was just folded/expanded.
          focusRow(layer.id);
        });
        row.appendChild(chev);
      } else {
        // keep names aligned whether or not a row has a twisty
        const gap = document.createElement("span");
        gap.className = "layer-chev-gap";
        row.appendChild(gap);
      }
      if (layer.groupId) {
        // the persisted colour tag: a tint, never a container. Tree grouping
        // is Layer.children and is drawn by the twisty above. The tint lives in
        // a pseudo-element, not inline background, so hover/selection still read.
        const tint = tagColour(layer.groupId);
        row.classList.add("tagged");
        row.style.setProperty("--tag", tint);
        row.style.setProperty("--tag-bg", `${tint}1f`);
        row.style.borderLeft = `3px solid ${tint}`;
      }
      // ui11: these three toggles were click-only spans — a focusable tree row
      // whose most-used controls a screen reader could not name or press. Real
      // buttons, -1 so the row keeps the tab order, pressed state announced.
      // (The same three states also live in the Layer menu, which is how a
      // keyboard user reaches them.)
      const vis = document.createElement("button");
      vis.type = "button";
      vis.tabIndex = -1;
      vis.className = "eye" + (layer.visible ? "" : " off");
      vis.innerHTML = iconSvg(layer.visible ? "eye" : "eye-off", 14);
      vis.title = layer.visible ? "Hide layer" : "Show layer";
      // A name that describes the next action and a pressed state that
      // describes the current one contradict each other: "Show layer, pressed"
      // on a hidden layer says the show action is active (uiux-r25 #5). The
      // tooltip keeps the action wording; the state lives in aria-pressed.
      vis.setAttribute("aria-label", `${layer.name} visibility`);
      vis.setAttribute("aria-pressed", layer.visible ? "true" : "false");
      vis.addEventListener("click", (e) => {
        e.stopPropagation();
        const before = layer.visible;
        layer.visible = !before;
        deps.undoable(
          `Visibility ${layer.name}`,
          (v) => { layer.visible = v as boolean; deps.repaint(); },
          before, layer.visible,
        );
        deps.repaint();
        deps.rerender();
        deps.refreshHistory();
        // The chip was replaced by the rebuild; without this the next arrow
        // key lands on <body> and nudges a layer nobody selected (uiux-r27 #1).
        focusRow(layer.id);
      });
      row.appendChild(vis);
      row.appendChild(layer.kind === "group" ? groupThumb(layer, deps.doc()) : layerThumb(layer));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = layer.name;
      name.title = `${layer.name} — double-click to rename`;
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation(); // keep the row click from stealing the rename
        if (layer.kind !== "pixel" && layer.kind !== "adjust" && layer.kind !== "fill" && layer.kind !== "group") return;
        const box = document.createElement("input");
        box.type = "text";
        box.className = "rename";
        box.value = layer.name;
        const commit = (): void => {
          const next = box.value.trim() || layer.name;
          if (next !== layer.name) {
            const before = layer.name;
            layer.name = next;
            deps.undoable(`Rename ${before} → ${next}`,
              (v) => { layer.name = v as string; },
              before, next);
            deps.refreshHistory();
          }
          deps.rerender();
          // The rerender replaces every row: without this the keyboard user
          // who pressed Enter ends up on <body> (uiux-r21).
          focusRow(layer.id);
        };
        box.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") { ev.preventDefault(); commit(); }
          if (ev.key === "Escape") {
            ev.preventDefault();
            deps.rerender();
            // Same reason as Enter: the row was replaced, so without this the
            // caret dies on <body> and the next Tab hides the chrome.
            focusRow(layer.id);
          }
        });
        box.addEventListener("blur", commit);
        name.replaceWith(box);
        box.focus();
        box.select();
      });
      row.appendChild(name);
      const lockBtn = document.createElement("button");
      lockBtn.type = "button";
      lockBtn.tabIndex = -1;
      lockBtn.className = "lockbtn" + (layer.locked ? " on" : "");
      lockBtn.innerHTML = iconSvg(layer.locked ? "lock" : "unlock", 12);
      lockBtn.title = layer.locked ? "Unlock layer" : "Lock layer (blocks painting and moving)";
      // "Unlock layer, pressed" contradicts itself: the name described the
      // action while the state described the current value (uiux-r26 F3).
      lockBtn.setAttribute("aria-label", `${layer.name} lock`);
      lockBtn.setAttribute("aria-pressed", layer.locked ? "true" : "false");
      lockBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const before = !layer.locked;
        layer.locked = before;
        deps.undoable(
          `${before ? "Lock" : "Unlock"} ${layer.name}`,
          (v) => { layer.locked = v as boolean; },
          !before, before,
        );
        deps.rerender();
        deps.refreshHistory();
        focusRow(layer.id);
      });
      row.appendChild(lockBtn);
      const tag = layer.groupId;
      const tagChip = document.createElement("button");
      tagChip.type = "button";
      tagChip.tabIndex = -1; // the row owns the tab stop (uiux-r28 #5)
      tagChip.className = "tagchip" + (tag ? " on" : "");
      tagChip.textContent = tag ? "●" : "+";
      tagChip.title = tag
        ? `Colour tag ${tag} — click to cycle, Shift-click to clear`
        : "Add a colour tag (tints the row; it does not group the layer)";
      tagChip.setAttribute("aria-label", tag
        ? `${layer.name} colour tag ${tag}`
        : `${layer.name} colour tag: none`);
      if (tag) tagChip.style.color = tagColour(tag);
      tagChip.addEventListener("click", (e) => {
        e.stopPropagation();
        const before = layer.groupId;
        const nextId = e.shiftKey ? undefined : nextTagId(before);
        layer.groupId = nextId;
        deps.undoable(
          nextId ? `Tag ${layer.name} ${nextId}` : `Clear colour tag on ${layer.name}`,
          (v) => { layer.groupId = v as string | undefined; },
          before, nextId,
        );
        deps.rerender();
        deps.refreshHistory();
        focusRow(layer.id);
      });
      row.appendChild(tagChip);
      if (layer.kind !== "pixel") {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = layer.kind === "group"
          ? `${LAYER_BADGE.group} ${layer.children?.length ?? 0}`
          : LAYER_BADGE[layer.kind];
        badge.title = layer.kind === "group"
          ? `Group — ${layer.children?.length ?? 0} layer${(layer.children?.length ?? 0) === 1 ? "" : "s"}`
          : layer.kind === "adjust" ? "Adjustment layer" : "Fill layer";
        row.appendChild(badge);
      }
      if (layer.mask) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.tabIndex = -1;
        chip.className = "maskchip" + (layer === activeLayer && deps.paintTarget() === "mask" ? " active" : "");
        chip.innerHTML = iconSvg("mask", 12);
        chip.title = "Layer mask — click to paint on it";
        chip.setAttribute("aria-label", `${layer.name} mask`);
        chip.setAttribute("aria-pressed", layer === activeLayer && deps.paintTarget() === "mask" ? "true" : "false");
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          deps.setActive(layer);
          deps.setPaintTarget("mask");
          deps.rerender();
          deps.refreshOptions();
          focusRow(layer.id);
        });
        row.appendChild(chip);
      }
      row.addEventListener("click", () => {
        deps.setActive(layer);
        if (deps.paintTarget() === "mask" && !layer.mask) deps.setPaintTarget("pixel");
        deps.rerender();
        deps.refreshOptions();
        // The clicked node is replaced by the rerender; keep keyboard focus on
        // the row it represents instead of dropping it to <body>.
        focusRow(layer.id);
      });
      row.addEventListener("contextmenu", (e) => {
        // Select the row first, then open the menu. Rerendering here detached
        // the row the menu recorded as its opener, so Escape and Tab returned
        // focus to <body> (uiux-r28 #2). Highlight in place instead.
        deps.setActive(layer);
        if (deps.paintTarget() === "mask" && !layer.mask) deps.setPaintTarget("pixel");
        for (const r of Array.from(body.querySelectorAll(".row")) as HTMLElement[]) {
          r.classList.remove("active");
          r.setAttribute("aria-selected", String(r === row));
          // The roving stop has to follow the selection, or Tab lands on a
          // row that is not the one the reader just announced as selected.
          r.tabIndex = r === row ? 0 : -1;
        }
        row.classList.add("active");
        deps.refreshOptions();
        deps.menu(e, layer);
      });

      // ---- drag to reparent: edges are siblings, a group's middle is inside -
      const zoneFor = (ev: DragEvent): DropZone =>
        dropZoneAt(ev.clientY, row.getBoundingClientRect(), layer.kind === "group", hasChildren);
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        dragLayer = layer;
        row.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(layer.id));
        }
      });
      row.addEventListener("dragover", (e) => {
        if (!dragLayer || dragLayer === layer) return;
        const zone = zoneFor(e);
        clearDropMarks();
        if (!deps.canDropLayer(dragLayer, layer, zone)) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
          // The cursor alone is invisible in a screenshot and to a low-vision
          // user; mark the row so the refusal has a visible, testable state.
          const first = !row.classList.contains("drop-illegal");
          row.classList.add("drop-illegal");
          dropRow = row;
          if (first) deps.onRefused?.();
          return;
        }
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        row.classList.add(`drop-${zone}`);
        dropRow = row;
      });
      row.addEventListener("drop", (e) => {
        if (!dragLayer || dragLayer === layer) return;
        const zone = zoneFor(e);
        if (!deps.canDropLayer(dragLayer, layer, zone)) {
          clearDropMarks();
          return;
        }
        e.preventDefault();
        const moving = dragLayer;
        clearDropMarks();
        deps.dropLayer(moving, layer, zone);
      });
      row.addEventListener("dragend", () => {
        dragLayer = null;
        row.classList.remove("dragging");
        clearDropMarks();
      });
      rowList.appendChild(row);
    }

    // ---- panel-bottom action strip -----------------------------------------
    // One row, seven buttons. It used to carry eleven, which wrapped into a
    // second row the moment the panel was narrower than ~360 px and put Merge
    // and Delete within 2 px of each other. The four that left (Free Transform,
    // clipping, Merge Down, Flatten) all live in the layer menu or the Layer
    // menu already, so nothing became unreachable — the strip keeps only what
    // is used while laying a document out.
    const strip = deps.strip;
    strip.innerHTML = "";
    strip.setAttribute("role", "toolbar");
    strip.setAttribute("aria-label", "Layer actions");
    const stripBtn = (ic: IconName, title: string, cb: () => void, act?: string): void => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn icon subtle";
      b.title = title;
      b.setAttribute("aria-label", title);
      // The label changes with state ("Add layer mask" becomes "Mask — click to
      // load it as a selection"), so the strip's identity must be stable
      // (uiux-r28 #1).
      b.dataset.act = act ?? title.replace(/[^a-z]+/gi, "-").toLowerCase();
      setIcon(b, ic, 15);
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        cb();
        const again = strip.querySelector(`[data-act="${act}"]`) as HTMLElement | null;
        // The mask button's title (and so any derived id) flips when a mask
        // appears; a miss must land on a button, never the strip div.
        ((again ?? strip.querySelector("button")) as HTMLElement | null)?.focus();
      });
      strip.appendChild(b);
    };
    const sep = (): void => {
      const d = document.createElement("span");
      d.className = "foot-sep";
      d.setAttribute("aria-hidden", "true");
      strip.appendChild(d);
    };
    stripBtn("plus", "New layer (Ctrl+Shift+N)", () => deps.addLayer(), "new-layer");
    stripBtn("copy", "Duplicate layer (Ctrl+J)", () => deps.duplicateLayer(), "duplicate-layer");
    sep();
    // The panel does not know the sibling list any more (rows are flattened),
    // so it asks for a direction; the owner resolves it against the active
    // layer's own parent. This is what makes raise/lower work for a group child.
    stripBtn("arrow-up", "Move layer up", () => deps.moveLayer(1), "raise-layer");
    stripBtn("arrow-down", "Move layer down", () => deps.moveLayer(-1), "lower-layer");
    sep();
    stripBtn("mask", activeLayer.mask ? "Mask — click to load it as a selection" : "Add layer mask",
      () => {
        // The title says "load it as a selection"; with a selection live it used
        // to rewrite the existing mask instead, silently flipping its polarity.
        // Adding from a selection lives in the Layer menu.
        if (activeLayer.mask) { deps.loadMask(); return; }
        deps.addMask();
      }, "layer-mask");
    stripBtn("sliders", "New adjustment layer", () => deps.addAdjust(), "new-adjustment");
    // Delete is pushed to the far edge: the other six edit the layer, this one
    // removes it, and a row of 26 px targets gives a mis-click no forgiveness.
    const push = document.createElement("span");
    push.className = "foot-push";
    push.setAttribute("aria-hidden", "true");
    strip.appendChild(push);
    stripBtn("trash", "Delete layer", () => deps.deleteLayer(), "delete-layer");
    body.scrollTop = keepScroll;
  }

  return { render };
}
