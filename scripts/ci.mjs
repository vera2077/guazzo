#!/usr/bin/env node
/**
 * One command that must be green before a version ships — Phase C3.
 *
 * The gate used to be five commands remembered from a chat message, run in an
 * order that mattered (build before cargo, etc.). Anything remembered by a human
 * eventually gets skipped, so this is the list in code:
 *
 *   1. typecheck + bundle + desktop-dist   (scripts/build-desktop.mjs)
 *   2. static pins                          (scripts/pins.mjs)
 *   3. the engine suite                     (every file under src/engine/tests)
 *   4. the UI smoke                         (scripts/ui-smoke.mjs)
 *   5. version lockstep                     (scripts/bump.mjs --check)
 *   6. artifact reproducibility             (rebuild, compare the hash)
 *
 * Deliberately in-process: this sandbox forbids spawning child processes, and a
 * gate that cannot run where the work happens is not a gate. Each stage is an
 * import; a stage that throws fails the run and the rest do not execute.
 *
 * `cargo build` is NOT here — it needs the crates mirror and a Rust rebuild, and
 * it is the one step a CI machine would do differently. Run it after this is
 * green; the exe is then relabelled and copied by hand.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const t0 = Date.now();
const step = (name) => console.log(`\n── ${name}`);
const fail = (msg) => {
  console.error(`\n✖ CI FAILED: ${msg}`);
  process.exitCode = 1;
};

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function main() {
  step("1/6 build (typecheck → bundle → desktop-dist)");
  await import("./build-desktop.mjs");

  step("2/6 static pins");
  await import("./pins.mjs");
  if (process.exitCode) return fail("static pins");

  step("3/6 engine suite");
  const testDir = new URL("../src/engine/tests/", import.meta.url);
  const files = readdirSync(testDir)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();
  for (const file of files) await import(new URL(file, testDir).href);
  if (process.exitCode) return fail(`engine suite (${files.length} files)`);

  step("4/6 UI smoke");
  await import("./ui-smoke.mjs");
  if (process.exitCode) return fail("UI smoke");

  step("5/6 version lockstep");
  await import("./bump.mjs").then((m) => m.check?.());
  if (process.exitCode) return fail("version lockstep");

  step("6/6 artifact reproducibility");
  const first = hash("app-single.html");
  await import("./single-file.mjs");
  const second = hash("app-single.html");
  if (first !== second) return fail(`app-single.html is not reproducible (${first.slice(0, 8)} → ${second.slice(0, 8)})`);

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✔ CI green in ${secs}s — ${files.length} test files, pins, smoke, reproducible artifact`);
}

main().catch((err) => {
  console.error(err);
  fail(err instanceof Error ? err.message : String(err));
});
