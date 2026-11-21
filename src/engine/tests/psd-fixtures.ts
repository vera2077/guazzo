/**
 * psd-fixtures.ts — PSD files made in code, no Photoshop.
 *
 * The vendored ag-psd writer produces real bytes; the reader parses them back
 * exactly as `main.ts` will, so every assertion below runs against the same
 * object shape the importer consumes. Fixtures are deliberately small: a
 * 16×12 file is enough to see stacking, opacity, clipping and group nesting,
 * and it keeps a failure readable.
 *
 * `TOLERANCE` is stated once and used by both the tests and scripts/psd-check.
 */
import type { PsdLike } from "../psd.ts";
import { loadAgPsd, type AgPsd } from "./agpsd.ts";

let ag: AgPsd | null = null;

/** one loader for the whole suite: resolution first, store path second */
export function agPsd(): AgPsd {
  if (ag) return ag;
  ag = loadAgPsd();
  return ag;
}

/** an RGBA buffer filled with one colour (ag-psd's ImageData shape) */
export function fill(w: number, h: number, rgba: readonly [number, number, number, number]): {
  width: number; height: number; data: Uint8ClampedArray;
} {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width: w, height: h, data };
}

/** write a PSD object to bytes and parse it back the way main.ts does */
export function roundtrip(psd: unknown): PsdLike {
  const api = agPsd();
  const bytes = new Uint8Array(api.writePsd(psd, { generateThumbnail: false }));
  return api.readPsd(bytes, { useImageData: true }) as PsdLike;
}

/** 8-bit rounding is the only source of error between PSD and Document */
export const TOLERANCE = { maxDelta: 2, meanDelta: 0.5 } as const;

export interface FixtureSpec {
  /** short name used in failure messages */
  name: string;
  /** the PSD object handed to ag-psd's writer */
  psd: unknown;
  /** leaf names in depth-first order (groups themselves are real nodes now) */
  flatOrder: string[];
  /** unsupported features this file must name in the import report */
  expectedFindings: ReadonlyArray<{ feature: string; path?: string; detail?: string }>;
  /** layers whose props must survive the roundtrip */
  props: ReadonlyArray<{
    name: string; opacity?: number; blend?: string; visible?: boolean; clip?: boolean;
  }>;
}

export const FIXTURES: readonly FixtureSpec[] = [
  {
    name: "groups",
    psd: {
      width: 16, height: 12,
      children: [
        { name: "BG", imageData: fill(16, 12, [32, 64, 96, 255]), left: 0, top: 0, right: 16, bottom: 12 },
        {
          name: "Group A", opacity: 0.75, blendMode: "multiply",
          children: [
            { name: "inner", imageData: fill(4, 4, [200, 50, 50, 255]), left: 2, top: 2, right: 6, bottom: 6 },
            {
              name: "Group B", opacity: 0.5, hidden: true,
              children: [
                { name: "deep", imageData: fill(3, 3, [0, 200, 0, 255]), left: 8, top: 5, right: 11, bottom: 8 },
              ],
            },
          ],
        },
        { name: "Clip", imageData: fill(4, 3, [255, 220, 0, 255]), left: 1, top: 8, right: 5, bottom: 11, clipping: true },
      ],
    },
    flatOrder: ["BG", "inner", "deep", "Clip"],
    expectedFindings: [],
    props: [
      { name: "BG" },
      // group opacity/blend/pass-through are real node props now, not losses
      { name: "inner" },
      { name: "Clip", clip: true },
    ],
  },
  {
    name: "adjustments",
    psd: {
      width: 8, height: 8,
      children: [
        { name: "BG", imageData: fill(8, 8, [90, 90, 90, 255]), left: 0, top: 0, right: 8, bottom: 8 },
        { name: "Bright/Contrast", adjustment: { type: "brightness/contrast", brightness: 20, contrast: 10 } },
        { name: "Levels", adjustment: { type: "levels" } },
        { name: "Curves", adjustment: { type: "curves" } },
      ],
    },
    flatOrder: ["BG", "Bright/Contrast", "Levels", "Curves"],
    expectedFindings: [
      // Bright/Contrast and Curves are mapped to live recipes now; the Levels
      // fixture carries no channels, so that record still falls through to the
      // generic adjustment admission.
      { feature: "adjustment", path: "Levels" },
    ],
    props: [
      { name: "BG" },
      { name: "Bright/Contrast", visible: true },
      { name: "Levels", visible: true },
      { name: "Curves", visible: true },
    ],
  },
  {
    name: "fills-text",
    psd: {
      width: 10, height: 8,
      children: [
        { name: "BG", imageData: fill(10, 8, [255, 255, 255, 255]), left: 0, top: 0, right: 10, bottom: 8 },
        { name: "Solid", vectorFill: { type: "color", color: { r: 255, g: 0, b: 0 } } },
        {
          name: "Text", text: { text: "Hi" },
          imageData: fill(6, 4, [0, 0, 0, 255]), left: 2, top: 2, right: 8, bottom: 6,
        },
      ],
    },
    flatOrder: ["BG", "Solid", "Text"],
    // Solid colour fills and text are live now; the fixture has no lost feature.
    expectedFindings: [],
    props: [{ name: "BG" }, { name: "Solid", visible: true }, { name: "Text", visible: true }],
  },
  {
    name: "bit-depth",
    psd: {
      width: 8, height: 8, bitsPerChannel: 16,
      children: [
        { name: "Sixteen", imageData: fill(8, 8, [10, 20, 30, 255]), left: 0, top: 0, right: 8, bottom: 8 },
      ],
    },
    flatOrder: ["Sixteen"],
    expectedFindings: [{ feature: "bit-depth", path: "-", detail: "16-bit" }],
    props: [{ name: "Sixteen" }],
  },
  {
    name: "effects",
    psd: {
      width: 12, height: 12,
      children: [
        { name: "BG", imageData: fill(12, 12, [255, 255, 255, 255]), left: 0, top: 0, right: 12, bottom: 12 },
        {
          name: "Square", imageData: fill(4, 4, [255, 0, 0, 255]), left: 4, top: 4, right: 8, bottom: 8,
          effects: {
            dropShadow: [{
              enabled: true, color: { r: 0, g: 0, b: 0 }, opacity: 0.8,
              angle: 120, distance: { value: 3, units: "Pixels" }, size: { value: 2, units: "Pixels" },
            }],
          },
        },
      ],
    },
    flatOrder: ["BG", "Square"],
    expectedFindings: [{ feature: "effect", path: "Square" }],
    props: [{ name: "BG" }, { name: "Square" }],
  },
];

export interface NativeLayerSpec {
  name: string;
  rgba: readonly [number, number, number, number];
  x: number; y: number; w: number; h: number;
  opacity?: number;
  blend?: "normal" | "multiply";
}

/** the same document built directly in Guazzo, for composite comparison */
export const NATIVE_COMPOSITE: {
  width: number; height: number; layers: readonly NativeLayerSpec[];
} = {
  width: 8, height: 6,
  layers: [
    { name: "BG", rgba: [40, 80, 160, 255], x: 0, y: 0, w: 8, h: 6 },
    { name: "Top", rgba: [200, 30, 30, 255], x: 2, y: 1, w: 4, h: 3, opacity: 0.6, blend: "multiply" },
  ],
};

export const COMPOSITE_FIXTURE: FixtureSpec = {
  name: "composite",
  psd: {
    width: 8, height: 6,
    children: NATIVE_COMPOSITE.layers.map((l) => ({
      name: l.name,
      imageData: fill(l.w, l.h, l.rgba),
      left: l.x, top: l.y, right: l.x + l.w, bottom: l.y + l.h,
      opacity: l.opacity ?? 1,
      blendMode: l.blend ?? "normal",
    })),
  },
  flatOrder: ["BG", "Top"],
  expectedFindings: [],
  props: [
    { name: "BG" },
    { name: "Top", opacity: 0.6, blend: "multiply" },
  ],
};
