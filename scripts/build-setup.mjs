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
import { readSignature, requireSignature, signExe, REQUIRE_SIGNED_ENV } from "./signature.mjs";

/** The version becomes a path and a file name; a bare join would follow "..". */
function safeVersion(v, where) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(String(v))) {
    console.error(`${where}: "${v}" is not a version — refusing to build paths from it`);
    process.exit(1);
  }
  return String(v);
}

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const version = safeVersion(process.argv[2] ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "build-setup");
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

// --- verify the release folder before packing it ---------------------------
// The Setup exe is what a user runs. Packing release/<version>/ without checking
// it means trusting whatever is in that folder; SHA256SUMS.txt is the release's
// own statement about what those files are (sec-r9 #5).
const sumsPath = join(releaseDir, "SHA256SUMS.txt");
if (!existsSync(sumsPath)) {
  console.error(`build-setup: release/${version}/SHA256SUMS.txt is missing — run scripts/release.mjs first`);
  process.exit(1);
}
const sums = new Map();
for (const line of readFileSync(sumsPath, "utf8").split(/\r?\n/)) {
  const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
  if (m) sums.set(m[2], m[1].toLowerCase());
}
const digest = (buf) => createHash("sha256").update(buf).digest("hex");
for (const [from] of FILES) {
  const want = sums.get(from);
  if (!want) {
    console.error(`build-setup: ${from} is not listed in SHA256SUMS.txt`);
    process.exit(1);
  }
  const got = digest(readFileSync(join(releaseDir, from)));
  if (got !== want) {
    console.error(`build-setup: ${from} does not match SHA256SUMS.txt (${got} != ${want})`);
    process.exit(1);
  }
}
if (process.env[REQUIRE_SIGNED_ENV] === "1") {
  const exe = join(releaseDir, `Guazzo-v${version}.exe`);
  requireSignature(readSignature(exe), exe, process.env.RELEASE_REQUIRE_SIGNER);
}
console.log(`build-setup: ${FILES.length} payload files match SHA256SUMS.txt`);

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
const payloadHash = sha256(join(assets, "payload.bin"));

// --- compile ----------------------------------------------------------------
const cargo = process.env.CARGO ?? "cargo";
// Fingerprint the installer sources BEFORE compiling them. Hashing after the
// build can describe files the compiler never saw (sec-r26 F2); hashing before
// it means the recorded value is at least the input, and verify-asset re-derives
// it from the tagged commit rather than the live tree.
// The Rust sources the Setup is compiled from. The packed payload is NOT in
// this set: it is rebuilt from the staged release files at release time, so a
// `git show` of it can never equal what was compiled (sec-r29 #2). It is
// attested instead by payloadSha256 over the bytes that ship, and by
// verify-asset unpacking it and comparing every entry to a release file.
const INSTALLER_SOURCES = [
  "installer/Cargo.toml",
  "installer/Cargo.lock",
  "installer/src/main.rs",
];
const sha256Bytes = (b) => createHash("sha256").update(b).digest("hex");
const installerSourceHash = () =>
  sha256Bytes(Buffer.concat([...INSTALLER_SOURCES.map((f) => readFileSync(join(root, f))), Buffer.from("\n")]));
const installerSha256 = installerSourceHash();

// --locked: the attested installerSha256 covers the lockfile, so cargo must not
// be free to resolve a different dependency set while that hash is recorded
// (sec-r30 #2).
const build = spawnSync(cargo, ["build", "--release", "--locked", "--manifest-path", join(root, "installer", "Cargo.toml")], {
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
// Prove the Setup embeds the payload that was hashed above: `--extract-payload`
// writes the include_bytes! blob the compiler baked in, so a stale target dir or
// a payload swapped after hashing cannot ship (sec-r30 #1).
const extracted = join(outDir, ".payload-extracted.bin");
// An interrupted earlier run leaves this file behind, and --extract-payload
// refuses an existing path (CREATE_NEW); the failure it then reports is not the
// one that happened. Clear it before the probe (sec-r33 #4).
rmSync(extracted, { force: true });
const probe = spawnSync(built, ["--extract-payload", extracted], { stdio: "ignore", env: process.env });
if (probe.status !== 0 || !existsSync(extracted)) {
  console.error("build-setup: the built Setup did not report its payload");
  process.exit(1);
}
const embeddedHash = sha256Bytes(readFileSync(extracted));
rmSync(extracted, { force: true });
if (embeddedHash !== payloadHash) {
  console.error(`build-setup: the Setup embeds payload ${embeddedHash}, but ${payloadHash} was packed`);
  process.exit(1);
}
console.log(`build-setup: Setup embeds payload ${embeddedHash.slice(0, 12)}…`);
// A release requirement applies to every executable that ships, not only the
// app exe: an unsigned Setup is the first thing Windows distrusts (sec-r9 #5).
if (process.env.SIGN_CERT_SHA1) {
  // Sign whenever a certificate is configured, not only when the release is
  // required to be signed: a signing mode with ALLOW_UNSIGNED=true used to
  // publish a signed app exe beside an unsigned Setup (sec-r23 F1).
  signExe(out);
  requireSignature(readSignature(out), out, process.env.RELEASE_REQUIRE_SIGNER);
} else if (process.env[REQUIRE_SIGNED_ENV] === "1") {
  // A signing requirement with no certificate is a misconfiguration, not a
  // warning: the app exe would be signed and the Setup — the file winget
  // installs — would ship unsigned while the manifest said otherwise.
  console.error("build-setup: signing is required but SIGN_CERT_SHA1 is empty");
  process.exit(1);
}
const setupHash = digest(readFileSync(out));
const setupName = `Guazzo-v${version}-Setup.exe`;
writeFileSync(`${out}.sha256`, `${setupHash}  ${setupName}\n`);
console.log(`build-setup: ${setupName} sha256 ${setupHash}`);

// The Setup exe is the file winget installs and the one most users run, so it
// belongs in the release's own manifest and checksum list rather than sitting
// in dist/ outside every verification (sec-r10 #2).
copyFileSync(out, join(releaseDir, setupName));
copyFileSync(`${out}.sha256`, join(releaseDir, `${setupName}.sha256`));
const manifestPath = join(releaseDir, "RELEASE.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files = { ...(manifest.files ?? {}), [setupName]: setupHash };
  manifest.setupSha256 = setupHash;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`build-setup: RELEASE.json lists ${setupName}`);
}
const sumsFile = join(releaseDir, "SHA256SUMS.txt");
// Every name in the manifest must appear in the sums list, with the bytes that
// are actually on disk. RELEASE.json is rewritten above, so its line goes
// stale unless it is recomputed here — and `sha256sum -c` is what the README
// tells people to run (sec-r11 #2).
function refreshSums() {
  const names = new Set([
    ...Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")).files ?? {}),
    setupName,
    "RELEASE.json",
    "RELEASE-NOTES.md",
  ]);
  const lines = readFileSync(sumsFile, "utf8").split(/\r?\n/).filter((line) => {
    const name = line.trim().split(/\s+/).pop() ?? "";
    return line.trim() !== "" && !name.endsWith(setupName) && !names.has(name);
  });
  for (const name of names) {
    const path = join(releaseDir, name);
    if (!existsSync(path)) continue;
    lines.push(`${sha256(path)}  ${name}`);
  }
  lines.sort((a, b) => a.localeCompare(b));
  writeFileSync(sumsFile, `${lines.join("\n")}\n`);
}
refreshSums();
const manifestNow = JSON.parse(readFileSync(manifestPath, "utf8"));
delete manifestNow.files[setupName];
// The Setup is compiled from the installer sources, which staging does not
// hash. Record them so a verifier can see that the signed Setup came from the
// same tree as the manifest (sec-r25 #3).
manifestNow.installerSha256 = installerSha256;
  // Name the inputs so a later release can extend the set without making older
  // manifests unverifiable (sec-r28 #2).
  manifestNow.installerInputs = INSTALLER_SOURCES;
  // The packed bytes themselves: verify-asset re-opens this file and compares
  // every embedded entry to a release file, so the payload cannot describe
  // anything the release does not ship (sec-r29 #2).
  manifestNow.payloadSha256 = payloadHash;
  copyFileSync(join(assets, "payload.bin"), join(releaseDir, "payload.bin"));
  manifestNow.files["payload.bin"] = payloadHash;
writeFileSync(manifestPath, `${JSON.stringify(manifestNow, null, 2)}\n`);
manifestNow.files[setupName] = setupHash;
writeFileSync(manifestPath, `${JSON.stringify(manifestNow, null, 2)}\n`);
refreshSums();
writeFileSync(`${out}.sha256`, `${sha256(out)}  Guazzo-v${version}-Setup.exe\n`);
console.log(`build-setup: ${out} (${readFileSync(out).length} bytes)`);

// winget installs the bytes in release/, so its manifest must be regenerated
// from this exact Setup; a stale InstallerSha256 fails winget's own check
// (sec-r11 #3). The generator is the only place that knows the three files.
if (!skipTest) {
  const generated = spawnSync(process.execPath, [join(root, "scripts", "winget.mjs"), version], {
    cwd: root,
    stdio: "inherit",
  });
  if (generated.status !== 0) {
    console.error("build-setup: the winget manifests could not be regenerated — run scripts/winget.mjs first");
    process.exit(1);
  }
}

// --- prove it ---------------------------------------------------------------
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!skipTest) {
  // Workspace-local, not %TEMP%: a check must not depend on where the OS
  // puts temporary files (and a sandbox may deny that path outright).
  // Beside the Setup, inside dist/: hosted runners check out on D:\\a\\...,
  // which the installer's profile-scope rule refuses (sec-r23 F5).
  const dir = join(outDir, ".setup-test");
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
  // A file Setup did not put there must survive the uninstall: "Your documents
  // are untouched" is a promise, not a footer.
  writeFileSync(join(dir, "personal-notes.txt"), "do not delete\n");
  // Run the installed uninstaller, not the setup exe: that is the program a
  // user runs from Apps, and it is the one that has to delete itself.
  const remove = spawnSync(join(dir, "uninstall.exe"), ["--uninstall", "--silent"], { stdio: "inherit" });
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
    if (left.every((n) => n === "personal-notes.txt")) break;
  }
  const myPayloads = left.filter((n) => n !== "personal-notes.txt");
  if (myPayloads.length > 0) {
    console.error(`build-setup: uninstall left ${myPayloads.join(", ")} behind`);
    process.exit(1);
  }
  if (!existsSync(join(dir, "personal-notes.txt"))) {
    console.error("build-setup: uninstall deleted a file Setup did not install");
    process.exit(1);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("build-setup: installed, uninstalled, and left a stranger's file alone");
}
