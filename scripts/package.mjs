#!/usr/bin/env node
/**
 * Package a staged release into the downloadable archive.
 *
 * The zip is deterministic on purpose: fixed entry order, fixed timestamps taken
 * from the release commit, fixed compression settings, and no directory entries.
 * Two packaging runs on the same staged folder therefore produce the same
 * `zipSha256`.
 *
 * The manifest *inside* the zip cannot contain the zip's own hash. The outer
 * `RELEASE.json` gets `zipSha256` and `zipBytes` after the archive is written;
 * the copy in the zip is the same manifest with those two fields removed. The
 * checksum list covers the payload files, not the manifest.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

export const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
export const MAX_ZIP_BYTES = 12 * 1024 * 1024;
export const RELEASE_ENTRY_ORDER = [
  (version) => `Guazzo-v${version}.exe`,
  () => "WebView2Loader.dll",
  () => "app-single.html",
  () => "LICENSE",
  () => "THIRD-PARTY-NOTICES.md",
  () => "SHA256SUMS.txt",
  () => "RELEASE.json",
  () => "README.txt",
];

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();

export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  return { date: dosDate, time };
}

/**
 * Build a deterministic ZIP from `{ name, data }` entries. Exported so the gate
 * can compare two builds without touching the filesystem.
 */
export function buildZip(entries, timestamp = new Date()) {
  const { date, time } = dosTime(timestamp);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });
    if (compressed.length > data.length) {
      // Stored is valid and keeps the archive smaller for already-compressed
      // payloads. Everything here is small enough that this is rare.
      chunks.push(localHeader(name, 0, crc, data.length, data.length, time, date));
      chunks.push(data);
      central.push(centralHeader(name, 0, crc, data.length, data.length, time, date, offset));
      offset += 30 + name.length + data.length;
      continue;
    }
    chunks.push(localHeader(name, 8, crc, compressed.length, data.length, time, date));
    chunks.push(compressed);
    central.push(centralHeader(name, 8, crc, compressed.length, data.length, time, date, offset));
    offset += 30 + name.length + compressed.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const entry of central) {
    chunks.push(entry);
    centralSize += entry.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);
  return Buffer.concat(chunks);
}

function localHeader(name, method, crc, compressedSize, size, time, date) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6);
  head.writeUInt16LE(method, 8);
  head.writeUInt16LE(time, 10);
  head.writeUInt16LE(date, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(compressedSize, 18);
  head.writeUInt32LE(size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name]);
}

function centralHeader(name, method, crc, compressedSize, size, time, date, offset) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(method, 10);
  head.writeUInt16LE(time, 12);
  head.writeUInt16LE(date, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(compressedSize, 20);
  head.writeUInt32LE(size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30);
  head.writeUInt16LE(0, 32);
  head.writeUInt16LE(0, 34);
  head.writeUInt16LE(0, 36);
  head.writeUInt32LE(0, 38);
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, name]);
}

export function zipEntryNames(zip) {
  const names = [];
  let at = 0;
  while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8);
    const compressedSize = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extraLength = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    names.push({ name, method });
    at += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
}

function commitTimestamp(appDir) {
  try {
    const seconds = Number(
      execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
        cwd: appDir,
        encoding: "utf8",
      }).trim(),
    );
    if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000);
  } catch {
    // A checkout without git still packages; the date is fixed, not "now".
  }
  return new Date(Date.UTC(1980, 0, 1));
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Re-derive every hash the folder claims, from the bytes about to be zipped. */
export function assertManifestHashes(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "RELEASE.json"), "utf8"));
  const exeName = `Guazzo-v${manifest.version}.exe`;
  const exePath = join(dir, exeName);
  if (!existsSync(exePath)) throw new Error(`package: ${exeName} is missing from ${dir}`);
  const exeHash = sha256(readFileSync(exePath));
  if (manifest.exeSha256 !== exeHash) {
    throw new Error(
      `package: ${exeName} hashes to ${exeHash} but RELEASE.json says ${manifest.exeSha256} — ` +
        `the folder changed after staging`,
    );
  }
  for (const [name, want] of Object.entries(manifest.files ?? {})) {
    const path = join(dir, name);
    if (!existsSync(path)) continue; // the notes are documentation, not payload
    const got = sha256(readFileSync(path));
    if (got !== want) {
      throw new Error(
        `package: ${name} hashes to ${got} but RELEASE.json says ${want} — the folder changed after staging`,
      );
    }
  }
  return manifest;
}

function readManifest(dir) {
  const path = join(dir, "RELEASE.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  delete manifest.zipSha256;
  delete manifest.zipBytes;
  return manifest;
}

export function releaseEntries(dir, version, timestamp) {
  // SHA256SUMS.txt is regenerated here so it covers RELEASE.json as well; the
  // staged one predates the zipSha256 fields and would vouch for an older file.
  const payload = [];
  let manifestData = null;
  for (const nameOf of RELEASE_ENTRY_ORDER) {
    const name = nameOf(version);
    if (name === "SHA256SUMS.txt") continue;
    if (name === "RELEASE.json") {
      manifestData = Buffer.from(`${JSON.stringify(readManifest(dir), null, 2)}\n`);
      continue;
    }
    payload.push({ name, data: readFileSync(join(dir, name)) });
  }
  if (!manifestData) throw new Error("package: RELEASE.json is missing from the staging folder");
  const sums = Buffer.from(
    [...payload, { name: "RELEASE.json", data: manifestData }]
      .map((e) => `${sha256(e.data)}  ${e.name}`)
      .join("\n") + "\n",
  );
  const byName = new Map(
    [...payload, { name: "SHA256SUMS.txt", data: sums }, { name: "RELEASE.json", data: manifestData }]
      .map((e) => [e.name, e]),
  );
  return RELEASE_ENTRY_ORDER.map((nameOf) => {
    const name = nameOf(version);
    const entry = byName.get(name);
    if (!entry) throw new Error(`package: no entry for ${name}`);
    return entry;
  });
}

export function verifyArchive(zipPath) {
  const tmp = mkdtempSync(join(tmpdir(), "guazzo-zip-"));
  try {
    // bsdtar reads zip on Windows and macOS; unzip is the fallback on Linux.
    const firstLine = (err) => String(err?.stderr ?? err?.message ?? err).split("\n")[0].trim();
    try {
      execFileSync("tar", ["-xf", zipPath, "-C", tmp], { stdio: "pipe" });
    } catch (tarError) {
      try {
        execFileSync("unzip", ["-q", zipPath, "-d", tmp], { stdio: "pipe" });
      } catch (unzipError) {
        throw new Error(
          `package: could not extract ${zipPath} — tar: ${firstLine(tarError)}; unzip: ${firstLine(unzipError)}`,
        );
      }
    }
    try {
      execFileSync("sha256sum", ["-c", "SHA256SUMS.txt"], { cwd: tmp, stdio: "pipe" });
    } catch (sumError) {
      throw new Error(
        `package: the extracted archive failed its own checksum list — ${firstLine(sumError)}`,
      );
    }
    return tmp;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

export async function packageRelease(version, appDir = APP_DIR) {
  const dir = join(appDir, "release", version);
  if (!existsSync(dir)) throw new Error(`release/${version} does not exist — stage it first`);
  assertManifestHashes(dir);
  const manifest = readManifest(dir);
  const timestamp = commitTimestamp(appDir);
  const entries = releaseEntries(dir, version, timestamp);

  const zip = buildZip(entries, timestamp);
  const zipAgain = buildZip(entries, timestamp);
  if (!zip.equals(zipAgain)) throw new Error("zip is not deterministic — refusing to write it");
  if (zip.length > MAX_ZIP_BYTES) throw new Error(`zip is ${zip.length} B, over the 12 MB limit`);

  const name = `Guazzo-v${version}.zip`;
  const zipPath = join(dir, name);
  writeFileSync(zipPath, zip);
  const zipSha256 = sha256(zip);
  writeFileSync(join(dir, `${name}.sha256`), `${zipSha256}  ${name}\n`);

  manifest.zipSha256 = zipSha256;
  manifest.zipBytes = zip.length;
  writeFileSync(join(dir, "RELEASE.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const tmp = verifyArchive(zipPath);
  try {
    const exe = join(tmp, `Guazzo-v${version}.exe`);
    const label = execFileSync("icacls", [exe], { encoding: "utf8" });
    // icacls localises the mandatory-label text (this machine prints Turkish),
    // and a file with no explicit label inherits the process token's Medium level.
    // Treat missing as Medium, but never accept Low or High.
    const low = /Low Mandatory Level|Düşük Zorunlu Düzey/i.test(label);
    const high = /High Mandatory Level|Yüksek Zorunlu Düzey/i.test(label);
    const explicitMedium = /Medium Mandatory Level|Orta Zorunlu Düzey/i.test(label);
    if (low || high) throw new Error("extracted exe is not Medium integrity");
    console.log(`package: ${name} ${zip.length} bytes, sha256 ${zipSha256}`);
    console.log(`package: extracted and verified ${entries.length} entries`);
    console.log(
      `package: extracted exe integrity label Medium = yes${explicitMedium ? "" : " (inherited)"}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { zipPath, zipSha256, zipBytes: zip.length };
}

async function main() {
  const version = assertVersion(
    process.argv[2] ?? JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version,
    "package",
  );
  try {
    await packageRelease(version);
  } catch (err) {
    console.error(`package: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) await main();

function assertVersion(v, where) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(String(v))) {
    throw new Error(`${where}: version "${v}" is not a version — refusing to build paths from it`);
  }
  return String(v);
}
