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
 *   6. bundler determinism + freshness      (build twice, compare bytes)
 *
 * Deliberately in-process: this sandbox forbids spawning child processes
 * (`spawn EPERM`, measured), and a gate that cannot run where the work happens
 * is not a gate.
 *
 * The three ways this gate used to lie, and what replaced them:
 *
 *   - Stage 2 imported `pins.mjs`, whose `main()` is guarded by
 *     `import.meta.url === argv[1]`; an import is not execution, so all pins
 *     were decorative. It now calls `runPins()` and uses the failure count.
 *   - Stage 3 checked `process.exitCode` immediately after *registering*
 *     node:test cases, then printed `CI green` before the suite ran. It now
 *     waits for the runner's `beforeExit` (the sandbox rules out the child
 *     processes `run({ files })` needs) and reads the runner's own
 *     `ℹ tests` / `ℹ fail` lines before it continues.
 *   - Stage 6 hashed the artifact, re-imported the bundler (a module-cache hit
 *     that rebuilt nothing) and hashed it again. It now builds the single-file
 *     artifact twice into separate paths, compares the bytes, and asserts the
 *     shipped artifact is one of those builds rather than a leftover.
 *
 * `cargo build` is NOT here — it needs the crates mirror and a Rust rebuild, and
 * it is the one step a CI machine would do differently. Run it after this is
 * green; the exe is then relabelled and copied by hand.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";

const t0 = Date.now();
const step = (name) => console.log(`\n── ${name}`);
const fail = (msg) => {
  console.error(`\n✖ CI FAILED: ${msg}`);
  process.exitCode = 1;
  return true;
};

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Run the engine suite in-process and report what the runner itself reported.
 *
 * node:test's default harness executes registered cases when the event loop
 * empties; `await`-ing the first `beforeExit` after the imports is therefore the
 * only in-process completion signal available here (each test file is a `.ts`
 * module Node runs natively, and `run({ files })` would spawn a process).
 *
 * The reporter's summary lines are captured while they are written so the
 * numbers printed below are the runner's, not a guess from the import list.
 */
async function runEngineSuite(testDir, files) {
  const captured = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString());
    return write(chunk, ...rest);
  };

  const harnessDone = new Promise((resolve) => process.once("beforeExit", resolve));
  try {
    for (const file of files) await import(new URL(file, testDir).href);
    await harnessDone;
    // The reporter writes `ℹ tests` / `ℹ fail` after the harness settles — the
    // beforeExit turn is too early to parse. Poll for the summary instead of
    // assuming it landed, so a suite that never reports cannot look green.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const text = captured.join("");
      if (/^ℹ tests \d+$/m.test(text) && /^ℹ fail \d+$/m.test(text)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    process.stdout.write = write;
  }

  const log = captured.join("");
  const total = Number(/^ℹ tests (\d+)$/m.exec(log)?.[1] ?? 0);
  const failed = Number(/^ℹ fail (\d+)$/m.exec(log)?.[1] ?? NaN);
  return { total, failed, exitCode: process.exitCode ?? 0 };
}

async function main() {
  step("1/6 build (typecheck → bundle → desktop-dist)");
  await import("./build-desktop.mjs");

  step("2/6 static pins");
  const pinsFailed = (await import("./pins.mjs")).runPins();
  if (pinsFailed) return fail(`static pins (${pinsFailed} failed)`);

  step("3/6 engine suite");
  const testDir = new URL("../src/engine/tests/", import.meta.url);
  const files = readdirSync(testDir)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();
  if (files.length === 0) return fail("engine suite (no test files found)");

  const suite = await runEngineSuite(testDir, files);
  if (suite.total === 0) return fail("engine suite (the runner reported no tests)");
  if (!Number.isFinite(suite.failed)) return fail("engine suite (the runner reported no result)");
  if (suite.failed > 0 || suite.exitCode !== 0) {
    return fail(`engine suite (${suite.failed} failing of ${suite.total})`);
  }
  process.exitCode = 0;

  step("4/6 UI smoke");
  await import("./ui-smoke.mjs");
  if (process.exitCode) return fail("UI smoke");

  step("5/6 version lockstep");
  await import("./bump.mjs").then((m) => m.check?.());
  if (process.exitCode) return fail("version lockstep");

  step("6/6 bundler determinism + artifact freshness");
  const { build } = await import("./single-file.mjs");
  const first = await build({ htmlPath: ".ci-single-a.html", bundlePath: ".ci-bundle-a.js", quiet: true });
  const second = await build({ htmlPath: ".ci-single-b.html", bundlePath: ".ci-bundle-b.js", quiet: true });
  rmSync(".ci-single-a.html", { force: true });
  rmSync(".ci-single-b.html", { force: true });
  rmSync(".ci-bundle-a.js", { force: true });
  rmSync(".ci-bundle-b.js", { force: true });
  if (first.htmlHash !== second.htmlHash || first.jsHash !== second.jsHash) {
    return fail(
      `the single-file build is not deterministic (${first.htmlHash.slice(0, 8)} vs ${second.htmlHash.slice(0, 8)})`,
    );
  }
  if (hash("app-single.html") !== first.htmlHash) {
    return fail("app-single.html on disk is not what the bundler produces — the artifact is stale");
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n✔ CI green in ${secs}s — ${files.length} test files / ${suite.total} tests, ` +
      `pins, smoke, deterministic single-file build`,
  );
}

main().catch((err) => {
  console.error(err);
  fail(err instanceof Error ? err.message : String(err));
});
