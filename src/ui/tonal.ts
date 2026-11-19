/**
 * tonal.ts — the Tonal panel: Levels, Curves, Exposure, Vibrance, Colour
 * Balance, Black & White, Photo Filter, Channel Mixer, Gradient Map,
 * Desaturate, Auto Tone/Contrast/Colour, Equalize, plus the Histogram card.
 *
 * The engine (engine/tone.ts) stays DOM-free; this module owns the dialogs and
 * calls back into main via `run`, which wraps an op in one history entry.
 */
import {
  applyLevels, applyCurve, applyExposure, applyVibrance, applyColorBalance,
  applyBlackWhite, applyPhotoFilter, applyChannelMixer, applyGradientMap,
  applyDesaturate, autoTone, autoContrast, autoColor, applyEqualize,
  curveLut, levelsLut, histogram, type Rect4, type Lut,
  type ColorBalanceOptions, type BlackWhiteOptions, type ChannelMixerOptions,
  type PhotoFilterOptions, type MapStop, type CurvePoint,
} from "../engine/tone.ts";
import { iconSvg, type IconName } from "./icons.ts";
import type { TileGrid } from "../engine/tile.ts";
import type { PixelMask } from "../engine/mask.ts";

export interface TonalDeps {
  panels: HTMLElement;
  cardHead: (box: HTMLElement, icon: IconName, title: string) => HTMLElement;
  showModal: (title: string, body: HTMLElement, onOk: () => void) => void;
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
    const inB = sliderRow("Input black", 0, 254, 0, (v) => String(v));
    const inW = sliderRow("Input white", 1, 255, 255, (v) => String(v));
    const gamma = sliderRow("Gamma", 0.1, 9, 1, (v) => v.toFixed(2), 0.05);
    const outB = sliderRow("Output black", 0, 255, 0, (v) => String(v));
    const outW = sliderRow("Output white", 0, 255, 255, (v) => String(v));
    const preview = document.createElement("canvas");
    preview.width = 256;
    preview.height = 56;
    preview.className = "curve-preview";
    const draw = (): void => {
      const lut = levelsLut({
        inBlack: inB.value(), inWhite: Math.max(inB.value() + 1, inW.value()),
        gamma: gamma.value(), outBlack: outB.value(), outWhite: outW.value(),
      });
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
    for (const s of [inB, inW, gamma, outB, outW]) {
      s.input.addEventListener("input", draw);
      form.appendChild(s.row);
    }
    form.appendChild(preview);
    deps.showModal("Levels", form, () => {
      const o = {
        inBlack: inB.value(), inWhite: Math.max(inB.value() + 1, inW.value()),
        gamma: gamma.value(), outBlack: outB.value(), outWhite: outW.value(),
      };
      runOp(`Levels ${o.inBlack}–${o.inWhite} γ${o.gamma.toFixed(2)}`,
        (g, r, m) => applyLevels(g, r, o, m));
    });
    draw();
  };

  // ---- Curves -------------------------------------------------------------
  const curvesDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const chan = selectOf([["rgb", "RGB"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]], "rgb");
    form.appendChild(fieldRow("Channel", chan));
    const canvas = document.createElement("canvas");
    canvas.width = 260;
    canvas.height = 260;
    canvas.className = "curve-editor";
    form.appendChild(canvas);
    const hint = document.createElement("div");
    hint.className = "label";
    hint.textContent = "Click to add a point · drag to bend · double-click a point to remove · endpoints move vertically";
    form.appendChild(hint);

    type Chan = "rgb" | "r" | "g" | "b";
    let active: Chan = "rgb";
    const store: Record<Chan, CurvePoint[]> & { rgb: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] } = {
      rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      g: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      b: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    };
    const PAD = 6;
    const toCanvas = (p: CurvePoint): [number, number] => [
      PAD + (p.x / 255) * (canvas.width - PAD * 2),
      canvas.height - PAD - (p.y / 255) * (canvas.height - PAD * 2),
    ];
    const fromCanvas = (cx: number, cy: number): CurvePoint => ({
      x: Math.round(((cx - PAD) / (canvas.width - PAD * 2)) * 255),
      y: Math.round(((canvas.height - PAD - cy) / (canvas.height - PAD * 2)) * 255),
    });
    let drag = -1;

    const paint = (): void => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0e0f12";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,255,255,.08)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const gx = PAD + ((w - PAD * 2) * i) / 4;
        const gy = PAD + ((h - PAD * 2) * i) / 4;
        ctx.beginPath(); ctx.moveTo(gx, PAD); ctx.lineTo(gx, h - PAD); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(PAD, gy); ctx.lineTo(w - PAD, gy); ctx.stroke();
      }
      ctx.strokeStyle = "rgba(255,255,255,.18)";
      ctx.beginPath();
      ctx.moveTo(PAD, h - PAD); ctx.lineTo(w - PAD, PAD);
      ctx.stroke();
      const lut: Lut = active === "rgb"
        ? curveLut(store.rgb)
        : (() => {
            const base = new Uint8ClampedArray(256);
            for (let i = 0; i < 256; i++) base[i] = i;
            const own = curveLut(store[active]);
            for (let i = 0; i < 256; i++) base[i] = own[i]!;
            return base;
          })();
      const colour = active === "rgb" ? "#5b8cff" : active === "r" ? "#ff6b6b" : active === "g" ? "#4ade80" : "#60a5fa";
      ctx.beginPath();
      for (let x = 0; x < 256; x++) {
        const y = 255 - lut[x]!;
        const cx = PAD + (x / 255) * (w - PAD * 2);
        const cy = PAD + (y / 255) * (h - PAD * 2);
        if (x === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      }
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      for (const p of store[active]) {
        const [cx, cy] = toCanvas(p);
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#141519";
        ctx.fill();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    };

    const nearest = (cx: number, cy: number): number => {
      let best = -1, bestD = 12;
      store[active].forEach((p, i) => {
        const [px, py] = toCanvas(p);
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };

    canvas.addEventListener("pointerdown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      let idx = nearest(cx, cy);
      if (idx < 0) {
        const p = fromCanvas(cx, cy);
        store[active].push(p);
        store[active].sort((a, b) => a.x - b.x);
        idx = store[active].findIndex((q) => q.x === p.x && q.y === p.y);
      }
      drag = idx;
      canvas.setPointerCapture?.(e.pointerId);
      paint();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (drag < 0) return;
      const rect = canvas.getBoundingClientRect();
      const p = fromCanvas(e.clientX - rect.left, e.clientY - rect.top);
      const pts = store[active];
      const isFirst = drag === 0, isLast = drag === pts.length - 1;
      const q = pts[drag]!;
      q.y = Math.max(0, Math.min(255, p.y));
      // interior points may slide horizontally between their neighbours
      if (!isFirst && !isLast) {
        const lo = pts[drag - 1]!.x + 1;
        const hi = pts[drag + 1]!.x - 1;
        q.x = Math.max(lo, Math.min(hi, p.x));
      }
      paint();
    });
    const stopDrag = (): void => { drag = -1; };
    canvas.addEventListener("pointerup", stopDrag);
    canvas.addEventListener("pointercancel", stopDrag);
    canvas.addEventListener("dblclick", (e) => {
      const rect = canvas.getBoundingClientRect();
      const idx = nearest(e.clientX - rect.left, e.clientY - rect.top);
      if (idx > 0 && idx < store[active].length - 1) {
        store[active].splice(idx, 1);
        paint();
      }
    });
    chan.addEventListener("change", () => {
      active = chan.value as typeof active;
      paint();
    });
    const reset = document.createElement("button");
    reset.className = "btn subtle";
    reset.textContent = "Reset curve";
    reset.addEventListener("click", () => {
      store[active] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      paint();
    });
    form.appendChild(reset);

    deps.showModal("Curves", form, () => {
      const touched = (["rgb", "r", "g", "b"] as const).filter((k) => {
        const pts = store[k];
        return pts.length !== 2 ||
          pts[0]!.x !== 0 || pts[0]!.y !== 0 || pts[1]!.x !== 255 || pts[1]!.y !== 255;
      });
      if (touched.length === 0) return;
      runOp(`Curves (${touched.join(", ")})`, (g, r, m) => {
        for (const ch of touched) applyCurve(g, r, store[ch]!, ch, m);
      });
    });
    paint();
  };

  // ---- simple numeric dialogs --------------------------------------------
  const exposureDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const stops = sliderRow("Exposure (EV)", -40, 40, 0, (v) => `${(v / 10).toFixed(1)}`, 1);
    form.appendChild(stops.row);
    deps.showModal("Exposure", form, () => {
      const ev = stops.value() / 10;
      if (ev === 0) return;
      runOp(`Exposure ${ev > 0 ? "+" : ""}${ev.toFixed(1)} EV`, (g, r, m) => applyExposure(g, r, ev, m));
    });
  };

  const vibranceDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const amount = sliderRow("Vibrance", -100, 100, 25, (v) => String(v));
    form.appendChild(amount.row);
    deps.showModal("Vibrance", form, () => {
      const a = amount.value();
      if (a === 0) return;
      runOp(`Vibrance ${a}`, (g, r, m) => applyVibrance(g, r, a, m));
    });
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
    deps.showModal("Colour Balance", form, () => {
      const o: ColorBalanceOptions = {
        shadows: sh.get(), midtones: mid.get(), highlights: hi.get(),
        preserveLuminosity: preserve.checked,
      };
      runOp("Colour Balance", (g, r, m) => applyColorBalance(g, r, o, m));
    });
  };

  const blackWhiteDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const defs: [keyof BlackWhiteOptions, string, number][] = [
      ["red", "Reds", 40], ["yellow", "Yellows", 60], ["green", "Greens", 40],
      ["cyan", "Cyans", 60], ["blue", "Blues", 20], ["magenta", "Magentas", 80],
    ];
    const sliders = defs.map(([key, label, def]) => {
      const s = sliderRow(label, -200, 300, def, (v) => String(v));
      form.appendChild(s.row);
      return { key, s };
    });
    deps.showModal("Black & White", form, () => {
      const o = {} as BlackWhiteOptions;
      for (const { key, s } of sliders) o[key] = s.value();
      runOp("Black & White", (g, r, m) => applyBlackWhite(g, r, o, m));
    });
  };

  const photoFilterDialog = (): void => {
    const form = document.createElement("div");
    form.className = "stack";
    const colour = colorInput("#ec8a00");
    form.appendChild(fieldRow("Filter colour", colour));
    const density = sliderRow("Density", 1, 100, 25, (v) => `${v}%`);
    form.appendChild(density.row);
    const preserve = document.createElement("input");
    preserve.type = "checkbox";
    preserve.checked = true;
    form.appendChild(fieldRow("Preserve luminosity", preserve));
    deps.showModal("Photo Filter", form, () => {
      const c = parseHex(colour.value) ?? [236, 138, 0];
      const o: PhotoFilterOptions = { color: c, density: density.value(), preserveLuminosity: preserve.checked };
      runOp(`Photo Filter ${HEX(c)} ${o.density}%`, (g, r, m) => applyPhotoFilter(g, r, o, m));
    });
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
    deps.showModal("Channel Mixer", form, () => {
      const o: ChannelMixerOptions = {
        red: [red[0]!.value(), red[1]!.value(), red[2]!.value()],
        green: [green[0]!.value(), green[1]!.value(), green[2]!.value()],
        blue: [blue[0]!.value(), blue[1]!.value(), blue[2]!.value()],
        monochrome: mono.checked,
        constant: (constant.value() / 100) * 255,
      };
      runOp("Channel Mixer", (g, r, m) => applyChannelMixer(g, r, o, m));
    });
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
    deps.showModal("Gradient Map", form, () => {
      const stops: MapStop[] = [];
      stops.push({ pos: 0, color: parseHex(lo.value) ?? [0, 0, 0] });
      if (midOn.checked) stops.push({ pos: 0.5, color: parseHex(mid.value) ?? fg });
      stops.push({ pos: 1, color: parseHex(hi.value) ?? [255, 255, 255] });
      runOp(`Gradient Map ${stops.length} stops`, (g, r, m) => applyGradientMap(g, r, stops, m));
    });
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
    autoTone: { label: "Auto Tone", open: () => { } },
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
  deps.cardHead(histBox, "layers", "Histogram");
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
