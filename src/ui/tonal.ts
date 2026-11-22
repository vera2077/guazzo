/**
 * tonal.ts — the Tonal panel: Levels, Curves, Exposure, Vibrance, Colour
 * Balance, Black & White, Photo Filter, Channel Mixer, Gradient Map,
 * Desaturate, Auto Tone/Contrast/Colour, Equalize, plus the Histogram card.
 *
 * The engine (engine/tone.ts) stays DOM-free; this module owns the dialogs and
 * calls back into main via `run`, which wraps an op in one history entry.
 */
import {
  buildBlackWhiteForm, buildExposureForm, buildFields, buildPhotoFilterForm,
  levelsFromFields, LEVELS_FIELDS,
} from "./adjust-forms.ts";
import { mountCurveEditor } from "./curveeditor.ts";
import {
  applyLevels, applyCurve, applyExposure, applyVibrance, applyColorBalance,
  applyBlackWhite, applyPhotoFilter, applyChannelMixer, applyGradientMap,
  applyDesaturate, autoTone, autoContrast, autoColor, applyEqualize,
  levelsLut, histogram, type Rect4,
  type MapStop,
} from "../engine/tone.ts";
import { iconSvg, type IconName } from "./icons.ts";
import type { ShowModal } from "./dialogs.ts";
import type { TileGrid } from "../engine/tile.ts";
import type { PixelMask } from "../engine/mask.ts";

export interface TonalDeps {
  panels: HTMLElement;
  cardHead: (box: HTMLElement, icon: IconName, title: string) => HTMLElement;
  showModal: ShowModal;
  /** clip rect for the current selection (whole layer when nothing is selected) */
  targetRect: () => Rect4 | null;
  targetMask: () => PixelMask | null;
  hasSelection: () => boolean;
  activeGrid: () => TileGrid | null;
  docSize: () => { w: number; h: number };
  /** wrap a pixel op in one undoable history entry */
  run: (label: string, fn: (grid: TileGrid, rect: Rect4, mask: PixelMask | null) => void) => void;
  foreground: () => [number, number, number];
  pulse: (el: HTMLElement) => void;
  /** show a non-committed result on the canvas (downsampled proxy in main.ts) */
  preview?: (fn: (g: TileGrid, r: Rect4, m: PixelMask | null) => void) => void;
  clearPreview?: () => void;
}

const HEX = (c: readonly [number, number, number]): string =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function parseHex(v: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

interface Slider { row: HTMLDivElement; input: HTMLInputElement; value: () => number; set: (v: number) => void }

function sliderRow(label: string, min: number, max: number, def: number,
  fmt: (v: number) => string, step = 1): Slider {
  const row = document.createElement("div");
  row.className = "field inline-row";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.style.minWidth = "86px";
  lab.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(def);
  input.style.flex = "1 1 auto";
  input.setAttribute("aria-label", label);
  const val = document.createElement("span");
  val.className = "value";
  val.style.minWidth = "52px";
  val.textContent = fmt(def);
  input.addEventListener("input", () => { val.textContent = fmt(Number(input.value)); });
  row.append(lab, input, val);
  return {
    row, input,
    value: () => Number(input.value),
    set: (v) => { input.value = String(v); val.textContent = fmt(v); },
  };
}

function fieldRow(label: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "field inline-row";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.style.minWidth = "86px";
  lab.textContent = label;
  row.append(lab, control);
  return row;
}

function selectOf(options: readonly (readonly [string, string])[], value: string): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
  return sel;
}

function colorInput(value: string): HTMLInputElement {
  const inp = document.createElement("input");
  inp.type = "color";
  inp.className = "color-well";
  inp.value = value;
  return inp;
}

export interface TonalPanel {
  refreshHistogram: () => void;
  /** open a dialog / run an immediate op by its panel key (used by the menus) */
  open: (key: string) => void;
}

export function buildTonalPanel(deps: TonalDeps): TonalPanel {
  const box = document.createElement("div");
  box.className = "card";
  deps.panels.appendChild(box);
  deps.cardHead(box, "sliders", "Tonal");

  const body = document.createElement("div");
  body.className = "card-body inline-wrap";
  box.appendChild(body);

  /** run a full-layer/selection op with a label suffix */
  const runOp = (label: string, fn: (grid: TileGrid, rect: Rect4, mask: PixelMask | null) => void): void => {
    deps.run(label + (deps.hasSelection() ? " (selection)" : ""), fn);
  };

  /**
   * Keep the canvas in step with the controls while the dialog is open. The op
   * closure is re-evaluated on every event, so it reads live slider values —
   * exactly what OK would run. Dialogs whose values are a no-op return null.
   */
  /** set by the Curves dialog: canvas edits have no input event to listen for */
  let curvePreview: (() => void) | null = null;

  const wirePreview = (form: HTMLElement, current: () => ((g: TileGrid, r: Rect4, m: PixelMask | null) => void) | null): void => {
    if (!deps.preview) return;
    const fire = (): void => {
      const fn = current();
      if (fn) deps.preview?.(fn);
    };
    for (const el of Array.from(form.querySelectorAll("input, select"))) {
      el.addEventListener("input", fire);
      el.addEventListener("change", fire);
    }
    fire();
  };

  // ---- immediate ops ------------------------------------------------------
  const IMMEDIATE: Record<string, { label: string; apply: (g: TileGrid, r: Rect4, m: PixelMask | null) => void }> = {
    autoTone: { label: "Auto Tone", apply: (g, r, m) => autoTone(g, r, 0.5, m) },
    autoContrast: { label: "Auto Contrast", apply: (g, r, m) => autoContrast(g, r, m) },
    autoColor: { label: "Auto Colour", apply: (g, r, m) => autoColor(g, r, m) },
    equalize: { label: "Equalize", apply: (g, r, m) => applyEqualize(g, r, m) },
    desaturate: { label: "Desaturate", apply: (g, r, m) => applyDesaturate(g, r, m) },
  };

  // ---- Levels -------------------------------------------------------------
  const levelsDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    // AF2: same field table as the palette — the two surfaces must not disagree.
    const lf = buildFields(form, LEVELS_FIELDS);
    const preview = document.createElement("canvas");
    preview.width = 256;
    preview.height = 56;
    preview.className = "curve-preview";
    const draw = (): void => {
      const lut = levelsLut(levelsFromFields(lf));
      const ctx = preview.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, 256, 56);
      ctx.fillStyle = "#0e0f12";
      ctx.fillRect(0, 0, 256, 56);
      ctx.beginPath();
      for (let x = 0; x < 256; x++) {
        const y = 55 - (lut[x]! / 255) * 55;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#5b8cff";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    };
    for (const c of Object.values(lf)) {
      c.input.addEventListener("input", draw);
    }
    form.appendChild(preview);
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      applyLevels(g, r, levelsFromFields(lf), m);
    };
    wirePreview(form, () => current);
    deps.showModal("Levels", form, () => {
      const o = levelsFromFields(lf);
      runOp(`Levels ${o.inBlack}–${o.inWhite} γ${o.gamma.toFixed(2)}`, current);
    }, { onClose: () => deps.clearPreview?.() });
    draw();
  };

  // ---- Curves -------------------------------------------------------------
  const curvesDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const editor = mountCurveEditor(form, { onChange: () => curvePreview?.() });
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      const values = editor.values();
      for (const ch of editor.touched()) applyCurve(g, r, values[ch], ch, m);
    };
    // the curve is edited with the pointer, so preview after every mutation
    curvePreview = () => { if (editor.touched().length > 0) deps.preview?.(current); };
    deps.showModal("Curves", form, () => {
      const touched = editor.touched();
      if (touched.length === 0) return;
      runOp(`Curves (${touched.join(", ")})`, current);
    }, { onClose: () => { curvePreview = null; deps.clearPreview?.(); } });
  };

  // ---- simple numeric dialogs --------------------------------------------
  const exposureDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    // AF2: EV scale shared with the palette (m10524) — no tenths, no /10.
    const f = buildExposureForm(form);
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      const ev = f.ev();
      if (ev === 0) return;
      applyExposure(g, r, ev, m);
    };
    wirePreview(form, () => current);
    deps.showModal("Exposure", form, () => {
      if (f.ev() === 0) return;
      runOp(f.label(), current);
    }, { onClose: () => deps.clearPreview?.() });
  };

  const vibranceDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const amount = sliderRow("Vibrance", -100, 100, 25, (v) => String(v));
    form.appendChild(amount.row);
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      const a = amount.value();
      if (a === 0) return;
      applyVibrance(g, r, a, m);
    };
    wirePreview(form, () => current);
    deps.showModal("Vibrance", form, () => {
      const a = amount.value();
      if (a === 0) return;
      runOp(`Vibrance ${a}`, current);
    }, { onClose: () => deps.clearPreview?.() });
  };

  const colorBalanceDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const mk = (name: string): { rows: Slider[]; get: () => { r: number; g: number; b: number } } => {
      const head = document.createElement("div");
      head.className = "label";
      head.textContent = name;
      form.appendChild(head);
      const cyan = sliderRow("Cyan / Red", -100, 100, 0, (v) => String(v));
      const magenta = sliderRow("Magenta / Green", -100, 100, 0, (v) => String(v));
      const yellow = sliderRow("Yellow / Blue", -100, 100, 0, (v) => String(v));
      form.append(cyan.row, magenta.row, yellow.row);
      return {
        rows: [cyan, magenta, yellow],
        get: () => ({ r: cyan.value(), g: magenta.value(), b: yellow.value() }),
      };
    };
    const sh = mk("Shadows");
    const mid = mk("Midtones");
    const hi = mk("Highlights");
    const preserve = document.createElement("input");
    preserve.type = "checkbox";
    preserve.checked = true;
    form.appendChild(fieldRow("Preserve luminosity", preserve));
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      applyColorBalance(g, r, {
        shadows: sh.get(), midtones: mid.get(), highlights: hi.get(),
        preserveLuminosity: preserve.checked,
      }, m);
    };
    wirePreview(form, () => current);
    deps.showModal("Colour Balance", form, () => runOp("Colour Balance", current),
      { onClose: () => deps.clearPreview?.() });
  };

  const blackWhiteDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    // AF2: same weights and −200…300 range as the palette (m10524).
    const f = buildBlackWhiteForm(form);
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      applyBlackWhite(g, r, f.values(), m);
    };
    wirePreview(form, () => current);
    deps.showModal("Black & White", form, () => runOp("Black & White", current),
      { onClose: () => deps.clearPreview?.() });
  };

  const photoFilterDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    // AF2: one builder, one default — Warming (85) at 25 % (m10524).
    const f = buildPhotoFilterForm(form);
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      const v = f.values();
      applyPhotoFilter(g, r, {
        color: v.color, density: v.density, preserveLuminosity: v.preserveLuminosity,
      }, m);
    };
    wirePreview(form, () => current);
    deps.showModal("Photo Filter", form, () => runOp(f.label(), current),
      { onClose: () => deps.clearPreview?.() });
  };

  const channelMixerDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const mkRow = (label: string, defs: [number, number, number]): Slider[] => {
      const head = document.createElement("div");
      head.className = "label";
      head.textContent = label;
      form.appendChild(head);
      const out = defs.map((d, i) => {
        const s = sliderRow(["Red %", "Green %", "Blue %"][i]!, -200, 200, d, (v) => String(v));
        form.appendChild(s.row);
        return s;
      });
      return out;
    };
    const red = mkRow("Red output", [100, 0, 0]);
    const green = mkRow("Green output", [0, 100, 0]);
    const blue = mkRow("Blue output", [0, 0, 100]);
    const mono = document.createElement("input");
    mono.type = "checkbox";
    form.appendChild(fieldRow("Monochrome", mono));
    const constant = sliderRow("Constant", -100, 100, 0, (v) => String(v));
    form.appendChild(constant.row);
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      applyChannelMixer(g, r, {
        red: [red[0]!.value(), red[1]!.value(), red[2]!.value()],
        green: [green[0]!.value(), green[1]!.value(), green[2]!.value()],
        blue: [blue[0]!.value(), blue[1]!.value(), blue[2]!.value()],
        monochrome: mono.checked,
        constant: (constant.value() / 100) * 255,
      }, m);
    };
    wirePreview(form, () => current);
    deps.showModal("Channel Mixer", form, () => runOp("Channel Mixer", current),
      { onClose: () => deps.clearPreview?.() });
  };

  const gradientMapDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const fg = deps.foreground();
    const lo = colorInput(HEX([0, 0, 0]));
    const midOn = document.createElement("input");
    midOn.type = "checkbox";
    const mid = colorInput(HEX(fg));
    const hi = colorInput(HEX([255, 255, 255]));
    form.append(
      fieldRow("Shadows", lo),
      fieldRow("Add midtone stop", midOn),
      fieldRow("Midtone", mid),
      fieldRow("Highlights", hi),
    );
    const readStops = (): MapStop[] => {
      const stops: MapStop[] = [];
      stops.push({ pos: 0, color: parseHex(lo.value) ?? [0, 0, 0] });
      if (midOn.checked) stops.push({ pos: 0.5, color: parseHex(mid.value) ?? fg });
      stops.push({ pos: 1, color: parseHex(hi.value) ?? [255, 255, 255] });
      return stops;
    };
    const current = (g: TileGrid, r: Rect4, m: PixelMask | null): void => {
      applyGradientMap(g, r, readStops(), m);
    };
    wirePreview(form, () => current);
    deps.showModal("Gradient Map", form, () => runOp(`Gradient Map ${readStops().length} stops`, current),
      { onClose: () => deps.clearPreview?.() });
  };

  // ---- panel UI -----------------------------------------------------------
  const DIALOGS: Record<string, { label: string; open: () => void }> = {
    levels: { label: "Levels…", open: levelsDialog },
    curves: { label: "Curves…", open: curvesDialog },
    exposure: { label: "Exposure…", open: exposureDialog },
    vibrance: { label: "Vibrance…", open: vibranceDialog },
    colorBalance: { label: "Colour Balance…", open: colorBalanceDialog },
    blackWhite: { label: "Black & White…", open: blackWhiteDialog },
    photoFilter: { label: "Photo Filter…", open: photoFilterDialog },
    channelMixer: { label: "Channel Mixer…", open: channelMixerDialog },
    gradientMap: { label: "Gradient Map…", open: gradientMapDialog },
  };

  const sel = selectOf([
    ...Object.entries(DIALOGS).map(([k, v]) => [k, v.label] as const),
    ...Object.entries(IMMEDIATE).map(([k, v]) => [k, v.label] as const),
  ], "levels");
  sel.style.flex = "1 1 100%";

  const go = document.createElement("button");
  go.className = "btn primary";
  go.textContent = "Apply";
  go.addEventListener("click", () => {
    const key = sel.value;
    const immediate = IMMEDIATE[key];
    if (immediate) {
      runOp(immediate.label, (g, r, m) => immediate.apply(g, r, m));
      refreshHistogram();
      return;
    }
    const d = DIALOGS[key];
    if (d) d.open();
  });
  body.append(sel, go);

  // ---- Histogram card -----------------------------------------------------
  const histBox = document.createElement("div");
  histBox.className = "card";
  deps.panels.appendChild(histBox);
  deps.cardHead(histBox, "chart", "Histogram");
  const histBody = document.createElement("div");
  histBody.className = "card-body tight";
  histBox.appendChild(histBody);
  const histCanvas = document.createElement("canvas");
  histCanvas.width = 256;
  histCanvas.height = 72;
  histCanvas.className = "histogram";
  histBody.appendChild(histCanvas);

  const chan = selectOf([["lum", "Luminosity"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]], "lum");
  const chanRow = document.createElement("div");
  chanRow.className = "inline-wrap";
  const refresh = document.createElement("button");
  refresh.className = "btn subtle";
  refresh.textContent = "Refresh";
  refresh.innerHTML = iconSvg("history", 13) + "<span>Refresh</span>";
  chanRow.append(chan, refresh);
  histBody.appendChild(chanRow);

  function refreshHistogram(): void {
    const grid = deps.activeGrid();
    const size = deps.docSize();
    if (!grid) return;
    const h = histogram(grid, { x: 0, y: 0, w: size.w, h: size.h });
    const counts = chan.value === "r" ? h.r : chan.value === "g" ? h.g : chan.value === "b" ? h.b : h.lum;
    let peak = 1;
    for (let i = 0; i < 256; i++) peak = Math.max(peak, counts[i] ?? 0);
    const ctx = histCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 256, 72);
    ctx.fillStyle = "#0e0f12";
    ctx.fillRect(0, 0, 256, 72);
    const colour = chan.value === "r" ? "#ff6b6b" : chan.value === "g" ? "#4ade80"
      : chan.value === "b" ? "#60a5fa" : "#c7cdd8";
    ctx.fillStyle = colour;
    for (let i = 0; i < 256; i++) {
      const v = (counts[i] ?? 0) / peak;
      const bar = Math.max(v > 0 ? 1 : 0, Math.round(v * 70));
      ctx.fillRect(i, 72 - bar, 1, bar);
    }
  }
  chan.addEventListener("change", refreshHistogram);
  refresh.addEventListener("click", refreshHistogram);
  refreshHistogram();

  const open = (key: string): void => {
    const immediate = IMMEDIATE[key];
    if (immediate) {
      runOp(immediate.label, (g, r, m) => immediate.apply(g, r, m));
      refreshHistogram();
      return;
    }
    DIALOGS[key]?.open();
  };

  return { refreshHistogram, open };
}
