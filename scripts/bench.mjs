#!/usr/bin/env node
/**
 * Micro-benchmarks for the paths that make a large document feel slow.
 *
 * Deliberately plain: no dependency, no warm-up ritual, no thresholds that fail
 * a build (machines differ). It prints milliseconds per operation so a change
 * can be compared against the previous run — the point is the number, not a gate.
 *
 * Run:  node scripts/bench.mjs [size]
 *       size defaults to 1500 (a 1500² document — 9 MP, a plausible photo).
 */
import { mkdirSync } from "node:fs";

const SIZE = Number(process.argv[2] ?? 1500) || 1500;

const dist = new URL("../dist/engine/", import.meta.url);
const { Document } = await import(new URL("document.js", dist).href);
const { applyFilter } = await import(new URL("filter.js", dist).href);
const { applyLevels } = await import(new URL("tone.js", dist).href);
const { floodFill, sampleGrid } = await import(new URL("flood.js", dist).href);
const { defaultAdjustSpec } = await import(new URL("adjustfn.js", dist).href);
const { perspectiveCrop } = await import(new URL("perspective.js", dist).href);
const { fillMaskFromSelection } = await import(new URL("document.js", dist).href);
const { SelectionMask } = await import(new URL("mask.js", dist).href);

/** median of `runs` timings, in ms — the median ignores a single GC spike */
function time(label, runs, fn) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn(i);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(samples.length / 2)];
  console.log(`${label.padEnd(46)} ${med.toFixed(1).padStart(8)} ms`);
  return med;
}

const w = SIZE;
const h = SIZE;
console.log(`\nGuazzo benchmarks — ${w} × ${h} (${(w * h / 1e6).toFixed(1)} MP)\n`);

// A 5-layer stack with real pixels: the shape a document actually has.
const doc = new Document(w, h);
for (let i = 0; i < 5; i++) {
  const l = doc.addLayer(`Layer ${i + 1}`);
  l.grid.fillRect(0, 0, w, h, [40 + i * 30, 90, 160, 180]);
}
const buf = new Uint8ClampedArray(w * h * 4);

time("composite 5 layers, full document", 5, () => doc.compositeRect(0, 0, w, h, buf));
time("composite 5 layers, 512² dirty rect", 20, () => doc.compositeRect(100, 100, 512, 512, new Uint8ClampedArray(512 * 512 * 4)));

// Blur is the heaviest filter (separable gaussian over the tiles).
const small = new Document(1000, 1000);
const sLayer = small.addLayer("Blur");
sLayer.grid.fillRect(0, 0, 1000, 1000, [120, 140, 160, 255]);
time("gaussian blur σ=8 over 1000²", 3, () => applyFilter(sLayer.grid, 0, 0, 1000, 1000, { kind: "blur", amount: 8 }));

// Adjustment layers: the cache means the LUT is built once, then reused.
const adjDoc = new Document(w, h);
adjDoc.addLayer("BG").grid.fillRect(0, 0, w, h, [130, 130, 130, 255]);
adjDoc.addAdjustLayer({ ...defaultAdjustSpec("curves") });
time("composite with an adjustment layer (cached LUT)", 5, () => adjDoc.compositeRect(0, 0, w, h, buf));

// Destructive tonal pass over the tile grid.
const toneDoc = new Document(w, h);
const toneLayer = toneDoc.addLayer("Tone");
toneLayer.grid.fillRect(0, 0, w, h, [130, 130, 130, 255]);
time("applyLevels over the full document", 3, () => applyLevels(toneLayer.grid, { x: 0, y: 0, w, h }, { inBlack: 10, inWhite: 240, gamma: 1.1, outBlack: 0, outWhite: 255 }));

// Region sampling is what the magic wand pays per click.
time("sampleGrid (full document read)", 10, () => sampleGrid(toneLayer.grid, w, h));
const px = sampleGrid(toneLayer.grid, w, h);
time("floodFill from the centre, contiguous", 5, () => floodFill(toneLayer.grid, (w / 2) | 0, (h / 2) | 0, [255, 0, 0, 255], { tolerance: 8, contiguous: true }));

console.log("\nNotes: one timing per line is the median; the machine is shared, so");
console.log("compare relative numbers between runs rather than absolute values.\n");
mkdirSync(new URL("../.bench", import.meta.url), { recursive: true });

// ---- handoff-7 AL3: what a preview tick costs on a heavy document -----------
// A 6000 x 4000 document with twenty layers. Tiles are sparse, so the layers
// cost only what is drawn; the preview works on a 420 px proxy.
{
  const { TileGrid } = await import(new URL("tile.js", dist).href);
  const PREVIEW_MAX = 420;
  const docW = 6000, docH = 4000;
  const sel = { x: 1200, y: 800, w: 2600, h: 1800 };
  const k = Math.min(1, PREVIEW_MAX / Math.max(sel.w, sel.h));
  const sw = Math.max(1, Math.round(sel.w * k));
  const sh = Math.max(1, Math.round(sel.h * k));
  const layers = [];
  for (let i = 0; i < 20; i++) {
    const g = new TileGrid(docW, docH);
    const patch = new Uint8ClampedArray(64 * 64 * 4).fill((i * 12) & 255);
    g.writeRect((i * 211) % 3000, (i * 173) % 2000, 64, 64, patch);
    layers.push(g);
  }
  time("preview proxy build, 20 layers (ms)", 3, () => {
    const stack = new Document(sw, sh);
    for (const g of layers) {
      const l = stack.addLayer("l");
      const out = new Uint8ClampedArray(sw * sh * 4);
      g.readRect(0, 0, sw, sh, out);
      l.grid.writeRect(0, 0, sw, sh, out);
    }
  });
  const stack = new Document(sw, sh);
  for (const g of layers) {
    const l = stack.addLayer("l");
    const out = new Uint8ClampedArray(sw * sh * 4);
    g.readRect(0, 0, sw, sh, out);
    l.grid.writeRect(0, 0, sw, sh, out);
  }
  const buf = new Uint8ClampedArray(sw * sh * 4);
  time(`preview tick, cached stack ${sw} x ${sh} (ms)`, 5, () => {
    stack.compositeRect(0, 0, sw, sh, buf);
  });
  console.log(`  (proxy ${sw} x ${sh} px for a ${sel.w} x ${sel.h} selection)`);
}

// ---- perspective crop -------------------------------------------------------
// The warp copies the quad's bounding box into a float buffer before sampling,
// so a full-canvas quad is the worst case a user can ask for.
const { TileGrid } = await import(new URL("tile.js", dist).href);
{
  const quad = [[0, 0], [w, 0], [w, h], [0, h]];
  time("perspective crop, full-canvas quad", w <= 2048 ? 3 : 2, () => {
    perspectiveCrop(doc, quad, w, h);
  });
}

// ---- select-and-mask output -------------------------------------------------
// "Select all, then add a layer mask" is the shape that touches every tile.
{
  const sel = new SelectionMask(w, h);
  sel.selectRect(0, 0, w, h);
  time("fillMaskFromSelection, select-all", 3, () => {
    fillMaskFromSelection(new TileGrid(w, h), sel, true, 255);
  });
}
