// Pigment icon set — hand-written 24×24 stroke icons (no icon-font, no network).
// Every glyph uses `currentColor` so buttons tint on hover/active state.
// Kept stroke-only and geometric to match the soft-rounded dark UI.

export type IconName =
  | "brush" | "eraser" | "marquee" | "ellipse" | "lasso" | "gradient" | "text"
  | "move" | "crop" | "transform"
  | "eye" | "eye-off" | "plus" | "arrow-up" | "arrow-down" | "copy" | "trash"
  | "merge" | "flatten" | "close" | "history" | "layers" | "sliders" | "funnel"
  | "image" | "save" | "folder-open" | "file-plus" | "download" | "resize"
  | "frame" | "chevron-down" | "columns" | "check" | "mask" | "wand" | "bucket"
  | "eyedropper"
  | "stamp"
  | "blur"
  | "dodge"
  | "sponge"
  | "swap"
  | "target"
  | "lock"
  | "bandage"
  | "unlock"
  | "pencil";

const PATHS: Record<IconName, string> = {
  brush: `<path d="M16.5 3.5 20.5 7.5 9 19H5v-4L16.5 3.5Z"/><path d="m13.4 6.6 4 4"/>`,
  eraser: `<path d="M7 20h13"/><path d="M16 3.8a2 2 0 0 1 2.8 0l1.9 1.9a2 2 0 0 1 0 2.8L11.4 18H6.6l-3-3a2 2 0 0 1 0-2.8Z"/>`,
  marquee: `<rect x="3.5" y="5" width="17" height="14" rx="1.6" stroke-dasharray="3 2.4"/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="8.5" ry="7" stroke-dasharray="3 2.4"/>`,
  lasso: `<path d="M12 4c4.4 0 8 2.3 8 5.2 0 2.9-3.6 5.3-8 5.3s-8-2.4-8-5.3C4 6.3 7.6 4 12 4Z"/><path d="M8.6 14.2c0 2.3.9 2.6.9 4.1a1.9 1.9 0 1 1-3.8 0"/>`,
  gradient: `<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 19.5 20.5 4.5"/><path d="M20.5 4.5v15h-6.4Z" fill="currentColor" stroke="none" opacity=".3"/>`,
  text: `<path d="M4.5 7V4.5h15V7"/><path d="M12 4.5v15"/><path d="M8.5 19.5h7"/>`,
  move: `<path d="M12 3.5v17M3.5 12h17"/><path d="m9 6 3-2.5L15 6M9 18l3 2.5L15 18M6 9l-2.5 3L6 15M18 9l2.5 3L18 15"/>`,
  crop: `<path d="M6.5 2.5v15h15"/><path d="M2.5 6.5h15v15"/>`,
  transform: `<rect x="5" y="5" width="14" height="14" rx="1.6"/><rect x="2.5" y="2.5" width="5" height="5" rx="1.1" fill="currentColor" stroke="none" opacity=".75"/><rect x="16.5" y="16.5" width="5" height="5" rx="1.1" fill="currentColor" stroke="none" opacity=".75"/>`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>`,
  "eye-off": `<path d="m3 3 18 18"/><path d="M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.7 3.4"/><path d="M6.2 7.7A16.8 16.8 0 0 0 2.5 12s3.5 6 9.5 6a9.6 9.6 0 0 0 3.6-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>`,
  plus: `<path d="M12 5.5v13M5.5 12h13"/>`,
  "arrow-up": `<path d="M12 19V5.5"/><path d="m6.5 11 5.5-5.5L17.5 11"/>`,
  "arrow-down": `<path d="M12 5v13.5"/><path d="m6.5 13 5.5 5.5L17.5 13"/>`,
  copy: `<rect x="9.5" y="9.5" width="10.5" height="10.5" rx="2.2"/><path d="M14.5 6.9V5.9A1.4 1.4 0 0 0 13.1 4.5H5.9A1.4 1.4 0 0 0 4.5 5.9v7.2a1.4 1.4 0 0 0 1.4 1.4h1"/>`,
  trash: `<path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="m6.5 7 .8 12.2A1.6 1.6 0 0 0 8.9 20.8h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7"/><path d="M10 11v6M14 11v6"/>`,
  merge: `<path d="M12 4v9"/><path d="m8.5 9.5 3.5 3.5 3.5-3.5"/><path d="M4.5 19.5h15"/>`,
  flatten: `<path d="m12 4 8 4.2-8 4.2-8-4.2L12 4Z"/><path d="m4 12.6 8 4.2 8-4.2"/><path d="m4 17 8 4.2 8-4.2"/>`,
  close: `<path d="m6 6 12 12M18 6 6 18"/>`,
  history: `<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"/><path d="M3.5 4.5v4.5h4.5"/><path d="M12 8v4.4l3 1.8"/>`,
  layers: `<path d="m12 3.5 8.5 4.3L12 12.1 3.5 7.8 12 3.5Z"/><path d="m3.5 12.2 8.5 4.3 8.5-4.3"/>`,
  sliders: `<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>`,
  funnel: `<path d="M3.5 5.5h17l-6.6 7.6v6l-3.8 1.9v-7.9L3.5 5.5Z"/>`,
  image: `<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4.5 17.5 4.7-4.4a2 2 0 0 1 2.7 0l3.1 2.9"/><path d="m14.5 14.5 1.7-1.6a2 2 0 0 1 2.7 0l1.6 1.5"/>`,
  save: `<path d="M5 4.5h10.5L19.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M8 4.5v5h7v-5"/><rect x="7.5" y="13" width="9" height="7" rx=".8"/>`,
  "folder-open": `<path d="M3.5 8.5V6A1.5 1.5 0 0 1 5 4.5h4l2 2.5h5.5A1.5 1.5 0 0 1 18 8.5"/><path d="M3.5 8.5h16.2a1 1 0 0 1 .97 1.25l-1.9 6.4a2 2 0 0 1-1.92 1.45H5.3a1.8 1.8 0 0 1-1.8-1.8Z"/>`,
  "file-plus": `<path d="M6 3.5h7.5L19 9v10.5A1.5 1.5 0 0 1 17.5 21H6A1.5 1.5 0 0 1 4.5 19.5v-14A1.5 1.5 0 0 1 6 3.5Z"/><path d="M13 3.5V9h5.5"/><path d="M11.7 12.4v5.2M9.1 15h5.2"/>`,
  download: `<path d="M12 3.5v11"/><path d="m7.8 10.5 4.2 4.2 4.2-4.2"/><path d="M4.5 18.5v1a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1"/>`,
  resize: `<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M7.5 12h9"/><path d="m10 9-2.5 3 2.5 3M14 9l2.5 3-2.5 3"/>`,
  frame: `<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3 2.4"/><rect x="8" y="8" width="8" height="8" rx="1.2"/>`,
  "columns": '<rect x="3" y="5" width="7" height="14" rx="1.5"/><rect x="14" y="5" width="7" height="14" rx="1.5"/>',
  "chevron-down": `<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>`,
  check: `<path d="m5 12.5 4.5 4.5L19 7"/>`,
  mask: `<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/><circle cx="7.8" cy="12" r="2.4" fill="currentColor" stroke="none" opacity=".5"/>`,
  eyedropper:
    '<path d="M19.5 4.5a2.1 2.1 0 0 0-3 0l-2 2-1.2-1.2-1.5 1.5 1.2 1.2L7 14.6V18h3.4l6.6-6.6 1.2 1.2 1.5-1.5-1.2-1.2 2-2a2.1 2.1 0 0 0 0-3Z"/>',
  stamp:
    '<path d="M9 3h6v3.2a3 3 0 0 1-1 2.2 2 2 0 0 0-.7 1.5V11h3.2a2 2 0 0 1 2 2v1H5.5v-1a2 2 0 0 1 2-2H11v-1.1A3 3 0 0 0 9 6.2V3Z"/><path d="M4 17h16"/>',
  blur:
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
  dodge:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/>',
  sponge:
    '<path d="M5 13.5 10.5 8a3 3 0 0 1 4.2 0l1.3 1.3a3 3 0 0 1 0 4.2L10.5 19H6.5a2 2 0 0 1-1.5-5.5Z"/><path d="M8 10.5 4.6 7.1a2.6 2.6 0 0 1 3.7-3.7"/>',
  swap:
    '<path d="M7 8h9l-2.5-2.5M17 16H8l2.5 2.5"/>',
  target:
    '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
  bucket: `<path d="m5 11 7-7 6 6-7 7a4.2 4.2 0 0 1-6 0 4.2 4.2 0 0 1 0-6Z"/><path d="M11 4 8 7"/><path d="M19.5 15.5s1.5 1.9 1.5 2.8a1.5 1.5 0 0 1-3 0c0-.9 1.5-2.8 1.5-2.8Z"/>`,
  bandage: `<path d="M9.2 4.6a3.4 3.4 0 0 1 4.8 0l5.4 5.4a3.4 3.4 0 0 1-4.8 4.8L9.2 9.4a3.4 3.4 0 0 1 0-4.8Z"/><path d="M14.6 14.6a3.4 3.4 0 0 1-4.8 0l-5.4-5.4a3.4 3.4 0 0 1 4.8-4.8l5.4 5.4a3.4 3.4 0 0 1 0 4.8Z"/><path d="m9 10 6-6" stroke-dasharray="1.6 2.4"/>`,
  lock: `<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>`,
  unlock: `<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.4-2"/>`,
  pencil: `<path d="M16.5 3.8 20.2 7.5 8.6 19.1 4 20l.9-4.6Z"/><path d="m14.8 5.5 3.7 3.7"/>`,
  wand: `<path d="M4 20 15 9"/><path d="m13.8 7.8 2.4 2.4"/><path d="M17.5 3.5v3M16 5h3"/><path d="M19.5 9.5v2M18.5 10.5h2"/><path d="M11 3.5v2.2M9.9 4.6h2.2"/>`,
};

/** Serialised <svg> markup — use inside innerHTML templates. */
export function iconSvg(name: IconName, size = 18): string {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true">${PATHS[name]}</svg>`;
}

/** Replace an element's content with a single icon. */
export function setIcon(el: HTMLElement, name: IconName, size = 18): void {
  el.innerHTML = iconSvg(name, size);
}
