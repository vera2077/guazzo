import { test } from "node:test";
import { proxyKey, type ProxyKeyInput } from "../../ui/proxykey.ts";
import { TileGrid } from "../tile.ts";
import { Document } from "../document.ts";
import assert from "node:assert/strict";

function base(): ProxyKeyInput {
  return {
    docId: 1, width: 800, height: 600,
    rect: { x: 0, y: 0, w: 100, h: 80 },
    scale: 0.5, revision: 7, layerCount: 3, layerId: 2, maskStamp: 0, maskHidden: false,
  };
}

test("AQ3: the proxy key changes on an edit, a tab switch and a mask repaint", () => {
  const k0 = proxyKey(base());
  assert.ok(proxyKey({ ...base(), revision: 8 }) !== k0, "an edit must rebuild");
  assert.ok(proxyKey({ ...base(), docId: 2 }) !== k0, "a tab switch must rebuild");
  assert.ok(proxyKey({ ...base(), layerCount: 4 }) !== k0, "a layer add must rebuild");
  assert.ok(proxyKey({ ...base(), maskStamp: 99 }) !== k0, "mask paintwork must rebuild");
  assert.equal(proxyKey({ ...base(), rect: { x: 1, y: 0, w: 100, h: 80 } }) !== k0, true);
  assert.equal(proxyKey({ ...base(), scale: 0.25 }) !== k0, true);
  assert.equal(proxyKey(base()), k0, "identical inputs give an identical key");
});

test("AQ3: a mask repaint moves the grid stamp", () => {
  const g = new TileGrid(64, 64);
  const before = g.stamp();
  g.writeRect(0, 0, 2, 2, new Uint8ClampedArray(2 * 2 * 4).fill(200));
  const after = g.stamp();
  assert.ok(after !== before, "writing pixels must change the stamp");
  g.writeRect(0, 0, 2, 2, new Uint8ClampedArray(2 * 2 * 4));
  assert.ok(g.stamp() !== after, "restoring pixels is also a change");
});

test("AQ3: a mask pixel write and a polarity flip both change the key", () => {
  const mask = new TileGrid(8, 8);
  const k0 = proxyKey({ ...base(), maskStamp: mask.stamp(), maskHidden: false });
  mask.writeRect(0, 0, 1, 1, new Uint8ClampedArray(4).fill(255));
  const k1 = proxyKey({ ...base(), maskStamp: mask.stamp(), maskHidden: false });
  assert.ok(k1 !== k0, "mask paint must rebuild the preview");
  const k2 = proxyKey({ ...base(), maskStamp: mask.stamp(), maskHidden: true });
  assert.ok(k2 !== k1, "mask polarity must rebuild the preview");
});

test("AQ3: layer count is the total node count, not the root length", () => {
  const flat = new Document(8, 8);
  for (let i = 0; i < 5; i++) flat.addLayer(`L${i}`);
  const nested = new Document(8, 8);
  for (let i = 0; i < 5; i++) {
    const g = nested.addGroup(`G${i}`);
    nested.addLayerTo(g, "x");
    nested.addLayerTo(g, "y");
  }
  assert.equal(flat.layers.length, nested.layers.length, "the two trees have the same root length");
  assert.notEqual(flat.layerCount(), nested.layerCount(), "their totals differ");
  // The bug: keying on the root length collapses these two documents.
  assert.equal(
    proxyKey({ ...base(), layerCount: flat.layers.length }),
    proxyKey({ ...base(), layerCount: nested.layers.length }),
    "root length alone cannot distinguish them",
  );
  const keyFor = (doc: Document) => proxyKey({ ...base(), layerCount: doc.layerCount() });
  assert.notEqual(keyFor(flat), keyFor(nested), "the total node count distinguishes them");
});
