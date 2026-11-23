/**
 * The set of files whose content must match the exe that ships.
 *
 * build-desktop writes a receipt over this set immediately before cargo builds
 * the exe. release.mjs re-reads it and refuses when any input changed between
 * the build and the stage, so a Rust-only fix cannot ship an exe built before
 * it. The receipt is deliberately ignored by git: it describes one local build.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const RECEIPT_NAME = "desktop-build-receipt.json";

const filesUnder = (appDir, rel, keep = () => true) => {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (keep(entry.name)) out.push(relative(appDir, full).split(sep).join("/"));
    }
  };
  walk(join(appDir, rel));
  return out;
};

/** Every input whose bytes can change the shipped page, the crate, or the embed. */
export function buildInputPaths(appDir) {
  const explicit = [
    "index.html",
    "package.json",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "vendor/ag-psd-bundle.js",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
  // The installer is compiled from these and ships as the Setup; a change
  // after the gate must invalidate the receipt like any other source
  // (sec-r25 #3).
  "installer/Cargo.toml",
  "installer/Cargo.lock",
  "installer/src/main.rs",
    "src-tauri/build.rs",
    "src-tauri/app.manifest",
    "src-tauri/src/main.rs",
    "desktop-dist/index.html",
    // The page that actually ships. It is gitignored, so the dirty check cannot
    // see a post-gate overwrite; hashing it into the receipt is what makes
    // "the exe was built from these bytes" true for the embedded page too
    // (sec-r24 #1).
    "app-single.html",
  ];
  const paths = new Set(explicit);
  for (const p of filesUnder(appDir, "src", (name) => name.endsWith(".ts"))) paths.add(p);
  for (const p of filesUnder(appDir, "src-tauri/capabilities")) paths.add(p);
  return [...paths].sort();
}

export function hashBuildInputs(appDir) {
  const files = buildInputPaths(appDir)
    .filter((p) => existsSync(join(appDir, p)))
    .map((p) => {
      const sha256 = createHash("sha256").update(readFileSync(join(appDir, p))).digest("hex");
      return { path: p, sha256 };
    });
  const digest = createHash("sha256")
    .update(files.map((f) => `${f.path}\0${f.sha256}\n`).join(""))
    .digest("hex");
  return { files, digest };
}

export function writeBuildReceipt(appDir, extra = {}) {
  const { files, digest } = hashBuildInputs(appDir);
  const receipt = {
    ...extra,
    builtAt: new Date().toISOString(),
    digest,
    files,
  };
  return { path: join(appDir, RECEIPT_NAME), receipt };
}

export function verifyBuildReceipt(appDir, receiptPath) {
  const actual = hashBuildInputs(appDir);
  if (!existsSync(receiptPath)) {
    throw new Error(`${RECEIPT_NAME} is missing — run node scripts/build-desktop.mjs before staging`);
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.digest !== actual.digest || !Array.isArray(receipt.files)) {
    throw new Error(
      `${RECEIPT_NAME} does not match the current sources — rebuild (build-desktop then cargo) before staging`,
    );
  }
  return receipt;
}
