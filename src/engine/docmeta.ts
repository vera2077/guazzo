/**
 * Document metadata helpers: the print units, resolutions and preset shapes the
 * New Document dialog works in. Pure functions only — no DOM, no storage — so
 * the arithmetic that turns "19 inches at 300 ppi" into a pixel canvas is
 * unit-tested like the rest of the engine.
 */

/**
 * Largest document side we allow. The compositor keeps one flat RGBA buffer for
 * the whole canvas, and WebView2's Canvas2D stops drawing past ~16384 px per
 * side, so 30000 (Photoshop's number) would produce a blank canvas and a 3.6 GB
 * allocation. Better to refuse the size than to silently show nothing.
 */
export const MAX_DIM = 16384;

/**
 * AG3: ceiling for anything a user drags in. The canvas limit bounds the
 * *allocated* document, but a hostile file is read into memory long before it is
 * decoded — a 2 GB PSD is a 2 GB ArrayBuffer plus a decoded copy. Refuse on
 * `file.size` first, which costs nothing to check.
 */
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

/**
 * AG3/ui13: a project file is JSON, and JSON.parse allocates roughly two to
 * three times the text in live objects before `deserializeProject` can apply
 * any structural cap. A 256 MB file of `{},{}…` therefore exhausts the renderer
 * rather than being refused. Project files are tile-base64 and far smaller than
 * their pixel count suggests, so this ceiling is generous in practice.
 */
// One 256 x 256 RGBA tile is 349,528 base64 characters. 192 MB is room for 512
// such tiles (179 MB) plus the document and layer metadata — the same number as
// MAX_PROJECT_TILES in io.ts, so "saves" and "opens" cannot disagree (code-r6).
export const MAX_JSON_TOKENS = 4_000_000;
export const MAX_JSON_BYTES = 192 * 1024 * 1024;

/**
 * The pixel budget. A per-side ceiling is not enough: 16384 x 16384 is 1 GiB
 * per RGBA buffer, and the decode path makes three of them. 64 MPx matches
 * `EFFECT_MAX_PIXELS`; export refuses above 256 MB. A 10000 x 10000 PNG is a
 * few KB compressed and passes a per-side test (sec-r6).
 */
export const MAX_PIXELS = 64 * 1024 * 1024;
/** How deep groups may nest. Each isolated level holds a scratch buffer. */
export const MAX_GROUP_DEPTH = 16;

/** The refusal message for a project file over the JSON ceiling, or null. */
/**
 * A picture is decoded into a document, so a picture larger than a document is
 * not something this app can place. Checked *before* the canvas allocation:
 * `createImageBitmap` has already decoded at this point, but the RGBA copy is
 * the allocation that kills the renderer.
 */
/** The pixel size a raster header declares, or null when the bytes are not a
 *  format whose header we can read. Used to refuse a decompression bomb before
 *  the decoder allocates the pixels (sec-r8 F1). */
export function sniffImageSize(head: Uint8Array): { width: number; height: number } | null {
  const u16 = (at: number): number => (head[at]! << 8) | head[at + 1]!;
  const u16le = (at: number): number => head[at]! | (head[at + 1]! << 8);
  const u32 = (at: number): number =>
    ((head[at]! << 24) | (head[at + 1]! << 16) | (head[at + 2]! << 8) | head[at + 3]!) >>> 0;
  const i32le = (at: number): number =>
    (head[at]! | (head[at + 1]! << 8) | (head[at + 2]! << 16) | (head[at + 3]! << 24)) | 0;
  // PNG: 8-byte signature, then IHDR's width/height at 16 and 20.
  if (head.length >= 24 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { width: u32(16), height: u32(20) };
  }
  // GIF: "GIF87a"/"GIF89a", little-endian screen descriptor.
  if (head.length >= 10 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
    return { width: u16le(6), height: u16le(8) };
  }
  // BMP: "BM", DIB header size at 14; CORE (12) uses u16, the rest i32.
  if (head.length >= 26 && head[0] === 0x42 && head[1] === 0x4d) {
    const dib = (head[14]! | (head[15]! << 8) | (head[16]! << 16) | (head[17]! << 24)) >>> 0;
    if (dib === 12) return { width: u16le(18), height: u16le(20) };
    return { width: Math.abs(i32le(18)), height: Math.abs(i32le(22)) };
  }
  // WebP: RIFF....WEBP, then VP8X (canvas size minus one, 24-bit LE at 24/27)
  // or the lossy/lossless chunk headers. WebP was accepted by the picker but
  // had no branch here, so a 16383² image decoded before any refusal (sec-r9 #3).
  if (head.length >= 30 && head[0] === 0x52 && head[1] === 0x49 &&
      head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    const chunk = String.fromCharCode(head[12]!, head[13]!, head[14]!, head[15]!);
    const u24le = (at: number): number => head[at]! | (head[at + 1]! << 8) | (head[at + 2]! << 16);
    if (chunk === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === "VP8L" && head.length >= 25) {
      const b0 = head[21]!, b1 = head[22]!, b2 = head[23]!, b3 = head[24]!;
      return {
        width: ((b1 & 0x3f) << 8 | b0) + 1,
        height: ((b3 & 0x0f) << 10 | b2 << 2 | (b1 & 0xc0) >> 6) + 1,
      };
    }
  }
  // JPEG: walk the segment chain to the first Start Of Frame.
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let at = 2;
    while (at + 9 <= head.length) {
      if (head[at] !== 0xff) { at++; continue; }
      const marker = head[at + 1]!;
      at += 2;
      if (marker === 0xff) { at--; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda) break;
      const len = u16(at);
      if (len < 2) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && at + 7 <= head.length) {
        return { width: u16(at + 5), height: u16(at + 3) };
      }
      at += len;
    }
  }
  return null;
}

export function imageImportRefusal(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return "That file does not contain a picture with a usable size.";
  }
  if (width > MAX_DIM || height > MAX_DIM) {
    return `Pictures can be up to ${MAX_DIM} px per side. This one is ${Math.round(width)} x ${Math.round(height)}.`;
  }
  if (width * height > MAX_PIXELS) {
    const mp = Math.round((width * height) / 1e6);
    return `Pictures can be up to ${MAX_PIXELS / 1e6} megapixels. This one is ${mp}.`;
  }
  return null;
}

/**
 * A size ceiling alone does not bound JSON: 190 MB of `[[],[],…]` is millions of
 * arrays and parses into gigabytes before any layer validation runs (sec-r11).
 * Count the structural tokens first and refuse an implausible shape.
 */
export function jsonShapeRefusal(text: string): string | null {
  if (text.length <= MAX_JSON_BYTES) {
    let tokens = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 91 || c === 123) { // [ or {
        if (++tokens > MAX_JSON_TOKENS) {
          return `That project has more than ${MAX_JSON_TOKENS.toLocaleString("en-US")} arrays or objects, which is not a document Guazzo wrote.`;
        }
      }
    }
  }
  return null;
}

export function jsonImportRefusal(bytes: number): string | null {
  if (bytes <= MAX_JSON_BYTES) return null;
  return `Project files can be up to ${MAX_JSON_BYTES / (1024 * 1024)} MB. This one is ${Math.round(bytes / (1024 * 1024))} MB.`;
}

export type DocUnit = "px" | "in" | "cm" | "mm" | "pt" | "pica";

export const UNIT_LABELS: Record<DocUnit, string> = {
  px: "Pixels",
  in: "Inches",
  cm: "Centimeters",
  mm: "Millimeters",
  pt: "Points",
  pica: "Picas",
};

export const UNIT_ORDER: DocUnit[] = ["px", "in", "cm", "mm", "pt", "pica"];

/** How many pixels one unit spans at a given resolution. */
export function unitToPx(value: number, unit: DocUnit, dpi: number): number {
  switch (unit) {
    case "px": return value;
    case "in": return value * dpi;
    case "cm": return (value * dpi) / 2.54;
    case "mm": return (value * dpi) / 25.4;
    case "pt": return (value * dpi) / 72;
    case "pica": return (value * dpi) / 6;
  }
}

/** Inverse of {@link unitToPx}; safe for a zero resolution. */
export function pxToUnit(value: number, unit: DocUnit, dpi: number): number {
  const per = unitToPx(1, unit, dpi);
  return per === 0 ? value : value / per;
}

/** Canvas pixels for a width/height pair, clamped to what the engine accepts. */
export function dimensionsToPixels(
  width: number,
  height: number,
  unit: DocUnit,
  dpi: number,
  limit = MAX_DIM,
): [number, number] {
  const w = Math.round(unitToPx(width, unit, dpi));
  const h = Math.round(unitToPx(height, unit, dpi));
  const clamp = (v: number): number => (Number.isFinite(v) ? Math.min(limit, Math.max(1, v)) : 1);
  return [clamp(w), clamp(h)];
}

/** Human-readable footprint, the way Photoshop shows "Image Size". */
export function imageSizeMb(width: number, height: number): string {
  const mb = (width * height * 4) / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export interface DocPreset {
  name: string;
  w: number;
  h: number;
  unit: DocUnit;
  dpi: number;
}

/** First entry is what the dialog opens with — kept small on purpose. */
export const BUILTIN_PRESETS: DocPreset[] = [
  { name: "Default Photoshop Size", w: 7, h: 5, unit: "in", dpi: 300 },
  { name: "Landscape, 13 × 19", w: 19, h: 13, unit: "in", dpi: 300 },
  { name: "Portrait, 13 × 19", w: 13, h: 19, unit: "in", dpi: 300 },
  { name: "U.S. Paper, 8.5 × 11", w: 8.5, h: 11, unit: "in", dpi: 300 },
  { name: "A4, 210 × 297 mm", w: 210, h: 297, unit: "mm", dpi: 300 },
  { name: "Web, 1920 × 1080", w: 1920, h: 1080, unit: "px", dpi: 72 },
  { name: "Web, 1280 × 720", w: 1280, h: 720, unit: "px", dpi: 72 },
  { name: "Square, 2048 × 2048", w: 2048, h: 2048, unit: "px", dpi: 72 },
];

/** Accepts anything (JSON out of localStorage) and keeps only usable presets. */
export function sanitisePresets(input: unknown, max = 40): DocPreset[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: DocPreset[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Partial<DocPreset>;
    if (typeof p.name !== "string" || !p.name.trim()) continue;
    if (typeof p.w !== "number" || !(p.w > 0)) continue;
    if (typeof p.h !== "number" || !(p.h > 0)) continue;
    if (typeof p.dpi !== "number" || !(p.dpi > 0)) continue;
    if (typeof p.unit !== "string" || !(p.unit in UNIT_LABELS)) continue;
    const name = p.name.trim().slice(0, 60);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, w: p.w, h: p.h, unit: p.unit as DocUnit, dpi: Math.round(p.dpi) });
    if (out.length >= max) break;
  }
  return out;
}
