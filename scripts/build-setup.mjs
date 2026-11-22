#!/usr/bin/env node
/**
 * Build Guazzo-v<version>-Setup.exe from release/<version>/.
 *
 * The setup program (installer/src/main.rs) carries the release folder as a
 * payload and writes it to %LOCALAPPDATA%\Programs\Guazzo, so this script's job
 * is only to pack that folder and then prove the result actually installs and
 * uninstalls — an installer nobody ran is a guess.
 *
 * Usage: node scripts/build-setup.mjs [version] [--skip-test]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const skipTest = process.argv.includes("--skip-test");
const releaseDir = join(root, "release", version);
if (!existsSync(releaseDir)) {
  console.error(`build-setup: release/${version} does not exist — run scripts/release.mjs ${version} first`);
  process.exit(1);
}

/** Files that make up an installed Guazzo, mapped to their names on disk. */
const FILES = [
  [`Guazzo-v${version}.exe`, "Guazzo.exe"],
  ["WebView2Loader.dll", "WebView2Loader.dll"],
  ["app-single.html", "app-single.html"],
  ["LICENSE", "LICENSE"],
  ["README.txt", "README.txt"],
  ["THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.md"],
];

const missing = FILES.filter(([from]) => !existsSync(join(releaseDir, from)));
if (missing.length > 0) {
  console.error(`build-setup: release/${version} is missing ${missing.map(([f]) => f).join(", ")}`);
  process.exit(1);
}

// --- pack -------------------------------------------------------------------
const parts = [];
let count = 0;
for (const [from, to] of FILES) {
  const bytes = readFileSync(join(releaseDir, from));
  const name = Buffer.from(to, "utf8");
  const header = Buffer.alloc(2 + 4);
  header.writeUInt16LE(name.length, 0);
  header.writeUInt32LE(bytes.length, 2);
  parts.push(header.subarray(0, 2), name, header.subarray(2, 6), bytes);
  count += 1;
}
const magic = Buffer.from("GZP1", "binary");
const countBuf = Buffer.alloc(4);
countBuf.writeUInt32LE(count, 0);
const payload = Buffer.concat([magic, countBuf, ...parts]);
const assets = join(root, "installer", "assets");
mkdirSync(assets, { recursive: true });
writeFileSync(join(assets, "payload.bin"), payload);
console.log(`build-setup: payload ${payload.length} bytes (${count} files)`);

// --- compile ----------------------------------------------------------------
const cargo = process.env.CARGO ?? "cargo";
const build = spawnSync(cargo, ["build", "--release", "--manifest-path", join(root, "installer", "Cargo.toml")], {
  stdio: "inherit",
  env: { ...process.env, GUAZZO_SETUP_VERSION: version, CARGO_TARGET_DIR: join(root, "installer", "target") },
});
if (build.status !== 0) {
  console.error("build-setup: cargo build failed");
  process.exit(1);
}

const built = join(root, "installer", "target", "release", "guazzo-setup.exe");
// Outside release/<version>/ on purpose: that folder is a fixed, checksummed
// set that release.mjs asserts exactly, and the installer is built from it.
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `Guazzo-v${version}-Setup.exe`);
copyFileSync(built, out);
writeFileSync(`${out}.sha256`, `${sha256(out)}  Guazzo-v${version}-Setup.exe\n`);
console.log(`build-setup: ${out} (${readFileSync(out).length} bytes)`);

// --- prove it ---------------------------------------------------------------
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!skipTest) {
  // Workspace-local, not %TEMP%: a check must not depend on where the OS
  // puts temporary files (and a sandbox may deny that path outright).
  const dir = join(root, ".setup-test");
  rmSync(dir, { recursive: true, force: true });
  const run = (args) => spawnSync(out, args, { stdio: "inherit" });
  const install = run(["--silent", "--no-shortcut", "--dir", dir]);
  if (install.status !== 0) {
    console.error("build-setup: the installer exited non-zero");
    process.exit(1);
  }
  for (const [, to] of FILES) {
    if (!existsSync(join(dir, to))) {
      console.error(`build-setup: install left no ${to}`);
      process.exit(1);
    }
  }
  if (!existsSync(join(dir, "uninstall.exe"))) {
    console.error("build-setup: install left no uninstaller");
    process.exit(1);
  }
  const remove = run(["--uninstall", "--silent", "--dir", dir]);
  if (remove.status !== 0) {
    console.error("build-setup: the uninstaller exited non-zero");
    process.exit(1);
  }
  // The uninstaller hands its own deletion to cmd (a running exe cannot remove
  // itself), so poll instead of guessing one sleep.
  let left = [];
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    left = existsSync(dir) ? readdirSync(dir) : [];
    if (left.length === 0) break;
  }
  if (left.length > 0) {
    console.error(`build-setup: uninstall left ${left.join(", ")} behind`);
    process.exit(1);
  }
  console.log("build-setup: installed and uninstalled cleanly into a temp folder");
}
