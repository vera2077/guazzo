// The Brush Settings dialog: the left list is the section index, the right
// side is the selected section. A section's bsCheckbox turns its effect on
// without discarding its numbers — the same rule Photoshop uses, and the
// reason closing the dialog must not reset anything that is unticked.
//
// The preview strip runs the real `dabVariation` maths, so what it draws is
// what a stroke does: scatter spreads it, count multiplies it, transfer fades
// it. A preview that drew circles by hand would prove nothing.

import {
  DEFAULT_BRUSH_SETTINGS,
  brushRandom,
  cloneBrushSettings,
  dabVariation,
  type BrushControl,
  type DabBase,
  type BrushSettings,
  type GrainKind,
} from "../engine/brushsettings.ts";
import { TOOL_LABELS, type ToolId } from "./toollabels.ts";

export interface BrushPanelDeps {
  foreground: () => readonly [number, number, number];
}

export interface BrushPanelHandle {
  focus: () => void;
  close: () => void;
}

type SectionId =
  | "tip"
  | "shape"
  | "scattering"
  | "texture"
  | "dual"
  | "colour"
  | "transfer"
  | "pose"
  | "noise"
  | "wet"
  | "buildup"
  | "smoothing"
  | "protect";

interface Section {
  id: SectionId;
  label: string;
  /** undefined for the tip section: it is always on */
  on?: (s: BrushSettings) => boolean;
  toggle?: (s: BrushSettings, v: boolean) => void;
  build: (s: BrushSettings, touch: () => void) => HTMLElement;
}

const CONTROL_CHOICES: Array<[BrushControl, string]> = [
  ["off", "Off"],
  ["pressure", "Pressure"],
  ["tilt", "Pen Tilt"],
];

function bsEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function bsNote(text: string): HTMLElement {
  const p = bsEl("p", "bs-note");
  p.textContent = text;
  return p;
}

function bsRow(label: string, control: HTMLElement): HTMLElement {
  const wrap = bsEl("div", "bs-row");
  const lab = bsEl("span", "bs-label");
  lab.textContent = label;
  wrap.append(lab, control);
  return wrap;
}

function bsSlider(
  label: string,
  value: number,
  min: number,
  max: number,
  unit: string,
  onInput: (v: number) => void,
): HTMLElement {
  const range = bsEl("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.value = String(value);
  range.setAttribute("aria-label", label);
  const num = bsEl("input", "num");
  num.type = "number";
  num.min = String(min);
  num.max = String(max);
  num.value = String(Math.round(value));
  num.setAttribute("aria-label", `${label} value`);
  const set = (v: number): void => {
    const clamped = Math.max(min, Math.min(max, v));
    range.value = String(clamped);
    num.value = String(Math.round(clamped));
    onInput(clamped);
  };
  range.addEventListener("input", () => set(Number(range.value)));
  num.addEventListener("change", () => {
    const v = Number(num.value);
    if (Number.isFinite(v)) set(v);
  });
  num.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") num.blur();
  });
  const box = bsEl("div", "bs-slider");
  box.append(range, num);
  if (unit) {
    const u = bsEl("span", "bs-unit");
    u.textContent = unit;
    box.append(u);
  }
  return bsRow(label, box);
}

function bsSelectRow(
  label: string,
  value: BrushControl,
  onPick: (v: BrushControl) => void,
): HTMLElement {
  const sel = bsEl("select");
  sel.setAttribute("aria-label", label);
  for (const [v, text] of CONTROL_CHOICES) {
    const o = bsEl("option");
    o.value = v;
    o.textContent = text;
    sel.append(o);
  }
  sel.value = value;
  sel.addEventListener("change", () => onPick(sel.value as BrushControl));
  return bsRow(label, sel);
}

function bsCheck(label: string, value: boolean, onFlip: (v: boolean) => void): HTMLElement {
  const wrap = bsEl("label", "bs-check");
  const box = bsEl("input");
  box.type = "checkbox";
  box.checked = value;
  box.addEventListener("change", () => onFlip(box.checked));
  const span = bsEl("span");
  span.textContent = label;
  wrap.append(box, span);
  return wrap;
}

/**
 * Sections whose values the active tool does not read. The panel is shared by
 * Brush, Eraser, Pencil, Pattern Stamp and Mixer; offering Pattern Stamp a
 * Colour Dynamics section it ignores is the same defect class as the pencil's
 * dead Scatter slider (uiux-r6). Disabled, not hidden: the settings still exist
 * for other tools, and a hidden row would make the panel jump.
 */
const INERT_BY_TOOL: Partial<Record<ToolId, readonly SectionId[]>> = {
  pencil: ["shape", "scattering", "texture", "dual", "colour", "transfer", "pose", "noise", "wet", "protect"],
  patternstamp: ["shape", "scattering", "colour", "pose"],
  mixer: ["shape", "scattering", "colour", "pose"],
};

const BS_SECTIONS: Section[] = [
  {
    id: "tip",
    label: "Brush Tip Shape",
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Size, angle and roundness also apply without Shape Dynamics. Spacing is a fraction of the tip."),
        bsSlider("Size", s.tip.size, 1, 300, "px", (v) => { s.tip.size = v; touch(); }),
        bsSlider("Angle", s.tip.angle, -180, 180, "°", (v) => { s.tip.angle = v; touch(); }),
        bsSlider("Roundness", s.tip.roundness, 5, 100, "%", (v) => { s.tip.roundness = v; touch(); }),
        bsSlider("Hardness", s.tip.hardness, 0, 100, "%", (v) => { s.tip.hardness = v; touch(); }),
        bsSlider("Spacing", s.tip.spacing, 1, 200, "%", (v) => { s.tip.spacing = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "shape",
    label: "Shape Dynamics",
    on: (s) => s.shape.on,
    toggle: (s, v) => { s.shape.on = v; },
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Jitter is a percentage of the maximum change; the Control menu decides what drives it."),
        bsSlider("Size Jitter", s.shape.sizeJitter, 0, 100, "%", (v) => { s.shape.sizeJitter = v; touch(); }),
        bsSelectRow("Size Control", s.shape.sizeControl, (v) => { s.shape.sizeControl = v; touch(); }),
        bsSlider("Minimum", s.shape.minDiameter, 1, 100, "%", (v) => { s.shape.minDiameter = v; touch(); }),
        bsSlider("Angle Jitter", s.shape.angleJitter, 0, 100, "%", (v) => { s.shape.angleJitter = v; touch(); }),
        bsSelectRow("Angle Control", s.shape.angleControl, (v) => { s.shape.angleControl = v; touch(); }),
        bsSlider("Roundness", s.shape.roundnessJitter, 0, 100, "%", (v) => { s.shape.roundnessJitter = v; touch(); }),
        bsSelectRow("Roundness Control", s.shape.roundnessControl, (v) => { s.shape.roundnessControl = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "scattering",
    label: "Scattering",
    on: (s) => s.scattering.on,
    toggle: (s, v) => { s.scattering.on = v; },
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Scatter spreads dabs across the stroke. With Both Axes off it moves only sideways, which is what makes a stroke look sprayed rather than vibrating."),
        bsSlider("Scatter", s.scattering.scatter, 0, 100, "%", (v) => { s.scattering.scatter = v; touch(); }),
        bsCheck("Both Axes", s.scattering.bothAxes, (v) => { s.scattering.bothAxes = v; touch(); }),
        bsSlider("Count", s.scattering.count, 1, 20, "", (v) => { s.scattering.count = Math.round(v); touch(); }),
        bsSlider("Count Jitter", s.scattering.countJitter, 0, 100, "%", (v) => { s.scattering.countJitter = v; touch(); }),
        bsSelectRow("Control", s.scattering.control, (v) => { s.scattering.control = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "texture",
    label: "Texture",
    on: (s) => s.texture.on,
    toggle: (s, v) => { s.texture.on = v; },
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(bsNote("The grain multiplies the dab's coverage; Depth decides how much of it shows."));
      const grain = bsEl("select");
      grain.setAttribute("aria-label", "Grain");
      for (const [value, text] of [["fine", "Fine"], ["coarse", "Coarse"], ["chalk", "Chalk"]] as Array<[GrainKind, string]>) {
        const o = bsEl("option");
        o.value = value;
        o.textContent = text;
        grain.append(o);
      }
      grain.value = s.texture.grain;
      grain.addEventListener("change", () => { s.texture.grain = grain.value as GrainKind; touch(); });
      box.append(bsRow("Grain", grain));
      box.append(
        bsSlider("Scale", s.texture.scale, 10, 400, "%", (v) => { s.texture.scale = v; touch(); }),
        bsSlider("Depth", s.texture.depth, 1, 100, "%", (v) => { s.texture.depth = v; touch(); }),
        bsCheck("Invert", s.texture.invert, (v) => { s.texture.invert = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "dual",
    label: "Dual Brush",
    on: (s) => s.dual.on,
    toggle: (s, v) => { s.dual.on = v; },
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("The second tip multiplies coverage, so the stroke breaks up where it is dark. Pick the tip itself in the options bar."),
        bsSlider("Second tip size", s.dual.scale, 5, 100, "%", (v) => { s.dual.scale = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "colour",
    label: "Color Dynamics",
    on: (s) => s.colour.on,
    toggle: (s, v) => { s.colour.on = v; },
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Hue, Saturation and Brightness jitter move each dab; Purity pushes it toward a fully saturated colour."),
        bsSlider("Foreground/Background", s.colour.fgBg, 0, 100, "%", (v) => { s.colour.fgBg = v; touch(); }),
        bsSlider("Hue Jitter", s.colour.hue, 0, 100, "%", (v) => { s.colour.hue = v; touch(); }),
        bsSlider("Saturation Jitter", s.colour.saturation, 0, 100, "%", (v) => { s.colour.saturation = v; touch(); }),
        bsSlider("Brightness Jitter", s.colour.brightness, 0, 100, "%", (v) => { s.colour.brightness = v; touch(); }),
        bsSlider("Purity", s.colour.purity, 0, 100, "%", (v) => { s.colour.purity = v; touch(); }),
        bsCheck("Apply per tip", s.colour.perTip, (v) => { s.colour.perTip = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "transfer",
    label: "Transfer",
    on: (s) => s.transfer.on,
    toggle: (s, v) => { s.transfer.on = v; },
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Jitters the dab's opacity and flow. This is how a stroke gets the uneven density of a real brush."),
        bsSlider("Opacity Jitter", s.transfer.opacityJitter, 0, 100, "%", (v) => { s.transfer.opacityJitter = v; touch(); }),
        bsSelectRow("Opacity Control", s.transfer.opacityControl, (v) => { s.transfer.opacityControl = v; touch(); }),
        bsSlider("Flow Jitter", s.transfer.flowJitter, 0, 100, "%", (v) => { s.transfer.flowJitter = v; touch(); }),
        bsSelectRow("Flow Control", s.transfer.flowControl, (v) => { s.transfer.flowControl = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "pose",
    label: "Brush Pose",
    on: (s) => s.pose.on,
    toggle: (s, v) => { s.pose.on = v; },
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Overrides what the stylus reports, so a shape can be drawn with a mouse and reproduced exactly on a tablet."),
        bsSlider("Pressure", s.pose.pressure, 0, 100, "%", (v) => { s.pose.pressure = v; touch(); }),
        bsSlider("Tilt X", s.pose.tiltX, -60, 60, "°", (v) => { s.pose.tiltX = v; touch(); }),
        bsSlider("Tilt Y", s.pose.tiltY, -60, 60, "°", (v) => { s.pose.tiltY = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "noise",
    label: "Noise",
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Adds a fine, deterministic grain to every dab — the same stroke always produces the same noise."),
        bsSlider("Noise", s.noise, 0, 100, "%", (v) => { s.noise = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "wet",
    label: "Wet Edges",
    toggle: (s, v) => { s.wetEdges = v; },
    on: (s) => s.wetEdges,
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Pigment gathers at the rim of each dab, the way watercolour pools at the edge of a wash."),
        bsCheck("Wet Edges", s.wetEdges, (v) => { s.wetEdges = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "buildup",
    label: "Build-up",
    toggle: (s, v) => { s.buildUp = v; },
    on: (s) => s.buildUp,
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Overlapping dabs inside one stroke keep adding density instead of stopping at Opacity. Flow is the rate."),
        bsCheck("Build-up", s.buildUp, (v) => { s.buildUp = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "smoothing",
    label: "Smoothing",
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Pulls the stroke behind the cursor. High values are for long, deliberate lines."),
        bsSlider("Smoothing", s.smoothing, 0, 90, "%", (v) => { s.smoothing = v; touch(); }),
      );
      return box;
    },
  },
  {
    id: "protect",
    label: "Protect Texture",
    toggle: (s, v) => { s.protectTexture = v; },
    on: (s) => s.protectTexture,
    build: (s, touch) => {
      const box = bsEl("div");
      box.append(
        bsNote("Locks the grain so switching brushes does not move the paper under the paint."),
        bsCheck("Protect Texture", s.protectTexture, (v) => { s.protectTexture = v; touch(); }),
      );
      return box;
    },
  },
];


/** The panel's width and height are fixed: a section switch must not resize the
 *  window the user is painting under, and a fixed grid is what keeps the list
 *  and the controls from trading space every time the text changes length. */
const PANEL_W = 560;
const PANEL_H = 452;
const PANEL_POS_KEY = "guazzo.brush.panel.v1";

function loadPanelPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof p.x !== "number" || typeof p.y !== "number") return null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return { x: p.x, y: p.y };
  } catch {
    return null;
  }
}

function savePanelPosition(x: number, y: number): void {
  try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ x, y })); } catch { /* no storage, no position */ }
}

/**
 * A non-modal Brush Settings window. Every control writes into a draft and
 * reports it immediately, so the next dab on the canvas already uses it — there
 * is no OK, because there is nothing to confirm: the stroke is the preview.
 */
export function openBrushSettingsPanel(
  deps: BrushPanelDeps,
  current: BrushSettings,
  onChange: (next: BrushSettings) => void,
  onClose?: () => void,
  tool: ToolId = "brush",
): BrushPanelHandle {
  const inert = new Set<SectionId>(INERT_BY_TOOL[tool] ?? []);
  let draft = cloneBrushSettings(current);
  let selected: SectionId = "tip";
  const items = new Map<SectionId, HTMLButtonElement>();

  const win = bsEl("div", "float-win bs-win");
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-modal", "false");
  win.setAttribute("aria-label", "Brush Settings");
  win.style.width = `${PANEL_W}px`;
  win.style.height = `${PANEL_H}px`;

  const head = bsEl("div", "float-head");
  const title = bsEl("b", "bs-title");
  title.textContent = "Brush Settings";
  const sub = bsEl("span", "bs-sub");
  sub.textContent = `${TOOL_LABELS[tool]} · applies to the next stroke`;
  const reset = bsEl("button", "btn subtle bs-reset");
  reset.type = "button";
  reset.textContent = "Reset";
  reset.title = "Restore every section to its default";
  const close = bsEl("button", "btn subtle float-close");
  close.type = "button";
  close.textContent = "×";
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close Brush Settings");
  head.append(title, sub, reset, close);

  const body = bsEl("div", "bs-body");
  const grid = bsEl("div", "bs-grid");
  const listEl = bsEl("div", "bs-list");
  listEl.setAttribute("role", "tablist");
  listEl.setAttribute("aria-label", "Brush settings sections");
  const panelEl = bsEl("div", "bs-panel");
  panelEl.setAttribute("role", "group");
  grid.append(listEl, panelEl);

  const foot = bsEl("div", "bs-foot");
  const preview = bsEl("canvas", "bs-preview") as HTMLCanvasElement;
  preview.width = 512;
  preview.height = 76;
  const footNote = bsEl("span", "bs-foot-note");
  footNote.textContent = "Preview — the same dab maths a stroke uses";
  foot.append(preview, footNote);
  body.append(grid, foot);
  win.append(head, body);

  function drawPreview(): void {
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    const W = preview.width;
    const H = preview.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#14161a";
    ctx.fillRect(0, 0, W, H);
    const [fr, fg, fb] = deps.foreground();
    const base: DabBase = {
      x: 0, y: 0, radius: Math.max(3, Math.min(24, 6 + draft.tip.size * 0.3)),
      alpha: 255, color: [fr, fg, fb], pressure: 0.85, tilt: 0.2, direction: 0,
    };
    const rnd = brushRandom(20261122);
    const steps = 64;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const x = 18 + t * (W - 36);
      const y = H / 2 + Math.sin(t * Math.PI * 3) * (H / 2 - 22);
      const dabs = dabVariation(draft, { ...base, x, y }, rnd);
      for (const d of dabs) {
        const a = d.alpha / 255;
        if (a <= 0.002 || d.radius <= 0) continue;
        ctx.globalAlpha = a;
        ctx.fillStyle = `rgb(${d.color[0]},${d.color[1]},${d.color[2]})`;
        ctx.save();
        ctx.translate(d.x, d.y);
        if (d.angle !== 0) ctx.rotate(d.angle);
        if (d.ratio < 0.999) ctx.scale(1, d.ratio);
        ctx.beginPath();
        ctx.arc(0, 0, d.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  function syncList(): void {
    for (const [id, btn] of items) {
      const on = BS_SECTIONS.find((s) => s.id === id)?.on?.(draft) ?? true;
      btn.classList.toggle("on", on);
      btn.classList.toggle("current", id === selected);
      btn.setAttribute("aria-selected", String(id === selected));
      const box = btn.firstElementChild as HTMLElement | null;
      box?.setAttribute("aria-checked", String(on));
    }
  }

  function touch(): void {
    drawPreview();
    syncList();
    onChange(cloneBrushSettings(draft));
  }

  function renderPanel(): void {
    const section = BS_SECTIONS.find((s) => s.id === selected) ?? BS_SECTIONS[0]!;
    panelEl.setAttribute("aria-label", section.label);
    const headRow = bsEl("div", "bs-panel-head");
    const h = bsEl("b");
    h.textContent = section.label;
    headRow.append(h);
    const content = section.build(draft, touch);
    panelEl.replaceChildren(headRow, content);
    syncList();
  }

  function selectSection(id: SectionId): void {
    if (inert.has(id)) return;
    selected = id;
    renderPanel();
    drawPreview();
    items.get(id)?.focus();
  }

  for (const section of BS_SECTIONS) {
    const item = bsEl("button", "bs-item") as HTMLButtonElement;
    item.type = "button";
    item.setAttribute("role", "tab");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.tabIndex = -1;
    box.checked = section.on ? section.on(draft) : true;
    box.setAttribute("aria-label", section.label);
    box.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!section.on || !section.toggle) return;
      const now = !box.checked;
      box.checked = now;
      section.toggle(draft, now);
      touch();
      if (now && selected !== section.id) renderPanel();
    });
    const name = bsEl("span", "bs-name");
    name.textContent = section.label;
    item.append(box, name);
    item.addEventListener("click", () => selectSection(section.id));
    if (inert.has(section.id)) {
      item.classList.add("off");
      item.setAttribute("aria-disabled", "true");
      box.disabled = true;
    }
    listEl.append(item);
    items.set(section.id, item);
  }

  reset.addEventListener("click", () => {
    draft = cloneBrushSettings(DEFAULT_BRUSH_SETTINGS);
    renderPanel();
    drawPreview();
    onChange(cloneBrushSettings(draft));
  });

  const dismiss = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    win.remove();
    onClose?.();
  };
  close.addEventListener("click", dismiss);
  win.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      // The document-level chain would otherwise deselect the canvas or clear
      // the ruler in the same keystroke (uiux-r5).
      ev.stopPropagation();
      dismiss();
      return;
    }
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    // A slider or number field inside the panel owns its arrows: moving the
    // section under the user's fingers while they nudge a value is a bug (ui13).
    const t = ev.target as HTMLElement | null;
    const onList = t === listEl || (t !== null && [...items.values()].some((b) => b === t || b.contains(t)));
    if (!onList) return;
    // The list is a tablist: arrows move the visible selection, not the panel.
    const order = BS_SECTIONS.map((s) => s.id);
    const at = order.indexOf(selected);
    const next = ev.key === "ArrowDown" ? Math.min(order.length - 1, at + 1) : Math.max(0, at - 1);
    ev.preventDefault();
    selectSection(order[next]!);
  });

  // Drag the window by its header; buttons inside the header keep working.
  let drag: { dx: number; dy: number } | null = null;
  head.addEventListener("pointerdown", (ev) => {
    const target = ev.target as HTMLElement | null;
    const tag = target?.tagName ?? "";
    if (tag === "BUTTON" || tag === "INPUT") return;
    const rect = win.getBoundingClientRect();
    drag = { dx: (ev.clientX || 0) - rect.left, dy: (ev.clientY || 0) - rect.top };
    ev.preventDefault?.();
  });
  const onMove = (ev: PointerEvent): void => {
    if (!drag) return;
    const w = win.offsetWidth || PANEL_W;
    const h = win.offsetHeight || PANEL_H;
    const maxX = Math.max(4, window.innerWidth - w - 4);
    const maxY = Math.max(4, window.innerHeight - h - 4);
    const x = Math.max(4, Math.min(maxX, (ev.clientX || 0) - drag.dx));
    const y = Math.max(4, Math.min(maxY, (ev.clientY || 0) - drag.dy));
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
  };
  const onUp = (): void => {
    if (!drag) return;
    drag = null;
    savePanelPosition(parseFloat(win.style.left) || 0, parseFloat(win.style.top) || 0);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);

  const saved = loadPanelPosition();
  const w0 = window.innerWidth || 1280;
  const h0 = window.innerHeight || 800;
  const x0 = Math.max(4, Math.min(Math.max(4, w0 - PANEL_W - 4), saved ? saved.x : w0 - PANEL_W - 28));
  const y0 = Math.max(4, Math.min(Math.max(4, h0 - PANEL_H - 4), saved ? saved.y : 92));
  win.style.left = `${x0}px`;
  win.style.top = `${y0}px`;

  document.body.append(win);
  renderPanel();
  drawPreview();
  items.get(selected)?.focus();

  return {
    focus: () => { items.get(selected)?.focus(); },
    close: dismiss,
  };
}
