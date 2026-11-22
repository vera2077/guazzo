import { test } from "node:test";
import assert from "node:assert/strict";
import { createAirbrush, AIRBRUSH_INTERVAL_MS, AIRBRUSH_TICK_FLOW } from "../airbrush.ts";

/** A timer that only fires when the test says so. */
function fakeTimers() {
  let fn: (() => void) | null = null;
  let id = 0;
  const set = (f: () => void): number => { fn = f; return ++id; };
  const clear = (): void => { fn = null; };
  return {
    timers: { set, clear },
    fire: (times = 1): void => { for (let i = 0; i < times; i++) fn?.(); },
    running: (): boolean => fn !== null,
    interval: () => AIRBRUSH_INTERVAL_MS,
  };
}

test("airbrush: one deposit on press, then one per tick while held", () => {
  const seen: Array<[number, number]> = [];
  const fake = fakeTimers();
  const air = createAirbrush({ deposit: (x, y) => { seen.push([x, y]); return true; } }, 40, fake.timers);

  air.start(10, 20);
  assert.deepEqual(seen, [[10, 20]], "the press itself must deposit once");
  assert.equal(fake.running(), true, "the timer must be running after the press");

  fake.fire(3);
  assert.deepEqual(seen, [[10, 20], [10, 20], [10, 20], [10, 20]], "each tick deposits at the resting point");
  air.stop();
  fake.fire(2);
  assert.equal(seen.length, 4, "a stopped airbrush must not deposit");
  assert.equal(fake.running(), false);
});

test("airbrush: moving changes the resting point without depositing on the move", () => {
  const seen: Array<[number, number]> = [];
  const fake = fakeTimers();
  const air = createAirbrush({ deposit: (x, y) => { seen.push([x, y]); return true; } }, 40, fake.timers);

  air.start(0, 0);
  air.move(5, 5);
  assert.equal(seen.length, 1, "a move is not a deposit — the spacing loop already paints the path");
  fake.fire();
  assert.deepEqual(seen.at(-1), [5, 5], "the deposit follows the pointer");
  air.stop();
});

test("airbrush: restarting replaces the old timer instead of stacking a second one", () => {
  let deposits = 0;
  let cleared = 0;
  let live = 0;
  const timers = {
    set: () => { live++; return live; },
    clear: () => { cleared++; },
  };
  const air = createAirbrush({ deposit: () => { deposits++; return true; } }, 40, timers);
  air.start(1, 1);
  air.start(2, 2);
  assert.equal(cleared, 1, "the first timer must be cleared before the second starts");
  assert.equal(air.active(), true);
  air.stop();
});

test("airbrush: the tick flow is a fraction of a full dab", () => {
  // If this ever reaches 1, holding still becomes an instant fill and the
  // feature stops being an airbrush.
  assert.ok(AIRBRUSH_TICK_FLOW > 0 && AIRBRUSH_TICK_FLOW < 1,
    `expected a partial deposit per tick, got ${AIRBRUSH_TICK_FLOW}`);
});
