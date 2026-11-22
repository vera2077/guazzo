// The Brush Settings dialog: the left list is the section index, the right
// side is the selected section. A section's bsCheckbox turns its effect on
// without discarding its numbers — the same rule Photoshop uses, and the
// reason closing the dialog must not reset anything that is unticked.
//
// The preview strip runs the real `dabVariation` maths, so what it draws is
// what a stroke does: scatter spreads it, count multiplies it, transfer fades
// it. A preview that drew circles by hand would prove nothing.

import {
  cloneBrushSettings,
  dabVariation,
  type BrushControl,
  type BrushSettings,
  type GrainKind,
} from "../engine/brushsettings.ts";

export interface BrushDialogDeps {
  showModal: (title: string, body: HTMLElement, onOk: () => void | false) => void;
  foreground: () => readonly [number, number, number];
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
  const p = bsEl("p", "bs-bsNote");
  p.textContent = text;
  return p;
}

function bsRow(label: string, control: HTMLElement): HTMLElement {
  const wrap = bsEl("div", "bs-bsRow");
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
  const box = bsEl("div", "bs-bsSlider");
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
  const wrap = bsEl("label", "bs-bsCheck");
  const box = bsEl("input");
  box.type = "bsCheckbox";
  box.checked = value;
  box.addEventListener("change", () => onFlip(box.checked));
  const span = bsEl("span");
  span.textContent = label;
  wrap.append(box, span);
  return wrap;
}

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

export function openBrushSettingsDialog(
  deps: BrushDialogDeps,
  current: BrushSettings,
  onOk: (next: BrushSettings) => void,
): void {
  const draft = cloneBrushSettings(current);
  const body = bsEl("div", "bs-body");
  const grid = bsEl("div", "bs-grid");
  const list = bsEl("div", "bs-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Brush settings sections");
  const panel = bsEl("div", "bs-panel");
  panel.setAttribute("role", "group");
  const preview = bsEl("canvas", "bs-preview");
  preview.width = 640;
  preview.height = 72;
  const bodyBox = bsEl("div");
  bodyBox.className = "bs-body-col";
  bodyBox.append(grid, preview);

  let selected: SectionId = "tip";
  const items = new Map<SectionId, HTMLElement>();

  const drawPreview = (): void => {
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.fillStyle = "#141417";
    ctx.fillRect(0, 0, preview.width, preview.height);
    const fg = deps.foreground();
    const rnd = (() => {
      let a = 0x9e3779b9;
      return (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const radius = Math.max(2, (draft.tip.size / 2) * 0.55);
    for (let i = 0; i <= 90; i++) {
      const t = i / 90;
      const x = 26 + t * (preview.width - 52);
      const y = preview.height / 2 + Math.sin(t * Math.PI * 2.2) * 14;
      const dabs = dabVariation(draft, {
        x, y, radius, alpha: 0.85 * 255, color: [fg[0], fg[1], fg[2]],
        pressure: 0.85, tilt: 0.15,
      }, rnd);
      for (const d of dabs) {
        ctx.globalAlpha = Math.max(0, Math.min(1, d.alpha / 255));
        ctx.fillStyle = `rgb(${d.color[0]},${d.color[1]},${d.color[2]})`;
        ctx.beginPath();
        ctx.ellipse(d.x, d.y, d.radius, Math.max(0.5, d.radius * d.ratio), d.angle, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  const renderPanel = (): void => {
    panel.replaceChildren();
    const section = BS_SECTIONS.find((s) => s.id === selected) ?? BS_SECTIONS[0]!;
    const head = bsEl("h4", "bs-title");
    head.textContent = section.label;
    panel.append(head);
    const isOn = section.on ? section.on(draft) : true;
    if (section.on && !isOn) {
      panel.append(bsNote("This section is off. Tick its box in the list to apply it; its numbers are kept either way."));
    }
    panel.append(section.build(draft, () => { drawPreview(); syncList(); }));
    for (const [id, node] of items) {
      node.classList.toggle("sel", id === selected);
      node.setAttribute("aria-selected", String(id === selected));
    }
  };

  const syncList = (): void => {
    for (const section of BS_SECTIONS) {
      const node = items.get(section.id);
      if (!node) continue;
      const on = section.on ? section.on(draft) : true;
      node.classList.toggle("off", !on);
      const box = node.querySelector("input");
      if (box) box.checked = on;
    }
  };

  for (const section of BS_SECTIONS) {
    const item = bsEl("div", "bs-item");
    item.dataset.section = section.id;
    item.tabIndex = 0;
    const box = bsEl("input");
    box.type = "checkbox";
    if (section.on) {
      box.checked = section.on(draft);
      box.setAttribute("aria-label", `${section.label} on`);
      box.addEventListener("change", () => {
        section.toggle?.(draft, box.checked);
        syncList();
        if (selected === section.id) renderPanel();
        drawPreview();
      });
      box.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    } else {
      box.checked = true;
      box.disabled = true;
      box.style.visibility = "hidden";
    }
    const name = bsEl("span", "bs-name");
    name.textContent = section.label;
    item.append(box, name);
    const pick = (): void => { selected = section.id; renderPanel(); };
    item.addEventListener("click", pick);
    item.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        pick();
      }
    });
    items.set(section.id, item);
    list.append(item);
  }

  grid.append(list, panel);
  body.append(bodyBox);
  renderPanel();
  drawPreview();

  deps.showModal("Brush Settings", body, () => {
    onOk(cloneBrushSettings(draft));
  });
}
