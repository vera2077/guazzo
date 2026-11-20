#!/usr/bin/env node
/**
 * release.mjs — assemble the folder that actually ships (AK1).
 *
 * The handoff's complaint was that the "release" lived in `app/` next to source,
 * caches and a stray `Untitled.guazzo.json`, so what a user received depended on
 * whatever happened to be in the directory. This script produces
 * `release/<version>/` containing exactly the four files a recipient needs plus
 * a checksum file, and refuses to run if the build or the version is off.
 *
 * It cannot label the binaries: `icacls` needs a child process, which the
 * sandbox forbids. It prints the exact command instead (a LOW-integrity exe
 * cannot start WebView2, so the step is not optional).
 *
 *   node scripts/release.mjs            # stage the current version
 *   node scripts/release.mjs --print    # dry run: list what would be copied
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { check } from "./bump.mjs";

const APP_DIR = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const EXE_SRC = join(APP_DIR, "src-tauri", "target", "release", "guazzo.exe");
const DLL_SRC = join(APP_DIR, "WebView2Loader.dll");
const LICENSE = join(APP_DIR, "LICENSE");
const NOTICES = join(APP_DIR, "THIRD-PARTY-NOTICES.md");

function die(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const version = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version;
const dryRun = process.argv.includes("--print");

// The four carriers must agree before anything is staged: a release whose About
// box says a different number than its exe is the bug this check exists for.
try {
  check(); // throws when the four carriers disagree
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}

for (const [label, path] of [["exe", EXE_SRC], ["WebView2Loader.dll", DLL_SRC], ["LICENSE", LICENSE], ["notices", NOTICES]]) {
  if (!existsSync(path)) die(`${label} is missing (${path}) — build it first`);
}

const outDir = join(APP_DIR, "release", version);
const exeName = `Guazzo-v${version}.exe`;
const files = [
  [EXE_SRC, exeName],
  [DLL_SRC, "WebView2Loader.dll"],
  [LICENSE, "LICENSE"],
  [NOTICES, "THIRD-PARTY-NOTICES.md"],
];

if (dryRun) {
  console.log(`release: v${version} would contain`);
  for (const [, name] of files) console.log(`  ${name}`);
  console.log(`  ${exeName} sha256 ${sha256(EXE_SRC)}`);
  process.exit(0);
}

// A stale folder from an earlier run would ship files nobody checked.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const sums = [];
for (const [src, name] of files) {
  const dest = join(outDir, name);
  copyFileSync(src, dest);
  sums.push(`${sha256(dest)}  ${name}`);
}
writeFileSync(join(outDir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);

// Exactly the shipped set: four files plus the checksum list. If a stray file
// appears here it did not come from this script.
const expected = new Set([...files.map(([, n]) => n), "SHA256SUMS.txt"]);
for (const name of readdirSync(outDir)) {
  if (!expected.has(name)) die(`unexpected file in ${outDir}: ${name}`);
}

const bytes = statSync(join(outDir, exeName)).size;
console.log(`release: staged ${basename(outDir)} (${files.length + 1} files, exe ${bytes} bytes)`);
for (const line of sums) console.log(`  ${line}`);
console.log(`\nNext — label the binaries Medium, or the exe cannot start WebView2:`);
for (const [, name] of files.slice(0, 2)) {
  console.log(`  icacls "${join(outDir, name)}" /setintegritylevel medium`);
}
