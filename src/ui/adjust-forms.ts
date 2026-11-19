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
