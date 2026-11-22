// The pressure-curve dialog: three small graphs, one per attribute.
//
// Each graph has three knots at pressure 0, 0.5 and 1. Drag a knot up or down;
// the line between knots is what the brush reads. Size starts at the diagonal
// because that is how it has always behaved; opacity and flow start flat at 1
// so nothing changes until the artist moves a knot.

import {
  DEFAULT_PRESSURE,
  isDefaultPressure,
  normalizePressureSettings,
  pressureAt,
  type PressureCurve,
  type PressureSettings,
} from "./pressure.ts";

export interface PressureDeps {
  showModal: (title: string, body: HTMLElement, onOk: () => void | false) => void;
}

type Attr = "size" | "opacity" | "flow";

const ROWS: Array<{ attr: Attr; label: string; hint: string }> = [
  { attr: "size", label: "Size", hint: "0 = a pen at rest still draws a small dab" },
  { attr: "opacity", label: "Opacity", hint: "flat at 100 % until you shape it" },
  { attr: "flow", label: "Flow", hint: "flat at 100 % until you shape it" },
];

const W = 200;
const H = 84;
const PAD = 8;

function copyCurve(c: PressureCurve): PressureCurve {
  return [c[0], c[1], c[2]];
}

function copySettings(s: PressureSettings): PressureSettings {
  return { size: copyCurve(s.size), opacity: copyCurve(s.opacity), flow: copyCurve(s.flow) };
}

function drawCurve(canvas: HTMLCanvasElement, curve: PressureCurve): void {
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return;
  ctx.clearRect?.(0, 0, W, H);
  // quarter lines, so the shape can be read without a tooltip
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = PAD + ((H - 2 * PAD) * i) / 4;
    ctx.beginPath?.();
    ctx.moveTo?.(PAD, y);
    ctx.lineTo?.(W - PAD, y);
    ctx.stroke?.();
  }
  ctx.strokeStyle = "#7aa2ff";
  ctx.lineWidth = 2;
  ctx.beginPath?.();
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    const x = PAD + t * (W - 2 * PAD);
    const y = H - PAD - pressureAt(curve, t) * (H - 2 * PAD);
    if (i === 0) ctx.moveTo?.(x, y);
    else ctx.lineTo?.(x, y);
  }
  ctx.stroke?.();
  ctx.fillStyle = "#e7e9ee";
  for (let k = 0; k < 3; k++) {
    const x = PAD + (k / 2) * (W - 2 * PAD);
    const y = H - PAD - curve[k]! * (H - 2 * PAD);
    ctx.beginPath?.();
    ctx.arc?.(x, y, 4, 0, Math.PI * 2);
    ctx.fill?.();
  }
}

export function openPressureDialog(
  deps: PressureDeps,
  current: PressureSettings,
  onOk: (next: PressureSettings) => void,
): void {
  const draft = copySettings(normalizePressureSettings(current));
  const body = document.createElement("div");
  body.className = "pressure-grid";

  const canvases: Partial<Record<Attr, HTMLCanvasElement>> = {};
  const values: Partial<Record<Attr, HTMLElement>> = {};

  const refresh = (attr: Attr): void => {
    const curve = draft[attr];
    const canvas = canvases[attr];
    if (canvas) drawCurve(canvas, curve);
    const label = values[attr];
    if (label) label.textContent = `${Math.round(curve[0] * 100)} · ${Math.round(curve[1] * 100)} · ${Math.round(curve[2] * 100)}`;
  };

  for (const row of ROWS) {
    const name = document.createElement("div");
    name.className = "pressure-name";
    name.textContent = row.label;
    body.appendChild(name);

    const right = document.createElement("div");
    right.className = "pressure-cell";
    const canvas = document.createElement("canvas");
    canvas.className = "pressure-canvas";
    canvas.width = W;
    canvas.height = H;
    canvas.tabIndex = 0;
    canvas.dataset.curve = row.attr;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${row.label} pressure curve — three knots at 0, 50 and 100 percent pressure`);
    canvases[row.attr] = canvas;

    const foot = document.createElement("div");
    foot.className = "pressure-foot";
    const hint = document.createElement("span");
    hint.className = "pressure-note";
    hint.textContent = row.hint;
    const read = document.createElement("span");
    read.className = "pressure-value";
    values[row.attr] = read;
    foot.append(hint, read);
    right.append(canvas, foot);
    body.appendChild(right);

    let dragging = -1;
    const valueFromEvent = (ev: PointerEvent | MouseEvent): number => {
      const y = (ev as MouseEvent).offsetY ?? H / 2;
      return Math.max(0, Math.min(1, (H - PAD - y) / (H - 2 * PAD)));
    };
    const knotFromEvent = (ev: PointerEvent | MouseEvent): number => {
      const x = (ev as MouseEvent).offsetX ?? W / 2;
      const at = (x - PAD) / (W - 2 * PAD);
      return at < 0.25 ? 0 : at < 0.75 ? 1 : 2;
    };
    const apply = (ev: PointerEvent | MouseEvent): void => {
      if (dragging < 0) return;
      draft[row.attr][dragging] = Math.round(valueFromEvent(ev) * 1000) / 1000;
      refresh(row.attr);
    };
    canvas.addEventListener("pointerdown", (ev) => {
      dragging = knotFromEvent(ev);
      apply(ev);
      ev.preventDefault?.();
    });
    canvas.addEventListener("pointermove", (ev) => apply(ev));
    canvas.addEventListener("pointerup", () => {
      dragging = -1;
    });
    canvas.addEventListener("pointerleave", () => {
      dragging = -1;
    });
    // The pointer can be released outside the graph; without this a knot would
    // keep following the cursor after the button came up.
    window.addEventListener("pointerup", () => {
      dragging = -1;
    });
  }

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn subtle pressure-reset";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", () => {
    draft.size = copyCurve(DEFAULT_PRESSURE.size);
    draft.opacity = copyCurve(DEFAULT_PRESSURE.opacity);
    draft.flow = copyCurve(DEFAULT_PRESSURE.flow);
    refresh("size");
    refresh("opacity");
    refresh("flow");
  });
  const footer = document.createElement("div");
  footer.className = "pressure-reset-row";
  footer.appendChild(reset);
  body.appendChild(footer);

  refresh("size");
  refresh("opacity");
  refresh("flow");

  deps.showModal("Pressure curves", body, () => {
    const next = copySettings(draft);
    if (!isDefaultPressure(next)) onOk(next);
    else onOk(DEFAULT_PRESSURE);
  });
}
