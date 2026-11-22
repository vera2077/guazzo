/**
 * brushsettings.ts — the Brush Settings model and the per-dab variation maths.
 *
 * Photoshop's Brush Settings panel is a list of sections, each with a checkbox
 * that turns its effect on without losing its numbers. This module owns that
 * state, its normalisation from untrusted storage, a seeded generator so a
 * stroke can be reproduced, and the function that turns one cursor position
 * into the dabs actually stamped.
 *
 * Nothing here touches a canvas: `dabVariation` is pure, which is what makes
 * "Scatter 100 % with Both Axes off moves only x" a test instead of a photo.
 */

export type BrushControl = "off" | "pressure" | "tilt";
export type GrainKind = "fine" | "coarse" | "chalk";

export interface BrushSettings {
  /** size/hardness/spacing live in the options bar too; the dialog mirrors them */
  tip: { size: number; hardness: number; spacing: number; angle: number; roundness: number };
  shape: {
    on: boolean;
    sizeJitter: number;
    sizeControl: BrushControl;
    angleJitter: number;
    angleControl: BrushControl;
    roundnessJitter: number;
    roundnessControl: BrushControl;
    /** floor for a jittered size, as a percentage of the brush diameter */
    minDiameter: number;
  };
  scattering: {
    on: boolean;
    scatter: number;
    bothAxes: boolean;
    count: number;
    countJitter: number;
    control: BrushControl;
  };
  texture: { on: boolean; grain: GrainKind; scale: number; depth: number; invert: boolean };
  dual: { on: boolean; scale: number };
  colour: {
    on: boolean;
    perTip: boolean;
    fgBg: number;
    hue: number;
    saturation: number;
    brightness: number;
    purity: number;
  };
  transfer: {
    on: boolean;
    opacityJitter: number;
    opacityControl: BrushControl;
    flowJitter: number;
    flowControl: BrushControl;
  };
  pose: { on: boolean; pressure: number; tiltX: number; tiltY: number };
  noise: number;
  wetEdges: boolean;
  buildUp: boolean;
  smoothing: number;
  protectTexture: boolean;
}

export const GRAIN_KINDS: GrainKind[] = ["fine", "coarse", "chalk"];

export const DEFAULT_BRUSH_SETTINGS: BrushSettings = {
  tip: { size: 24, hardness: 80, spacing: 25, angle: 0, roundness: 100 },
  shape: {
    on: false,
    sizeJitter: 0,
    sizeControl: "off",
    angleJitter: 0,
    angleControl: "off",
    roundnessJitter: 0,
    roundnessControl: "off",
    minDiameter: 1,
  },
  scattering: { on: false, scatter: 0, bothAxes: false, count: 1, countJitter: 0, control: "off" },
  texture: { on: false, grain: "fine", scale: 100, depth: 50, invert: false },
  dual: { on: false, scale: 100 },
  colour: { on: false, perTip: false, fgBg: 0, hue: 0, saturation: 0, brightness: 0, purity: 0 },
  transfer: {
    on: false,
    opacityJitter: 0,
    opacityControl: "off",
    flowJitter: 0,
    flowControl: "off",
  },
  pose: { on: false, pressure: 100, tiltX: 0, tiltY: 0 },
  noise: 0,
  wetEdges: false,
  buildUp: false,
  smoothing: 10,
  protectTexture: false,
};

const CONTROLS: BrushControl[] = ["off", "pressure", "tilt"];

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  return fallback;
}

function control(v: unknown, fallback: BrushControl): BrushControl {
  return CONTROLS.includes(v as BrushControl) ? (v as BrushControl) : fallback;
}

function grain(v: unknown, fallback: GrainKind): GrainKind {
  return GRAIN_KINDS.includes(v as GrainKind) ? (v as GrainKind) : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Accept anything (old storage, a hand-edited file) and return a valid recipe. */
export function normalizeBrushSettings(raw: unknown): BrushSettings {
  const r = obj(raw);
  const d = DEFAULT_BRUSH_SETTINGS;
  const tip = obj(r.tip);
  const shape = obj(r.shape);
  const scat = obj(r.scattering);
  const tex = obj(r.texture);
  const dual = obj(r.dual);
  const col = obj(r.colour);
  const tr = obj(r.transfer);
  const pose = obj(r.pose);
  return {
    tip: {
      size: clampNum(tip.size, d.tip.size, 1, 300),
      hardness: clampNum(tip.hardness, d.tip.hardness, 0, 100),
      spacing: clampNum(tip.spacing, d.tip.spacing, 1, 200),
      angle: clampNum(tip.angle, d.tip.angle, -180, 180),
      roundness: clampNum(tip.roundness, d.tip.roundness, 5, 100),
    },
    shape: {
      on: bool(shape.on, d.shape.on),
      sizeJitter: clampNum(shape.sizeJitter, d.shape.sizeJitter, 0, 100),
      sizeControl: control(shape.sizeControl, d.shape.sizeControl),
      angleJitter: clampNum(shape.angleJitter, d.shape.angleJitter, 0, 100),
      angleControl: control(shape.angleControl, d.shape.angleControl),
      roundnessJitter: clampNum(shape.roundnessJitter, d.shape.roundnessJitter, 0, 100),
      roundnessControl: control(shape.roundnessControl, d.shape.roundnessControl),
      minDiameter: clampNum(shape.minDiameter, d.shape.minDiameter, 1, 100),
    },
    scattering: {
      on: bool(scat.on, d.scattering.on),
      scatter: clampNum(scat.scatter, d.scattering.scatter, 0, 100),
      bothAxes: bool(scat.bothAxes, d.scattering.bothAxes),
      count: Math.round(clampNum(scat.count, d.scattering.count, 1, 20)),
      countJitter: clampNum(scat.countJitter, d.scattering.countJitter, 0, 100),
      control: control(scat.control, d.scattering.control),
    },
    texture: {
      on: bool(tex.on, d.texture.on),
      grain: grain(tex.grain, d.texture.grain),
      scale: clampNum(tex.scale, d.texture.scale, 10, 400),
      depth: clampNum(tex.depth, d.texture.depth, 1, 100),
      invert: bool(tex.invert, d.texture.invert),
    },
    dual: {
      on: bool(dual.on, d.dual.on),
      scale: clampNum(dual.scale, d.dual.scale, 5, 100),
    },
    colour: {
      on: bool(col.on, d.colour.on),
      perTip: bool(col.perTip, d.colour.perTip),
      fgBg: clampNum(col.fgBg, d.colour.fgBg, 0, 100),
      hue: clampNum(col.hue, d.colour.hue, 0, 100),
      saturation: clampNum(col.saturation, d.colour.saturation, 0, 100),
      brightness: clampNum(col.brightness, d.colour.brightness, 0, 100),
      purity: clampNum(col.purity, d.colour.purity, 0, 100),
    },
    transfer: {
      on: bool(tr.on, d.transfer.on),
      opacityJitter: clampNum(tr.opacityJitter, d.transfer.opacityJitter, 0, 100),
      opacityControl: control(tr.opacityControl, d.transfer.opacityControl),
      flowJitter: clampNum(tr.flowJitter, d.transfer.flowJitter, 0, 100),
      flowControl: control(tr.flowControl, d.transfer.flowControl),
    },
    pose: {
      on: bool(pose.on, d.pose.on),
      pressure: clampNum(pose.pressure, d.pose.pressure, 0, 100),
      tiltX: clampNum(pose.tiltX, d.pose.tiltX, -60, 60),
      tiltY: clampNum(pose.tiltY, d.pose.tiltY, -60, 60),
    },
    noise: clampNum(r.noise, d.noise, 0, 100),
    wetEdges: bool(r.wetEdges, d.wetEdges),
    buildUp: bool(r.buildUp, d.buildUp),
    smoothing: clampNum(r.smoothing, d.smoothing, 0, 90),
    protectTexture: bool(r.protectTexture, d.protectTexture),
  };
}

export function cloneBrushSettings(s: BrushSettings): BrushSettings {
  return normalizeBrushSettings(s);
}

/** mulberry32: small, seeded, and identical across runs — a stroke is a test. */
export function brushRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hslOf(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 1) + 1) % 1;
  if (s <= 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(channel(hue + 1 / 3) * 255),
    Math.round(channel(hue) * 255),
    Math.round(channel(hue - 1 / 3) * 255),
  ];
}

/** one dab after the dynamics have been applied */
export interface DabVariant {
  x: number;
  y: number;
  radius: number;
  /** vertical/horizontal aspect for a tilted or squashed tip (0.05..1) */
  ratio: number;
  /** radians */
  angle: number;
  alpha: number;
  color: [number, number, number];
}

export interface DabBase {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  color: readonly [number, number, number];
  pressure: number;
  /** 0..1, how far the pen is tilted from vertical (0 = upright) */
  tilt: number;
  /** stroke direction in radians; used when a control asks for it */
  direction?: number;
}

function controlValue(c: BrushControl, base: DabBase): number {
  switch (c) {
    case "pressure":
      return Math.max(0, Math.min(1, base.pressure));
    case "tilt":
      return Math.max(0, Math.min(1, base.tilt));
    default:
      return 1;
  }
}

/**
 * Turn one cursor position into the dabs to stamp. Deterministic for a given
 * `rnd` sequence, so a caller can replay a stroke.
 */
export function dabVariation(
  s: BrushSettings,
  base: DabBase,
  rnd: () => number,
): DabVariant[] {
  const pressure = s.pose.on ? s.pose.pressure / 100 : base.pressure;
  const tilt = s.pose.on ? Math.min(1, Math.hypot(s.pose.tiltX, s.pose.tiltY) / 60) : base.tilt;
  const b: DabBase = { ...base, pressure, tilt };

  const count = s.scattering.on
    ? Math.max(1, Math.round(s.scattering.count * (1 - (s.scattering.countJitter / 100) * rnd())))
    : 1;
  const countClamped = Math.min(20, count);

  const scatScale = s.scattering.on ? controlValue(s.scattering.control, b) : 0;
  const radiusBase = Math.max(0.5, b.radius);
  const spread = (s.scattering.scatter / 100) * radiusBase * 2 * scatScale;

  const out: DabVariant[] = [];
  for (let i = 0; i < countClamped; i++) {
    let radius = radiusBase;
    if (s.shape.on) {
      const sizeAmt = (s.shape.sizeJitter / 100) * controlValue(s.shape.sizeControl, b);
      radius = Math.max((radiusBase * s.shape.minDiameter) / 50, radiusBase * (1 - sizeAmt * rnd()));
    }

    let angle = (s.tip.angle * Math.PI) / 180;
    let ratio = s.tip.roundness / 100;
    if (s.shape.on) {
      const angAmt = (s.shape.angleJitter / 100) * controlValue(s.shape.angleControl, b);
      angle += (rnd() * 2 - 1) * angAmt * Math.PI;
      const roundAmt = (s.shape.roundnessJitter / 100) * controlValue(s.shape.roundnessControl, b);
      ratio *= Math.max(0.05, 1 - roundAmt * rnd());
    }
    ratio = Math.max(0.05, Math.min(1, ratio));

    let dx = 0, dy = 0;
    if (spread > 0) {
      dx = (rnd() * 2 - 1) * spread;
      if (s.scattering.bothAxes) dy = (rnd() * 2 - 1) * spread;
    }

    let alpha = b.alpha;
    if (s.transfer.on) {
      const opAmt = (s.transfer.opacityJitter / 100) * controlValue(s.transfer.opacityControl, b);
      const flAmt = (s.transfer.flowJitter / 100) * controlValue(s.transfer.flowControl, b);
      alpha *= Math.max(0, 1 - Math.max(opAmt, flAmt) * rnd());
    }

    let color: [number, number, number] = [b.color[0], b.color[1], b.color[2]];
    if (s.colour.on) {
      color = jitterColour(s.colour, color, rnd);
    }

    out.push({ x: b.x + dx, y: b.y + dy, radius, ratio, angle, alpha, color });
  }
  return out;
}

function jitterColour(
  c: BrushSettings["colour"],
  base: [number, number, number],
  rnd: () => number,
): [number, number, number] {
  let [r, g, b] = base;
  if (c.fgBg > 0) {
    const t = (c.fgBg / 100) * rnd();
    // mix toward a paper-ish light tone; the caller's background is not
    // passed in, and inventing a second colour would be a second control
    r = r + (245 - r) * t;
    g = g + (245 - g) * t;
    b = b + (240 - b) * t;
  }
  if (c.hue === 0 && c.saturation === 0 && c.brightness === 0 && c.purity === 0) {
    return [Math.round(r), Math.round(g), Math.round(b)];
  }
  let [h, sat, lum] = hslOf(r, g, b);
  if (c.hue > 0) h += ((rnd() * 2 - 1) * (c.hue / 100)) / 2;
  if (c.saturation > 0) sat += (rnd() * 2 - 1) * (c.saturation / 100);
  if (c.brightness > 0) lum += (rnd() * 2 - 1) * (c.brightness / 100) * 0.5;
  if (c.purity > 0) sat += ((1 - sat) * c.purity) / 100;
  sat = Math.max(0, Math.min(1, sat));
  lum = Math.max(0, Math.min(1, lum));
  const rgb = hslRgb(h, sat, lum);
  return [rgb[0], rgb[1], rgb[2]];
}

const GRAIN_SIZE = 64;
const grainCache = new Map<GrainKind, Uint8Array>();

function valueNoise(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size * size);
  const rnd = brushRandom(seed);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(rnd() * 255);
  return out;
}

/** a tileable grain texture; deterministic per kind so preview and stroke agree */
export function grainTexture(kind: GrainKind): Uint8Array {
  const hit = grainCache.get(kind);
  if (hit) return hit;
  let data: Uint8Array;
  if (kind === "coarse") {
    const cells = 8;
    const small = valueNoise(cells, 0x51a7);
    data = new Uint8Array(GRAIN_SIZE * GRAIN_SIZE);
    for (let y = 0; y < GRAIN_SIZE; y++) {
      for (let x = 0; x < GRAIN_SIZE; x++) {
        const v = small[((y * cells) / GRAIN_SIZE | 0) * cells + ((x * cells) / GRAIN_SIZE | 0)]!;
        data[y * GRAIN_SIZE + x] = v;
      }
    }
  } else if (kind === "chalk") {
    const fine = valueNoise(GRAIN_SIZE, 0x9e3d);
    data = new Uint8Array(GRAIN_SIZE * GRAIN_SIZE);
    for (let i = 0; i < data.length; i++) {
      const v = fine[i]!;
      data[i] = v < 110 ? 0 : v > 190 ? 255 : v;
    }
  } else {
    data = valueNoise(GRAIN_SIZE, 0x2f19);
  }
  grainCache.set(kind, data);
  return data;
}

/** sample the grain at a doc pixel; returns a 0..1 alpha multiplier */
export function grainAt(
  data: Uint8Array,
  x: number,
  y: number,
  scale: number,
  depth: number,
  invert: boolean,
): number {
  const s = Math.max(0.1, scale / 100);
  const gx = ((x / s) | 0) & (GRAIN_SIZE - 1);
  const gy = ((y / s) | 0) & (GRAIN_SIZE - 1);
  let v = data[gy * GRAIN_SIZE + gx]! / 255;
  if (invert) v = 1 - v;
  return 1 - (depth / 100) * (1 - v);
}
