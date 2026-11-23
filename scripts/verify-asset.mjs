import { createHash } from "node:crypto";
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
  if (!sidecar.includes(zipHash)) {
    throw new Error(`verify-asset: the sidecar names ${sidecar.split(/\s+/)[0]} but the zip hashes to ${zipHash}`);
  }
  // The Setup exe is published beside the zip; when the manifest lists it, the
  // bytes that will be uploaded must hash to that value (sec-r10 #2).
  const setupName = `Guazzo-v${version}-Setup.exe`;
  const setupHash = manifest.files?.[setupName];
  if (setupHash) {
    const setupPath = join(dir, setupName);
    if (!existsSync(setupPath)) throw new Error(`verify-asset: RELEASE.json lists ${setupName} but it is missing`);
    const got = sha256(readFileSync(setupPath));
    if (got !== setupHash) {
      throw new Error(`verify-asset: ${setupName} hashes to ${got} but RELEASE.json says ${setupHash}`);
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
