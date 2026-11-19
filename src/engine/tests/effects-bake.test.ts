/**
 * effects-bake.test.ts — golden tests for layer-style baking (PSD stage 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blurAlpha, makeDropShadowLayer, bakeSolidFill, makeStrokeLayer, compositeOver, makeInnerShadowLayer, makeOuterGlowLayer, makeInnerGlowLayer, makeBevelLayers, bakeGradientOverlay, type RgbaBuffer } from "../effects-bake.ts";
import { psdToDocument, type PsdLike } from "../psd.ts";

function eq(actual: unknown, expected: unknown): void {
  assert.deepStrictEqual(actual, expected);
}

function makeBuf(w: number, h: number): RgbaBuffer {
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
}

/** paint an opaque square into a buffer */
function square(buf: RgbaBuffer, x0: number, y0: number, s: number, rgba: [number, number, number, number]): void {
  for (let y = y0; y < y0 + s; y++) {
    for (let x = x0; x < x0 + s; x++) {
      const o = (y * buf.width + x) * 4;
      buf.data[o] = rgba[0]; buf.data[o + 1] = rgba[1];
      buf.data[o + 2] = rgba[2]; buf.data[o + 3] = rgba[3];
    }
  }
}

function px(buf: RgbaBuffer, x: number, y: number): [number, number, number, number] {
  const o = (y * buf.width + x) * 4;
  return [buf.data[o] ?? 0, buf.data[o + 1] ?? 0, buf.data[o + 2] ?? 0, buf.data[o + 3] ?? 0];
}

test("blurAlpha spreads an impulse symmetrically", () => {
  const w = 9, h = 9;
  const a = new Float32Array(w * h);
  a[4 * w + 4] = 1;
  const b = blurAlpha(a, w, h, 1);
  eq(b[4 * w + 4]! < 1, true);            // center diluted
  eq(b[4 * w + 5]!, b[5 * w + 4]!);       // right == down (symmetry)
  eq(b[3 * w + 4]!, b[4 * w + 5]!);       // up == right
  eq(b[0]!, 0);                            // far corner untouched
  let sum = 0;
  for (const v of b) sum += v;
  eq(Math.abs(sum - 1) < 0.01, true);      // clamped sampling conserves mass
});

test("drop shadow: hard shadow at 90° falls below, content excluded", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const sh = makeDropShadowLayer(buf, { r: 0, g: 0, b: 0, opacity: 1, angleDeg: 90, distance: 4, size: 0 });
  // light from top → shadow below: square rows 6..9 → shadow rows 10..13
  eq(px(sh, 7, 12), [0, 0, 0, 255]);
  eq(px(sh, 7, 7), [0, 0, 0, 0]);   // shadow layer contains NO content
  eq(px(sh, 7, 9), [0, 0, 0, 0]);    // gap between content and shadow
});

test("drop shadow: 0° light from east → shadow to the left", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const sh = makeDropShadowLayer(buf, { r: 0, g: 0, b: 0, opacity: 1, angleDeg: 0, distance: 4, size: 0 });
  eq(px(sh, 3, 7), [0, 0, 0, 255]);  // square x 6..9 → shadow x 2..5
  eq(px(sh, 7, 7), [0, 0, 0, 0]);
});

test("drop shadow: blur softens and fades with distance", () => {
  const buf = makeBuf(20, 20);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const sh = makeDropShadowLayer(buf, { r: 0, g: 0, b: 0, opacity: 1, angleDeg: 90, distance: 4, size: 4 });
  const center = px(sh, 7, 12)[3] ?? 0;
  const edge = px(sh, 7, 16)[3] ?? 0;
  eq(center > 0 && center < 255, true);   // soft, not full
  eq(edge > 0, true);                       // blur reaches past the hard edge
  eq(center > edge, true);                  // fades with distance
});

test("solid fill mixes the color, keeps alpha and transparent pixels", () => {
  const buf = makeBuf(8, 8);
  square(buf, 2, 2, 4, [255, 0, 0, 255]);
  const out = bakeSolidFill(buf, { r: 0, g: 0, b: 255, opacity: 0.5 });
  eq(px(out, 3, 3), [128, 0, 128, 255]);  // 127.5 rounds half-to-even → 128
  eq(px(out, 0, 0), [0, 0, 0, 0]);        // transparent untouched
});

test("stroke outside: one-pixel ring with square corners at size 1", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const st = makeStrokeLayer(buf, { r: 0, g: 0, b: 0, opacity: 1, size: 1 });
  eq(px(st, 5, 7), [0, 0, 0, 255]);  // band above content row
  eq(px(st, 7, 5), [0, 0, 0, 255]);  // band left of content col
  eq(px(st, 4, 7), [0, 0, 0, 0]);    // only 1px wide
  eq(px(st, 5, 5), [0, 0, 0, 0]);    // r=1 disc has no diagonal → square corners
  eq(px(st, 7, 7), [0, 0, 0, 0]);    // content itself excluded from the band
});

test("stroke outside: size 2 rounds the corners", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const st = makeStrokeLayer(buf, { r: 0, g: 0, b: 0, opacity: 1, size: 2 });
  eq(px(st, 5, 5), [0, 0, 0, 255]);  // (±1,±1) in disc → corner covered
  eq(px(st, 4, 4), [0, 0, 0, 0]);    // but not (±2,±2)
});

test("compositeOver: content covers the shadow where they overlap", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const sh = makeDropShadowLayer(buf, { r: 0, g: 0, b: 0, opacity: 1, angleDeg: 90, distance: 4, size: 0 });
  compositeOver(sh, buf); // dst = shadow, src = content
  eq(px(sh, 7, 12), [0, 0, 0, 255]);
  eq(px(sh, 7, 7), [255, 0, 0, 255]);
});

test("psd import bakes drop shadow beyond the layer bounds", () => {
  const img = new Uint8ClampedArray(4 * 4 * 4);
  for (let o = 0; o < img.length; o += 4) { img[o] = 255; img[o + 3] = 255; }
  const psd: PsdLike = {
    width: 32, height: 32,
    children: [{
      name: "L", left: 6, top: 6, right: 10, bottom: 10,
      imageData: { width: 4, height: 4, data: img },
      effects: { dropShadow: [{ enabled: true, color: { r: 0, g: 0, b: 0 }, opacity: 1, angle: 90, distance: 4, size: 0 }] },
    }],
  };
  const doc = psdToDocument(psd);
  const out = doc.composite();
  const at = (x: number, y: number): number[] => {
    const o = (y * doc.width + x) * 4;
    return [out[o] ?? 0, out[o + 1] ?? 0, out[o + 2] ?? 0, out[o + 3] ?? 0];
  };
  eq(at(7, 7), [255, 0, 0, 255]);   // content
  eq(at(7, 12), [0, 0, 0, 255]);   // shadow below, outside original bounds
});

test("psd import bakes color overlay onto the layer", () => {
  const img = new Uint8ClampedArray(4 * 4 * 4);
  for (let o = 0; o < img.length; o += 4) { img[o] = 255; img[o + 3] = 255; }
  const psd: PsdLike = {
    width: 32, height: 32,
    children: [{
      name: "L", left: 6, top: 6, right: 10, bottom: 10,
      imageData: { width: 4, height: 4, data: img },
      effects: { solidFill: [{ enabled: true, color: { r: 0, g: 0, b: 255 }, opacity: 1 }] },
    }],
  };
  const doc = psdToDocument(psd);
  const out = doc.composite();
  const o = (7 * doc.width + 7) * 4;
  eq([out[o] ?? 0, out[o + 1] ?? 0, out[o + 2] ?? 0, out[o + 3] ?? 0], [0, 0, 255, 255]);
});

// ---- stage 3: inner shadow / glows / bevel / gradient overlay --------------

test("inner shadow: light from top → band at the bottom inside edge", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const sh = makeInnerShadowLayer(buf, { r: 0, g: 0, b: 0, opacity: 1, angleDeg: 90, distance: 2, size: 0 });
  // moved silhouette covers rows 4..7 → uncovered band rows 8..9
  eq(px(sh, 7, 9), [0, 0, 0, 255]);
  eq(px(sh, 7, 8), [0, 0, 0, 255]);
  eq(px(sh, 7, 7)[3], 0);   // covered by the shifted silhouette
  eq(px(sh, 7, 6)[3], 0);
  eq(px(sh, 7, 5)[3], 0);   // outside content: never inner-shadowed
});

test("outer glow: falloff just outside the content, zero far away", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const g = makeOuterGlowLayer(buf, { r: 0, g: 255, b: 0, opacity: 1, size: 4, choke: 0 });
  const near = px(g, 7, 5);       // 1px above the square
  eq(near[3] > 0 && near[3] < 255, true);
  eq(near[1], 255);               // tinted green
  eq(px(g, 1, 1)[3], 0);          // far corner: no glow
  // (interior pixels DO carry partial glow alpha — harmless: compositeOver
  //  paints the opaque content over them in bakeEffects' merge order.)
});

test("inner glow: strongest at the inside edge, dimmer toward the center", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [255, 0, 0, 255]);
  const g = makeInnerGlowLayer(buf, { r: 255, g: 255, b: 0, opacity: 1, size: 4, choke: 0 });
  const edge = px(g, 7, 6)[3];    // top edge of the square
  const inner = px(g, 7, 8)[3];   // 2px in from the top edge
  eq(edge > 0, true);
  eq(inner > 0, true);            // σ=2 reaches the middle of a 4px shape
  eq(edge > inner, true);         // edge glow dominates
  eq(px(g, 3, 3)[3], 0);          // outside: no inner glow
});

test("bevel: light from east → highlight right-inside, shadow left-inside", () => {
  const buf = makeBuf(16, 16);
  square(buf, 6, 6, 4, [128, 128, 128, 255]);
  const b = makeBevelLayers(buf, {
    size: 4, angleDeg: 0, invert: false,
    highlight: { r: 255, g: 255, b: 255, opacity: 1 },
    shadow: { r: 0, g: 0, b: 0, opacity: 1 },
  });
  const hlR = px(b.highlight, 9, 7)[3];   // right inside edge
  const hlL = px(b.highlight, 6, 7)[3];   // left inside edge
  eq(hlR > 0, true);
  eq(hlR > hlL, true);
  const shL = px(b.shadow, 6, 7)[3];
  const shR = px(b.shadow, 9, 7)[3];
  eq(shL > 0, true);
  eq(shL > shR, true);
});

test("gradient overlay: endpoint stops land exactly at the content bbox", () => {
  const buf = makeBuf(16, 16);
  square(buf, 3, 6, 10, [255, 255, 255, 255]);   // x 3..12
  const g = bakeGradientOverlay(buf, {
    stops: [
      { loc: 0, r: 255, g: 0, b: 0 },
      { loc: 1, r: 0, g: 0, b: 255 },
    ],
    angleDeg: 0, opacity: 1, reverse: false,
  });
  eq(px(g, 3, 8), [255, 0, 0, 255]);    // leftmost content: first stop, exact
  eq(px(g, 12, 8), [0, 0, 255, 255]);   // rightmost: last stop, exact
  eq(px(g, 2, 8)[3], 0);                // transparent outside stays untouched
});

test("psd import bakes outer glow beyond the layer bounds", () => {
  const img = new Uint8ClampedArray(4 * 4 * 4);
  for (let o = 0; o < img.length; o += 4) { img[o] = 255; img[o + 3] = 255; }
  const psd: PsdLike = {
    width: 32, height: 32,
    children: [{
      name: "L", left: 6, top: 6, right: 10, bottom: 10,
      imageData: { width: 4, height: 4, data: img },
      effects: { outerGlow: { enabled: true, color: { r: 0, g: 255, b: 0 }, opacity: 1, size: 4, choke: 0 } },
    }],
  };
  const doc = psdToDocument(psd);
  const out = doc.composite();
  const at = (x: number, y: number): [number, number, number, number] => {
    const o = (y * doc.width + x) * 4;
    return [out[o] ?? 0, out[o + 1] ?? 0, out[o + 2] ?? 0, out[o + 3] ?? 0];
  };
  // 2px above the layer, over transparent document: pure tinted glow, partial alpha
  const near = at(7, 4);
  eq(near[1], 255);                          // green channel saturated
  eq(near[0], 0);                            // red channel fully replaced by tint
  eq(near[3] > 0 && near[3] < 255, true);    // soft falloff alpha
  eq(at(2, 2), [0, 0, 0, 0]);                // far corner transparent, no glow
});
