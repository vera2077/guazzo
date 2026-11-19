import { test } from "node:test";
import assert from "node:assert/strict";

import { SelectionMask } from "../mask.ts";
import * as S from "../selectops.ts";
import { eq } from "./helpers.ts";

/** count fully-selected pixels, a cheap way to assert mask area */
function area(m: SelectionMask): number {
  let n = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) if (m.alphaAt(x, y) === 255) n++;
  }
  return n;
}

function box(w: number, h: number, x: number, y: number, bw: number, bh: number): SelectionMask {
  const m = new SelectionMask(w, h);
  m.selectRect(x, y, bw, bh);
  return m;
}

test("expand grows the box outward symmetrically", () => {
  const m = box(40, 40, 15, 15, 10, 10);
  eq(area(m), 100);
  const e = S.expandSelection(m, 2);
  // the corner grows by the disc, so area rises but the centre stays selected
  assert.ok(area(e) > 100, "expand must add pixels");
  eq(e.alphaAt(20, 20), 255);
  eq(m.alphaAt(13, 20), 0); // source untouched
  eq(e.alphaAt(13, 20), 255);
});

test("contract shrinks the box and can erase it entirely", () => {
  const m = box(40, 40, 15, 15, 10, 10);
  const c = S.contractSelection(m, 2);
  assert.ok(area(c) < 100, "contract must remove pixels");
  eq(m.alphaAt(15, 20), 255);
  eq(c.alphaAt(15, 20), 0);
  const tiny = box(20, 20, 9, 9, 2, 2);
  eq(area(S.contractSelection(tiny, 3)), 0);
});

test("expand then contract returns roughly the original area", () => {
  const m = box(40, 40, 12, 12, 16, 16);
  const round = S.contractSelection(S.expandSelection(m, 2), 2);
  const diff = Math.abs(area(round) - area(m));
  assert.ok(diff <= 16, `expected near-identity, area ${area(m)} vs ${area(round)}`);
});

test("feather produces soft edges without losing the core", () => {
  const m = box(40, 40, 10, 10, 20, 20);
  const f = S.featherSelection(m, 4);
  eq(f.alphaAt(20, 20), 255);
  const edge = f.alphaAt(10, 20);
  assert.ok(edge > 0 && edge < 255, `edge should be partial, got ${edge}`);
  eq(f.alphaAt(0, 0), 0);
});

test("smooth rounds off a lone speck", () => {
  const m = box(30, 30, 14, 14, 3, 1);
  const s = S.smoothSelection(m, 1);
  assert.ok(area(s) > 0, "smooth must keep the region");
});

test("grow only takes neighbours whose colour matches the average", () => {
  const w = 20, h = 20;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const blue = y >= 10; // bottom half is a different colour
      px[i] = blue ? 0 : 200;
      px[i + 1] = blue ? 0 : 200;
      px[i + 2] = blue ? 255 : 200;
      px[i + 3] = 255;
    }
  }
  const m = new SelectionMask(w, h);
  m.selectRect(8, 8, 4, 2); // sits on the 200-grey side, touching the boundary
  const g = S.growSelection(m, px, w, h, 20);
  eq(g.alphaAt(8, 9), 255); // stays grey
  eq(g.alphaAt(8, 11), 0); // refuses the blue half
  assert.ok(area(g) >= area(m));
});

test("similar selects matching colours anywhere in the document", () => {
  const w = 20, h = 20;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 10; px[i + 1] = 10; px[i + 2] = 10; px[i + 3] = 255;
  }
  for (const [x, y] of [[2, 2], [15, 15]] as const) {
    const i = (y * w + x) * 4;
    px[i] = 240; px[i + 1] = 20; px[i + 2] = 20;
  }
  const m = new SelectionMask(w, h);
  m.setAlpha(2, 2, 255);
  const s = S.similarSelection(m, px, w, h, 10);
  eq(s.alphaAt(2, 2), 255);
  eq(s.alphaAt(15, 15), 255); // the far twin is found
  eq(s.alphaAt(8, 8), 0); // the background is not
});

test("border keeps only a band around the edge", () => {
  const m = box(40, 40, 10, 10, 20, 20);
  const b = S.borderSelection(m, 3);
  eq(b.alphaAt(20, 20), 0); // centre hollowed out
  eq(b.alphaAt(10, 20), 255); // edge kept
  assert.ok(area(b) < area(m));
});

test("an empty selection survives every op without throwing", () => {
  const m = new SelectionMask(10, 10);
  eq(area(S.expandSelection(m, 3)), 0);
  eq(area(S.contractSelection(m, 3)), 0);
  eq(area(S.featherSelection(m, 3)), 0);
  eq(area(S.borderSelection(m, 2)), 0);
});
