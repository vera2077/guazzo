/**
 * Help ▸ Keyboard Shortcuts is generated from this table, and a test checks the
 * table against the dispatcher in `src/main.ts`.
 *
 * Why a table instead of hand-written rows in the dialog: the previous version
 * advertised Ctrl+Shift+S and Ctrl+Shift+L and taught neither (one was bound to
 * Export As, the other did not exist), and one row leaked a developer note
 * ("keep the key pressed? no: H toggles") into the UI. A list that cannot be
 * generated from the thing it documents rots silently; this one can at least be
 * checked mechanically.
 *
 * `keys` is the display text. The test tokenises it: "Ctrl+Shift+S" → "S",
 * "[ / ]" → two rows, and it requires each token to appear in the key chain.
 * Rows whose behaviour is not a `key ===` comparison are named in
 * `NON_KEY_ROWS` below so the test does not have to guess.
 */
export interface ShortcutRow {
  keys: string;
  what: string;
}

/** Documented accelerators that are not a plain `key === "x"` comparison. */
export const NON_KEY_ROWS: readonly string[] = [
  "Right-click",
  "Menu key",
  "C then Enter",
];

export const SHORTCUTS: readonly ShortcutRow[] = [
  // tools — one row per tool, in toolbar order
  { keys: "V", what: "Move" },
  { keys: "M", what: "Marquee / ellipse" },
  { keys: "L", what: "Lasso" },
  { keys: "Shift+B", what: "Pencil" },
  { keys: "Shift+K", what: "Mixer Brush" },
  { keys: "Shift+P", what: "Pattern Stamp" },
  { keys: "Shift+L", what: "Polygonal lasso" },
  { keys: "W", what: "Magic wand" },
  { keys: "Shift+W", what: "Quick selection" },
  { keys: "C", what: "Crop" },
  { keys: "B", what: "Brush" },
  { keys: "E", what: "Eraser" },
  { keys: "G", what: "Gradient" },
  { keys: "Shift+G", what: "Paint bucket" },
  { keys: "I", what: "Eyedropper" },
  { keys: "Shift+I", what: "Color Sampler" },
  { keys: "Shift+R", what: "Ruler" },
  { keys: "Shift+C", what: "Count" },
  { keys: "Shift+E", what: "Magic / Background eraser (cycles)" },
  { keys: "Shift+Y", what: "Colour Replacement" },
  { keys: "O", what: "Dodge / burn / sponge" },
  { keys: "J", what: "Spot healing" },
  { keys: "S", what: "Clone stamp" },
  { keys: "Shift+S", what: "Blur / sharpen / smudge" },
  { keys: "P", what: "Pen — click anchors; Enter or double-click closes into a selection" },
  { keys: "U", what: "Shape" },
  { keys: "T", what: "Text" },
  { keys: "Q", what: "Quick Mask" },
  { keys: "X", what: "Swap foreground and background" },
  { keys: "D", what: "Reset colours to black and white" },

  // selection and editing
  { keys: "Ctrl+A", what: "Select all" },
  { keys: "Ctrl+D", what: "Deselect" },
  { keys: "Ctrl+Shift+I", what: "Invert selection" },
  { keys: "Ctrl+Shift+L", what: "Auto Tone" },
  { keys: "Delete", what: "Clear the selected pixels" },
  { keys: "Alt+Backspace", what: "Fill the selection with the foreground colour" },
  { keys: "Ctrl+C / Ctrl+X / Ctrl+V", what: "Copy / cut / paste" },
  { keys: "Ctrl+Shift+C", what: "Copy merged (all layers)" },
  { keys: "Right-click", what: "Context menu — canvas, layers, history, tabs, tools, swatches" },
  { keys: "Menu key", what: "Open the context menu at the focused element" },

  // transform and document
  { keys: "Ctrl+T", what: "Free transform" },
  { keys: "Enter", what: "Apply transform, crop or text" },
  { keys: "Esc", what: "Cancel the current transform, crop, path or dialog" },
  { keys: "C then Enter", what: "Crop — or press Perspective in the options bar for a four-corner crop" },
  { keys: "Ctrl+N", what: "New document" },
  { keys: "Ctrl+O", what: "Open image" },
  { keys: "Ctrl+Shift+O", what: "Open project" },
  { keys: "Ctrl+S", what: "Save project" },
  { keys: "Ctrl+Shift+S", what: "Save project as…" },
  { keys: "Ctrl+Shift+E", what: "Export as…" },
  { keys: "Ctrl+W", what: "Close the current tab" },

  // layers
  { keys: "Ctrl+J", what: "Duplicate layer" },
  { keys: "Ctrl+Shift+N", what: "New layer" },
  { keys: "Ctrl+E", what: "Merge down" },

  // history
  { keys: "Ctrl+Z", what: "Undo" },
  { keys: "Ctrl+Shift+Z", what: "Redo" },
  { keys: "Ctrl+Y", what: "Redo (Windows files style)" },

  // view
  { keys: "Ctrl+0", what: "Fit on screen" },
  { keys: "Ctrl+1", what: "Actual pixels" },
  { keys: "Ctrl+= / Ctrl+-", what: "Zoom in / out" },
  { keys: "[ / ]", what: "Smaller / larger brush" },
  { keys: "Space", what: "Pan while held (middle-drag also pans)" },
  { keys: "H", what: "Hand mode — drag to pan, H to leave" },
  { keys: "Z", what: "Zoom mode — click to zoom in, Alt-click to zoom out" },
  { keys: "F6", what: "Next pane (menu bar, tools, options, canvas, panels)" },
  { keys: "F10", what: "Focus the menu bar" },
  { keys: "Tab", what: "Hide or show the panels and toolbar" },
  { keys: "Shift+Tab", what: "Hide or show the panels only" },
  { keys: "Ctrl/Cmd+K", what: "Search tools and actions" },
];
