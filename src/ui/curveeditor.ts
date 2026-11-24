/**
 * curveeditor.ts — the curve widget, extracted so two surfaces can share it.
 *
 * It was born inside tonal.ts's destructive Curves dialog. An adjustment layer
 * needs the same editor to *edit its recipe*, and the second copy of a piece of
 * interaction this fiddly (add/drag/delete points, keyboard nudges, per-channel
 * tabs) is exactly the drift AF2 was created to stop. So the widget lives here
 * and both callers mount it.
 *
 * The widget owns no document: it renders points and reports the channels the
 * user actually touched, so a caller can decide what a "touched" channel means
 * (apply a destructive op, or store a recipe).
 */

import { curveLut, type CurvePoint, type Lut } from "../engine/tone.ts";
import { CURVE_CHANNELS, type CurveChannel } from "./adjust-forms.ts";

/** The identity curve: the shape that changes nothing. */
const identity = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }];

export interface CurveEditorOptions {
  /** starting points per channel; missing channels start at identity */
  initial?: Partial<Record<CurveChannel, CurvePoint[]>>;
  /** called after every mutation (add, drag, delete, nudge, reset, tab switch) */
  onChange?: () => void;
  /** one-line hint under the canvas; pass "" to omit it */
  hint?: string;
}

export interface CurveEditor {
  /** channel select + canvas + hint + reset button, ready to append */
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  /** points for every channel, copied (callers may store or diff this) */
  values(): Record<CurveChannel, CurvePoint[]>;
  /** channels whose points are not the identity curve */
  touched(): CurveChannel[];
  /** put one channel (or every channel) back to the identity curve */
  reset(channel?: CurveChannel): void;
}

const copyPoints = (pts: readonly CurvePoint[]): CurvePoint[] => pts.map((p) => ({ ...p }));

export function mountCurveEditor(host: HTMLElement, opts: CurveEditorOptions = {}): CurveEditor {
  const wrap = document.createElement("div");
  wrap.className = "curve-editor-wrap";

  const chan = document.createElement("select");
  chan.className = "curve-channel";
  chan.setAttribute("aria-label", "Curve channel");
  for (const [value, label] of CURVE_CHANNELS) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    chan.appendChild(o);
  }
  chan.value = "rgb";
  wrap.appendChild(chan);

  const canvas = document.createElement("canvas");
  canvas.width = 260;
  canvas.height = 260;
  canvas.className = "curve-editor";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute(
    "aria-label",
    "Curve editor — click to add a point, drag to bend, arrows nudge the selected point",
  );
  wrap.appendChild(canvas);
  // The keys change a curve with no visible cursor; without an announcement a
  // screen-reader user cannot tell which point moved, or by how much.
  const said = document.createElement("div");
  said.className = "sr-only";
  said.setAttribute("role", "status");
  wrap.appendChild(said);

  if (opts.hint !== "") {
    const hint = document.createElement("div");
    hint.className = "label";
    hint.textContent = opts.hint
      ?? "Click to add a point · drag to bend · double-click a point to remove · endpoints move vertically";
    wrap.appendChild(hint);
  }

  const store: Record<CurveChannel, CurvePoint[]> = {
    rgb: copyPoints(opts.initial?.rgb ?? identity()),
    r: copyPoints(opts.initial?.r ?? identity()),
    g: copyPoints(opts.initial?.g ?? identity()),
    b: copyPoints(opts.initial?.b ?? identity()),
  };
  let active: CurveChannel = "rgb";
  const PAD = 6;
  let drag = -1;
  let selIdx = -1;

  const changed = (): void => { opts.onChange?.(); };
  const toCanvas = (p: CurvePoint): [number, number] => [
    PAD + (p.x / 255) * (canvas.width - PAD * 2),
    canvas.height - PAD - (p.y / 255) * (canvas.height - PAD * 2),
  ];
  const fromCanvas = (cx: number, cy: number): CurvePoint => ({
    x: Math.round(((cx - PAD) / (canvas.width - PAD * 2)) * 255),
    y: Math.round(((canvas.height - PAD - cy) / (canvas.height - PAD * 2)) * 255),
  });

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
    ctx.moveTo(PAD, h - PAD);
    ctx.lineTo(w - PAD, PAD);
    ctx.stroke();
    const lut: Lut = curveLut(store[active]);
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
    selIdx = idx;
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
    changed();
  });
  const stopDrag = (): void => { drag = -1; };
  canvas.addEventListener("keydown", (e: KeyboardEvent) => {
    // Keyboard equivalent of dragging: nudge the most recently touched point
    // (or the midpoint of the curve) by one level per arrow press.
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const list = store[active];
    if (selIdx < 0 || selIdx >= list.length) selIdx = list.length > 2 ? 1 : 0;
    const p = list[selIdx]!;
    const step = e.shiftKey ? 8 : 1;
    const endpoint = selIdx === 0 || selIdx === list.length - 1;
    if (e.key === "ArrowUp") p.y = Math.min(255, p.y + step);
    else if (e.key === "ArrowDown") p.y = Math.max(0, p.y - step);
    else if (endpoint) {
      // The pointer path keeps the endpoints at their edges; the keyboard used
      // to slide them off the ends, which no drag could reproduce.
      e.preventDefault();
      return;
    } else if (e.key === "ArrowLeft") p.x = Math.max(0, p.x - step);
    else p.x = Math.min(255, p.x + step);
    // An interior point may not pass its neighbours, the same rule the pointer
    // path enforces; sorting afterwards hid the collision but left two knots
    // on one x (a zero slope the user never asked for).
    if (!endpoint) {
      const lo = list[selIdx - 1]!.x + 1;
      const hi = list[selIdx + 1]!.x - 1;
      p.x = Math.max(lo, Math.min(hi, p.x));
    }
    list.sort((a, b) => a.x - b.x);
    selIdx = list.indexOf(p);
    paint();
    changed();
    said.textContent = `Point ${selIdx + 1} of ${list.length}: input ${Math.round(p.x)}, output ${Math.round(p.y)}`;
  });
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    const idx = nearest(e.clientX - rect.left, e.clientY - rect.top);
    if (idx > 0 && idx < store[active].length - 1) {
      store[active].splice(idx, 1);
      paint();
      changed();
    }
  });
  chan.addEventListener("change", () => {
    active = chan.value as CurveChannel;
    paint();
    changed();
  });

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn subtle";
  reset.textContent = "Reset curve";
  reset.addEventListener("click", () => {
    store[active] = identity();
    paint();
    changed();
  });
  wrap.appendChild(reset);

  paint();
  host.appendChild(wrap);

  const touched = (): CurveChannel[] =>
    CURVE_CHANNELS.map(([k]) => k).filter((k) => {
      const pts = store[k];
      return pts.length !== 2
        || pts[0]!.x !== 0 || pts[0]!.y !== 0
        || pts[1]!.x !== 255 || pts[1]!.y !== 255;
    });

  return {
    element: wrap,
    canvas,
    values: () => ({
      rgb: copyPoints(store.rgb),
      r: copyPoints(store.r),
      g: copyPoints(store.g),
      b: copyPoints(store.b),
    }),
    touched,
    reset: (channel?: CurveChannel) => {
      if (channel) store[channel] = identity();
      else for (const [k] of CURVE_CHANNELS) store[k] = identity();
      paint();
      changed();
    },
  };
}
