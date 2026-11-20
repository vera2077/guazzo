/**
 * flatcache.ts — the composited-document cache, with an explicit invalidation
 * signal.
 *
 * The shell used to own this as a bare `let flat` buffer plus a `flatDirty`
 * boolean that ~60 call sites set by hand. That works until one site forgets,
 * and the failure is silent: the screen keeps showing pixels from before the
 * edit. This module gives the buffer one owner and one way to be invalidated.
 *
 * Invalidation is explicit (`invalidate()`), not derived from a document
 * revision counter. A revision counter would move the same discipline problem
 * into the engine, where every tile primitive (setPx, writeRect, mask writes)
 * would have to bump it; a missed bump inside a hot primitive is harder to see
 * in review than a missed call site. The revision belongs to slice 3, once the
 * session owns the document and the setter layer it would police.
 *
 * Geometry: the buffer is width × height × 4 RGBA bytes. A fresh cache has not
 * composited anything, so `needsComposite()` is true until `markComposited()`.
 */

export interface FlatCache {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, width × height × 4 bytes */
  buffer: Uint8ClampedArray<ArrayBuffer>;
  /** monotonic; every invalidation, reset or adopt produces a new value */
  readonly generation: number;
  invalidate(): void;
  needsComposite(): boolean;
  /** the compositor says the buffer now reflects the document */
  markComposited(): void;
  /**
   * Take over another document's cache geometry and generation. The pixels are
   * deliberately not borrowed: a tab switch must never leave the previous
   * document's composite on screen ("right pixels, wrong document"), so the
   * buffer is cleared and the new document has to composite again. The
   * generation is seeded from the adopted cache and bumped, so consumers that
   * track it see that the switch happened even though the pixels are new.
   */
  adopt(other: FlatCache): void;
  /** a document swap: new geometry, empty buffer, new generation */
  reset(width: number, height: number): void;
}

function bytesFor(width: number, height: number): number {
  return Math.max(0, Math.trunc(width)) * Math.max(0, Math.trunc(height)) * 4;
}

class Cache implements FlatCache {
  width: number;
  height: number;
  buffer: Uint8ClampedArray<ArrayBuffer>;
  private gen = 0;
  private composited = false;

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.trunc(width));
    this.height = Math.max(0, Math.trunc(height));
    this.buffer = new Uint8ClampedArray(bytesFor(this.width, this.height));
  }

  get generation(): number {
    return this.gen;
  }

  invalidate(): void {
    this.gen++;
    this.composited = false;
  }

  needsComposite(): boolean {
    return !this.composited || this.buffer.length !== bytesFor(this.width, this.height);
  }

  markComposited(): void {
    if (this.buffer.length !== bytesFor(this.width, this.height)) {
      throw new Error(`flat cache: buffer is ${this.buffer.length} bytes for ${this.width}×${this.height}`);
    }
    this.composited = true;
  }

  adopt(other: FlatCache): void {
    this.width = other.width;
    this.height = other.height;
    this.buffer = new Uint8ClampedArray(bytesFor(this.width, this.height));
    this.gen = other.generation + 1;
    this.composited = false;
  }

  reset(width: number, height: number): void {
    this.width = Math.max(0, Math.trunc(width));
    this.height = Math.max(0, Math.trunc(height));
    this.buffer = new Uint8ClampedArray(bytesFor(this.width, this.height));
    this.gen++;
    this.composited = false;
  }
}

export function createFlatCache(width = 0, height = 0): FlatCache {
  return new Cache(width, height);
}
