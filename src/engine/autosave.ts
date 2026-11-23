/**
 * Crash-recovery snapshots, distinct from the user-facing .guazzo.json format.
 *
 * v1 was one deflated JSON string. That is fine until a 4096² document with
 * eight layers makes `JSON.stringify` ask V8 for a string larger than its
 * ~512 MB ceiling: autosave then throws `RangeError: Invalid string length`
 * forever, exactly for the sessions that most need crash recovery.
 *
 * v2 keeps the metadata as JSON but writes pixels as binary tile records:
 *
 *   u8 version=2, "GZAS", u32 metadataByteLength, deflated metadata
 *   repeat: u8 1, u32 tab, u32 flatLayer, u8 kind(0 pixels,1 mask),
 *           u32 deflatedLength, deflated tile frames
 *   u8 0xff end
 *
 * A tile frame is `u16 tx, u16 ty, u32 byteLength, RGBA bytes`; the first
 * decompressed frame also starts with a `u32 tileCount`. Each layer is its own
 * deflate stream and the encoder yields between ~2 MB slices, so no single
 * synchronous step builds the whole snapshot (or blocks the editor for long).
 */

import type { Document, Layer } from "./document.ts";
import { TILE_BYTES, type TileGrid } from "./tile.ts";
import { deserializeProject, serializeProjectMeta, type ProjectJson } from "./io.ts";

export const AUTOSAVE_SNAPSHOT_VERSION = 2;
export const AUTOSAVE_V1_SNAPSHOT_VERSION = 1;
export const AUTOSAVE_IDLE_MS = 2_000;
export const AUTOSAVE_MAX_WAIT_MS = 30_000;

/** tiles per encoder slice; 8 × 256 KB ≈ 2 MB */
export const AUTOSAVE_TILES_PER_SLICE = 8;
export const AUTOSAVE_SLICE_BYTES = AUTOSAVE_TILES_PER_SLICE * (8 + TILE_BYTES) + 4;
/** 8192 × 256 KB = 2 GB of pixels. The v1 path's 1024-tile project cap would
 *  reject the 8 × 4096² session this format exists to recover. */
/**
 * The crash snapshot is binary, so it is not bounded by the base64 text budget
 * `MAX_PROJECT_TILES` describes. A document too large to save can still be
 * recovered here — which is the point of a crash snapshot.
 */
export const MAX_AUTOSAVE_TILES = 8192;

const MAGIC = [0x47, 0x5a, 0x41, 0x53]; // GZAS
const HEADER_BYTES = 9;
const MAX_META_BYTES = 16 * 1024 * 1024;
const MAX_TABS = 32;
const MAX_COMPRESSED_RECORD_BYTES = 512 * 1024 * 1024;
/** The tab list is text; 16 MB is far past any honest snapshot. */
const MAX_AUTOSAVE_META_BYTES = 16 * 1024 * 1024;

export type AutosaveTimer = ReturnType<typeof setTimeout>;
export interface AutosaveClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): AutosaveTimer;
  clearTimeout(id: AutosaveTimer): void;
}

const systemClock: AutosaveClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export interface AutosaveTabInput {
  name: string;
  doc: Document;
}

export interface AutosaveSnapshotInput {
  savedAt: number;
  active: number;
  tabs: readonly AutosaveTabInput[];
}

export interface AutosaveRestoredTab {
  name: string;
  restored: Document;
  warnings: string[];
}

export interface AutosaveRestoredSnapshot {
  savedAt: number;
  active: number;
  tabs: AutosaveRestoredTab[];
}

export interface AutosaveEncodeOptions {
  /**
   * Called once per yielded slice with its raw byte count. Tests use this to
   * prove the writer never hands one giant slice to the event loop; the app
   * does not need it.
   */
  onSlice?: (bytes: number) => void;
}

interface AutosaveMeta {
  savedAt: number;
  active: number;
  tabs: { name: string; project: ProjectJson }[];
}

interface AutosaveTile {
  tx: number;
  ty: number;
  data: Uint8ClampedArray;
}

function writeU32(out: Uint8Array, at: number, value: number): void {
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(at, value, true);
}

function readAutosaveU32(bytes: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > bytes.byteLength) throw new Error("autosave: truncated snapshot");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function deflateBytes(input: Uint8Array): Promise<Uint8Array> {
  const compressed = await new Response(
    new Blob([input as BlobPart]).stream().pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

/** A tile record's inflated size is declared by its own leading count.
 *  Exported for the corruption test: a bomb must fail before it allocates. */
export async function inflateTileRecord(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let count = -1;
  let limit = 4 + 8 + TILE_BYTES;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (count < 0 && total >= 4) {
        const head = new Uint8Array(4);
        let got = 0;
        outer: for (const c of chunks) {
          for (let i = 0; i < c.byteLength; i++) {
            head[got++] = c[i]!;
            if (got === 4) break outer;
          }
        }
        count = readAutosaveU32(head, 0);
        if (count > 4096) throw new Error("autosave: tile record is too large");
        limit = 4 + count * (8 + TILE_BYTES);
      }
      if (total > limit) throw new Error("autosave: tile record inflates beyond its declared size");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** Decompress with a ceiling. `inflateBytes` was unbounded, so a deflate bomb
 *  inherited from a 512 MB record could allocate tens of gigabytes before the
 *  tile budget noticed anything. The caller knows how large the record is
 *  allowed to be; anything past that is corruption, not data. */
async function inflateBytesBounded(input: Uint8Array, limit: number, label: string): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      total += chunk.byteLength;
      if (total > limit) throw new Error(`${label}: inflates beyond its declared size`);
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** v1 encoder, kept so a test can prove old snapshots still decode. */
export async function encodeAutosaveSnapshotV1(json: string): Promise<Uint8Array> {
  const compressed = await deflateBytes(new TextEncoder().encode(json));
  const out = new Uint8Array(compressed.byteLength + 1);
  out[0] = AUTOSAVE_V1_SNAPSHOT_VERSION;
  out.set(compressed, 1);
  return out;
}

/** Read a v1 snapshot, or return null when this is not a v1 file. */
export async function decodeAutosaveSnapshotV1(bytes: Uint8Array): Promise<string | null> {
  if (bytes[0] !== AUTOSAVE_V1_SNAPSHOT_VERSION) return null;
  const plain = await inflateBytesBounded(bytes.subarray(1), MAX_AUTOSAVE_META_BYTES, "autosave");
  return new TextDecoder().decode(plain);
}

function collectTiles(grid: TileGrid): AutosaveTile[] {
  const tiles: AutosaveTile[] = [];
  grid.forEachTile((tile, tx, ty) => {
    tiles.push({ tx, ty, data: tile.data });
  });
  return tiles;
}

/**
 * Deflate one layer's tiles without ever building the layer as one buffer.
 * Each pull enqueues at most AUTOSAVE_TILES_PER_SLICE and then yields, so the
 * peak allocation is one ~2 MB frame plus whatever the compressor buffers.
 */
async function encodeLayerStream(
  tiles: readonly AutosaveTile[],
  onSlice?: (bytes: number) => void,
): Promise<Uint8Array> {
  const compressor = new CompressionStream("deflate");
  const writer = compressor.writable.getWriter();
  const reader = compressor.readable.getReader();
  const chunks: Uint8Array[] = [];
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) chunks.push(value);
    }
  })();

  let index = 0;
  while (index < tiles.length) {
    const end = Math.min(tiles.length, index + AUTOSAVE_TILES_PER_SLICE);
    const first = index === 0;
    let size = first ? 4 : 0;
    for (let i = index; i < end; i++) size += 8 + TILE_BYTES;
    const frame = new Uint8Array(size);
    const view = new DataView(frame.buffer);
    let at = 0;
    if (first) {
      view.setUint32(0, tiles.length, true);
      at = 4;
    }
    for (let i = index; i < end; i++) {
      const tile = tiles[i]!;
      view.setUint16(at, tile.tx, true);
      view.setUint16(at + 2, tile.ty, true);
      view.setUint32(at + 4, tile.data.byteLength, true);
      frame.set(tile.data, at + 8);
      at += 8 + tile.data.byteLength;
    }
    index = end;
    await writer.write(frame);
    onSlice?.(frame.byteLength);
    await yieldToEventLoop();
  }
  await writer.close();
  await readAll;
  return concat(chunks);
}

async function pushLayerRecord(
  out: Uint8Array[],
  tab: number,
  layer: number,
  kind: 0 | 1,
  tiles: readonly AutosaveTile[],
  onSlice?: (bytes: number) => void,
): Promise<void> {
  const compressed = await encodeLayerStream(tiles, onSlice);
  if (compressed.byteLength > MAX_COMPRESSED_RECORD_BYTES) {
    throw new Error("autosave: one layer compressed beyond the snapshot limit");
  }
  const header = new Uint8Array(14);
  header[0] = 1;
  writeU32(header, 1, tab);
  writeU32(header, 5, layer);
  header[9] = kind;
  writeU32(header, 10, compressed.byteLength);
  out.push(header, compressed);
}

/**
 * Encode metadata + per-layer binary records. The metadata still goes through
 * JSON.stringify, but it contains no pixels: even 2000 layers is a few MB of
 * strings, not a 512 MB single allocation.
 */
export async function encodeAutosaveSnapshotV2(
  snapshot: AutosaveSnapshotInput,
  options: AutosaveEncodeOptions = {},
): Promise<Uint8Array> {
  const meta: AutosaveMeta = {
    savedAt: snapshot.savedAt,
    active: snapshot.active,
    tabs: snapshot.tabs.map((tab) => ({
      name: tab.name,
      project: serializeProjectMeta(tab.doc, tab.name),
    })),
  };
  const metaText = new TextEncoder().encode(JSON.stringify(meta));
  if (metaText.byteLength > MAX_META_BYTES) {
    throw new Error("autosave: snapshot metadata is too large");
  }
  const metaCompressed = await deflateBytes(metaText);
  if (metaCompressed.byteLength > MAX_META_BYTES) {
    throw new Error("autosave: compressed snapshot metadata is too large");
  }
  const out: Uint8Array[] = [];
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = AUTOSAVE_SNAPSHOT_VERSION;
  header.set(MAGIC, 1);
  writeU32(header, 5, metaCompressed.byteLength);
  out.push(header, metaCompressed);
  options.onSlice?.(HEADER_BYTES + metaCompressed.byteLength);

  for (let tabIndex = 0; tabIndex < snapshot.tabs.length; tabIndex++) {
    const flat = snapshot.tabs[tabIndex]!.doc.allLayers();
    for (let layerIndex = 0; layerIndex < flat.length; layerIndex++) {
      const layer: Layer = flat[layerIndex]!;
      const pixels = collectTiles(layer.grid);
      if (pixels.length > 0) {
        await pushLayerRecord(out, tabIndex, layerIndex, 0, pixels, options.onSlice);
      }
      if (layer.mask) {
        const mask = collectTiles(layer.mask);
        if (mask.length > 0) {
          await pushLayerRecord(out, tabIndex, layerIndex, 1, mask, options.onSlice);
        }
      }
    }
  }
  out.push(new Uint8Array([0xff]));
  return concat(out);
}

function applyTileRecord(
  payload: Uint8Array,
  grid: TileGrid,
  spendTile: () => void,
): void {
  if (payload.byteLength < 4) throw new Error("autosave: truncated tile record");
  const count = readAutosaveU32(payload, 0);
  if (count > 4096) throw new Error("autosave: tile record is too large");
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 8 > payload.byteLength) throw new Error("autosave: truncated tile frame");
    const tx = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(at, true);
    const ty = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(at + 2, true);
    const length = readAutosaveU32(payload, at + 4);
    at += 8;
    if (length !== TILE_BYTES || at + length > payload.byteLength) {
      throw new Error("autosave: bad tile length");
    }
    if (tx >= grid.cols || ty >= grid.rows) throw new Error("autosave: tile is outside the document");
    spendTile();
    const tile = grid.tile(tx, ty, true);
    if (!tile) throw new Error("autosave: tile could not be allocated");
    tile.data.set(payload.subarray(at, at + length));
    tile.version++;
    at += length;
  }
  if (at !== payload.byteLength) throw new Error("autosave: trailing bytes in tile record");
}

/**
 * Decode a v2 snapshot. Returns null when the bytes are not v2 (v1 files are
 * handled separately); corrupt v2 data throws a descriptive error rather than
 * being mistaken for a usable snapshot.
 */
export async function decodeAutosaveSnapshotV2(
  bytes: Uint8Array,
): Promise<AutosaveRestoredSnapshot | null> {
  if (bytes.byteLength === 0 || bytes[0] !== AUTOSAVE_SNAPSHOT_VERSION) return null;
  if (
    bytes.byteLength < HEADER_BYTES ||
    bytes[1] !== MAGIC[0] || bytes[2] !== MAGIC[1] || bytes[3] !== MAGIC[2] || bytes[4] !== MAGIC[3]
  ) {
    throw new Error("autosave: snapshot header is damaged — not restored");
  }
  const metaLength = readAutosaveU32(bytes, 5);
  if (metaLength > MAX_META_BYTES || HEADER_BYTES + metaLength > bytes.byteLength) {
    throw new Error("autosave: snapshot metadata is damaged — not restored");
  }
  const metaEnd = HEADER_BYTES + metaLength;
  const metaText = new TextDecoder().decode(await inflateBytesBounded(bytes.subarray(HEADER_BYTES, metaEnd), MAX_AUTOSAVE_META_BYTES, "autosave"));
  let raw: unknown;
  try {
    raw = JSON.parse(metaText);
  } catch {
    throw new Error("autosave: snapshot metadata is not valid JSON — not restored");
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error("autosave: snapshot metadata is damaged — not restored");
  }
  const meta = raw as Partial<AutosaveMeta>;
  if (typeof meta.savedAt !== "number" || !Array.isArray(meta.tabs)) {
    throw new Error("autosave: snapshot metadata is incomplete — not restored");
  }
  if (meta.tabs.length > MAX_TABS) {
    throw new Error("autosave: snapshot has too many tabs — not restored");
  }
  const tabs: AutosaveRestoredTab[] = [];
  for (const value of meta.tabs) {
    if (value === null || typeof value !== "object") {
      throw new Error("autosave: snapshot tab is damaged — not restored");
    }
    const tab = value as { name?: unknown; project?: unknown };
    const loaded = deserializeProject(tab.project);
    tabs.push({
      name: typeof tab.name === "string" && tab.name ? tab.name : "Restored",
      restored: loaded.doc,
      warnings: loaded.warnings,
    });
  }
  const flat = tabs.map((tab) => tab.restored.allLayers());
  let tiles = 0;
  const spendTile = (): void => {
    tiles++;
    if (tiles > MAX_AUTOSAVE_TILES) {
      throw new Error(`autosave: snapshot needs more than ${MAX_AUTOSAVE_TILES} tiles — not restored`);
    }
  };

  let at = metaEnd;
  let sawEnd = false;
  while (at < bytes.byteLength) {
    const type = bytes[at++]!;
    if (type === 0xff) {
      sawEnd = true;
      break;
    }
    if (type !== 1) throw new Error("autosave: unknown record in snapshot — not restored");
    if (at + 13 > bytes.byteLength) throw new Error("autosave: truncated layer record");
    const tabIndex = readAutosaveU32(bytes, at);
    const layerIndex = readAutosaveU32(bytes, at + 4);
    const kind = bytes[at + 8]!;
    const compressedLength = readAutosaveU32(bytes, at + 9);
    at += 13;
    if (kind !== 0 && kind !== 1) throw new Error("autosave: bad layer record kind");
    if (compressedLength === 0 || compressedLength > MAX_COMPRESSED_RECORD_BYTES) {
      throw new Error("autosave: bad layer record size");
    }
    if (at + compressedLength > bytes.byteLength) {
      throw new Error("autosave: truncated layer record payload");
    }
    const layer = flat[tabIndex]?.[layerIndex];
    if (!layer) throw new Error("autosave: layer record points outside the document");
    // The record starts with the tile count, so its exact inflated size is
    // known from those four bytes: 4 + count * (8 header + TILE_BYTES).
    const payload = await inflateTileRecord(bytes.subarray(at, at + compressedLength));
    at += compressedLength;
    if (kind === 0) {
      applyTileRecord(payload, layer.grid, spendTile);
    } else {
      const mask = tabs[tabIndex]!.restored.attachMask(layer);
      applyTileRecord(payload, mask, spendTile);
    }
  }
  if (!sawEnd) throw new Error("autosave: snapshot is missing its end marker");
  if (at !== bytes.byteLength) throw new Error("autosave: trailing bytes after snapshot end");
  return {
    savedAt: meta.savedAt,
    active: typeof meta.active === "number" && meta.active >= 0 && meta.active < tabs.length
      ? Math.floor(meta.active)
      : 0,
    tabs,
  };
}

/**
 * Idle debounce with a hard ceiling. Every edit restarts a 2 s timer; if edits
 * keep arriving the write is forced at 30 s after the first unsaved edit. The
 * write runs outside the timer callback so a failed or slow write cannot make
 * the next edit wait for it. A failure can schedule its own backoff retry.
 */
export class AutosaveScheduler {
  private timer: AutosaveTimer | null = null;
  private firstEditAt: number | null = null;
  private lastEditAt = 0;
  private inFlight = false;
  private pending = false;
  private readonly write: () => Promise<unknown> | unknown;
  private readonly clock: AutosaveClock;

  constructor(
    write: () => Promise<unknown> | unknown,
    clock: AutosaveClock = systemClock,
  ) {
    this.write = write;
    this.clock = clock;
  }

  /** Call on every content-changing edit. */
  noteEdit(): void {
    const now = this.clock.now();
    if (this.firstEditAt === null) this.firstEditAt = now;
    this.lastEditAt = now;
    this.arm();
  }

  /** Used after a failed write; an edit in the meantime wins and re-arms. */
  retryAfter(ms: number): void {
    this.clearTimer();
    this.firstEditAt = null;
    this.lastEditAt = 0;
    this.pending = false;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, Math.max(0, ms));
  }

  private arm(): void {
    this.clearTimer();
    if (this.firstEditAt === null) return;
    const now = this.clock.now();
    const idle = Math.max(0, this.lastEditAt + AUTOSAVE_IDLE_MS - now);
    const cap = Math.max(0, this.firstEditAt + AUTOSAVE_MAX_WAIT_MS - now);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, Math.min(idle, cap));
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async fire(): Promise<void> {
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.inFlight = true;
    const firedAt = this.clock.now();
    // An edit exactly at the deadline belongs to the next 30 s window too: keep
    // it as that window's anchor so a continuous stream writes every 30 s, not
    // 30 s plus the first second after the previous write.
    this.firstEditAt = this.lastEditAt === firedAt ? firedAt : null;
    this.lastEditAt = 0;
    try {
      await this.write();
    } finally {
      this.inFlight = false;
      if (this.pending) {
        this.pending = false;
        if (this.firstEditAt !== null) this.arm();
      }
    }
  }
}
