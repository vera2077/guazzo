import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  AUTOSAVE_SLICE_BYTES,
  AutosaveScheduler,
  decodeAutosaveSnapshotV1,
  decodeAutosaveSnapshotV2,
  encodeAutosaveSnapshotV1,
  encodeAutosaveSnapshotV2,
  inflateTileRecord,
  type AutosaveClock,
  type AutosaveTimer,
} from "../autosave.ts";
import { Document } from "../document.ts";

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

function fillDoc(size: number, layers: number): Document {
  const doc = new Document(size, size);
  for (let i = 0; i < layers; i++) {
    // Distinct solid colours make a swapped/duplicated layer visible in the
    // hash without making the compressed snapshot large.
    doc.addLayer(`L${i}`).grid.fillRect(0, 0, size, size, [20 + i * 25, 60 + i * 10, 200 - i * 15, 255]);
  }
  return doc;
}

function pixelHash(doc: Document): string {
  const hash = createHash("sha256");
  for (const layer of doc.allLayers()) {
    hash.update(layer.name);
    layer.grid.forEachTile((tile) => hash.update(tile.data));
    if (layer.mask) {
      hash.update("mask");
      layer.mask.forEachTile((tile) => hash.update(tile.data));
    }
  }
  return hash.digest("hex");
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

test("v1 snapshots still decode, and v1/v2 never mistake each other", async () => {
  const json = JSON.stringify({ savedAt: 1, tabs: [] });
  const v1 = await encodeAutosaveSnapshotV1(json);
  assert.equal(await decodeAutosaveSnapshotV1(v1), json);
  assert.equal(await decodeAutosaveSnapshotV1(new TextEncoder().encode("{\"savedAt\":1}")), null);

  const doc = new Document(64, 64);
  doc.addLayer("small").grid.fillRect(0, 0, 64, 64, [1, 2, 3, 255]);
  const v2 = await encodeAutosaveSnapshotV2({
    savedAt: 2,
    active: 0,
    tabs: [{ name: "small", doc }],
  });
  assert.equal(await decodeAutosaveSnapshotV1(v2), null);
  assert.equal(await decodeAutosaveSnapshotV2(v1), null);
});

test("v2 round-trips groups, masks, mask polarity and layer order", async () => {
  const doc = new Document(512, 512);
  const group = doc.addGroup("Group");
  const child = doc.addLayerTo(group, "Child");
  child.grid.fillRect(0, 0, 512, 512, [10, 20, 30, 255]);
  const masked = doc.addLayer("Masked");
  masked.grid.fillRect(0, 0, 512, 512, [200, 100, 50, 255]);
  const mask = doc.attachMask(masked);
  mask.fillRect(0, 0, 512, 512, [128, 0, 0, 255]);
  masked.maskHide = true;

  const before = pixelHash(doc);
  const bytes = await encodeAutosaveSnapshotV2({
    savedAt: 123,
    active: 0,
    tabs: [{ name: "tree", doc }],
  });
  const restored = await decodeAutosaveSnapshotV2(bytes);
  assert.ok(restored);
  const back = restored.tabs[0]!.restored;
  assert.deepEqual(back.allLayers().map((l) => l.name), ["Group", "Child", "Masked"]);
  assert.equal(back.layers[0]!.kind, "group");
  assert.equal(back.layers[0]!.children?.[0]!.name, "Child");
  assert.equal(back.allLayers()[2]!.maskHide, true);
  assert.equal(pixelHash(back), before);
});

test("v2 writes 4096² × 8 layers, >512 MB of pixels, without a giant string", async () => {
  const doc = fillDoc(4096, 8);
  // Derived from the document the encoder is handed, so shrinking the fixture
  // cannot silently turn this test into a tautology.
  assert.equal(doc.width, 4096);
  assert.equal(doc.layers.length, 8);
  const rawBytes = doc.width * doc.height * 4 * doc.layers.length;
  assert.ok(rawBytes >= 512 * 1024 * 1024, "regression document is at the V8 string limit");
  const slices: number[] = [];
  const started = performance.now();
  const bytes = await encodeAutosaveSnapshotV2({
    savedAt: 1,
    active: 0,
    tabs: [{ name: "big", doc }],
  }, { onSlice: (n) => slices.push(n) });
  const elapsed = performance.now() - started;
  const maxSlice = Math.max(...slices);
  console.log(
    `autosave v2 4096² × 8: ${elapsed.toFixed(0)} ms, ${(rawBytes / 1e6).toFixed(0)} MB raw -> ` +
    `${(bytes.length / 1e6).toFixed(2)} MB, ${slices.length} slices, max ${maxSlice} B`,
  );
  assert.ok(bytes.length < 4_000_000, `snapshot is ${bytes.length} bytes`);
  assert.ok(slices.length > 1);
  assert.ok(maxSlice <= AUTOSAVE_SLICE_BYTES, `slice ${maxSlice} > ${AUTOSAVE_SLICE_BYTES}`);
  const restored = await decodeAutosaveSnapshotV2(bytes);
  assert.ok(restored);
  assert.equal(restored.tabs[0]!.restored.allLayers().length, 8);
  assert.equal(pixelHash(restored.tabs[0]!.restored), pixelHash(doc));
});

test("v2 restores 3 tabs × 4096² × 3 layers", async () => {
  const tabs = [0, 1, 2].map((i) => ({ name: `Tab ${i}`, doc: fillDoc(4096, 3) }));
  const started = performance.now();
  const bytes = await encodeAutosaveSnapshotV2({ savedAt: 2, active: 1, tabs });
  const elapsed = performance.now() - started;
  console.log(
    `autosave v2 3 tabs × 4096² × 3: ${elapsed.toFixed(0)} ms, ` +
    `${(bytes.length / 1e6).toFixed(2)} MB`,
  );
  const restored = await decodeAutosaveSnapshotV2(bytes);
  assert.ok(restored);
  assert.equal(restored.tabs.length, 3);
  assert.equal(restored.active, 1);
  for (let i = 0; i < tabs.length; i++) {
    assert.equal(restored.tabs[i]!.name, tabs[i]!.name);
    assert.equal(restored.tabs[i]!.restored.allLayers().length, 3);
    assert.equal(pixelHash(restored.tabs[i]!.restored), pixelHash(tabs[i]!.doc));
  }
});

test("a damaged v2 header is refused, not mistaken for a snapshot", async () => {
  const doc = fillDoc(64, 1);
  const bytes = await encodeAutosaveSnapshotV2({ savedAt: 1, active: 0, tabs: [{ name: "x", doc }] });
  const bad = bytes.slice();
  bad[1] = 0;
  await assert.rejects(() => decodeAutosaveSnapshotV2(bad), /header is damaged/);
});

test("a tile record cannot inflate past the size its own count declares", async () => {
  // A hostile snapshot may hand us a record compressed from hundreds of MB of
  // zeros. The old inflateBytes() expanded it fully, so the tile budget only
  // fired after the allocation. The count is in the first four bytes now, so
  // the ceiling is known before the stream runs.
  const bomb = new Uint8Array(8 * 1024 * 1024);
  new DataView(bomb.buffer).setUint32(0, 1, true); // declares one tile
  const gz = await new Response(
    new Blob([bomb as BlobPart]).stream().pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer();
  await assert.rejects(
    () => inflateTileRecord(new Uint8Array(gz)),
    /inflates beyond its declared size/,
  );
});
