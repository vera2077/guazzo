import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readSignature, requireSignature } from "./signature.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

function assertVersion(version) {
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    throw new Error(`verify-asset: "${version}" is not a version — refusing to build paths from it`);
  }
}

/**
 * Split a GZP1 payload into its entries, refusing anything a verifier should not
 * accept: a short buffer, an empty/unsafe name, or a length that runs past the
 * end. Exported so a unit test can prove the refusals without building a Setup
 * (sec-r29 #2).
 */
export function parsePayload(buf) {
  if (buf.length < 8 || buf.toString("latin1", 0, 4) !== "GZP1") throw new Error("payload is not GZP1");
  const count = buf.readUInt32LE(4);
  // The Setup's own parser refuses an empty list and a list longer than 64,
  // and refuses trailing bytes after the last entry. This verifier must not be
  // the weaker of the two (sec-r41 F3).
  if (count < 1 || count > 64) throw new Error(`payload names ${count} entries`);
  const entries = [];
  let at = 8;
  for (let i = 0; i < count; i++) {
    if (at + 2 > buf.length) throw new Error("payload is truncated");
    const nameLen = buf.readUInt16LE(at); at += 2;
    if (at + nameLen > buf.length) throw new Error("payload is truncated");
    const name = buf.toString("utf8", at, at + nameLen); at += nameLen;
    if (name === "" || name.includes("/") || name.includes("\\") || name.includes("..") || /^[A-Za-z]:/.test(name)) {
      throw new Error(`payload names an unsafe entry: ${name}`);
    }
    if (at + 4 > buf.length) throw new Error("payload is truncated");
    const len = buf.readUInt32LE(at); at += 4;
    if (at + len > buf.length) throw new Error("payload is truncated");
    entries.push({ name, data: buf.subarray(at, at + len) }); at += len;
  }
  if (at !== buf.length) throw new Error("payload has trailing bytes");
  return entries;
}

/**
 * The last check before a file becomes public: the bytes on disk must hash to the
 * value the manifest names, and the sidecar must agree with both. Everything
 * upstream can pass and still hand the wrong file to the upload step; this reads
 * the exact file the release job passes to `files:`.
 */
export function verifyAsset(version, appDir = APP_DIR) {
  // The CLI check is not enough: callers can import this function directly.
  assertVersion(version);
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
    // A rewritten RELEASE.json must not be able to point the loop at a file
    // outside release/<version>/ (sec-r27 #2). Same predicate as package.mjs.
    if (!/^[^\\/\r\n]+$/.test(String(name)) || String(name).includes("..")) {
      throw new Error(`verify-asset: RELEASE.json names an unsafe file: ${String(name)}`);
    }
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
  const setupListed = Object.prototype.hasOwnProperty.call(
    manifest.files ?? {},
    `Guazzo-v${version}-Setup.exe`,
  );
  if (setupListed && !manifest.installerSha256) {
    // Deleting the field used to ship a Setup the verifier never tied to the
    // reviewed tree; a release that publishes a Setup must name its sources
    // (sec-r27 #1).
    throw new Error("verify-asset: RELEASE.json lists the Setup but does not name installerSha256");
  }
  if (manifest.installerSha256 && !/^[0-9a-f]{40}$/.test(String(manifest.commit ?? ""))) {
    throw new Error(`verify-asset: RELEASE.json names commit ${String(manifest.commit)}, not a full SHA`);
  }
  if (manifest.installerSha256 && process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA) {
    throw new Error(
      `verify-asset: manifest was built from ${manifest.commit} but CI is at ${process.env.GITHUB_SHA}`,
    );
  }
  if (!manifest.installerSha256) {
    throw new Error("verify-asset: RELEASE.json does not name installerSha256 — rerun release.mjs");
  }
  {
    // Read the sources from the recorded commit, not the live tree: a tree that
    // changed after staging would otherwise be checked against itself, and a
    // verifier run from another directory would report on the wrong files
    // (sec-r26 F2/F3).
    // The list is fixed here, not read from the manifest: a manifest that
    // shrinks its own input list could attest any payload it liked (sec-r29 #1).
    const files = ["installer/Cargo.toml", "installer/Cargo.lock", "installer/src/main.rs"];
    if (!Array.isArray(manifest.installerInputs) || manifest.installerInputs.join("\n") !== files.join("\n")) {
      const named = Array.isArray(manifest.installerInputs)
        ? manifest.installerInputs.join(", ")
        : String(manifest.installerInputs);
      throw new Error(`verify-asset: RELEASE.json names installer inputs ${named} — the anchored set is ${files.join(", ")}`);
    }
    const parts = files.map((f) => {
      try {
        return execFileSync("git", ["show", `${manifest.commit}:${f}`], { cwd: appDir, maxBuffer: 32 * 1024 * 1024 });
      } catch {
        throw new Error(`verify-asset: cannot read ${f} at commit ${manifest.commit}`);
      }
    });
    const installerHash = sha256(Buffer.concat([...parts, Buffer.from("\n")]));
    if (installerHash !== manifest.installerSha256) {
      throw new Error(
        `verify-asset: RELEASE.json names installer ${manifest.installerSha256}, but commit ${manifest.commit} has ${installerHash}`,
      );
    }
  }
  // The packed payload ships inside the release, so it is authenticated by the
  // release itself: read the GZP1 entries and require every one to be a release
  // file with identical bytes (sec-r29 #2). A regenerated payload from the
  // staged exe is therefore checked by content, not by git identity.
  const payloadName = "payload.bin";
  const payloadPath = join(dir, payloadName);
  const payloadHash = manifest.payloadSha256;
  // Manifests from the r29 scheme on anchor three installer inputs and must
  // carry the payload: without this, deleting the file and its manifest entry
  // silently skipped the only content check (sec-r30 #3).
  // build-setup always writes this list; a manifest without it predates the
  // anchored scheme, so every payload check below would be skipped and a
  // hand-edited RELEASE.json + SHA256SUMS pair would verify clean (sec-r31 #3).
  if (manifest.installerInputs !== undefined && !Array.isArray(manifest.installerInputs)) {
    throw new Error("verify-asset: RELEASE.json declares installerInputs but it is not a list");
  }
  if (!Array.isArray(manifest.installerInputs) || manifest.installerInputs.length !== 3) {
    // No opt-out: a manifest that cannot name the installer sources, or the
    // payload it packed, proves nothing about the Setup (sec-r34).
    throw new Error(
      "verify-asset: RELEASE.json does not name the three installer sources — the Setup cannot be authenticated",
    );
  }
  const anchored = Array.isArray(manifest.installerInputs) && manifest.installerInputs.length === 3;
  if (anchored && !existsSync(payloadPath)) {
    throw new Error(`verify-asset: RELEASE.json is anchored but ${payloadName} is missing`);
  }
  if (anchored && (!payloadHash || manifest.files?.[payloadName] !== payloadHash)) {
    throw new Error(`verify-asset: RELEASE.json must list ${payloadName} with its payloadSha256`);
  }
  if (existsSync(payloadPath)) {
    if (!payloadHash) {
      throw new Error(`verify-asset: ${payloadName} ships but RELEASE.json has no payloadSha256`);
    }
    if (sha256(readFileSync(payloadPath)) !== payloadHash) {
      throw new Error(`verify-asset: ${payloadName} does not match payloadSha256`);
    }
    const entries = parsePayload(readFileSync(payloadPath));
    // A payload missing one of the files Setup installs verifies clean and
    // installs a broken app; comparisons need the complete set (code-r30 #4).
    const expected = ["Guazzo.exe", "WebView2Loader.dll", "app-single.html", "LICENSE", "README.txt", "THIRD-PARTY-NOTICES.md"].sort();
    const names = entries.map((e) => e.name).sort();
    if (names.join("\n") !== expected.join("\n")) {
      throw new Error(`verify-asset: ${payloadName} lists ${names.join(", ")} — expected ${expected.join(", ")}`);
    }
    for (const { name, data } of entries) {
      // The Setup installs the exe under a stable name; the release ships the
      // same bytes under the versioned name (a real release failed here first).
      const shippedName = name === "Guazzo.exe" ? `Guazzo-v${version}.exe` : name;
      const shipped = join(dir, shippedName);
      if (!existsSync(shipped)) throw new Error(`verify-asset: ${payloadName} embeds ${name}, which the release does not ship`);
      const onDisk = readFileSync(shipped);
      if (onDisk.length !== data.length || !onDisk.equals(Buffer.from(data))) {
        throw new Error(`verify-asset: ${payloadName} embeds ${name} with different bytes than the release`);
      }
    }
    console.log(`verify-asset: ${payloadName} matches ${entries.length} release files`);
    // The shipped payload must also be the payload in the tagged commit. A
    // payload generated at package time and never committed makes the published
    // installer un-auditable from its tag: the tree can build a different app
    // than users download (sec-r40 F1, proved by drift in 1.18.9).
    const commit = typeof manifest.commit === "string" ? manifest.commit : "";
    if (/^[0-9a-f]{40}$/i.test(commit)) {
      let tracked = null;
      try {
        tracked = execFileSync("git", ["show", `${commit}:installer/assets/payload.bin`], {
          cwd: appDir,
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        throw new Error(
          `verify-asset: ${commit.slice(0, 12)} does not contain installer/assets/payload.bin — commit the payload, re-run release.mjs, then rebuild the Setup`,
        );
      }
      const shipped = readFileSync(payloadPath);
      if (tracked.length !== shipped.length || !tracked.equals(shipped)) {
        throw new Error(
          `verify-asset: installer/assets/payload.bin at ${commit.slice(0, 12)} differs from the shipped ${payloadName} — commit the payload, re-run release.mjs, then rebuild the Setup`,
        );
      }
      console.log(`verify-asset: ${payloadName} matches installer/assets/payload.bin at ${commit.slice(0, 12)}`);
    }
  }

  const setupName = `Guazzo-v${version}-Setup.exe`;
  const setupHash = manifest.files?.[setupName];
  // The release page always carries the Setup, so a manifest without it is an
  // unverifiable release, not an older one (sec-r37 #2).
  if (!setupHash) {
    throw new Error(`verify-asset: RELEASE.json does not list ${setupName} — rerun build-setup`);
  }
  if (!existsSync(join(dir, setupName))) {
    throw new Error(`verify-asset: RELEASE.json lists ${setupName} but it is missing`);
  }
  if (setupHash && (process.env.RELEASE_REQUIRE_SIGNED === "1" || process.env.RELEASE_REQUIRE_SIGNER)) {
    // Same policy as the app exe: Valid, and the signer the release names.
    requireSignature(readSignature(join(dir, setupName)), setupName, process.env.RELEASE_REQUIRE_SIGNER);
  }
  {
    const setupPath = join(dir, setupName);
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
  if (!VERSION_RE.test(version)) {
    console.error(`verify-asset: "${version}" is not a version — refusing to build paths from it`);
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
