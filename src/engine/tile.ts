/**
 * tile.ts — sparse tile buffer backing every pixel layer.
 *
 * The document is divided into 256×256 tiles. A layer only allocates
 * tiles it has painted into, so empty layers and large canvases stay
 * cheap (GIMP/Photoshop-style sparse allocation).
 */

export const TILE = 256;
export const TILE_AREA = TILE * TILE;
export const TILE_BYTES = TILE_AREA * 4;

export interface Tile {
  data: Uint8ClampedArray; // RGBA straight alpha, row-major, tile-local
  /** bumped on every mutation; compositor uses it to skip clean tiles */
  version: number;
}

export class TileGrid {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  /** tiles[row * cols + col], undefined = fully transparent */
  private tiles: Array<Tile | undefined>;

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("TileGrid: bad dimensions");
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / TILE);
    this.rows = Math.ceil(height / TILE);
    this.tiles = new Array(this.cols * this.rows);
  }

  private index(tx: number, ty: number): number | undefined {
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return undefined;
    return ty * this.cols + tx;
  }

  /** iterate every allocated tile in the grid, in row-major order */
  forEachTile(cb: (t: Tile, tx: number, ty: number) => void): void {
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const i = this.index(tx, ty);
        if (i === undefined) continue;
        const t = this.tiles[i];
        if (t) cb(t, tx, ty);
      }
    }
  }

  /**
   * AQ3: a change stamp for cache keys. It folds (tile index, version) over the
   * allocated tiles — O(allocated), not O(pixels) — so a key can notice that a
   * layer mask was repainted without hashing a canvas.
   */
  stamp(): number {
    let h = 0x811c9dc5;
    this.forEachTile((tile, tx, ty) => {
      h = (h ^ ((ty * this.cols + tx) * 2654435761 + tile.version)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    });
    return h;
  }

  /** get (or create) the tile at tile coords (tx,ty) */
  tile(tx: number, ty: number, create = true): Tile | undefined {
    const i = this.index(tx, ty);
    if (i === undefined) return undefined;
    let t = this.tiles[i];
    if (!t && create) {
      t = { data: new Uint8ClampedArray(TILE_BYTES), version: 0 };
      this.tiles[i] = t;
    }
    return t;
  }

  /** tile coords for a document pixel */
  tileOf(x: number, y: number): { tx: number; ty: number } {
    return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) };
  }

  /** number of allocated tiles (for memory estimates / tests) */
  get allocated(): number {
    let n = 0;
    for (const t of this.tiles) if (t) n++;
    return n;
  }

  /**
   * Zero every allocated tile in place (transparent), keeping the
   * allocations. Zeroed tiles are equivalent to unallocated ones for
   * compositing, so this is the cheap way to wipe a layer without
   * re-materialising the whole document.
   */
  clearAllocated(): void {
    this.forEachTile((t) => {
      t.data.fill(0);
      t.version++;
    });
  }

  /** iterate tiles intersecting doc rect; clip is tile-local. create=true materializes empty tiles (for writers). */
  forEachTileInRect(
    x: number, y: number, w: number, h: number,
    cb: (tile: Tile, cx: number, cy: number, cw: number, ch: number, bx: number, by: number) => void,
    create = false,
  ): void {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w), y1 = Math.min(this.height, y + h);
    if (x0 >= x1 || y0 >= y1) return;
    const txa = Math.floor(x0 / TILE), tya = Math.floor(y0 / TILE);
    const txb = Math.floor((x1 - 1) / TILE), tyb = Math.floor((y1 - 1) / TILE);
    for (let ty = tya; ty <= tyb; ty++) {
      for (let tx = txa; tx <= txb; tx++) {
        const t = this.tile(tx, ty, create);
        if (!t) continue;
        const bx = tx * TILE, by = ty * TILE;
        const cx = Math.max(x0, bx) - bx, cy = Math.max(y0, by) - by;
        const cw = Math.min(x1, bx + TILE) - bx - cx;
        const ch = Math.min(y1, by + TILE) - by - cy;
        cb(t, cx, cy, cw, ch, bx, by);
      }
    }
  }

  /** fill a doc-space rect with constant RGBA */
  fillRect(x: number, y: number, w: number, h: number, rgba: readonly number[]): void {
    this.forEachTileInRect(x, y, w, h, (t, cx, cy, cw, ch, bx, by) => {
      const d = t.data;
      const r = rgba[0] ?? 0, g = rgba[1] ?? 0, b = rgba[2] ?? 0, a = rgba[3] ?? 0;
      for (let yy = 0; yy < ch; yy++) {
        let p = ((cy + yy) * TILE + cx) * 4;
        for (let xx = 0; xx < cw; xx++) {
          d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = a;
          p += 4;
        }
      }
      t.version++;
      void bx; void by;
    }, true);
  }

  /** read a doc-space rect into out (w*h*4, straight RGBA); area outside allocated tiles reads as transparent */
  readRect(x: number, y: number, w: number, h: number, out: Uint8ClampedArray): void {
    if (out.length < w * h * 4) throw new Error("readRect: buffer too small");
    out.fill(0);
    this.forEachTileInRect(x, y, w, h, (t, cx, cy, cw, ch, bx, by) => {
      const d = t.data;
      for (let yy = 0; yy < ch; yy++) {
        const srcRow = ((cy + yy) * TILE + cx) * 4;
        const dstRow = ((by + cy + yy - y) * w + (bx + cx - x)) * 4;
        out.set(d.subarray(srcRow, srcRow + cw * 4), dstRow);
      }
    });
  }

  /** copy src (w*h*4 straight RGBA, row-major) into the grid at (x,y), clipped to bounds */
  writeRect(x: number, y: number, w: number, h: number, src: Uint8ClampedArray): void {
    if (src.length < w * h * 4) throw new Error("writeRect: buffer too small");
    this.forEachTileInRect(x, y, w, h, (t, cx, cy, cw, ch, bx, by) => {
      const d = t.data;
      for (let yy = 0; yy < ch; yy++) {
        const srcRow = ((by + cy + yy - y) * w + (bx + cx - x)) * 4;
        const dstRow = ((cy + yy) * TILE + cx) * 4;
        d.set(src.subarray(srcRow, srcRow + cw * 4), dstRow);
      }
      t.version++;
    }, true);
  }
}

/** Crop a straight-RGBA buffer of width srcW to an exact w×h buffer.
 * writeRect indexes its src with stride w and demands a true w*h*4 buffer —
 * passing an oversized buffer (e.g. a clip pasted into a smaller document)
 * silently shears rows: row 1 is read from the tail of row 0. Always crop
 * first; this returns src unchanged when it is already the exact size. */
/** Crop the top-left region — kept for callers that paste from the origin. */
export function cropRGBA(src: Uint8ClampedArray, srcW: number, w: number, h: number): Uint8ClampedArray {
  return cropRGBAAt(src, srcW, 0, 0, w, h);
}

/**
 * Crop an arbitrary region. Paste needs this: when the clipboard is larger than
 * the canvas we keep the MIDDLE of it (handoff-4 X5) instead of the top-left.
 */
export function cropRGBAAt(
  src: Uint8ClampedArray, srcW: number, sx: number, sy: number, w: number, h: number,
): Uint8ClampedArray {
  if (sx === 0 && sy === 0 && srcW === w) return src;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((sy + row) * srcW + sx) * 4;
    out.set(src.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}
