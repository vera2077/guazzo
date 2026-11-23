import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectPadding,
  normalizeLayerEffects,
  renderLayerEffects,
  toAgEffects,
  type LayerEffects,
} from "../effects.ts";
import type { RgbaBuffer } from "../effects-bake.ts";
import { Document } from "../document.ts";
import { eq } from "./helpers.ts";

/** A 40×40 buffer with a solid 16×16 red square at (12,12). */
function square(): RgbaBuffer {
  const width = 40, height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 12; y < 28; y++) {
    for (let x = 12; x < 28; x++) {
      const i = (y * width + x) * 4;
      data[i] = 255;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const at = (b: RgbaBuffer, x: number, y: number): number[] => {
  const i = (y * b.width + x) * 4;
  return [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!, b.data[i + 3]!];
};

const shadow: LayerEffects = {
  dropShadow: [{ enabled: true, color: { r: 0, g: 0, b: 0 }, opacity: 1, angle: 90, distance: 6, size: 2 }],
};

test("a disabled style returns the content untouched", () => {
  const content = square();
  const out = renderLayerEffects(content, { ...shadow, disabled: true });
  assert.equal(out, content);
});

test("a drop shadow paints outside the layer's own pixels", () => {
  const out = renderLayerEffects(square(), shadow);
  // 90° in Photoshop means "down"; the square ends at y=27, so the shadow
  // lands below it without covering the square's own colour.
  assert.ok(at(out, 20, 34)[3]! > 0, "the shadow must reach below the layer");
  eq(at(out, 20, 20)[0], 255);
  eq(at(out, 0, 0)[3], 0);
});

test("a solid fill recolours the shape without changing its coverage", () => {
  const fx: LayerEffects = { solidFill: [{ enabled: true, color: { r: 0, g: 0, b: 255 }, opacity: 1 }] };
  const out = renderLayerEffects(square(), fx);
  eq(at(out, 20, 20)[2], 255);
  eq(at(out, 20, 20)[0], 0);
  eq(at(out, 20, 20)[3], 255);
  eq(at(out, 5, 5)[3], 0);
});

test("a stroke adds a band just outside the edge", () => {
  const fx: LayerEffects = { stroke: [{ enabled: true, color: { r: 0, g: 255, b: 0 }, opacity: 1, size: 3 }] };
  const out = renderLayerEffects(square(), fx);
  // one pixel outside the square's left edge, inside the 3-px band
  eq(at(out, 11, 20)[1], 255);
  assert.ok(at(out, 11, 20)[3]! > 0);
  eq(at(out, 20, 20)[0], 255);
});

test("effectPadding matches the reach the renderer uses", () => {
  // distance 6 + size 2
  eq(effectPadding(shadow), 8);
  eq(effectPadding({}), 0);
  eq(effectPadding({ stroke: [{ enabled: true, color: { r: 0, g: 0, b: 0 }, size: 4 }] }), 4);
});

test("normalize keeps the numbers and drops what the renderer cannot draw", () => {
  const fx = normalizeLayerEffects({
    dropShadow: [{ enabled: true, color: { r: 1, g: 2, b: 3 }, distance: { units: "Pixels", value: 7 }, size: 2 }],
    satin: [{ enabled: true }],
    bevel: { enabled: true, size: { units: "Pixels", value: 5 } },
  });
  assert.ok(fx);
  eq(fx!.dropShadow![0]!.distance, 7);
  eq(fx!.dropShadow![0]!.size, 2);
  assert.equal((fx as unknown as Record<string, unknown>).satin, undefined);
  eq(fx!.bevel!.size, 5);
});

test("export puts units back so Photoshop reads a reach, not a zero", () => {
  const out = toAgEffects(shadow) as Record<string, unknown>;
  const list = out.dropShadow as Array<Record<string, unknown>>;
  assert.deepEqual(list[0]!.distance, { units: "Pixels", value: 6 });
  assert.deepEqual(list[0]!.size, { units: "Pixels", value: 2 });
  eq(list[0]!.present, true);
});

test("the compositor draws the style outside the layer's pixels", () => {
  const doc = new Document(40, 40);
  const layer = doc.addLayer("Styled");
  layer.grid.fillRect(12, 12, 8, 8, [255, 0, 0, 255]);
  layer.effects = shadow;

  const flat = doc.composite();
  const alphaAt = (b: Uint8ClampedArray, x: number, y: number): number => b[(y * 40 + x) * 4 + 3]!;
  eq(alphaAt(flat, 16, 16), 255);
  assert.ok(alphaAt(flat, 16, 26) > 0, "the shadow must be composited below the square");
  eq(alphaAt(flat, 0, 0), 0);

  // Removing the recipe must remove the shadow: otherwise the test would pass
  // for a compositor that ignored styles and simply drew the square.
  layer.effects = undefined;
  const bare = doc.composite();
  eq(alphaAt(bare, 16, 26), 0);
});

test("a style reach is clamped to the canvas, not to the number in the file", () => {
  // 1,000,000 px of stroke is not a style; it is a padded buffer and a
  // (2r+1)² disc loop before any area guard runs (sec-r13 #2).
  const fx = normalizeLayerEffects({ stroke: [{ enabled: true, size: { units: "Pixels", value: 1_000_000 } }] });
  assert.ok(fx?.stroke?.[0]?.size !== undefined);
  assert.equal(fx.stroke[0].size, 250);
  assert.ok(effectPadding(fx) <= 250);
});

test("a gradient overlay keeps at most 64 colour stops", () => {
  const colorStops = Array.from({ length: 5000 }, (_, i) => ({ color: { r: i % 256, g: 0, b: 0 }, location: (i % 100) / 100 }));
  const fx = normalizeLayerEffects({ gradientOverlay: [{ gradient: { type: "solid", colorStops } }] });
  const stops = fx?.gradientOverlay?.[0]?.gradient?.colorStops ?? [];
  assert.ok(stops.length <= 64, `expected <= 64, got ${stops.length}`);
});
