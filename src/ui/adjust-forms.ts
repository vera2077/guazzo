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
