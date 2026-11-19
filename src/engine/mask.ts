/**
 * SelectionMask — a sparse 1-byte-per-pixel selection alpha (0 or 255).
 *
 * Photoshop-style selections are masks, not rects: the marquee is a special
 * case, the lasso is a freehand polygon, and every paint/adjust/filter
 * operation must clip per-pixel. Mask storage mirrors TileGrid: sparse tiles
 * of TILE×TILE bytes, allocated on demand.
 */

import { TILE, type TileGrid } from "./tile.ts";

/** Minimal per-pixel clip contract used by paint/adjust/filter/gradient. */
export interface PixelMask {
  /** Selection alpha at document coordinates; 0 = not selected. */
  alphaAt(x: number, y: number): number;
}

export class SelectionMask implements PixelMask {
  readonly width: number;
  readonly height: number;
  private tiles: (Uint8Array | undefined)[];
  /** bumped on every edit, so derived geometry (the outline) can be cached */
  private rev = 0;
  private outlineCache: {
    rev: number;
    value: { h: Array<[number, number, number]>; v: Array<[number, number, number]> };
  } | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.tiles = new Array(Math.ceil(width / TILE) * Math.ceil(height / TILE));
  }

  private tileIndex(tx: number, ty: number): number {
    return ty * Math.ceil(this.width / TILE) + tx;
  }

  alphaAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const t = this.tiles[this.tileIndex(tx, ty)];
    if (!t) return 0;
    return t[(y - ty * TILE) * TILE + (x - tx * TILE)] ?? 0;
  }

  /** Public per-pixel writer: 0 clears, 255 selects, anything between feathers. */
  setAlpha(x: number, y: number, alpha: number): void {
    const v = Math.max(0, Math.min(255, Math.round(alpha)));
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const i = this.tileIndex(tx, ty);
    let t = this.tiles[i];
    if (!t) {
      if (v === 0) return; // nothing to clear in an unallocated tile
      t = new Uint8Array(TILE * TILE);
      this.tiles[i] = t;
    }
    const off = (y - ty * TILE) * TILE + (x - tx * TILE);
    if (t[off] === v) return; // no change, keep the outline cache valid
    t[off] = v;
    this.rev++;
  }

  /** Border as merged horizontal/vertical runs, for marching ants. */
  outline(): { h: Array<[number, number, number]>; v: Array<[number, number, number]> } {
    if (this.outlineCache && this.outlineCache.rev === this.rev) return this.outlineCache.value;
    const result = this.computeOutline();
    this.outlineCache = { rev: this.rev, value: result };
    return result;
  }

  private computeOutline(): { h: Array<[number, number, number]>; v: Array<[number, number, number]> } {
    const b = this.bbox();
    const h: Array<[number, number, number]> = [];
    const v: Array<[number, number, number]> = [];
    if (!b) return { h, v };
    const x1 = b.x + b.w, y1 = b.y + b.h;
    const on = (x: number, y: number): boolean => this.alphaAt(x, y) >= 128;
    // horizontal edges: rows where coverage differs from the row above
    for (let y = b.y; y <= y1; y++) {
      let run = -1;
      for (let x = b.x; x <= x1; x++) {
        const edge = x < x1 && on(x, y) !== on(x, y - 1);
        if (edge && run < 0) run = x;
        else if (!edge && run >= 0) { h.push([run, x, y]); run = -1; }
      }
    }
    // vertical edges: columns where coverage differs from the column to the left
    for (let x = b.x; x <= x1; x++) {
      let run = -1;
      for (let y = b.y; y <= y1; y++) {
        const edge = y < y1 && on(x, y) !== on(x - 1, y);
        if (edge && run < 0) run = y;
        else if (!edge && run >= 0) { v.push([run, y, x]); run = -1; }
      }
    }
    return { h, v };
  }

  private setPx(x: number, y: number, on: boolean): void {
    this.setAlpha(x, y, on ? 255 : 0);
  }

  clear(): void {
    this.rev++;
    this.tiles = new Array(this.tiles.length);
  }

  /** Iterate allocated mask tiles row-major; bx/by = tile origin in doc coords. */
  forEachTile(cb: (t: Uint8Array, tx: number, ty: number, bx: number, by: number) => void): void {
    const cols = Math.ceil(this.width / TILE);
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (!t) continue;
      cb(t, i % cols, Math.floor(i / cols), (i % cols) * TILE, Math.floor(i / cols) * TILE);
    }
  }

  isEmpty(): boolean {
    for (const t of this.tiles) if (t) return false;
    return true;
  }

  /** Bounding box of selected pixels, or null when empty. */
  bbox(): { x: number; y: number; w: number; h: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.forEachTile((t, _tx, _ty, bx, by) => {
      for (let yy = 0; yy < TILE; yy++) {
        for (let xx = 0; xx < TILE; xx++) {
          if ((t[yy * TILE + xx] ?? 0) !== 0) {
            const gx = bx + xx, gy = by + yy;
            if (gx < minX) minX = gx;
            if (gy < minY) minY = gy;
            if (gx > maxX) maxX = gx;
            if (gy > maxY) maxY = gy;
          }
        }
      }
    });
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  selectRect(x: number, y: number, w: number, h: number): void {
    const x1 = Math.max(0, Math.floor(x)), y1 = Math.max(0, Math.floor(y));
    const x2 = Math.min(this.width, Math.ceil(x + w)), y2 = Math.min(this.height, Math.ceil(y + h));
    for (let gy = y1; gy < y2; gy++) for (let gx = x1; gx < x2; gx++) this.setPx(gx, gy, true);
  }

  selectEllipse(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2, ry = h / 2;
    const x1 = Math.max(0, Math.floor(x)), y1 = Math.max(0, Math.floor(y));
    const x2 = Math.min(this.width, Math.ceil(x + w)), y2 = Math.min(this.height, Math.ceil(y + h));
    for (let gy = y1; gy < y2; gy++) {
      for (let gx = x1; gx < x2; gx++) {
        const dx = (gx + 0.5 - cx) / rx, dy = (gy + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.setPx(gx, gy, true);
      }
    }
  }

  /** Even-odd point-in-polygon rasterization at pixel centers. */
  selectPolygon(points: readonly (readonly [number, number])[]): void {
    if (points.length < 3) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    const x1 = Math.max(0, Math.floor(minX)), y1 = Math.max(0, Math.floor(minY));
    const x2 = Math.min(this.width, Math.ceil(maxX)), y2 = Math.min(this.height, Math.ceil(maxY));
    for (let gy = y1; gy < y2; gy++) {
      const py = gy + 0.5;
      for (let gx = x1; gx < x2; gx++) {
        const px = gx + 0.5;
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const yi = points[i]![1]!, yj = points[j]![1]!;
          const xi = points[i]![0]!, xj = points[j]![0]!;
          // crossing test against a rightward horizontal ray
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
          }
        }
        if (inside) this.setPx(gx, gy, true);
      }
    }
  }

  /** Flip selection inside the document bounds (allocates every tile). */
  invert(): void {
    this.rev++;
    const cols = Math.ceil(this.width / TILE), rows = Math.ceil(this.height / TILE);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const i = this.tileIndex(tx, ty);
        let t = this.tiles[i];
        if (!t) {
          t = new Uint8Array(TILE * TILE);
          this.tiles[i] = t;
        }
        for (let k = 0; k < t.length; k++) t[k] = (t[k] ?? 0) === 0 ? 255 : 0;
      }
    }
  }

  /** True when every selected pixel is inside the given rect (fast paths). */
  isRect(): { x: number; y: number; w: number; h: number } | null {
    const b = this.bbox();
    if (!b) return null;
    // sample the bbox border: a rect selection has no selected pixels strictly
    // inside its own border ring, an ellipse/lasso does
    let solidRing = true;
    for (let gx = b.x; gx < b.x + b.w && solidRing; gx++) {
      if (this.alphaAt(gx, b.y) === 0 || this.alphaAt(gx, b.y + b.h - 1) === 0) solidRing = false;
    }
    for (let gy = b.y; gy < b.y + b.h && solidRing; gy++) {
      if (this.alphaAt(b.x, gy) === 0 || this.alphaAt(b.x + b.w - 1, gy) === 0) solidRing = false;
    }
    return solidRing ? b : null;
  }
}

/** Erase layer pixels under a selection mask (the Delete key).
 *  Alpha scales by (1 - ma/255); rgb is kept (straight-alpha semantics). */
export function clearMasked(grid: TileGrid, mask: SelectionMask): void {
  mask.forEachTile((mt, tx, ty, bx, by) => {
    const tile = grid.tile(tx, ty, false);
    if (!tile) return; // nothing painted in this region
    const d = tile.data;
    let touched = false;
    for (let yy = 0; yy < TILE; yy++) {
      for (let xx = 0; xx < TILE; xx++) {
        const ma = mt[yy * TILE + xx] ?? 0;
        if (ma === 0) continue;
        const docX = bx + xx, docY = by + yy;
        if (docX >= grid.width || docY >= grid.height) continue;
        const p = (yy * TILE + xx) * 4;
        const a = d[p + 3] ?? 0;
        if (a === 0) continue;
        d[p + 3] = a * (1 - ma / 255);
        touched = true;
      }
    }
    if (touched) tile.version++;
  });
}
