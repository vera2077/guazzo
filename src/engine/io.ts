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
import { normalizeLayerEffects, type LayerEffects } from "./effects.ts";
import type { TileGrid } from "./tile.ts";
import { MAX_DIM } from "./docmeta.ts";

const MAX_PROJECT_LAYERS = 2000;
/** ceiling for one layer's tile list: a 16k² canvas needs at most 4096 tiles */
const MAX_TILES_PER_LAYER = 4096;
/**
 * AT1: a per-layer ceiling is not a ceiling on anything. 2000 layers × 4096 tiles is
 * 8.19 million tiles of 262,144 bytes — 2.1 TB asked for by a 219 MB file, because
 * `grid.tile(tx, ty, true)` allocates before the base64 is even decoded.
 *
 * The number is 1024 × 262,144 B = 256 MB = MAX_IMPORT_BYTES. It is written as a
 * literal because the single-file bundle inlines modules in order and reading
 * `MAX_IMPORT_BYTES` at module scope here hit its temporal dead zone (io.js loads
 * before docmeta.js). `io.test.ts` asserts the two stay in step.
 */

/** Every node in a raw layer tree, groups included. The cap is about nodes: a
 *  PSD with 2000 leaves in a few groups must be refused on load for the same
 *  reason a flat 2000 does, and a document at the cap must still round-trip. */
function countNodes(list: readonly LayerJson[]): number {
  let n = 0;
  for (const l of list) {
    n++;
    const kids = l.children;
    if (kids && kids.length > 0) n += countNodes(kids);
  }
  return n;
}

export const MAX_PROJECT_TILES = 1024;
import { LAYER_BLEND_MODES, type BlendMode } from "./blend.ts";
import { normalizeFillGradient, type FillGradientSpec } from "./fillgradient.ts";
import { normalizeFillPattern, type FillPattern } from "./fillpattern.ts";

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
  maskHide?: boolean;
  /**
   * A .guazzo.json with passThrough MUST round-trip: reopening a saved file that
   * changed an isolated group into a pass-through one would silently change the
   * picture, and nothing would report it.
   */
  passThrough?: boolean;
  /** clip to the alpha of the stack below */
  clip?: boolean;
  /** flat visual group id (max 24 chars) */
  group?: string;
  /** adjustment-layer recipe */
  adjust?: AdjustSpec;
  /** fill-layer colour */
  fill?: [number, number, number];
  /** fill-layer gradient (a live fill, not the Gradient tool's pixels) */
  fillGradient?: FillGradientSpec;
  fillPattern?: FillPattern;
  /** smart-object source: base64 RGBA plus its natural size */
  smart?: { width: number; height: number; data: string };
  /** the crash snapshot skipped this source: say so instead of losing it silently */
  smartDropped?: boolean;
  /** layer styles: the recipe, not baked pixels */
  effects?: LayerEffects;
  children?: LayerJson[];
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

function serializeLayer(layer: Layer, includePixels = true, includeSmart = includePixels): LayerJson {
  return {
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    locked: layer.locked,
    tiles: includePixels ? serializeTiles(layer.grid) : [],
    ...(layer.kind !== "pixel" ? { kind: layer.kind } : {}),
    ...(layer.textData ? { text: layer.textData } : {}),
    ...(includePixels && layer.mask ? { mask: serializeTiles(layer.mask) } : {}),
    ...(layer.maskHide ? { maskHide: true } : {}),
    ...(layer.clipToBelow ? { clip: true } : {}),
    ...(layer.groupId ? { group: layer.groupId } : {}),
    ...(layer.adjust ? { adjust: layer.adjust } : {}),
    ...(layer.fill ? { fill: layer.fill.color } : {}),
    ...(layer.fill?.gradient ? { fillGradient: layer.fill.gradient } : {}),
    ...(layer.fill?.pattern ? { fillPattern: layer.fill.pattern } : {}),
    // The source travels with the project; without it a reopened smart object
    // would silently become an ordinary raster layer. The crash snapshot passes
    // includeSmart with a byte cap, and says so per layer when it skips one.
    ...(layer.smart && (includePixels || (includeSmart && layer.smart.data.length <= SMART_META_CAP))
      ? { smart: { width: layer.smart.width, height: layer.smart.height, data: bytesToBase64(layer.smart.data) } }
      : {}),
    ...(layer.smart && !includePixels && includeSmart && layer.smart.data.length > SMART_META_CAP
      ? { smartDropped: true }
      : {}),
    ...(layer.effects ? { effects: layer.effects } : {}),
    // Groups serialize their subtree; without this a save silently flattened
    // the tree back to the children-less stack the old model had.
    ...(layer.passThrough ? { passThrough: true } : {}),
    ...(layer.kind === "group" ? { children: (layer.children ?? []).map((child) => serializeLayer(child, includePixels)) } : {}),
  };
}

/** validate a text-layer recipe from a file; null = drop it, keep the pixels */
function parseSeg(s: unknown): TextSeg | null {
  if (!s || typeof s !== "object") return null;
  const sg = s as Record<string, unknown>;
  if (typeof sg.text !== "string") return null;
  const out: TextSeg = {
    text: sg.text,
    bold: sg.bold === true,
    italic: sg.italic === true,
    underline: sg.underline === true,
    strike: sg.strike === true,
    font: typeof sg.font === "string" ? sg.font : "Arial",
  };
  // Per-run overrides are optional and must survive a save; a hostile file gets
  // the same range check a typed size does (1..1000, channels 0..255).
  if (typeof sg.size === "number" && sg.size >= 1 && sg.size <= 1000) out.size = sg.size;
  const col = sg.color;
  if (
    Array.isArray(col) && col.length === 3 &&
    col.every((v) => typeof v === "number" && v >= 0 && v <= 255)
  ) out.color = [col[0] as number, col[1] as number, col[2] as number];
  return out;
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
    layers: doc.layers.map((layer) => serializeLayer(layer)),
  };
}

/**
 * Autosave v2 metadata: the layer tree and every recipe, but no tile bytes.
 * Pixels travel as binary records instead of base64 JSON (see autosave.ts), so
 * a 4096² session does not have to build a 700 MB string before writing.
 */
export function serializeProjectMeta(doc: Document, name = "Untitled"): ProjectJson {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name,
    width: doc.width,
    height: doc.height,
    layers: doc.layers.map((layer) => serializeLayer(layer, false, true)),
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

const SMART_META_CAP = 2 * 1024 * 1024;

export function deserializeProject(json: unknown): ProjectLoad {
  // AT1: decoded tiles are counted across the whole file, masks included.
  let tilesDecoded = 0;
  const spendTile = (): void => {
    tilesDecoded++;
    if (tilesDecoded > MAX_PROJECT_TILES) {
      throw new Error(
        `io: project needs more than ${MAX_PROJECT_TILES} tiles (256 MB of pixels) — refused before allocating`,
      );
    }
  };
  // Everything below reads untrusted fields. The guard order matters: a raw
  // TypeError ("cannot read length of undefined") is a crash, not a message.
  if (json === null || typeof json !== "object") throw new Error("io: not a valid guazzo project file");
  const j = json as Partial<ProjectJson>;
  const rawLayers = (j as { layers?: unknown }).layers;
  if (Array.isArray(rawLayers) && countNodes(rawLayers) > MAX_PROJECT_LAYERS) {
    throw new Error(`io: project has ${countNodes(rawLayers)} layers — the limit is ${MAX_PROJECT_LAYERS}`);
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
  // PSD fidelity step 1: groups are recursive, so loading is too. `parent`
  // decides where a node lands; `null` means the top-level stack.
  const loadInto = (list: LayerJson[], parent: Layer | null): void => {
  for (const l of list) {
    const isGroup = l.kind === "group" && Array.isArray(l.children);
    const kind = l.kind === "adjust" || l.kind === "fill" ? l.kind : "pixel";
    if (l.kind !== undefined && l.kind !== "pixel" && l.kind !== "adjust" && l.kind !== "fill" && l.kind !== "group") {
      warn(warnings, `layer "${l.name}": unknown kind "${String(l.kind)}" — loaded as a pixel layer`);
    }
    if (l.kind === "adjust" && kind === "pixel") {
      warn(warnings, `layer "${l.name}": adjustment recipe was unreadable — loaded as a pixel layer`);
    }
    if (l.kind === "fill" && kind === "pixel") {
      warn(warnings, `layer "${l.name}": fill colour was unreadable — loaded as a pixel layer`);
    }
    const layer =
      isGroup
        ? parent
          ? doc.addGroupTo(parent, l.name)
          : doc.addGroup(l.name)
        : kind === "adjust" && l.adjust && typeof l.adjust === "object"
        ? doc.addAdjustLayer(l.adjust)
        : kind === "fill" && Array.isArray(l.fill) && l.fill.length === 3
          ? doc.addFillLayer(
              [Number(l.fill[0]) || 0, Number(l.fill[1]) || 0, Number(l.fill[2]) || 0],
              "Solid Colour",
              l.fillGradient && Array.isArray(l.fillGradient.stops) ? normalizeFillGradient(l.fillGradient) : undefined,
              l.fillPattern ? normalizeFillPattern(l.fillPattern) : undefined,
            )
          : doc.addLayer(l.name);
    if (isGroup || kind !== "pixel") layer.name = l.name;
    if (isGroup) layer.passThrough = l.passThrough === true;
    // A non-group node created while `parent` is set belongs INSIDE it: the
    // constructor helpers only know the top-level stack, so move it here. This
    // is the line that keeps a loaded tree identical to the saved one.
    if (parent && !isGroup) {
      const at = doc.layers.indexOf(layer);
      if (at >= 0) {
        doc.layers.splice(at, 1);
        (parent.children ??= []).push(layer);
      }
    }
    if (l.clip === true) layer.clipToBelow = true;
    if (l.maskHide === true) layer.maskHide = true;
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
        !Number.isInteger(t.tx) || !Number.isInteger(t.ty) ||
        t.tx < 0 || t.ty < 0
      ) { skipped++; continue; } // tolerate junk tiles rather than failing the whole file
      spendTile();
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
    if (Array.isArray(l.mask) && l.mask.length > MAX_TILES_PER_LAYER) {
      throw new Error(`io: layer "${l.name}" has ${l.mask.length} mask tiles — the limit is ${MAX_TILES_PER_LAYER}`);
    }
    if (Array.isArray(l.mask) && l.mask.length) {
      const mask = doc.attachMask(layer);
      let skippedMask = 0;
      for (const t of l.mask) {
        if (
          typeof t.tx !== "number" || typeof t.ty !== "number" ||
          typeof t.data !== "string" || !Number.isInteger(t.tx) || !Number.isInteger(t.ty) ||
          t.tx < 0 || t.ty < 0
        ) { skippedMask++; continue; }
        spendTile();
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
    if (l.smartDropped === true) {
      warn(warnings, `layer "${l.name}": smart-object source was too large for the crash snapshot — restored as pixels`);
    }
    if (l.smart && typeof l.smart.width === "number" && typeof l.smart.height === "number" && typeof l.smart.data === "string") {
      const w = l.smart.width, h = l.smart.height;
      const expected = Math.round(w) * Math.round(h) * 4;
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM || expected > 512 * 1024 * 1024) {
        warn(warnings, `layer "${l.name}": smart-object source has an impossible size — dropped`);
      } else {
        try {
          const src = base64ToBytes(l.smart.data, expected);
          layer.smart = { width: w, height: h, data: src };
        } catch {
          warn(warnings, `layer "${l.name}": smart-object source could not be decoded — the pixels are kept, the source is not`);
        }
      }
    }
    if (l.effects) {
      const fx = normalizeLayerEffects(l.effects);
      if (fx) layer.effects = fx;
      else warn(warnings, `layer "${l.name}": layer styles were unreadable — the pixels are kept, the style is not`);
    }
    if (l.text !== undefined && !layer.textData && kind === "pixel") {
      warn(warnings, `layer "${l.name}": text metadata was unreadable — the pixels are kept, editing is not`);
    }
    if (isGroup) loadInto(l.children!, layer);
  }
  };
  loadInto(j.layers!, null);
  return { doc, warnings };
}
