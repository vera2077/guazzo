/**
 * adjust-forms.ts — data shared by BOTH adjustment surfaces.
 *
 * The Adjustments palette (floating, inline) and the tonal dialogs (modal) each
 * build their own controls, but they must not each invent their own domain data:
 * handoff-4 X1 found photo-filter presets that existed only in the palette and a
 * palette Curves that hardcoded the "rgb" channel, so per-channel curves were
 * unreachable there. Anything that is *knowledge about the adjustment* (presets,
 * channel lists) lives here; anything about widget layout stays with the surface.
 */

export type CurveChannel = "rgb" | "r" | "g" | "b";

/** Channels offered by every Curves editor, in Photoshop's order. */
export const CURVE_CHANNELS: readonly [CurveChannel, string][] = [
  ["rgb", "RGB"],
  ["r", "Red"],
  ["g", "Green"],
  ["b", "Blue"],
];

/** Photoshop's Photo Filter presets: label → filter colour. */
export const PHOTO_FILTER_PRESETS: readonly [string, [number, number, number]][] = [
  ["Warming (85)", [214, 143, 53]],
  ["Cooling (80)", [26, 85, 170]],
  ["Red", [255, 0, 0]],
  ["Orange", [255, 153, 0]],
  ["Yellow", [255, 255, 0]],
  ["Green", [0, 255, 0]],
  ["Cyan", [0, 255, 255]],
  ["Blue", [0, 0, 255]],
  ["Violet", [143, 94, 191]],
  ["Magenta", [255, 0, 255]],
];

/** Convenience for a preset select: label → label (the value IS the label). */
export function photoFilterPresetEntries(): [string, string][] {
  return PHOTO_FILTER_PRESETS.map(([label]) => [label, label]);
}

/** Look a preset up by label, falling back to the first entry. */
export function photoFilterPresetColour(label: string): [number, number, number] {
  const hit = PHOTO_FILTER_PRESETS.find(([l]) => l === label) ?? PHOTO_FILTER_PRESETS[0]!;
  return hit[1];
}

// ---------------------------------------------------------------------------
// AF2: shared *form* definitions, not just data.
//
// The floating palette and the modal dialogs used to declare the same ranges
// (Levels gamma 0.1–9 step 0.05, Vibrance −100…100 default 25, …) twice. That
// is how X1's drift happened. A FieldDefinition is now the only place a range
// lives; each surface renders them with its own row markup via buildFields().
// ---------------------------------------------------------------------------

/** One numeric control of an adjustment form. */
export interface AdjustField {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number;
  step?: number;
  fmt?: (v: number) => string;
}

export const LEVELS_FIELDS: readonly AdjustField[] = [
  { id: "inBlack", label: "Input black", min: 0, max: 254, def: 0 },
  { id: "inWhite", label: "Input white", min: 1, max: 255, def: 255 },
  { id: "gamma", label: "Gamma", min: 0.1, max: 9, def: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { id: "outBlack", label: "Output black", min: 0, max: 255, def: 0 },
  { id: "outWhite", label: "Output white", min: 0, max: 255, def: 255 },
];

/**
 * Only fields whose domain is IDENTICAL on both surfaces live here.
 *
 * The palette and the dialogs intentionally differ elsewhere: the palette's
 * Exposure slider is already in EV (−4…4) while the dialog runs in tenths
 * (−40…40 → /10); Black & White uses 0…200 "preset" weights in the palette but
 * −200…300 offsets in the dialog; Photo Filter density is 0-based there and
 * 1-based here. Those need a product decision about defaults, not a mechanical
 * merge — putting them in one table today would silently change one surface.
 */

/** A rendered control: the shared contract both surfaces program against. */
export interface FieldControl {
  id: string;
  row: HTMLElement;
  input: HTMLInputElement;
  value: () => number;
}

function fieldRowMarkup(f: AdjustField, indent: string): FieldControl {
  const row = document.createElement("label");
  row.className = "inline-row";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.style.minWidth = indent;
  lab.textContent = f.label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(f.min);
  input.max = String(f.max);
  input.value = String(f.def);
  if (f.step !== undefined) input.step = String(f.step);
  input.setAttribute("aria-label", f.label);
  const fmt = f.fmt ?? ((v: number) => String(v));
  const val = document.createElement("span");
  val.className = "value";
  val.style.minWidth = "38px";
  val.textContent = fmt(f.def);
  input.addEventListener("input", () => { val.textContent = fmt(Number(input.value)); });
  row.append(lab, input, val);
  return { id: f.id, row, input, value: () => Number(input.value) };
}

/**
 * Render a field list into `host` and return the controls by id.
 * Both the palette and the dialogs call this — one range table, two surfaces.
 */
export function buildFields(
  host: HTMLElement, fields: readonly AdjustField[], indent = "86px",
): Record<string, FieldControl> {
  const out: Record<string, FieldControl> = {};
  for (const f of fields) {
    const c = fieldRowMarkup(f, indent);
    host.appendChild(c.row);
    out[f.id] = c;
  }
  return out;
}

/** Level options from a Levels form, with the engine's input-white clamp. */
export function levelsFromFields(
  c: Record<string, FieldControl>,
): { inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number } {
  const inBlack = c.inBlack!.value();
  return {
    inBlack,
    inWhite: Math.max(inBlack + 1, c.inWhite!.value()),
    gamma: c.gamma!.value(),
    outBlack: c.outBlack!.value(),
    outWhite: c.outWhite!.value(),
  };
}

// ---------------------------------------------------------------------------
// AF2 slice 2 (user decision, m10524): converge the three adjustments whose
// surfaces disagreed — per CONTROL, not per surface. The numbers live here once;
// both surfaces call these builders, so the forms cannot drift apart again.
// ---------------------------------------------------------------------------

/** Exposure is stored in EV on both surfaces (was EV in the palette, tenths in the dialog). */
export const EXPOSURE = { min: -4, max: 4, def: 0, step: 0.1 } as const;

/** Black & White keeps the dialog's weights for every channel (m10524). */
export const BW_WEIGHTS = {
  min: -200, max: 300,
  red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80,
} as const;

/** Photo Filter keeps the palette's default: Warming (85) at 25 % (m10524). */
export const PHOTO_FILTER_DEFAULT = {
  preset: "Warming (85)",
  density: 25,
  color: [214, 143, 53] as [number, number, number],
  preserveLuminosity: true,
} as const;

const evLabel = (v: number): string => `${v > 0 ? "+" : ""}${v.toFixed(1)} EV`;
const pctLabel = (v: number): string => `${v}%`;

export function buildExposureForm(host: HTMLElement): { rows: FieldControl[]; ev: () => number; label: () => string } {
  const c = buildFields(host, [{ id: "ev", label: "Exposure", ...EXPOSURE, fmt: evLabel }]);
  const ev = (): number => c.ev!.value();
  return { rows: [c.ev!], ev, label: () => `Exposure ${evLabel(ev())}` };
}

export function buildBlackWhiteForm(host: HTMLElement): {
  rows: FieldControl[];
  values: () => { red: number; yellow: number; green: number; cyan: number; blue: number; magenta: number };
} {
  const defs: AdjustField[] = [
    { id: "red", label: "Reds", min: BW_WEIGHTS.min, max: BW_WEIGHTS.max, def: BW_WEIGHTS.red, fmt: pctLabel },
    { id: "yellow", label: "Yellows", min: BW_WEIGHTS.min, max: BW_WEIGHTS.max, def: BW_WEIGHTS.yellow, fmt: pctLabel },
    { id: "green", label: "Greens", min: BW_WEIGHTS.min, max: BW_WEIGHTS.max, def: BW_WEIGHTS.green, fmt: pctLabel },
    { id: "cyan", label: "Cyans", min: BW_WEIGHTS.min, max: BW_WEIGHTS.max, def: BW_WEIGHTS.cyan, fmt: pctLabel },
    { id: "blue", label: "Blues", min: BW_WEIGHTS.min, max: BW_WEIGHTS.max, def: BW_WEIGHTS.blue, fmt: pctLabel },
    { id: "magenta", label: "Magentas", min: BW_WEIGHTS.min, max: BW_WEIGHTS.max, def: BW_WEIGHTS.magenta, fmt: pctLabel },
  ];
  const c = buildFields(host, defs);
  return {
    rows: Object.values(c),
    values: () => ({
      red: c.red!.value(), yellow: c.yellow!.value(), green: c.green!.value(),
      cyan: c.cyan!.value(), blue: c.blue!.value(), magenta: c.magenta!.value(),
    }),
  };
}

export interface PhotoFilterValues {
  color: [number, number, number];
  density: number;
  preserveLuminosity: boolean;
  preset: string;
}

const hexOf = (c: readonly [number, number, number]): string =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/**
 * Preset select + colour well + density + preserve. Both surfaces render this,
 * so "which preset is selected by default" can only be answered once.
 */
export function buildPhotoFilterForm(host: HTMLElement): {
  rows: HTMLElement[];
  values: () => PhotoFilterValues;
  label: () => string;
} {
  const rows: HTMLElement[] = [];

  const presetRow = document.createElement("label");
  presetRow.className = "inline-row";
  const presetLab = document.createElement("span");
  presetLab.className = "label";
  presetLab.style.minWidth = "86px";
  presetLab.textContent = "Filter";
  const presetSel = document.createElement("select");
  for (const [label] of PHOTO_FILTER_PRESETS) {
    const o = document.createElement("option");
    o.value = label;
    o.textContent = label;
    presetSel.appendChild(o);
  }
  presetSel.value = PHOTO_FILTER_DEFAULT.preset;
  presetSel.style.flex = "1 1 auto";
  presetRow.append(presetLab, presetSel);
  host.appendChild(presetRow);
  rows.push(presetRow);

  const colourRow = document.createElement("label");
  colourRow.className = "inline-row";
  const colourLab = document.createElement("span");
  colourLab.className = "label";
  colourLab.style.minWidth = "86px";
  colourLab.textContent = "Colour";
  const colour = document.createElement("input");
  colour.type = "color";
  colour.value = hexOf(PHOTO_FILTER_DEFAULT.color);
  colourRow.append(colourLab, colour);
  host.appendChild(colourRow);
  rows.push(colourRow);

  const dens = buildFields(host, [{
    id: "density", label: "Density", min: 1, max: 100, def: PHOTO_FILTER_DEFAULT.density, fmt: pctLabel,
  }]);
  rows.push(dens.density!.row);

  const presRow = document.createElement("label");
  presRow.className = "inline-row check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = PHOTO_FILTER_DEFAULT.preserveLuminosity;
  const presLab = document.createElement("span");
  presLab.className = "label";
  presLab.style.minWidth = "0";
  presLab.textContent = "Preserve luminosity";
  presRow.append(cb, presLab);
  host.appendChild(presRow);
  rows.push(presRow);

  const parse = (): [number, number, number] => {
    const m = /^#([0-9a-f]{6})$/i.exec(colour.value.trim());
    if (!m) return [...PHOTO_FILTER_DEFAULT.color] as [number, number, number];
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  presetSel.addEventListener("change", () => {
    colour.value = hexOf(photoFilterPresetColour(presetSel.value));
  });

  return {
    rows,
    values: () => ({
      color: parse(),
      density: dens.density!.value(),
      preserveLuminosity: cb.checked,
      preset: presetSel.value,
    }),
    label: () => `Photo Filter ${presetSel.value} ${dens.density!.value()}%`,
  };
}
