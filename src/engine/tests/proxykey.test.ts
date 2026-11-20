import { test } from "node:test";
import { proxyKey, type ProxyKeyInput } from "../../ui/proxykey.ts";
import { TileGrid } from "../tile.ts";
import assert from "node:assert/strict";

function base(): ProxyKeyInput {
  return {
    docId: 1, width: 800, height: 600,
    rect: { x: 0, y: 0, w: 100, h: 80 },
    scale: 0.5, revision: 7, layerCount: 3, layerId: 2, maskStamp: 0,
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
