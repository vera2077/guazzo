#!/usr/bin/env node
/**
 * coupling.mjs — the rewrite's progress metric.
 *
 * Line count was the wrong number: moving 500 lines of dialogs out of main.ts
 * changed the architecture by nothing, and R5 of the handoff asked for a metric
 * that measures what the rewrite is actually about — how many functions in the
 * shell are still welded to document state.
 *
 * A function "touches document state" when its body mentions one of the globals
 * below. Those are the things the planned session container would have to own,
 * so the count is the distance left to cover. Each extraction step must LOWER it
 * (or leave it unchanged and say why); pins.mjs fails the gate when it grows.
 *
 *   node scripts/coupling.mjs            print the number
 *   node scripts/coupling.mjs --verbose  also list the functions and per-state counts
 *   node scripts/coupling.mjs --json     machine-readable
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

/** The state the session container is supposed to own. */
export const STATE = ["doc", "activeLayer", "history", "flat", "flatDirty", "selMask", "selRect"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Count top-level function declarations in a source file and how many of them
 * mention document state. Pure; pins.mjs calls it in-process.
 */
export function measure(file = path.join(ROOT, "src/main.ts")) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const totals = Object.fromEntries(STATE.map((name) => [name, 0]));
  let total = 0;
  const coupled = [];
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    total++;
    const seen = new Set();
    const visit = (node) => {
      if (ts.isIdentifier(node) && STATE.includes(node.text)) seen.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(statement.body);
    if (seen.size === 0) continue;
    coupled.push(statement.name.text);
    for (const name of seen) totals[name]++;
  }
  const pct = total === 0 ? 0 : Math.round((coupled.length * 100) / total);
  return { file, total, coupled: coupled.length, pct, names: coupled, perState: totals };
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  const result = measure();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`coupling: ${result.coupled}/${result.total} top-level functions in src/main.ts touch document state (${result.pct}%)`);
    if (process.argv.includes("--verbose")) {
      const per = Object.entries(result.perState).map(([name, n]) => `${name}=${n}`).join(" ");
      console.log(`  per state: ${per}`);
      for (const name of result.names) console.log(`  - ${name}`);
    }
  }
}
