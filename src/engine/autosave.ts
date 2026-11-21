/**
 * Crash-recovery snapshots, distinct from the user-facing .guazzo.json format.
 * A snapshot is one version byte followed by a deflate stream; the version byte
 * lets a newer build tell an older, uncompressed snapshot (plain JSON text)
 * from this one. The project serialiser is untouched.
 */

export const AUTOSAVE_SNAPSHOT_VERSION = 1;
export const AUTOSAVE_IDLE_MS = 2_000;
export const AUTOSAVE_MAX_WAIT_MS = 30_000;

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

/** Encode the snapshot JSON. The leading byte is the snapshot format version. */
export async function encodeAutosaveSnapshot(json: string): Promise<Uint8Array> {
  const compressed = await new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer();
  const out = new Uint8Array(compressed.byteLength + 1);
  out[0] = AUTOSAVE_SNAPSHOT_VERSION;
  out.set(new Uint8Array(compressed), 1);
  return out;
}

/** Decode a compressed snapshot, or return null for an older plain-JSON file. */
export async function decodeAutosaveSnapshot(bytes: Uint8Array): Promise<string | null> {
  if (bytes[0] !== AUTOSAVE_SNAPSHOT_VERSION) return null;
  const body = bytes.subarray(1);
  return await new Response(
    new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")),
  ).text();
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
