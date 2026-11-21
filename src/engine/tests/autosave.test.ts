import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  AutosaveScheduler,
  decodeAutosaveSnapshot,
  encodeAutosaveSnapshot,
  type AutosaveClock,
  type AutosaveTimer,
} from "../autosave.ts";
import { Document } from "../document.ts";
import { serializeProject } from "../io.ts";

class FakeClock implements AutosaveClock {
  private time = 0;
  private nextId = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): AutosaveTimer {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + Math.max(0, ms), fn });
    return id as unknown as AutosaveTimer;
  }

  clearTimeout(id: AutosaveTimer): void {
    const at = this.timers.findIndex((timer) => timer.id === (id as unknown as number));
    if (at >= 0) this.timers.splice(at, 1);
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.time = next.at;
      next.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

test("autosave waits for the 2 s idle window after the last edit", async () => {
  const clock = new FakeClock();
  const writes: number[] = [];
  const scheduler = new AutosaveScheduler(async () => { writes.push(clock.now()); }, clock);

  scheduler.noteEdit();
  await clock.advance(AUTOSAVE_IDLE_MS - 1);
  assert.deepEqual(writes, []);

  await clock.advance(1);
  assert.deepEqual(writes, [AUTOSAVE_IDLE_MS]);
});

test("continuous edits still snapshot at the 30 s ceiling", async () => {
  const clock = new FakeClock();
  const writes: number[] = [];
  const scheduler = new AutosaveScheduler(async () => { writes.push(clock.now()); }, clock);

  for (let second = 0; second < 60; second++) {
    scheduler.noteEdit();
    await clock.advance(1_000);
  }
  assert.deepEqual(writes, [AUTOSAVE_MAX_WAIT_MS, AUTOSAVE_MAX_WAIT_MS * 2]);
});

test("snapshot version survives a round trip and legacy JSON is not misread", async () => {
  const json = JSON.stringify({ savedAt: 1, tabs: [] });
  const bytes = await encodeAutosaveSnapshot(json);
  assert.equal(await decodeAutosaveSnapshot(bytes), json);
  assert.equal(await decodeAutosaveSnapshot(new TextEncoder().encode("{\"savedAt\":1}")), null);
});

test("project snapshot, 4096² 3 layers: compression and unchanged project bytes", async () => {
  const doc = new Document(4096, 4096);
  for (let i = 0; i < 3; i++) {
    doc.addLayer(`L${i}`).grid.fillRect(0, 0, 4096, 4096, [100, 100, 100, 255]);
  }
  const project = serializeProject(doc, "bench");
  const json = JSON.stringify(project);
  const started = performance.now();
  const bytes = await encodeAutosaveSnapshot(json);
  const elapsed = performance.now() - started;
  const ratio = bytes.length / json.length;
  console.log(
    `project snapshot, 4096² 3 layers: ${elapsed.toFixed(0)} ms, ` +
    `${(json.length / 1e6).toFixed(0)} MB JSON -> ${(bytes.length / 1e6).toFixed(1)} MB ` +
    `(${(ratio * 100).toFixed(1)} %)`,
  );
  assert.ok(bytes.length <= json.length * 0.4, `encoded snapshot is ${(ratio * 100).toFixed(1)} %`);
  assert.equal(JSON.stringify(serializeProject(doc, "bench")), json, "project JSON changed");
});
