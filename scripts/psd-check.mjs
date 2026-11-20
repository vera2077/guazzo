#!/usr/bin/env node
/**
 * scripts/psd-check.mjs — PSD import verification, in-process.
 *
 * Generates fixture PSDs with the vendored ag-psd writer, imports them through
 * the same code path the app uses, and checks:
 *   1. structure (layer count, names, opacity, visibility, blend, clipping)
 *   2. group nesting, group props and pass-through
 *   3. composite pixels against the same document built natively in Guazzo,
 *      with the tolerance stated in psd-fixtures.ts
 *   4. the "nothing silently dropped" report for every unsupported feature
 *
 * No child processes and no Photoshop: ag-psd writes real bytes in memory, the
 * importer reads them back. CI's own test run executes the same checks through
 * src/engine/tests/psd-import.test.ts; this script exists so a person can see
 * the report and so a future PSD change has one loud command to run.
 */
import { runChecks } from "../src/engine/tests/psd-check-lib.ts";
import { TOLERANCE } from "../src/engine/tests/psd-fixtures.ts";
import { reportLines } from "../src/engine/tests/psd-report.ts";

const started = Date.now();
let failures = 0;
let findings = 0;
const results = runChecks();

for (const r of results) {
  findings += r.findings.length;
  if (r.failures.length > 0) {
    failures += r.failures.length;
    for (const f of r.failures) console.error(`✖ ${r.fixture}: ${f}`);
    continue;
  }
  const composite = r.composite
    ? `, composite max ${r.composite.max} / mean ${r.composite.mean.toFixed(3)} (tolerance ${TOLERANCE.maxDelta} / ${TOLERANCE.meanDelta})`
    : "";
  console.log(`✔ ${r.fixture} — ${r.layers} layers, ${r.findings.length} reported${composite}`);
  if (r.findings.length > 0) {
    for (const line of reportLines(r.findings)) console.log(line);
  }
}

const ms = Date.now() - started;
if (failures > 0) {
  console.error(`\n✖ PSD CHECK FAILED — ${failures} failure(s) in ${results.length} fixtures (${ms}ms)`);
  process.exit(1);
}
console.log(`\n✔ PSD import check green — ${results.length} fixtures, ${findings} reported feature(s) (${ms}ms)`);
