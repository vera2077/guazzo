import { test } from "node:test";
import assert from "node:assert/strict";
import { createPreviewScheduler } from "../../ui/previewqueue.ts";

/** captures the frame callbacks so the test controls time, like a browser does */
function fakeRaf() {
  const frames: (() => void)[] = [];
  return { request: (cb: () => void) => { frames.push(cb); }, runFrame: () => { const f = frames.shift(); f?.(); }, frames };
}

test("two preview requests produce two renders (the v0.40 deadlock)", () => {
  const raf = fakeRaf();
  const sched = createPreviewScheduler(raf.request);
  let renders = 0;
  sched.queue(() => { renders++; });
  raf.runFrame();
  sched.queue(() => { renders++; });
  raf.runFrame();
  assert.equal(renders, 2, "the second request must render — the old code returned early and never did");
  assert.equal(sched.runs, 2);
});

test("many requests inside one frame coalesce to the last job", () => {
  const raf = fakeRaf();
  const sched = createPreviewScheduler(raf.request);
  const seen: number[] = [];
  sched.queue(() => seen.push(1));
  sched.queue(() => seen.push(2));
  sched.queue(() => seen.push(3));
  assert.equal(raf.frames.length, 1, "only one frame may be scheduled");
  raf.runFrame();
  assert.deepEqual(seen, [3], "the last queued job wins");
  assert.equal(sched.pending, false);
});

test("flush runs the pending job without a frame and is idempotent", () => {
  const raf = fakeRaf();
  const sched = createPreviewScheduler(raf.request);
  let renders = 0;
  sched.queue(() => { renders++; });
  sched.flush();
  sched.flush();
  assert.equal(renders, 1, "a second flush has nothing to do");
  raf.runFrame(); // the scheduled frame is now a no-op
  assert.equal(renders, 1);
});
