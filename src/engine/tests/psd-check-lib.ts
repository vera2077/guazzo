/**
 * psd-check-lib.ts — one verification pass shared by the node test and
 * scripts/psd-check.mjs, so the gate and the standalone checker cannot drift.
 *
 * Every check returns a failure string instead of throwing: the script prints
 * all of them (a PSD import that loses three features should name three), and
 * the test asserts the array is empty.
 */
import { Document, type Layer } from "../document.ts";
import { psdToDocument } from "../psd.ts";
import { emptyImportReport, type ImportReport } from "../importreport.ts";
import {
  COMPOSITE_FIXTURE, FIXTURES, NATIVE_COMPOSITE, TOLERANCE, roundtrip,
  type FixtureSpec, type NativeLayerSpec,
} from "./psd-fixtures.ts";
import { reportFindings, silentDrops, type Finding } from "./psd-report.ts";

export interface CompositeDiff { max: number; mean: number; pixels: number }

export interface CheckResult {
  fixture: string;
  layers: number;
  findings: Finding[];
  composite?: CompositeDiff;
  failures: string[];
}

function approx(a: number, b: number, eps = 1 / 255 + 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function layerTree(doc: Document): Layer[] {
  const out: Layer[] = [];
  const walk = (list: readonly Layer[]): void => {
    for (const layer of list) {
      out.push(layer);
      if (layer.children) walk(layer.children);
    }
  };
  walk(doc.layers);
  return out;
}

function leafNames(doc: Document): string[] {
  return layerTree(doc).filter((l) => l.kind !== "group").map((l) => l.name);
}

function layerHasPixels(layer: Layer, width: number, height: number): boolean {
  if (!layer.grid) return false;
  const buf = new Uint8ClampedArray(width * height * 4);
  layer.grid.readRect(0, 0, width, height, buf);
  for (let i = 3; i < buf.length; i += 4) if (buf[i] !== 0) return true;
  return false;
}

/** compare two composite buffers channel by channel */
export function compositeDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): CompositeDiff {
  if (a.length !== b.length) throw new Error(`composite sizes differ: ${a.length} vs ${b.length}`);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: a.length ? sum / a.length : 0, pixels: a.length / 4 };
}

function nativeDoc(spec: { width: number; height: number; layers: readonly NativeLayerSpec[] }): Document {
  const doc = new Document(spec.width, spec.height);
  for (const l of spec.layers) {
    const layer = doc.addLayer(l.name);
    const data = new Uint8ClampedArray(l.w * l.h * 4);
    for (let i = 0; i < l.w * l.h; i++) {
      data[i * 4] = l.rgba[0]; data[i * 4 + 1] = l.rgba[1];
      data[i * 4 + 2] = l.rgba[2]; data[i * 4 + 3] = l.rgba[3];
    }
    layer.grid.writeRect(l.x, l.y, l.w, l.h, data);
    layer.opacity = l.opacity ?? 1;
    layer.blendMode = l.blend ?? "normal";
  }
  return doc;
}

function checkStructure(
  f: FixtureSpec,
  doc: Document,
  report: ImportReport,
  findings: readonly Finding[],
  failures: string[],
): void {
  const psd = roundtrip(f.psd);
  const leaves = leafNames(doc);
  if (leaves.length !== f.flatOrder.length || leaves.some((n, i) => n !== f.flatOrder[i])) {
    failures.push(`leaf order ${JSON.stringify(leaves)} != ${JSON.stringify(f.flatOrder)}`);
  }
  const byName = new Map(layerTree(doc).map((l) => [l.name, l]));
  for (const p of f.props) {
    const layer = byName.get(p.name);
    if (!layer) { failures.push(`layer "${p.name}" is missing`); continue; }
    if (p.opacity !== undefined && !approx(layer.opacity, p.opacity)) {
      failures.push(`"${p.name}" opacity ${layer.opacity.toFixed(3)} != ${p.opacity}`);
    }
    if (p.blend !== undefined && layer.blendMode !== p.blend) {
      failures.push(`"${p.name}" blend ${layer.blendMode} != ${p.blend}`);
    }
    if (p.visible !== undefined && layer.visible !== p.visible) {
      failures.push(`"${p.name}" visible ${layer.visible} != ${p.visible}`);
    }
    if (p.clip !== undefined && (layer.clipToBelow === true) !== p.clip) {
      failures.push(`"${p.name}" clipping ${layer.clipToBelow === true} != ${p.clip}`);
    }
  }
  for (const want of f.expectedFindings) {
    const hit = findings.find((g) =>
      g.feature === want.feature &&
      (want.path === undefined || g.path === want.path) &&
      (want.detail === undefined || g.detail.toLowerCase().includes(want.detail.toLowerCase())),
    );
    if (!hit) failures.push(`report lacks ${want.feature}${want.path ? ` "${want.path}"` : ""}`);
  }
  // every PSD leaf with pixels must still have pixels in the document
  for (const name of f.flatOrder) {
    const layer = byName.get(name);
    if (!layer) continue;
    if (layer.kind === "pixel" && !layerHasPixels(layer, doc.width, doc.height)) {
      // empty pixel layers are expected exactly for the reported features
      const reported = findings.some((g) => (g.path === name || g.path.endsWith(` / ${name}`)) && g.feature !== "bit-depth");
      if (!reported && f.name !== "bit-depth") failures.push(`"${name}" has no pixels and no report entry`);
    }
  }
  const silent = silentDrops(psd, doc, findings);
  if (silent.length) failures.push(`silently dropped: ${silent.join(", ")}`);

  // Groups are real nodes now. This is the contract the old harness deferred;
  // it asserts the tree and, just as importantly, that group props are NOT
  // admitted as losses: opacity/blend/pass-through survive on the node.
  if (f.name === "groups") {
    const a = byName.get("Group A");
    const b = byName.get("Group B");
    const inner = byName.get("inner");
    const deep = byName.get("deep");
    if (!a || a.kind !== "group") failures.push("Group A is not a group node");
    else {
      if (!approx(a.opacity, 0.75)) failures.push(`Group A opacity ${a.opacity.toFixed(3)} != 0.75`);
      if (a.blendMode !== "multiply") failures.push(`Group A blend ${a.blendMode} != multiply`);
      if (a.passThrough !== false) failures.push("Group A (multiply) imported as pass-through");
    }
    if (!b || b.kind !== "group") failures.push("Group B is not a group node");
    else {
      if (!approx(b.opacity, 0.5)) failures.push(`Group B opacity ${b.opacity.toFixed(3)} != 0.5`);
      if (b.visible) failures.push("hidden Group B imported visible");
      if (b.passThrough !== true) failures.push("Group B (no blend mode) did not import as pass-through");
    }
    if (!inner || !a || doc.parentOf(inner) !== a) failures.push("inner is not a child of Group A");
    if (!deep || !b || doc.parentOf(deep) !== b) failures.push("deep is not a child of Group B");
    const order = layerTree(doc).map((l) => l.name);
    const wantOrder = ["BG", "Group A", "inner", "Group B", "deep", "Clip"];
    if (JSON.stringify(order) !== JSON.stringify(wantOrder)) {
      failures.push(`tree order ${JSON.stringify(order)} != ${JSON.stringify(wantOrder)}`);
    }
    if (report.groups !== 2) failures.push(`report counted ${report.groups} groups, expected 2`);
    const groupLosses = findings.filter((g) =>
      g.feature === "group-opacity" || g.feature === "group-blend" || g.feature === "pass-through");
    if (groupLosses.length > 0) {
      failures.push(`group props reported as dropped: ${groupLosses.map((g) => g.feature).join(", ")}`);
    }
  }
}

/** the effect fixture must show a shadow pixel outside the square */
function checkEffect(failures: string[]): void {
  const fixture = FIXTURES.find((f) => f.name === "effects")!;
  const doc = psdToDocument(roundtrip(fixture.psd));
  const comp = doc.composite();
  const at = (x: number, y: number) => comp.slice((y * doc.width + x) * 4, (y * doc.width + x) * 4 + 3);
  let darkest = 255;
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      const inside = x >= 4 && x <= 7 && y >= 4 && y <= 7;
      if (inside) continue;
      darkest = Math.min(darkest, at(x, y)[0]!);
    }
  }
  if (darkest > 245) failures.push(`drop shadow was not baked outside the square (darkest ${darkest})`);
}

export function runChecks(): CheckResult[] {
  const out: CheckResult[] = [];
  for (const f of FIXTURES) {
    const psd = roundtrip(f.psd);
    const report = emptyImportReport();
    const doc = psdToDocument(psd, report);
    const findings = reportFindings(report);
    const failures: string[] = [];
    if (doc.width !== (psd as { width: number }).width || doc.height !== (psd as { height: number }).height) {
      failures.push(`size ${doc.width}×${doc.height} != ${psd.width}×${psd.height}`);
    }
    checkStructure(f, doc, report, findings, failures);
    if (f.name === "effects") checkEffect(failures);
    out.push({ fixture: f.name, layers: layerTree(doc).length, findings, failures });
  }
  // composite comparison against a document built natively in Guazzo
  {
    const fixtures = COMPOSITE_FIXTURE;
    const report = emptyImportReport();
    const imported = psdToDocument(roundtrip(fixtures.psd), report);
    const native = nativeDoc(NATIVE_COMPOSITE);
    const diff = compositeDiff(imported.composite(), native.composite());
    const failures: string[] = [];
    if (diff.max > TOLERANCE.maxDelta) failures.push(`composite max delta ${diff.max} > ${TOLERANCE.maxDelta}`);
    if (diff.mean > TOLERANCE.meanDelta) failures.push(`composite mean delta ${diff.mean.toFixed(3)} > ${TOLERANCE.meanDelta}`);
    out.push({ fixture: "composite", layers: layerTree(imported).length, findings: reportFindings(report), composite: diff, failures });
  }
  return out;
}
