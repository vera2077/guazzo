/**
 * io.ts — native project format v1 (".guazzo.json").
 *
 * Single JSON file: manifest + every allocated tile as base64.
 * Tauri pass will split tiles into binary blobs on disk; v1 keeps
 * everything in one file so the browser dev build can round-trip via
 * plain File API without any dependencies.
 */

import { TILE } from "./tile.ts";
import { Document, type Layer, type TextLayerMeta, type TextSeg } from "./document.ts";
import type { AdjustSpec } from "./adjustfn.ts";
import type { TileGrid } from "./tile.ts";
import { MAX_DIM } from "./docmeta.ts";

const MAX_PROJECT_LAYERS = 2000;
/** ceiling for one layer's tile list: a 16k² canvas needs at most 4096 tiles */
const MAX_TILES_PER_LAYER = 4096;
import { LAYER_BLEND_MODES, type BlendMode } from "./blend.ts";

export const PROJECT_FORMAT = "guazzo-project";
export const PROJECT_VERSION = 1;

interface TileJson {
  tx: number;
  ty: number;
  /** base64 of the full TILE×TILE×4 RGBA buffer */
  data: string;
}

interface LayerJson {
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  locked: boolean;
  tiles: TileJson[];
  /** "pixel" (default), "adjust" or "fill" */
  kind?: string;
  /** text-layer recipe (optional) */
  text?: TextLayerMeta;
  /** layer mask pixels (same encoding as tiles) */
  mask?: TileJson[];
  /** clip to the alpha of the stack below */
  clip?: boolean;
  /** flat visual group id (max 24 chars) */
  group?: string;
  /** adjustment-layer recipe */
  adjust?: AdjustSpec;
  /** fill-layer colour */
  fill?: [number, number, number];
}

export interface ProjectJson {
  format: string;
  version: number;
  name: string;
  width: number;
  height: number;
  layers: LayerJson[];
}

// ---- base64 helpers (work in both browser and node ≥16) --------------------

function bytesToBase64(bytes: Uint8ClampedArray): string {
  let out = "";
  // chunk size must be a multiple of 3 so independently-encoded chunks
  // concatenate into one decodable base64 string (padding only at the end)
  const CHUNK = 3 * 0x2AAA; // 32766
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    let s = "";
    for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j]!);
    out += btoa(s);
  }
  return out;
}

function base64ToBytes(b64: string, expected: number): Uint8ClampedArray {
  const bin = atob(b64);
  if (bin.length !== expected) {
    throw new Error(`io: tile data length ${bin.length}, expected ${expected}`);
  }
  const out = new Uint8ClampedArray(expected);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- serialize ------------------------------------------------------------

/** every allocated tile of a grid, base64 encoded */
function serializeTiles(grid: TileGrid): TileJson[] {
  const tiles: TileJson[] = [];
  grid.forEachTileInRect(
    0, 0, grid.width, grid.height,
    (t, _cx, _cy, _cw, _ch, bx, by) => {
      tiles.push({ tx: bx / TILE, ty: by / TILE, data: bytesToBase64(t.data) });
    },
    false,
  );
  return tiles;
}

function serializeLayer(layer: Layer): LayerJson {
  return {
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    locked: layer.locked,
    tiles: serializeTiles(layer.grid),
    ...(layer.kind !== "pixel" ? { kind: layer.kind } : {}),
    ...(layer.textData ? { text: layer.textData } : {}),
    ...(layer.mask ? { mask: serializeTiles(layer.mask) } : {}),
    ...(layer.clipToBelow ? { clip: true } : {}),
    ...(layer.groupId ? { group: layer.groupId } : {}),
    ...(layer.adjust ? { adjust: layer.adjust } : {}),
    ...(layer.fill ? { fill: layer.fill.color } : {}),
  };
}

/** validate a text-layer recipe from a file; null = drop it, keep the pixels */
function parseSeg(s: unknown): TextSeg | null {
  if (!s || typeof s !== "object") return null;
  const sg = s as Record<string, unknown>;
  if (typeof sg.text !== "string") return null;
  return {
    text: sg.text,
    bold: sg.bold === true,
    italic: sg.italic === true,
    underline: sg.underline === true,
    strike: sg.strike === true,
    font: typeof sg.font === "string" ? sg.font : "Arial",
  };
}

function parseTextMeta(v: unknown): TextLayerMeta | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (
    typeof m.x !== "number" || typeof m.y !== "number" ||
    typeof m.w !== "number" || typeof m.h !== "number" ||
    typeof m.size !== "number" || !Array.isArray(m.color) || m.color.length !== 3
  ) return null;
  // current shape: lines = TextSeg[][]; legacy shape (v0.3.1/0.3.2 files): segs = one line
  const lines: TextSeg[][] = [];
  if (Array.isArray(m.lines)) {
    for (const ln of m.lines) {
      if (!Array.isArray(ln)) return null; // junk line → drop whole recipe
      const segs: TextSeg[] = [];
      for (const s of ln) {
        const sg = parseSeg(s);
        if (!sg) return null;
        segs.push(sg);
      }
      lines.push(segs);
    }
  } else if (Array.isArray(m.segs)) {
    const segs: TextSeg[] = [];
    for (const s of m.segs) {
      const sg = parseSeg(s);
      if (!sg) return null;
      segs.push(sg);
    }
    lines.push(segs);
  } else return null;
  const c = m.color as unknown[];
  return {
    lines,
    x: m.x,
    y: m.y,
    w: m.w,
    h: m.h,
    ...(typeof m.wrap === "number" && m.wrap > 0 ? { wrap: m.wrap } : {}),
    ...(typeof m.boxH === "number" && m.boxH > 0 ? { boxH: m.boxH } : {}),
    ...(m.align === "center" || m.align === "right" || m.align === "justify" ? { align: m.align } : {}),
    size: m.size,
    color: [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0],
  };
}

export function serializeProject(doc: Document, name = "Untitled"): ProjectJson {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name,
    width: doc.width,
    height: doc.height,
    layers: doc.layers.map(serializeLayer),
  };
}

// ---- deserialize ----------------------------------------------------------

/**
 * A repaired load is not a clean load. Every place this file coerces an
 * untrusted value (a junk tile skipped, an unknown blend mode defaulted) the
 * repair is recorded, so the caller can TELL the user instead of silently
 * returning a document that is subtly not what was saved. The old behaviour
 * was to return `Document` and say nothing, which is how a corrupted file
 * could be re-saved over and look fine.
 */
export interface ProjectLoad {
  doc: Document;
  warnings: string[];
}

const MAX_WARNINGS = 40;

function warn(warnings: string[], line: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(line);
  else if (warnings.length === MAX_WARNINGS) warnings.push("… further repairs were not listed");
}

export function deserializeProject(json: unknown): ProjectLoad {
  // Everything below reads untrusted fields. The guard order matters: a raw
  // TypeError ("cannot read length of undefined") is a crash, not a message.
  if (json === null || typeof json !== "object") throw new Error("io: not a valid guazzo project file");
  const j = json as Partial<ProjectJson>;
  const rawLayers = (j as { layers?: unknown }).layers;
  if (Array.isArray(rawLayers) && rawLayers.length > MAX_PROJECT_LAYERS) {
    throw new Error(`io: project has ${rawLayers.length} layers — the limit is ${MAX_PROJECT_LAYERS}`);
  }
  if (
    !j || typeof j !== "object" || j.format !== PROJECT_FORMAT ||
    typeof j.version !== "number" || j.version > PROJECT_VERSION ||
    typeof j.width !== "number" || typeof j.height !== "number" ||
    !Array.isArray(j.layers) || j.width <= 0 || j.height <= 0
  ) {
    throw new Error("io: not a valid guazzo project file");
  }
  if (j.width! > MAX_DIM || j.height! > MAX_DIM) {
    // the same 16384px ceiling as New Document: a bigger saved project would
    // allocate gigabytes of tile buffers and render a blank canvas
    throw new Error(`io: project is too large (${j.width} × ${j.height}) — the canvas limit is ${MAX_DIM} × ${MAX_DIM}`);
  }
  const doc = new Document(j.width, j.height);
  const warnings: string[] = [];
  if (typeof j.version === "number" && j.version < PROJECT_VERSION) {
    warn(warnings, `file format v${j.version} was upgraded to v${PROJECT_VERSION}`);
  }
  for (const l of j.layers!) {
    const kind = l.kind === "adjust" || l.kind === "fill" ? l.kind : "pixel";
    if (l.kind !== undefined && l.kind !== "pixel" && l.kind !== "adjust" && l.kind !== "fill") {
      warn(warnings, `layer "${l.name}": unknown kind "${String(l.kind)}" — loaded as a pixel layer`);
    }
    if (l.kind === "adjust" && kind === "pixel") {
      warn(warnings, `layer "${l.name}": adjustment recipe was unreadable — loaded as a pixel layer`);
    }
    if (l.kind === "fill" && kind === "pixel") {
      warn(warnings, `layer "${l.name}": fill colour was unreadable — loaded as a pixel layer`);
    }
    const layer =
      kind === "adjust" && l.adjust && typeof l.adjust === "object"
        ? doc.addAdjustLayer(l.adjust)
        : kind === "fill" && Array.isArray(l.fill) && l.fill.length === 3
          ? doc.addFillLayer([
              Number(l.fill[0]) || 0,
              Number(l.fill[1]) || 0,
              Number(l.fill[2]) || 0,
            ])
          : doc.addLayer(l.name);
    if (kind !== "pixel") layer.name = l.name;
    if (l.clip === true) layer.clipToBelow = true;
    if (typeof l.group === "string" && l.group.length > 0 && l.group.length <= 24) layer.groupId = l.group;
    layer.visible = l.visible !== false;
    if (typeof l.opacity === "number" && l.opacity >= 0 && l.opacity <= 1) {
      layer.opacity = l.opacity;
    } else {
      if (l.opacity !== undefined) {
        warn(warnings, `layer "${l.name}": opacity ${String(l.opacity)} is not 0–1 — using 100%`);
      }
      layer.opacity = 1;
    }
    if (typeof l.blendMode === "string" && LAYER_BLEND_MODES.includes(l.blendMode as BlendMode)) {
      layer.blendMode = l.blendMode as BlendMode;
    } else {
      if (l.blendMode !== undefined && l.blendMode !== "normal") {
        warn(warnings, `layer "${l.name}": unknown blend mode "${String(l.blendMode)}" — using Normal`);
      }
      layer.blendMode = "normal";
    }
    layer.locked = l.locked === true;
    const tm = parseTextMeta(l.text);
    if (tm) layer.textData = tm;
    let skipped = 0;
    // A hostile file can claim more tiles than the canvas can hold; allocating
    // them before checking is a memory bomb (a 120 KB JSON reached ~1 GiB).
    const tiles = Array.isArray(l.tiles) ? l.tiles : [];
    if (tiles.length > MAX_TILES_PER_LAYER) {
      throw new Error(`io: layer "${l.name}" has ${tiles.length} tiles — the limit is ${MAX_TILES_PER_LAYER}`);
    }
    for (const t of tiles) {
      if (
        typeof t.tx !== "number" || typeof t.ty !== "number" ||
        typeof t.data !== "string" ||
        t.tx < 0 || t.ty < 0
      ) { skipped++; continue; } // tolerate junk tiles rather than failing the whole file
      const tile = layer.grid.tile(t.tx, t.ty, true);
      if (!tile) { skipped++; continue; } // outside the grid — skip
      try {
        tile.data.set(base64ToBytes(t.data, tile.data.length));
      } catch {
        skipped++; continue; // undecodable tile — skip
      }
      tile.version++;
    }
    if (skipped > 0) {
      warn(warnings, `layer "${l.name}": ${skipped} tile${skipped === 1 ? "" : "s"} could not be restored (damaged or out of bounds)`);
    }
    if (Array.isArray(l.mask) && l.mask.length) {
      const mask = doc.attachMask(layer);
      let skippedMask = 0;
      for (const t of l.mask) {
        if (
          typeof t.tx !== "number" || typeof t.ty !== "number" ||
          typeof t.data !== "string" || t.tx < 0 || t.ty < 0
        ) { skippedMask++; continue; }
        const tile = mask.tile(t.tx, t.ty, true);
        if (!tile) { skippedMask++; continue; }
        try {
          tile.data.set(base64ToBytes(t.data, tile.data.length));
        } catch {
          skippedMask++; continue;
        }
        tile.version++;
      }
      if (skippedMask > 0) {
        warn(warnings, `layer "${l.name}": ${skippedMask} mask tile${skippedMask === 1 ? "" : "s"} could not be restored`);
      }
    }
    if (l.text !== undefined && !layer.textData && kind === "pixel") {
      warn(warnings, `layer "${l.name}": text metadata was unreadable — the pixels are kept, editing is not`);
    }
  }
  return { doc, warnings };
}
