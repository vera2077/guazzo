/**
 * io.ts — native project format v1 (".guazzo.json").
 *
 * Single JSON file: manifest + every allocated tile as base64.
 * Tauri pass will split tiles into binary blobs on disk; v1 keeps
 * everything in one file so the browser dev build can round-trip via
 * plain File API without any dependencies.
 */

import { TILE, TILE_BYTES } from "./tile.ts";
import { Document, type Layer, type TextLayerMeta, type TextSeg } from "./document.ts";
import type { AdjustSpec } from "./adjustfn.ts";
import { normalizeLayerEffects, type LayerEffects } from "./effects.ts";
import type { TileGrid } from "./tile.ts";
import { MAX_DIM, MAX_GROUP_DEPTH, MAX_JSON_BYTES, MAX_PIXELS } from "./docmeta.ts";
import { LAYER_BLEND_MODES, type BlendMode } from "./blend.ts";
import { normalizeFillGradient, type FillGradientSpec } from "./fillgradient.ts";
import { normalizeFillPattern, type FillPattern } from "./fillpattern.ts";

const MAX_PROJECT_LAYERS = 2000;
/** ceiling for one layer's tile list: a 16k² canvas needs at most 4096 tiles */
const MAX_TILES_PER_LAYER = 4096;
/**
 * AT1: a per-layer ceiling is not a ceiling on anything. 2000 layers x 4096 tiles is
 * 8.19 million tiles of 262,144 bytes — 2.1 TB asked for by a 219 MB file, because
 * `grid.tile(tx, ty, true)` allocates before the base64 is even decoded.
 *
 * 512 tiles is 128 MB of pixels, written as 512 x 349,528 B = 179 MB of base64
 * text, under `MAX_JSON_BYTES` (192 MB). The number is a literal because the
 * single-file bundle inlines modules in order and reading `MAX_JSON_BYTES` at
 * module scope here hit its temporal dead zone (io.js loads before docmeta.js);
 * `projectByteEstimate` and the test "tile budget and import budget are the same
 * number" keep the three numbers in step. The crash snapshot is binary and
 * accepts more (`MAX_AUTOSAVE_TILES`), which is why a very large document can be
 * recovered after a crash but must be flattened before it is saved (sec-r5: the
 * save path used to accept it, report "Saved", and then the loader refused to
 * open it).
 */
export const MAX_PROJECT_TILES = 512;

/** Every node in a raw layer tree, groups included. The cap is about nodes: a
 *  PSD with 2000 leaves in a few groups must be refused on load for the same
 *  reason a flat 2000 does, and a document at the cap must still round-trip. */
function countNodes(list: readonly unknown[]): number {
  // Iterative: a file is a file, and a 5 000-level chain used to spend the JS
  // call stack before the loader ever got to flatten it (sec-r19 F3).
  let n = 0;
  const stack: unknown[][] = [list as unknown[]];
  while (stack.length > 0) {
    const level = stack.pop()!;
    for (const raw of level) {
      // A hand-edited file can hold nulls; the user must see the format error,
      // not "Cannot read properties of null (reading 'children')" (code-r15 #6).
      if (!raw || typeof raw !== "object") throw new Error("session: a layer entry is not an object");
      const l = raw as LayerJson;
      n++;
      if (Array.isArray(l.children) && l.children.length > 0) stack.push(l.children as unknown[]);
    }
  }
  return n;
}

/** How many 256 px tiles a document needs, across every layer and mask. */
export function projectTileCount(doc: Document): number {
  let n = 0;
  const count = (layers: Layer[]): void => {
    for (const l of layers) {
      l.grid.forEachTile(() => { n++; });
      if (l.mask) l.mask.forEachTile(() => { n++; });
      if (l.children) count(l.children);
    }
  };
  count(doc.layers);
  return n;
}

/** Base64 text one tile costs, used to keep the tile and byte budgets equal. */
export function projectByteEstimate(tiles: number): number {
  return tiles * 349_528;
}

/**
 * Base64 bytes the smart-object sources add to a project file. They are not
 * tiles — a 20 MP smart object is 320 tiles' worth of pixels but arrives as one
 * base64 blob — so the tile ceiling alone would let a document save and then
 * refuse to open on the byte ceiling.
 */
export function projectSmartBytes(doc: Document): number {
  let bytes = 0;
  const walk = (layers: Layer[]): void => {
    for (const l of layers) {
      if (l.smart) bytes += Math.ceil((l.smart.width * l.smart.height * 4 * 4) / 3);
      if (l.children) walk(l.children);
    }
  };
  walk(doc.layers);
  return bytes;
}

/** The message a save shows when a document is past the shared ceiling. */
export function projectTileRefusal(tiles: number, smartBytes = 0): string | null {
  const overTiles = tiles > MAX_PROJECT_TILES;
  const bytes = projectByteEstimate(tiles) + smartBytes;
  if (!overTiles && bytes <= MAX_JSON_BYTES) return null;
  const mb = (n: number) => `${Math.round(n / (1024 * 1024)).toLocaleString()} MB`;
  return `This document needs ${tiles.toLocaleString()} tile slots and ${mb(bytes)} with its smart-object sources; Guazzo saves up to ${MAX_PROJECT_TILES.toLocaleString()} slots and ${mb(MAX_JSON_BYTES)}. Merge or flatten layers, reduce the canvas, or rasterize a smart object, then save again.`;
}

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
    ...(layer.kind === "group" ? { children: (layer.children ?? []).map((child) => serializeLayer(child, includePixels, includeSmart)) } : {}),
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
  // A text recipe is a size that reaches canvas allocation. The PSD side has
  // clamped this for years (psd.ts); the project loader did not, so `"size":
  // 1e9` made the rasteriser ask for a canvas past the browser's 65535 cap and
  // threw mid-load (sec-r17 F2). Clamp here, like the importer does.
  const clamp = (n: unknown, lo: number, hi: number): number | null => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
  };
  const size = clamp(m.size, 1, 1000);
  const x = clamp(m.x, -MAX_DIM, MAX_DIM);
  const y = clamp(m.y, -MAX_DIM, MAX_DIM);
  const w = clamp(m.w, 1, MAX_DIM);
  const h = clamp(m.h, 1, MAX_DIM);
  if (size === null || x === null || y === null || w === null || h === null) return null;
  const wrap = typeof m.wrap === "number" && m.wrap > 0 ? clamp(m.wrap, 1, MAX_DIM) : null;
  const boxH = typeof m.boxH === "number" && m.boxH > 0 ? clamp(m.boxH, 1, MAX_DIM) : null;
  return {
    lines,
    x,
    y,
    w,
    h,
    ...(wrap !== null ? { wrap } : {}),
    ...(boxH !== null ? { boxH } : {}),
    ...(m.align === "center" || m.align === "right" || m.align === "justify" ? { align: m.align } : {}),
    size,
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

export function deserializeProject(
  json: unknown,
  spendShared?: () => void,
  spendLayer?: () => void,
): ProjectLoad {
  // AT1: decoded tiles are counted across the whole file, masks included.
  let tilesDecoded = 0;
  const spendTile = (): void => {
    tilesDecoded++;
    if (tilesDecoded > MAX_PROJECT_TILES) {
      throw new Error(
        `io: project needs more than ${MAX_PROJECT_TILES} tiles (256 MB of pixels) — refused before allocating`,
      );
    }
    // The crash snapshot shares one budget across every tab: without this a
    // 32-tab snapshot of empty tiles allocated 4 GB before saying no (sec-r8 F2).
    spendShared?.();
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
  if (j.width! * j.height! > MAX_PIXELS) {
    throw new Error(
      `io: project is too large (${j.width} × ${j.height} = ${Math.round((j.width! * j.height!) / 1e6)} MP) — ` +
        `the pixel limit is ${MAX_PIXELS / 1e6} MP`,
    );
  }
  const doc = new Document(j.width, j.height);
  const warnings: string[] = [];
  if (typeof j.version === "number" && j.version < PROJECT_VERSION) {
    warn(warnings, `file format v${j.version} was upgraded to v${PROJECT_VERSION}`);
  }
  // PSD fidelity step 1: groups are recursive, so loading is too. `parent`
  // decides where a node lands; `null` means the top-level stack.
  const loadInto = (list: LayerJson[], parent: Layer | null, depth = 0): void => {
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
    // One guard for the snapshot-wide layer count: tile slots are cheap to
    // name and expensive to allocate, so the caller's budget is spent here.
    spendLayer?.();
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
      if (t.data === "") { spendTile(); skipped++; continue; } // empty data: counted, but nothing allocated
      spendTile();
      // Decode before allocating: a tiny file could otherwise force 512 live
      // 256 KiB tiles before the payload was known to be junk (sec-r24 #5).
      let bytes: Uint8ClampedArray;
      try {
        bytes = base64ToBytes(t.data, TILE_BYTES);
      } catch {
        skipped++; continue;
      }
      const tile = layer.grid.tile(t.tx, t.ty, true);
      if (!tile) { skipped++; continue; } // outside the grid — skip
      tile.data.set(bytes);
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
    if (isGroup) {
      // The compositor renders past MAX_GROUP_DEPTH as a flat stack, but the
      // loader must not drop what is below it: skipping the recursion deleted
      // groups *and* their pixels while the warning claimed they were kept
      // (code-r19 #4). Refuse absurd nesting instead of silently losing it.
      if (depth + 1 > 512) {
        throw new Error("project: groups nest deeper than 512 levels");
      }
      if (depth + 1 === MAX_GROUP_DEPTH + 1) {
        warn(warnings, `layer "${layer.name}": groups nest deeper than ${MAX_GROUP_DEPTH}; they are kept but render flattened`);
      }
      loadInto(l.children!, layer, depth + 1);
    }
  }
  };
  loadInto(j.layers!, null);
  return { doc, warnings };
}
