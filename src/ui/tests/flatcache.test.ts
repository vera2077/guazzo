// The flat cache contract, without DOM and without main.ts: the buffer has one
// owner, pixel changes are derived from the document revision, structural
// changes declare themselves, and adopting a snapshot clears the pixels instead
// of letting a previous document's composite survive a tab switch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlatCache } from "../flatcache.ts";
import { setLayerOpacity } from "../layerops.ts";
import { Document } from "../../engine/document.ts";

test("FC1: a fresh cache has not composited anything", () => {
  const cache = createFlatCache(4, 3);
  assert.equal(cache.needsComposite(0), true);
  assert.equal(cache.buffer.length, 4 * 3 * 4);
  assert.equal(cache.generation, 0);
});

test("FC1: a pixel revision past the last composite demands a new composite", () => {
  const cache = createFlatCache(2, 2);
  cache.markComposited(7);
  assert.equal(cache.needsComposite(7), false);
  assert.equal(cache.needsComposite(8), true);
});

test("FC1: a declared change demands a composite even at the same revision", () => {
  const cache = createFlatCache(2, 2);
  cache.markComposited(7);
  const before = cache.generation;
  cache.invalidate();
  assert.equal(cache.needsComposite(7), true);
  assert.equal(cache.generation, before + 1);
});

test("FC1: two caches never share a buffer by reference", () => {
  const a = createFlatCache(2, 2);
  const b = createFlatCache(2, 2);
  assert.notEqual(a.buffer, b.buffer);
  a.buffer[0] = 255;
  assert.equal(b.buffer[0], 0);
});

test("FC1: adopt clears the buffer and bumps the generation past the source", () => {
  const source = createFlatCache(2, 1);
  source.invalidate();
  source.invalidate();
  const live = createFlatCache(2, 1);
  live.buffer.fill(9);
  live.adopt(source.snapshot());
  assert.deepEqual([live.width, live.height], [2, 1]);
  assert.equal(live.generation, source.generation + 1);
  assert.equal(live.needsComposite(0), true);
  assert.equal(live.buffer.every((byte) => byte === 0), true);
  assert.notEqual(live.buffer, source.buffer);
});

test("FC1: adopting a different geometry reallocates instead of reusing bytes", () => {
  const live = createFlatCache(2, 2);
  live.buffer.fill(7);
  live.adopt(createFlatCache(3, 1).snapshot());
  assert.deepEqual([live.width, live.height], [3, 1]);
  assert.equal(live.buffer.length, 3 * 1 * 4);
  assert.equal(live.buffer.every((byte) => byte === 0), true);
});

test("FC1: reset takes the new geometry and invalidates; markComposited refuses a mismatch", () => {
  const cache = createFlatCache(1, 1);
  cache.markComposited(3);
  const before = cache.generation;
  cache.reset(5, 4);
  assert.deepEqual([cache.width, cache.height], [5, 4]);
  assert.equal(cache.buffer.length, 5 * 4 * 4);
  assert.equal(cache.generation, before + 1);
  assert.equal(cache.needsComposite(3), true);
  cache.buffer = new Uint8ClampedArray(4);
  assert.throws(() => cache.markComposited(3), /flat cache: buffer is 4 bytes for 5×4/);
});

test("FC2: the opacity handler on a group child moves the revision and the cache", () => {
  // The layer panel's handler mutates the node and declares the change. A group
  // child is the case a walk over doc.layers would have missed.
  const doc = new Document(8, 8);
  const group = doc.addGroup("Group A");
  const child = doc.addLayerTo(group, "Inner");
  const cache = createFlatCache(doc.width, doc.height);
  const revision = doc.revision;
  cache.markComposited(revision);
  const before = cache.generation;
  assert.equal(setLayerOpacity(child, 50, doc, cache), true);
  assert.equal(doc.revision, revision + 1);
  assert.equal(cache.generation, before + 1);
  assert.equal(cache.needsComposite(revision), true);
  cache.markComposited(doc.revision);
  assert.equal(cache.needsComposite(doc.revision), false);
  assert.equal(setLayerOpacity(child, 50, doc, cache), false);
});

test("FC3: a pixel primitive bumps the revision the cache key reads", () => {
  // B3: the hook lives next to the version++ in TileGrid, so this is the one
  // place every paint, mask dab, filter and transform is visible to the key.
  const doc = new Document(4, 4);
  const layer = doc.addLayer("Paint");
  const cache = createFlatCache(doc.width, doc.height);
  const revision = doc.revision;
  cache.markComposited(revision);
  layer.grid.writeRect(0, 0, 1, 1, new Uint8ClampedArray([255, 0, 0, 255]));
  assert.ok(doc.revision > revision, "writeRect must move the document revision");
  assert.equal(cache.needsComposite(doc.revision), true);
  cache.markComposited(doc.revision);
  assert.equal(cache.needsComposite(doc.revision), false);
});
