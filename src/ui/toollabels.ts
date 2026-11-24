/**
 * The one place a tool's name, shortcut and family are written down.
 *
 * AF1 (handoff-5, re-opened Y3): the toolbar buttons used to carry their own
 * literal titles while `TOOL_LABELS` carried a second, drifting copy — the
 * context menu said "Type (T)" while the button said "Text (T)", and one said
 * "Quick Selection (Shift+W)" while the key that selects it is W. Now the
 * button title IS the label, derived from the tool id, so the two cannot
 * disagree and `toollabels.test.ts` pins the vocabulary.
 */
export type ToolId =
  | "brush"
  | "eraser"
  | "magicerase"
  | "bgerase"
  | "colourreplace"
  | "patch"
  | "note"
  | "magnet"
  | "marquee"
  | "ellipse"
  | "lasso"
  | "polylasso"
  | "pencil"
  | "patternstamp"
  | "mixer"
  | "pen"
  | "gradient"
  | "text"
  | "move"
  | "crop"
  | "wand"
  | "quick"
  | "shape"
  | "bucket"
  | "heal"
  | "eyedropper"
  | "sampler"
  | "count"
  | "ruler"
  | "retouch"
  | "clone"
  | "focus"
  | "historybrush"
  | "arthistory";

export const TOOL_IDS: readonly ToolId[] = [
  "move", "marquee", "ellipse", "lasso", "polylasso", "pen", "pencil", "patternstamp", "mixer", "wand", "quick",
  "crop", "shape", "eyedropper",
  "sampler", "count", "ruler", "brush", "eraser", "magicerase", "bgerase", "colourreplace", "patch", "note", "magnet", "bucket", "gradient",
  "heal", "retouch", "clone", "focus", "historybrush", "arthistory", "text",
];

/** `Name (KEY)` — the shortcut is the key that actually selects the tool. */
export const TOOL_LABELS: Record<ToolId, string> = {
  move: "Move (V)",
  marquee: "Rectangular Marquee (M)",
  ellipse: "Elliptical Marquee (M)",
  lasso: "Lasso (L)",
  polylasso: "Polygonal Lasso (Shift+L)",
  pencil: "Pencil (Shift+B)",
  patternstamp: "Pattern Stamp (Shift+P)",
  mixer: "Mixer Brush (Shift+K)",
  pen: "Pen (P)",
  wand: "Magic Wand (W)",
  quick: "Quick Selection (Shift+W)",
  crop: "Crop (C)",
  shape: "Shape (U)",
  eyedropper: "Eyedropper (I)",
  sampler: "Color Sampler (Shift+I)",
  count: "Count (Shift+C)",
  ruler: "Ruler (Shift+R)",
  brush: "Brush (B)",
  eraser: "Eraser (E)",
  magicerase: "Magic Eraser (Shift+E)",
  bgerase: "Background Eraser (Shift+E)",
  colourreplace: "Colour Replacement (Shift+Y)",
  patch: "Patch (Shift+J)",
  note: "Note (Shift+N)",
  magnet: "Magnetic Lasso (Shift+L)",
  bucket: "Paint Bucket (Shift+G)",
  gradient: "Gradient (G)",
  heal: "Spot Healing Brush (J)",
  retouch: "Dodge / Burn / Sponge (O)",
  clone: "Clone Stamp (S)",
  focus: "Blur / Sharpen / Smudge (Shift+S)",
  historybrush: "History Brush (Y)",
  arthistory: "Art History Brush (Alt+Y)",
  text: "Text (T)",
};

/** long-form hover text: label first so the key is always visible */
export function toolTitle(id: ToolId, description?: string): string {
  const label = TOOL_LABELS[id];
  return description ? `${label} — ${description}` : label;
}
