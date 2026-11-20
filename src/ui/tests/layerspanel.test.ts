// The Layers panel became a tree walk, but the pieces that decide what a row
// shows are pure: the crop a group thumbnail is built from, the 1 MP cap, and
// which row is "below" a given row for clip-to-below. They are tested here in
// Node — the fake DOM has no canvas context, so the drawing itself is covered
// by the smoke, and the decisions are covered by these.

import { test } from "node:test";
import assert from "node:assert/strict";
import { capSourceRect, groupSourceRect, layerBelowRow } from "../layerspanel.ts";
import type { PanelRow } from "../session.ts";
import { Document } from "../../engine/document.ts";

test("panel thumb: the 1 MP cap shrinks a 6000×4000 crop around its centre", () => {
  const rect = { x: 0, y: 0, w: 6000, h: 4000 };
  const capped = capSourceRect(rect);
  assert.ok(capped.w * capped.h <= 1024 * 1024, "the crop must fit the cap");
  assert.ok(capped.w >= 1 && capped.h >= 1);
  // The centre of the crop is the centre of the source, so the thumb is not
  // biased to the top-left of a large image.
  assert.ok(Math.abs(capped.x + capped.w / 2 - 3000) <= 1);
  assert.ok(Math.abs(capped.y + capped.h / 2 - 2000) <= 1);

  // Small crops pass through untouched: the common case must not allocate.
  const small = { x: 3, y: 4, w: 26, h: 20 };
  assert.equal(capSourceRect(small), small);
});

test("panel thumb: a group crop is the union of what its children paint", () => {
  // gridBBox spans allocated 256 px tiles, not individual pixels, so the two
  // children must land in different tiles for the union to be visible here.
  const doc = new Document(1000, 1000);
  const outer = doc.addGroup("outer");
  const inner = doc.addGroupTo(outer, "inner");
  const left = doc.addLayerTo(inner, "left");
  const right = doc.addLayerTo(outer, "right");
  left.grid.writeRect(300, 20, 2, 2, new Uint8ClampedArray(2 * 2 * 4).fill(255));
  right.grid.writeRect(20, 300, 4, 3, new Uint8ClampedArray(4 * 3 * 4).fill(255));

  // The nested group's tile is part of the union, not replaced by the sibling.
  assert.deepEqual(groupSourceRect([outer], doc.width, doc.height), {
    x: 0,
    y: 0,
    w: 512,
    h: 512,
  });

  // A hidden child contributes nothing, exactly as the compositor skips it.
  right.visible = false;
  assert.deepEqual(groupSourceRect([outer], doc.width, doc.height), {
    x: 256,
    y: 0,
    w: 256,
    h: 256,
  });

  // No visible ink at all: no crop, so the caller can show the checkerboard.
  left.visible = false;
  assert.equal(groupSourceRect([outer], doc.width, doc.height), null);
});

test("panel rows: the row below a group is its next sibling, never its child", () => {
  const doc = new Document(8, 8);
  const outer = doc.addGroup("outer");
  const high = doc.addLayerTo(outer, "high");
  const low = doc.addLayerTo(outer, "low");
  const top = doc.addLayer("top");
  const bottom = doc.addLayer("bottom");
  const rows: PanelRow[] = [
    { node: top, depth: 0 },
    { node: outer, depth: 0 },
    { node: high, depth: 1 },
    { node: low, depth: 1 },
    { node: bottom, depth: 0 },
  ];

  assert.equal(layerBelowRow(rows, 0), outer, "top's below is the group, not its child");
  assert.equal(layerBelowRow(rows, 1), bottom, "the group's below is the next root row");
  assert.equal(layerBelowRow(rows, 2), low, "inside a group, below is the next child");
  assert.equal(layerBelowRow(rows, 3), undefined, "the last child has no row below inside the group");
  assert.equal(layerBelowRow(rows, 4), undefined, "the bottom row has nothing below it");
});
