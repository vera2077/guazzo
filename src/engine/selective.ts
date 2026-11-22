/**
 * selective.ts — Photoshop's Selective Colour, as a per-pixel recipe.
 *
 * Nine ranges: six by hue (reds, yellows, greens, cyans, blues, magentas)
 * and three by tone (whites, neutrals, blacks). Each range holds four
 * offsets — cyan, magenta, yellow, black — in percent, and each pixel is
 * moved by every range it belongs to, weighted by how much it belongs.
 *
 * The arithmetic happens in CMYK, because that is the space the control
 * is expressed in: adding cyan is subtracting red, and doing it after a
 * round trip through RGB would make the four sliders interfere.
 *
 * Honesty note: this is an approximation of Adobe's rendering. The
 * recipe round-trips through PSD intact (the record carries the percent
 * values, not baked pixels), but Photoshop's own colour space and range
 * falloffs differ, so the same numbers can render a little differently
 * there. That is the same class of caveat as exposure.
 */

export type SelectiveRange =
  | "reds"
  | "yellows"
  | "greens"
  | "cyans"
  | "blues"
  | "magentas"
  | "whites"
  | "neutrals"
  | "blacks";

/** Offsets in percent, -100..100: [cyan, magenta, yellow, black]. */
export type CmykOffsets = { c: number; m: number; y: number; k: number };

export interface SelectiveSettings {
  /**
   * Photoshop's Relative/Absolute switch. Relative moves the existing
   * ink proportionally (so +50 % cyan adds half of what is already
   * there); absolute adds a flat percentage of the full channel.
   */
  mode: "relative" | "absolute";
  ranges: Partial<Record<SelectiveRange, CmykOffsets>>;
}

export const SELECTIVE_RANGES: readonly SelectiveRange[] = [
  "reds",
  "yellows",
  "greens",
  "cyans",
  "blues",
  "magentas",
  "whites",
  "neutrals",
  "blacks",
];

export const SELECTIVE_LABELS: Record<SelectiveRange, string> = {
  reds: "Reds",
  yellows: "Yellows",
  greens: "Greens",
  cyans: "Cyans",
  blues: "Blues",
  magentas: "Magentas",
  whites: "Whites",
  neutrals: "Neutrals",
  blacks: "Blacks",
};

/** Hue centre in degrees for the six chromatic ranges. */
const HUE_CENTRES: Partial<Record<SelectiveRange, number>> = {
  reds: 0,
  yellows: 60,
  greens: 120,
  cyans: 180,
  blues: 240,
  magentas: 300,
};


function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clampPercent(v: number): number {
  return Math.max(-100, Math.min(100, Math.round(v * 10) / 10));
}

/**
 * Sanitises a stored recipe. Anything unreadable falls back to the
 * identity rather than producing a half-applied adjustment: a file with
 * a broken range should look unchanged, not subtly wrong.
 */
export function normalizeSelective(input: unknown): SelectiveSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: SelectiveSettings = {
    mode: raw.mode === "absolute" ? "absolute" : "relative",
    ranges: {},
  };
  const ranges = raw.ranges && typeof raw.ranges === "object" ? (raw.ranges as Record<string, unknown>) : {};
  for (const range of SELECTIVE_RANGES) {
    const entry = ranges[range];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    out.ranges[range] = {
      c: clampPercent(num(e.c)),
      m: clampPercent(num(e.m)),
      y: clampPercent(num(e.y)),
      k: clampPercent(num(e.k)),
    };
  }
  return out;
}

/** True when every stored offset is zero, i.e. the recipe changes nothing. */
export function selectiveIsIdentity(settings: SelectiveSettings): boolean {
  for (const range of SELECTIVE_RANGES) {
    const v = settings.ranges[range];
    if (v && (v.c !== 0 || v.m !== 0 || v.y !== 0 || v.k !== 0)) return false;
  }
  return true;
}

function hueOf(r: number, g: number, b: number, max: number, min: number): number {
  const d = max - min;
  if (d <= 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * How much each range owns this pixel. Chromatic ranges are triangular
 * windows 60° wide, so a hue exactly between two centres contributes half
 * to each and the weights along the wheel always sum to one. The three
 * tone ranges split the low-saturation remainder by lightness.
 */
export function selectiveWeights(r: number, g: number, b: number): Record<SelectiveRange, number> {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const luma = 0.3 * rn + 0.59 * gn + 0.11 * bn;
  const sat = max > 0 ? (max - min) / max : 0;
  const hue = hueOf(rn, gn, bn, max, min);
  const colourWeight = Math.min(1, sat * 2);

  const w = {} as Record<SelectiveRange, number>;
  for (const range of SELECTIVE_RANGES) {
    const centre = HUE_CENTRES[range];
    if (centre !== undefined) {
      const d = circularDistance(hue, centre);
      w[range] = d >= 60 ? 0 : (1 - d / 60) * colourWeight;
    }
  }

  const grey = 1 - sat;
  w.whites = grey * Math.max(0, Math.min(1, (luma - 0.55) / 0.45));
  w.blacks = grey * Math.max(0, Math.min(1, (0.45 - luma) / 0.45));
  w.neutrals = grey * Math.max(0, 1 - Math.abs(2 * luma - 1));
  return w;
}

function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  const d = 1 - k;
  return [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k];
}

function clampInk(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Applies the recipe to one pixel. Returns 0..255 channels. The backdrop
 * is modified in place only through the returned tuple, so a caller can
 * run this on a copy without worrying about shared state.
 */
export function applySelective(
  r: number,
  g: number,
  b: number,
  settings: SelectiveSettings,
): [number, number, number] {
  if (selectiveIsIdentity(settings)) return [r, g, b];
  const w = selectiveWeights(r, g, b);
  const [c, m, y, k0] = rgbToCmyk(r / 255, g / 255, b / 255);
  const cmyk: [number, number, number, number] = [c, m, y, k0];
  const absolute = settings.mode === "absolute";
  for (const range of SELECTIVE_RANGES) {
    const adj = settings.ranges[range];
    const weight = w[range];
    if (!adj || weight <= 0) continue;
    if (adj.c === 0 && adj.m === 0 && adj.y === 0 && adj.k === 0) continue;
    const amount: [number, number, number, number] = [adj.c / 100, adj.m / 100, adj.y / 100, adj.k / 100];
    for (const i of [0, 1, 2, 3] as const) {
      const pct = amount[i];
      if (pct === 0) continue;
      const here = cmyk[i];
      const step = absolute ? pct : here * pct;
      cmyk[i] = clampInk(here + weight * step);
    }
  }
  const kk = cmyk[3];
  return [
    Math.round((1 - cmyk[0]) * (1 - kk) * 255),
    Math.round((1 - cmyk[1]) * (1 - kk) * 255),
    Math.round((1 - cmyk[2]) * (1 - kk) * 255),
  ];
}

/** The recipe Photoshop starts from: every range present, every offset zero. */
export function defaultSelective(): SelectiveSettings {
  return { mode: "relative", ranges: {} };
}

