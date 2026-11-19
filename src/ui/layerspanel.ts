/**
 * layerspanel.ts — the Layers panel (props block, rows, action strip).
 *
 * Extracted from main.ts (handoff-5 AF3): this was the last panel still built by
 * a 320-line function inside an 8300-line module, reaching into a dozen globals.
 * The panel now receives one deps object, so what it can touch is visible in its
 * signature instead of by grepping for `activeLayer`.
 *
 * The stack is deliberately FLAT: groups are a colour band (`groupId`), never a
 * nested container, and clipping is a one-bit flag on a layer.
 */
import { compileAdjust } from "../engine/adjustfn.ts";
import type { BlendMode } from "../engine/blend.ts";
import { LAYER_BLEND_MODES } from "../engine/blend.ts";
import type { Layer } from "../engine/document.ts";
import { gridBBox } from "../engine/transform.ts";
import { iconSvg, setIcon, type IconName } from "./icons.ts";

export const THUMB_W = 26;
export const THUMB_H = 20;

/** flat-group tints; a group is only a colour band, never a nested stack */
export const GROUP_COLOURS = ["#5b8cff", "#f2b33d", "#4ec98b", "#e0645c", "#a877f0", "#3dc3d4"];

export function groupColour(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GROUP_COLOURS[h % GROUP_COLOURS.length]!;
}

/** G1..G6 then none — fixed ids, so adjacent layers band together by construction */
export function nextGroupId(current?: string): string | undefined {
  if (!current) return "G1";
  const n = Number(current.slice(1));
  if (Number.isFinite(n) && n >= 1 && n < GROUP_COLOURS.length) return `G${n + 1}`;
  return undefined;
}

export type PaintTarget = "pixel" | "mask";

export interface LayersPanelDeps {
  /** scroll container holding the props block and the rows */
  body: HTMLElement;
  /** footer strip of action buttons */
  strip: HTMLElement;
  layers(): readonly Layer[];
  active(): Layer;
  setActive(layer: Layer): void;
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
  moveLayer(to: number): void;
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
      let sx = bb.x;
      let sy = bb.y;
      let sw = bb.w;
      let sh = bb.h;
      const cap = 1024 * 1024; // cap the sampled crop (huge backgrounds)
      if (sw * sh > cap) {
        const k = Math.sqrt((sw * sh) / cap);
        sw = Math.max(1, Math.round(sw / k));
        sh = Math.max(1, Math.round(sh / k));
        sx = Math.round(bb.x + (bb.w - sw) / 2);
        sy = Math.round(bb.y + (bb.h - sh) / 2);
      }
      const buf = new Uint8ClampedArray(sw * sh * 4);
      layer.grid.readRect(sx, sy, sw, sh, buf);
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
    c2.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    c2.fillRect(0, 0, THUMB_W, THUMB_H);
  }
  if (layer.mask) {
    // a chip in the corner, so a masked layer is readable at a glance
    c2.fillStyle = "rgba(255,255,255,.85)";
    c2.fillRect(0, 0 + THUMB_H - 3, 3, 3);
  }
  return cv;
}

export function buildLayersPanel(deps: LayersPanelDeps): LayersPanel {
  function render(): void {
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
        b.addEventListener("click", () => {
          deps.setPaintTarget(target);
          deps.rerender();
          deps.refreshOptions();
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
      tRow.append(tLab, mk("Pixels", "pixel"), mk("Mask", "mask"), applyBtn, delBtn);
      props.appendChild(tRow);
    }
    body.appendChild(props);

    // ---- layer rows (topmost first) ----------------------------------------
    const layers = deps.layers();
    for (const layer of [...layers].reverse()) {
      const row = document.createElement("div");
      const idx = layers.indexOf(layer);
      const above = layers[idx + 1];
      row.className = "row" + (layer === activeLayer ? " active" : "")
        + (layer.clipToBelow ? " clipped" : "")
        + (above && above.clipToBelow ? " clip-base" : "");
      row.title = layer.name + (layer.clipToBelow ? " (clipped to the layer below)" : "");
      row.dataset.layerId = String(layer.id);
      // keyboard reachable (handoff-3 S1): Enter/Space selects, ContextMenu key
      // fires the same right-click menu as the mouse
      row.tabIndex = 0;
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); }
      });
      if (layer.groupId) {
        const tint = groupColour(layer.groupId);
        row.style.borderLeft = `3px solid ${tint}`;
        row.style.background = `${tint}1f`;
      }
      const vis = document.createElement("span");
      vis.className = "eye" + (layer.visible ? "" : " off");
      vis.innerHTML = iconSvg(layer.visible ? "eye" : "eye-off", 14);
      vis.title = layer.visible ? "Hide layer" : "Show layer";
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
      });
      row.appendChild(vis);
      row.appendChild(layerThumb(layer));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = layer.name;
      name.title = "Double-click to rename";
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation(); // keep the row click from stealing the rename
        if (layer.kind !== "pixel" && layer.kind !== "adjust" && layer.kind !== "fill") return;
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
        };
        box.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") { ev.preventDefault(); commit(); }
          if (ev.key === "Escape") { ev.preventDefault(); deps.rerender(); }
        });
        box.addEventListener("blur", commit);
        name.replaceWith(box);
        box.focus();
        box.select();
      });
      row.appendChild(name);
      const lockBtn = document.createElement("span");
      lockBtn.className = "lockbtn" + (layer.locked ? " on" : "");
      lockBtn.innerHTML = iconSvg(layer.locked ? "lock" : "unlock", 12);
      lockBtn.title = layer.locked ? "Unlock layer" : "Lock layer (blocks painting and moving)";
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
      });
      row.appendChild(lockBtn);
      const gchip = document.createElement("span");
      gchip.className = "groupchip" + (layer.groupId ? " on" : "");
      gchip.textContent = layer.groupId ? layer.groupId : "+";
      gchip.title = layer.groupId
        ? `Group ${layer.groupId} — click to cycle, Shift-click to leave the group`
        : "Put this layer in a colour group (visual only — the stack stays flat)";
      if (layer.groupId) gchip.style.color = groupColour(layer.groupId);
      gchip.addEventListener("click", (e) => {
        e.stopPropagation();
        const before = layer.groupId;
        const nextId = e.shiftKey ? undefined : nextGroupId(before);
        layer.groupId = nextId;
        deps.undoable(
          nextId ? `Group ${layer.name} as ${nextId}` : `Leave group ${before ?? ""}`.trim(),
          (v) => { layer.groupId = v as string | undefined; },
          before, nextId,
        );
        deps.rerender();
        deps.refreshHistory();
      });
      row.appendChild(gchip);
      if (layer.kind !== "pixel") {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = layer.kind === "adjust" ? "adj" : "fill";
        badge.title = layer.kind === "adjust" ? "Adjustment layer" : "Fill layer";
        row.appendChild(badge);
      }
      if (layer.mask) {
        const chip = document.createElement("span");
        chip.className = "maskchip" + (layer === activeLayer && deps.paintTarget() === "mask" ? " active" : "");
        chip.innerHTML = iconSvg("mask", 12);
        chip.title = "Layer mask — click to paint on it";
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          deps.setActive(layer);
          deps.setPaintTarget("mask");
          deps.rerender();
          deps.refreshOptions();
        });
        row.appendChild(chip);
      }
      row.addEventListener("click", () => {
        deps.setActive(layer);
        if (deps.paintTarget() === "mask" && !layer.mask) deps.setPaintTarget("pixel");
        deps.rerender();
        deps.refreshOptions();
      });
      row.addEventListener("contextmenu", (e) => {
        // Photoshop's layers-panel right-click: select the row first, then menu
        deps.setActive(layer);
        if (deps.paintTarget() === "mask" && !layer.mask) deps.setPaintTarget("pixel");
        deps.rerender();
        deps.refreshOptions();
        deps.menu(e, layer);
      });
      body.appendChild(row);
    }

    // ---- panel-bottom action strip (Photoshop-style) ------------------------
    // render() runs on every edit, so the strip must be rebuilt, not appended to
    const strip = deps.strip;
    strip.innerHTML = "";
    const stripBtn = (ic: IconName, title: string, cb: () => void): void => {
      const b = document.createElement("button");
      b.className = "btn icon subtle";
      b.title = title;
      b.setAttribute("aria-label", title);
      setIcon(b, ic, 15);
      b.addEventListener("click", cb);
      strip.appendChild(b);
    };
    stripBtn("plus", "New layer (top)", () => deps.addLayer());
    stripBtn("arrow-up", "Move layer up", () => {
      const idx = layers.indexOf(activeLayer);
      const to = Math.min(layers.length - 1, idx + 1);
      if (to === idx) return;
      deps.moveLayer(to);
    });
    stripBtn("arrow-down", "Move layer down", () => {
      const idx = layers.indexOf(activeLayer);
      const to = Math.max(0, idx - 1);
      if (to === idx) return;
      deps.moveLayer(to);
    });
    stripBtn("copy", "Duplicate layer", () => deps.duplicateLayer());
    stripBtn("transform", "Free Transform (Ctrl+T)", () => {
      deps.cancelTransform(); // never carry a live transform onto new pixels
      deps.enterTransform();
    });
    stripBtn("mask", activeLayer.mask ? "Mask — apply, load or delete" : "Add layer mask",
      () => {
        if (!activeLayer.mask) { deps.addMask(); return; }
        // mask exists: add-selection-to-mask when a selection is live, else load it
        if (deps.hasSelection()) deps.addMask();
        else deps.loadMask();
      });
    stripBtn("sliders", "New adjustment layer", () => deps.addAdjust());
    stripBtn("target", activeLayer.clipToBelow ? "Clipped to layer below (click to unclip)" : "Clip to layer below",
      () => {
        const layer = activeLayer;
        const before = !!layer.clipToBelow;
        layer.clipToBelow = !before;
        deps.undoable(
          `${before ? "Unclip" : "Clip"} ${layer.name}`,
          (v) => { layer.clipToBelow = v as boolean; deps.repaint(); },
          before, layer.clipToBelow,
        );
        deps.repaint();
        deps.rerender();
        deps.refreshHistory();
      });
    stripBtn("merge", "Merge Down (Ctrl+E)", () => deps.mergeDown());
    stripBtn("flatten", "Flatten Image", () => deps.flatten());
    stripBtn("trash", "Delete layer", () => deps.deleteLayer());
    body.scrollTop = keepScroll;
  }

  return { render };
}
