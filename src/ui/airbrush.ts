/**
 * airbrush.ts — deposit while the pointer rests.
 *
 * A normal stroke only paints where the pointer moved: hold still and nothing
 * happens. Airbrush is the other convention — the pointer keeps depositing at
 * the same spot, so a soft edge builds up the longer you hold, like a can
 * spraying one place.
 *
 * The timer lives here, not in main.ts, for two reasons: the composition root
 * is already 8k lines, and the interval is the only piece worth reasoning about
 * on its own. Everything it does is "call deposit at the last point", so the
 * brush maths stays in paint.ts where the rest of it is.
 */

export interface AirbrushDeps {
  /** One deposit at the given document point. Return false to paint nothing. */
  deposit: (x: number, y: number) => boolean;
}

export interface Airbrush {
  /** Begin depositing at a point (pointer down). */
  start(x: number, y: number): void;
  /** Follow the pointer while it is down, without depositing on the move. */
  move(x: number, y: number): void;
  /** Stop depositing (pointer up, stroke end, tool switch). */
  stop(): void;
  /** True while the timer is running. */
  active(): boolean;
}

/** 25 deposits a second: fast enough to read as continuous, slow enough that
 *  each one is visible as build-up rather than an instant fill. */
export const AIRBRUSH_INTERVAL_MS = 40;

/**
 * The deposit is a fraction of the flow a moving dab would use, so one tick
 * never jumps to the brush's full alpha. At flow 30 %, one tick deposits 0.105
 * of the brush colour; the coverage halves every ~7 ticks after that.
 */
export const AIRBRUSH_TICK_FLOW = 0.35;

export interface AirbrushTimers {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
}

/** The browser pair, and the reason a fake timer can stand in for it in a test. */
const realTimers: AirbrushTimers = {
  set: (fn, ms) => (globalThis as unknown as Window).setInterval(fn, ms),
  clear: (id) => (globalThis as unknown as Window).clearInterval(id),
};

export function createAirbrush(
  deps: AirbrushDeps,
  intervalMs = AIRBRUSH_INTERVAL_MS,
  timers: AirbrushTimers = realTimers,
): Airbrush {
  let timer: number | null = null;
  let at: { x: number; y: number } | null = null;

  const tick = (): void => {
    if (!at) return;
    deps.deposit(at.x, at.y);
  };

  const stop = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    at = null;
  };

  return {
    start(x, y) {
      stop();
      at = { x, y };
      tick(); // the first tap deposits immediately, like a moving stroke would
      timer = timers.set(tick, intervalMs);
    },
    move(x, y) {
      // Only the resting point moves. Depositing on the move is what the normal
      // spacing loop already does; doing it here too would double the paint.
      if (at) at = { x, y };
    },
    stop,
    active: () => timer !== null,
  };
}
