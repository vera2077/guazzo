/**
 * psd-import.test.ts — the PSD import contract, executed by the gate.
 *
 * The fixtures live in psd-fixtures.ts and the report accounting in
 * psd-report.ts; scripts/psd-check.mjs runs the same pass with a readable
 * report. Assertions are structural on purpose: a PSD is a tree, and "it
 * imported something" is exactly the failure mode this harness exists to stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../document.ts";
import { psdToDocument } from "../psd.ts";
import { emptyImportReport } from "../importreport.ts";
import {
  COMPOSITE_FIXTURE, FIXTURES, NATIVE_COMPOSITE, TOLERANCE, roundtrip,
} from "./psd-fixtures.ts";
import { reportFindings, silentDrops } from "./psd-report.ts";
import { compositeDiff, runChecks } from "./psd-check-lib.ts";

test("psd import: every fixture passes structure, report and composite checks", () => {
  const results = runChecks();
  assert.ok(results.length >= FIXTURES.length, "every fixture was checked");
  for (const r of results) {
    assert.deepEqual(r.failures, [], `${r.fixture}: ${r.failures.join("; ")}`);
  }
});

test("psd import: the report names every unsupported feature", () => {
  for (const f of [...FIXTURES, COMPOSITE_FIXTURE]) {
    const report = emptyImportReport();
    psdToDocument(roundtrip(f.psd), report);
    const got = reportFindings(report).map((g) => `${g.feature}:${g.path}`).sort();
    const want = f.expectedFindings.map((g) => `${g.feature}:${g.path ?? ""}`).sort();
    assert.deepEqual(got, want, `${f.name} report`);
  }
});

test("psd import: nothing is silently dropped", () => {
  for (const f of FIXTURES) {
    const psd = roundtrip(f.psd);
    const report = emptyImportReport();
    const doc = psdToDocument(psd, report);
    assert.deepEqual(silentDrops(psd, doc, reportFindings(report)), [], `${f.name} has unaccounted nodes`);
  }
});

test("psd import: groups nest, keep pass-through, and are not report losses", () => {
  const groups = FIXTURES.find((f) => f.name === "groups")!;
  const report = emptyImportReport();
  const doc = psdToDocument(roundtrip(groups.psd), report);
  const all = doc.allLayers();
  const byName = new Map(all.map((layer) => [layer.name, layer]));

  const a = byName.get("Group A");
  const b = byName.get("Group B");
  const inner = byName.get("inner");
  const deep = byName.get("deep");
  assert.ok(a && b && inner && deep, "the whole group tree imported");
  assert.equal(a.kind, "group");
  assert.equal(b.kind, "group");
  // ag-psd writes props to 8 bits, so 0.75 comes back 0.749…
  const close = (actual: number, want: number): boolean => Math.abs(actual - want) <= 1 / 255 + 1e-9;
  assert.ok(close(a.opacity, 0.75), `Group A opacity ${a.opacity} != 0.75`);
  assert.ok(close(b.opacity, 0.5), `Group B opacity ${b.opacity} != 0.5`);
  assert.equal(a.blendMode, "multiply");
  assert.equal(a.passThrough, false, "multiply Group A isolates");
  assert.equal(b.passThrough, true, "Group B keeps Photoshop's pass-through default");
  assert.equal(b.visible, false);
  assert.equal(doc.parentOf(inner), a);
  assert.equal(doc.parentOf(deep), b);
  assert.deepEqual(all.map((layer) => layer.name), ["BG", "Group A", "inner", "Group B", "deep", "Clip"]);

  assert.equal(report.groups, 2);
  assert.deepEqual(reportFindings(report), [], "group opacity/blend/pass-through are preserved, not admitted");
  assert.ok(!report.avoided.some((entry) => entry.feature.startsWith("group")));
});

test("psd import: the composite matches a document built natively in Guazzo", () => {
  const imported = psdToDocument(roundtrip(COMPOSITE_FIXTURE.psd));
  const native = new Document(NATIVE_COMPOSITE.width, NATIVE_COMPOSITE.height);
  for (const l of NATIVE_COMPOSITE.layers) {
    const layer = native.addLayer(l.name);
    const data = new Uint8ClampedArray(l.w * l.h * 4);
    for (let i = 0; i < l.w * l.h; i++) {
      data[i * 4] = l.rgba[0]; data[i * 4 + 1] = l.rgba[1];
      data[i * 4 + 2] = l.rgba[2]; data[i * 4 + 3] = l.rgba[3];
    }
    layer.grid.writeRect(l.x, l.y, l.w, l.h, data);
    layer.opacity = l.opacity ?? 1;
    layer.blendMode = l.blend ?? "normal";
  }
  const diff = compositeDiff(imported.composite(), native.composite());
  assert.ok(diff.max <= TOLERANCE.maxDelta, `max channel delta ${diff.max} must be <= ${TOLERANCE.maxDelta}`);
  assert.ok(diff.mean <= TOLERANCE.meanDelta, `mean channel delta ${diff.mean.toFixed(4)} must be <= ${TOLERANCE.meanDelta}`);
});
