/**
 * flatcache.ts — the composited-document cache, with an explicit invalidation
 * signal.
 *
 * The shell used to own this as a bare buffer plus a dirty boolean that ~60
 * call sites set by hand. That works until one site forgets,
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
 * composited anything, so `needsComposite(rev)` is true until `markComposited(rev)`;
 * a revision past the last composite also means the pixels are stale.
 */

/**
 * The slot's memory of a cache. It is deliberately not a FlatCache: a slot
 * must never be able to hand the live cache (with its pixels and its geometry)
 * back to `adopt()`, because the next document would then resize the slot's
 * geometry too. `adopt()` accepts only this type, so the B2 smoke failure is a
 * compile error now.
 */
export interface FlatSnapshot {
  readonly width: number;
  readonly height: number;
  readonly generation: number;
  readonly kind: "flat-snapshot";
}

export interface FlatCache {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, width × height × 4 bytes */
  buffer: Uint8ClampedArray<ArrayBuffer>;
  /** monotonic; every invalidation, reset or adopt produces a new value */
  readonly generation: number;
  /** a structural change: no tile was written, so nothing bumped the document */
  invalidate(): void;
  /** derived: true when the document's revision moved past the last composite */
  needsComposite(revision: number): boolean;
  /** the compositor says the buffer now reflects the document at `revision` */
  markComposited(revision: number): void;
  /**
   * Take over another document's cache geometry and generation. The pixels are
   * deliberately not borrowed: a tab switch must never leave the previous
   * document's composite on screen ("right pixels, wrong document"), so the
   * buffer is cleared and the new document has to composite again. The
   * generation is seeded from the adopted cache and bumped, so consumers that
   * track it see that the switch happened even though the pixels are new.
   */
  adopt(snapshot: FlatSnapshot): void;
  /** a document swap: new geometry, empty buffer, new generation */
  reset(width: number, height: number): void;
  /**
   * A tab slot's copy of the cache: same geometry, generation and pixels, but
   * its own object. A tab slot must not hold the live cache itself, because
   * the next document's `adopt()` would resize the slot's geometry too.
   */
  snapshot(): FlatSnapshot;
}

function bytesFor(width: number, height: number): number {
  return Math.max(0, Math.trunc(width)) * Math.max(0, Math.trunc(height)) * 4;
}

class Cache implements FlatCache {
  width: number;
  height: number;
  buffer: Uint8ClampedArray<ArrayBuffer>;
  private gen = 0;
  /** the document revision the current pixels were composited from */
  private lastRevision: number | null = null;
  /** a declared (structural) change that no tile primitive can see */
  private declared = false;

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
    this.declared = true;
  }

  needsComposite(revision: number): boolean {
    return this.declared || this.lastRevision !== revision ||
      this.buffer.length !== bytesFor(this.width, this.height);
  }

  markComposited(revision: number): void {
    if (this.buffer.length !== bytesFor(this.width, this.height)) {
      throw new Error(`flat cache: buffer is ${this.buffer.length} bytes for ${this.width}×${this.height}`);
    }
    this.lastRevision = revision;
    this.declared = false;
  }

  adopt(snapshot: FlatSnapshot): void {
    this.width = snapshot.width;
    this.height = snapshot.height;
    this.buffer = new Uint8ClampedArray(bytesFor(this.width, this.height));
    this.gen = snapshot.generation + 1;
    this.lastRevision = null;
    this.declared = false;
  }

  snapshot(): FlatSnapshot {
    // pixels are not carried: adopt() clears them anyway, and a slot that holds
    // them would be the memory bug the type is here to prevent.
    return { width: this.width, height: this.height, generation: this.gen, kind: "flat-snapshot" };
  }

  reset(width: number, height: number): void {
    this.width = Math.max(0, Math.trunc(width));
    this.height = Math.max(0, Math.trunc(height));
    this.buffer = new Uint8ClampedArray(bytesFor(this.width, this.height));
    this.gen++;
    this.lastRevision = null;
    this.declared = false;
  }
}

export function createFlatCache(width = 0, height = 0): FlatCache {
  return new Cache(width, height);
}
