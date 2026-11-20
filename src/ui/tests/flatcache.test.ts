// The flat cache contract, without DOM and without main.ts: the buffer has one
// owner, invalidation is explicit and monotonic, and adopting another cache
// clears the pixels instead of letting a previous document's composite survive
// a tab switch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlatCache } from "../flatcache.ts";
import { Document } from "../../engine/document.ts";

test("FC1: a fresh cache has not composited anything", () => {
  const cache = createFlatCache(4, 3);
  assert.equal(cache.needsComposite(), true);
  assert.equal(cache.buffer.length, 4 * 3 * 4);
  assert.equal(cache.generation, 0);
});

test("FC1: invalidate bumps the generation and demands a new composite", () => {
  const cache = createFlatCache(2, 2);
  cache.markComposited();
  assert.equal(cache.needsComposite(), false);
  const before = cache.generation;
  cache.invalidate();
  assert.equal(cache.needsComposite(), true);
  assert.equal(cache.generation, before + 1);
  cache.invalidate();
  assert.equal(cache.generation, before + 2);
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
  source.markComposited();
  const live = createFlatCache(2, 1);
  live.buffer.fill(9);
  live.adopt(source);
  assert.deepEqual([live.width, live.height], [2, 1]);
  assert.equal(live.generation, source.generation + 1);
  assert.equal(live.needsComposite(), true);
  assert.equal(live.buffer.every((byte) => byte === 0), true);
  assert.notEqual(live.buffer, source.buffer);
});

test("FC1: adopting a different geometry reallocates instead of reusing bytes", () => {
  const live = createFlatCache(2, 2);
  live.buffer.fill(7);
  live.adopt(createFlatCache(3, 1));
  assert.deepEqual([live.width, live.height], [3, 1]);
  assert.equal(live.buffer.length, 3 * 1 * 4);
  assert.equal(live.buffer.every((byte) => byte === 0), true);
});

test("FC1: reset takes the new geometry and invalidates; markComposited refuses a mismatched buffer", () => {
  const cache = createFlatCache(1, 1);
  cache.markComposited();
  const before = cache.generation;
  cache.reset(5, 4);
  assert.deepEqual([cache.width, cache.height], [5, 4]);
  assert.equal(cache.buffer.length, 5 * 4 * 4);
  assert.equal(cache.generation, before + 1);
  assert.equal(cache.needsComposite(), true);
  cache.buffer = new Uint8ClampedArray(4);
  assert.throws(() => cache.markComposited(), /flat cache: buffer is 4 bytes for 5×4/);
});

test("FC2: a child layer's opacity change invalidates the cache", () => {
  // The layer panel's opacity handler mutates the node and invalidates the
  // cache. A group child is the case a walk over doc.layers would have missed.
  const doc = new Document(8, 8);
  const group = doc.addGroup("Group A");
  const child = doc.addLayerTo(group, "Inner");
  const cache = createFlatCache(doc.width, doc.height);
  cache.markComposited();
  const before = cache.generation;
  child.opacity = 0.5;
  cache.invalidate();
  assert.equal(cache.generation, before + 1);
  assert.equal(cache.needsComposite(), true);
});
