import { createHash } from "node:crypto";
import { readSignature, requireSignature } from "./signature.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * The last check before a file becomes public: the bytes on disk must hash to the
 * value the manifest names, and the sidecar must agree with both. Everything
 * upstream can pass and still hand the wrong file to the upload step; this reads
 * the exact file the release job passes to `files:`.
 */
export function verifyAsset(version, appDir = APP_DIR) {
  const dir = join(appDir, "release", version);
  const manifestPath = join(dir, "RELEASE.json");
  if (!existsSync(manifestPath)) throw new Error(`verify-asset: no ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version) {
    throw new Error(`verify-asset: RELEASE.json says ${manifest.version}, expected ${version}`);
  }
  const zipName = `Guazzo-v${version}.zip`;
  const zipPath = join(dir, zipName);
  if (!existsSync(zipPath)) throw new Error(`verify-asset: no ${zipPath}`);
  const zipHash = sha256(readFileSync(zipPath));
  if (!manifest.zipSha256) throw new Error("verify-asset: RELEASE.json has no zipSha256 — package first");
  if (zipHash !== manifest.zipSha256) {
    throw new Error(
      `verify-asset: ${zipName} hashes to ${zipHash} but RELEASE.json says ${manifest.zipSha256}`,
    );
  }
  const sidecarPath = `${zipPath}.sha256`;
  if (!existsSync(sidecarPath)) throw new Error(`verify-asset: no ${sidecarPath}`);
  const sidecar = readFileSync(sidecarPath, "utf8").trim();
  const okLine = new RegExp(`^${zipHash}  ${zipName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
  if (!okLine.test(sidecar)) {
    throw new Error(`verify-asset: the sidecar names ${sidecar.split(/\s+/)[0]} but the zip hashes to ${zipHash}`);
  }
  // The Setup exe is published beside the zip; when the manifest lists it, the
  // bytes that will be uploaded must hash to that value (sec-r10 #2).
  // Every file the manifest lists is public: a swapped exe, dll or page must
  // fail here, not only the two assets the old check happened to name.
  for (const [name, want] of Object.entries(manifest.files ?? {})) {
    const path = join(dir, String(name));
    if (!existsSync(path)) throw new Error(`verify-asset: RELEASE.json lists ${name} but it is missing`);
    const got = sha256(readFileSync(path));
    if (got !== want) {
      throw new Error(`verify-asset: ${name} hashes to ${got} but RELEASE.json says ${want}`);
    }
  }
  // Spell out the two names the rest of the release flow expects.
  // The Setup's code is the installer sources, not the app payload; check the
  // manifest's claim about them against the tree that produced it (sec-r25 #3).
  if (manifest.installerSha256) {
    const installerHash = sha256(
      Buffer.concat([
        ...["installer/Cargo.toml", "installer/src/main.rs"].map((f) => readFileSync(join(process.cwd(), f))),
        Buffer.from("\n"),
      ]),
    );
    if (installerHash !== manifest.installerSha256) {
      throw new Error(`verify-asset: RELEASE.json names installer ${manifest.installerSha256}, but this tree builds ${installerHash}`);
    }
  }
  const setupName = `Guazzo-v${version}-Setup.exe`;
  const setupHash = manifest.files?.[setupName];
  // The Publish step always uploads the Setup, so a Setup on disk that the
  // manifest does not name is a file that ships unchecked (sec-r23 F3).
  if (existsSync(join(dir, setupName)) && !setupHash) {
    throw new Error(
      `verify-asset: ${setupName} exists but RELEASE.json does not list it — rerun build-setup`,
    );
  }
  if (setupHash && (process.env.RELEASE_REQUIRE_SIGNED === "1" || process.env.RELEASE_REQUIRE_SIGNER)) {
    // Same policy as the app exe: Valid, and the signer the release names.
    requireSignature(readSignature(join(dir, setupName)), setupName, process.env.RELEASE_REQUIRE_SIGNER);
  }
  if (setupHash) {
    const setupPath = join(dir, setupName);
    if (!existsSync(setupPath)) {
      throw new Error(`verify-asset: RELEASE.json lists ${setupName} but it is missing`);
    }
    const esc = setupName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = new RegExp(`^${setupHash}  ${esc}$`, "m");
    const setupSidecar = `${setupPath}.sha256`;
    if (!existsSync(setupSidecar)) throw new Error(`verify-asset: no ${setupSidecar}`);
    if (!exact.test(readFileSync(setupSidecar, "utf8"))) {
      throw new Error(`verify-asset: ${setupName}.sha256 does not name the hash RELEASE.json lists`);
    }
    // The outer list is what a user checks without the manifest; it must cover
    // the Setup too, or the one file most people run is the one file unchecked.
    const sumsPath = join(dir, "SHA256SUMS.txt");
    if (!existsSync(sumsPath)) throw new Error(`verify-asset: no ${sumsPath}`);
    if (!exact.test(readFileSync(sumsPath, "utf8"))) {
      throw new Error(`verify-asset: SHA256SUMS.txt does not cover ${setupName}`);
    }
  }
  return { zipPath, zipHash, bytes: manifest.zipBytes ?? null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/verify-asset.mjs <version>");
    process.exit(1);
  }
  try {
    const out = verifyAsset(version);
    console.log(`✔ ${out.zipPath} — sha256 ${out.zipHash}`);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
}
