import { test } from "node:test";
import assert from "node:assert/strict";
import { refineSelection, refineWorkArea } from "../refine.ts";
import { SelectionMask } from "../mask.ts";
import { eq } from "./helpers.ts";

/** Half-red / half-blue image: an exact two-colour edge at x = 8. */
function edgeImage(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const left = x < 8;
      px[i] = left ? 255 : 0;
      px[i + 1] = 0;
      px[i + 2] = left ? 0 : 255;
      px[i + 3] = 255;
    }
  }
  return px;
}

function maskOf(w: number, h: number, rect: [number, number, number, number]): SelectionMask {
  const m = new SelectionMask(w, h);
  m.selectRect(...rect);
  return m;
}

test("refine snaps a blurred edge to the colour boundary", () => {
  const px = edgeImage(16, 16);
  // Deliberately soft mask: 50 % across a 4-px band straddling x = 8.
  const m = new SelectionMask(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 5; x <= 11; x++) {
      const a = Math.round(255 * (1 - (x - 5) / 6));
      m.setAlpha(x, y, a);
    }
  }
  const r = refineSelection(m, px, 16, 16, { radius: 6 });
  // Red side (x <= 7) stays fully selected, blue side (x >= 9) fully clear.
  assert.equal(r.alphaAt(6, 8), 255);
  assert.equal(r.alphaAt(10, 8), 0);
});

test("interior and exterior pixels are left exactly as they were", () => {
  const px = edgeImage(16, 16);
  const m = maskOf(16, 16, [0, 0, 8, 16]);
  const r = refineSelection(m, px, 16, 16, { radius: 4, feather: 2 });
  assert.equal(r.alphaAt(0, 0), 255, "the corner of a hard rect must not be softened");
  assert.equal(r.alphaAt(15, 15), 0);
  assert.equal(r.alphaAt(3, 8), 255);
});

test("feather produces a gradient across the boundary", () => {
  const px = edgeImage(16, 16);
  const m = maskOf(16, 16, [0, 0, 8, 16]);
  const r = refineSelection(m, px, 16, 16, { radius: 4, feather: 3 });
  const a7 = r.alphaAt(7, 8);
  const a8 = r.alphaAt(8, 8);
  assert.ok(a7 > 0 && a7 < 255, `expected a partial alpha at the edge, got ${a7}`);
  assert.ok(a8 >= 0 && a8 < a7, "coverage must fall off outside the rect");
});

test("an empty mask stays empty and a full mask stays full", () => {
  const px = edgeImage(16, 16);
  const empty = new SelectionMask(16, 16);
  const r0 = refineSelection(empty, px, 16, 16);
  assert.equal(r0.isEmpty(), true);
  const full = new SelectionMask(16, 16);
  full.selectRect(0, 0, 16, 16);
  const r1 = refineSelection(full, px, 16, 16, { feather: 2 });
  assert.equal(r1.alphaAt(8, 8), 255);
});

test("a flat image with no colour signal keeps the original alpha", () => {
  const px = new Uint8ClampedArray(16 * 16 * 4).fill(255);
  const m = new SelectionMask(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) m.setAlpha(x, y, 128);
  const r = refineSelection(m, px, 16, 16, { radius: 4 });
  assert.equal(r.alphaAt(8, 8), 128, "no edge in the image means no edge to snap to");
});

test("a hard selection offset from a soft image edge is pulled onto it", () => {
  // AI4 regression pin: marquee/wand/lasso/pen all write 0 or 255, so the old
  // "alpha between 26 and 229" band was always empty and only the feather ran.
  // Here the selection is two pixels wider than the subject: refining must move
  // the edge to the colour boundary instead of leaving it where the user dragged.
  const W = 16, H = 6;
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // red until x = 7, a half-covered pixel at x = 8, blue from x = 9
      const [r, g, b] = x < 8 ? [200, 30, 30] : x === 8 ? [128, 16, 112] : [30, 30, 200];
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  const mask = new SelectionMask(W, H);
  mask.selectRect(0, 0, 10, H); // two pixels wider than the subject
  eq(mask.alphaAt(9, 3), 255);

  const refined = refineSelection(mask, px, W, H, { radius: 8, feather: 0 });
  const a9 = refined.alphaAt(9, 3);
  const a8 = refined.alphaAt(8, 3);
  const a4 = refined.alphaAt(4, 3);
  assert.ok(a9 < 64, `the selected-but-empty column must fall away, got ${a9}`);
  assert.ok(a8 > 40 && a8 < 220, `the half-covered column must land near half, got ${a8}`);
  eq(a4, 255);
});

test("AP4: the work area is the selection, not the canvas", () => {
  const mask = new SelectionMask(16384, 16384);
  mask.selectRect(8000, 8000, 40, 40);
  const area = refineWorkArea(mask, 8, 6, 16384, 16384);
  assert.ok(area, "a non-empty selection must report an area");
  // 40 + 2 * (8 + 6 + 2) = 72 — the canvas would be 16384.
  assert.ok(area.w <= 80 && area.h <= 80, `expected a bounded rect, got ${area.w} × ${area.h}`);
  assert.ok(area.x >= 8000 - 20 && area.x + area.w <= 8000 + 40 + 20, "the rect must contain the selection");
  assert.equal(refineWorkArea(new SelectionMask(64, 64), 8, 0, 64, 64), null, "an empty mask has no work area");
});

test("AP2: refining twice does not creep", () => {
  // A hard-edged subject on a soft image edge, refined with feather 3: the second
  // pass must land on the same contour as the first, not one band wider.
  const W = 64, H = 64;
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px[i] = x < 32 ? 255 : 0;
      px[i + 1] = x < 32 ? 255 : 0;
      px[i + 2] = x < 32 ? 255 : 0;
      px[i + 3] = 255;
    }
  }
  const start = new SelectionMask(W, H);
  start.selectRect(16, 16, 16, 32);
  const once = refineSelection(start, px, W, H, { radius: 6, feather: 3 });
  const twice = refineSelection(once, px, W, H, { radius: 6, feather: 3 });
  const a = once.bbox();
  const b = twice.bbox();
  assert.ok(a && b, "both passes must keep a selection");
  // Exact equality is the contract now that the output footprint is the input
  // footprint: a second pass may adjust coverage inside the box, never the box.
  assert.equal(a.w, b.w, `second refinement must not widen (${a.w} → ${b.w})`);
  assert.equal(a.h, b.h, `second refinement must not heighten (${a.h} → ${b.h})`);
  assert.equal(a.x, b.x, "nor move");
  assert.equal(a.y, b.y, "nor move");
});

/**
 * 64 × 64 hard red/blue edge plus deterministic noise. A linear colour ramp can
 * hide a widening feather inside its own gradient; independent per-pixel noise
 * cannot, so a second pass that re-feathers shows up as a different vector.
 */
function hardNoisyImage(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const noise = ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 33) - 16;
      const base = x < w / 2 ? [210, 50, 50] : [50, 50, 210];
      px[i] = Math.max(0, Math.min(255, base[0]! + noise));
      px[i + 1] = Math.max(0, Math.min(255, base[1]! + noise));
      px[i + 2] = Math.max(0, Math.min(255, base[2]! + noise));
      px[i + 3] = 255;
    }
  }
  return px;
}

test("AQ1: a thin selection is not erased by matting", () => {
  // The review probe: a one-row marquee on a two-colour edge. Both colours are
  // confidently "inside", so the anchor pair has two valid orientations and the
  // old per-pixel nearest tie-break flipped between neighbours — 7 of 8 selected
  // pixels came back as 0 and anything under ~3 px wide vanished outright.
  const px = edgeImage(16, 16);
  for (const [x0, width] of [[4, 8], [6, 3], [7, 2], [6, 2]] as const) {
    const m = new SelectionMask(16, 16);
    m.selectRect(x0, 8, width, 1);
    const r = refineSelection(m, px, 16, 16, { radius: 8, feather: 0 });
    for (let x = x0; x < x0 + width; x++) {
      assert.ok(
        r.alphaAt(x, 8) >= 128,
        `a selected pixel must survive refine: x=${x} of a ${width}px selection came back ${r.alphaAt(x, 8)}`,
      );
    }
  }
});

test("AQ2: a second feathered pass leaves every alpha unchanged", () => {
  const W = 64, H = 64;
  const px = hardNoisyImage(W, H);
  const start = new SelectionMask(W, H);
  start.selectRect(10, 16, 16, 32); // binary all the way in; entirely on the red side
  const once = refineSelection(start, px, W, H, { radius: 6, feather: 3 });
  const twice = refineSelection(once, px, W, H, { radius: 6, feather: 3 });
  const before: number[] = [];
  const after: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      before.push(once.alphaAt(x, y));
      after.push(twice.alphaAt(x, y));
    }
  }
  assert.ok(
    before.some((a) => a > 0 && a < 255),
    "the first pass must produce a fractional ramp, or the fixed-point claim is vacuous",
  );
  assert.deepEqual(after, before, "refining a feathered mask twice must not change any alpha");
});
