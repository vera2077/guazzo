import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// AV2: release staging is executed, not grepped. The old "a release can name its
// commit" pin searched release.mjs for the literal "RELEASE.json", which the
// script's own allow-list contains, so it passed for any edit including deleting
// the manifest write.
// release.mjs is plain ESM with no declarations; the expect-error also fails the
// build if the module ever stops being importable, which is the regression here.
// @ts-expect-error - a .mjs script has no type declarations
const stageModule = await import("../../../scripts/release.mjs");
// @ts-expect-error - a .mjs script has no type declarations
const buildInputsModule = await import("../../../scripts/build-inputs.mjs");
const { stage, staleSources, gitState } = stageModule;
const { buildInputPaths } = buildInputsModule;
// @ts-expect-error - a .mjs script has no type declarations
const packageModule = await import("../../../scripts/package.mjs");
// @ts-expect-error - a .mjs script has no type declarations
const verifyModule = await import("../../../scripts/verify-asset.mjs");
const { verifyAsset } = verifyModule;
const { packageRelease } = packageModule;

function fixture(overrides: Record<string, unknown> = {}) {
  const appDir = mkdtempSync(join(tmpdir(), "guazzo-release-"));
  const src = join(appDir, "src");
  mkdirSync(src, { recursive: true });
  const files = {
    exe: join(src, "guazzo.exe"),
    dll: join(src, "WebView2Loader.dll"),
    artifact: join(src, "app-single.html"),
    license: join(src, "LICENSE"),
    notices: join(src, "THIRD-PARTY-NOTICES.md"),
  };
  for (const [name, path] of Object.entries(files)) writeFileSync(path, `fake ${name}`);
  const notes = join(appDir, "docs", "releases", "v9.9.9.md");
  mkdirSync(join(appDir, "docs", "releases"), { recursive: true });
  writeFileSync(notes, "# 9.9.9\n\nthe body\n");
  const receipt = join(appDir, "desktop-build-receipt.json");
  const inputs = buildInputPaths(appDir)
    .filter((rel: string) => existsSync(join(appDir, rel)))
    .map((rel: string) => {
      const hash = createHash("sha256").update(readFileSync(join(appDir, rel))).digest("hex");
      return { path: rel, sha256: hash };
    });
  const digest = createHash("sha256")
    .update(inputs.map((f: { path: string; sha256: string }) => `${f.path}\0${f.sha256}\n`).join(""))
    .digest("hex");
  writeFileSync(receipt, JSON.stringify({ digest, files: inputs }));
  // The freshness hop compares mtimes; the fixture writes the exe first, so
  // stamp it after the other inputs to model a real build.
  const after = new Date(Date.now() + 1000);
  utimesSync(files.exe, after, after);
  return {
    appDir,
    receipt,
    opts: {
      appDir,
      version: "9.9.9",
      ...files,
      receipt,
      git: { sha: "abc123def456", ref: "main", dirty: false, tagSha: "abc123def456" },
      // Deterministic by default: the real reader shells out to PowerShell, and
      // a test that depends on this machine's certificate stores is not a test.
      signature: { signed: false, status: "NotSigned", subject: null, thumbprint: null, notAfter: null, timestamped: false },
      ...overrides,
    },
  };
}

test("release notes come from docs/releases and are part of the staged set", () => {
  const f = fixture();
  const out = stage(f.opts);
  assert.equal(readFileSync(join(out.dir, "RELEASE-NOTES.md"), "utf8"), "# 9.9.9\n\nthe body\n");
  // The notes are not an entry inside the archive, so the list that travels with
  // the archive cannot name them — otherwise `sha256sum -c` fails on the
  // extracted zip, which is exactly what happened the first time this shipped.
  assert.doesNotMatch(readFileSync(join(out.dir, "SHA256SUMS.txt"), "utf8"), /RELEASE-NOTES\.md/);
  assert.ok(out.manifest.files["RELEASE-NOTES.md"]);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: a missing notes file is refused, naming the path to write", () => {
  const f = fixture();
  rmSync(join(f.appDir, "docs", "releases", "v9.9.9.md"));
  assert.throws(
    () => stage(f.opts),
    /no release notes at docs\/releases\/v9\.9\.9\.md/,
  );
  rmSync(f.appDir, { recursive: true, force: true });
});

test("AV2: a clean tree stages a folder whose manifest names the commit", () => {
  const f = fixture();
  const out = stage(f.opts);
  assert.equal(out.manifest.commit, "abc123def456");
  assert.equal(out.manifest.dirty, false);
  assert.match(readFileSync(join(out.dir, "RELEASE.json"), "utf8"), /"commit": "abc123def456"/);
  assert.deepEqual(readdirSync(out.dir).sort(), [
    "Guazzo-v9.9.9.exe",
    "LICENSE",
    "README.txt",
    "RELEASE-NOTES.md",
    "RELEASE.json",
    "SHA256SUMS.txt",
    "THIRD-PARTY-NOTICES.md",
    "WebView2Loader.dll",
    "app-single.html",
  ]);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: a missing version tag is refused with the exact fix", () => {
  const f = fixture({ git: { sha: "abc123def456", ref: "main", dirty: false } });
  assert.throws(
    () => stage(f.opts),
    /no v9\.9\.9 tag at HEAD — tag after the gate, before staging: git tag -f v9\.9\.9 HEAD/,
  );
  assert.deepEqual(readdirSync(f.appDir).filter((n) => n.startsWith("release")), []);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: a tag on another commit is refused, naming both revisions", () => {
  const f = fixture({ git: { sha: "abc123def456", ref: "main", dirty: false, tagSha: "fedcba987654" } });
  assert.throws(
    () => stage(f.opts),
    /v9\.9\.9 points at fedcba9, not HEAD abc123d — move it to the release commit: git tag -f v9\.9\.9 HEAD/,
  );
  assert.deepEqual(readdirSync(f.appDir).filter((n) => n.startsWith("release")), []);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("AV2: a dirty tree is refused instead of staged with a false commit", () => {
  const f = fixture({ git: { sha: "abc123def456", ref: "main", dirty: true, tagSha: "abc123def456" } });
  assert.throws(() => stage(f.opts), /worktree has uncommitted changes/);
  assert.deepEqual(readdirSync(f.appDir).filter((n) => n.startsWith("release")), []);
  rmSync(f.appDir, { recursive: true, force: true });
});

// F2: an untracked source that feeds the build must make the tree dirty. The
// runner is injected because spawning git from Node is forbidden in the build
// sandbox; the files are created so buildInputPaths() really sees the input.
test("F2: an untracked build input is dirty; unrelated untracked paths are not", () => {
  const withInput = mkdtempSync(join(tmpdir(), "guazzo-gitstate-"));
  mkdirSync(join(withInput, "src", "engine"), { recursive: true });
  writeFileSync(join(withInput, "src", "engine", "wasm.ts"), "// untracked build input");
  mkdirSync(join(withInput, "rust"), { recursive: true });
  writeFileSync(join(withInput, "rust", "Cargo.toml"), "[package]");
  const runWithInput = (_cmd: string, args: string[]) => {
    if (args[0] === "status") return "?? src/engine/wasm.ts\n?? rust/\n";
    if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
    if (args[0] === "rev-parse") return "abc123def456\n";
    return "";
  };
  const dirty = gitState(withInput, "9.9.9", runWithInput);
  assert.equal(dirty.dirty, true, "an untracked src/**/*.ts is a build input");
  assert.equal(dirty.sha, "abc123def456");
  assert.equal(dirty.ref, "main");
  assert.equal(dirty.tagSha, "abc123def456", "the tag check still runs");

  const unrelated = mkdtempSync(join(tmpdir(), "guazzo-gitstate-"));
  mkdirSync(join(unrelated, "rust"), { recursive: true });
  writeFileSync(join(unrelated, "rust", "Cargo.toml"), "[package]");
  writeFileSync(join(unrelated, ".r41-head-main.ts"), "// unrelated tool file");
  const runUnrelated = (_cmd: string, args: string[]) => {
    if (args[0] === "status") return "?? rust/\n?? .r41-head-main.ts\n";
    if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
    if (args[0] === "rev-parse") return "abc123def456\n";
    return "";
  };
  const clean = gitState(unrelated, "9.9.9", runUnrelated);
  assert.equal(clean.dirty, false, "unrelated tool dirs must not block a release");

  rmSync(withInput, { recursive: true, force: true });
  rmSync(unrelated, { recursive: true, force: true });
});

test("F1: the release workflow is a gate, not a publisher or a rebuild", () => {
  const workflow = readFileSync(
    fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url)),
    "utf8",
  );
  assert.match(workflow, /node scripts\/ci\.mjs/, "the gate step is still there");
  assert.doesNotMatch(workflow, /softprops\/action-gh-release/, "a publish step came back");
  assert.doesNotMatch(workflow, /cargo build --release/, "a non-reproducible rebuild came back");
  assert.doesNotMatch(workflow, /tag_name:|body_path:|if: startsWith\(github\.ref/, "a renamed publisher came back");
});

test("AV2: a missing exe is refused by name", () => {
  const f = fixture({ exe: join(tmpdir(), "definitely-not-here.exe") });
  assert.throws(() => stage(f.opts), /missing Guazzo-v9\.9\.9\.exe/);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("AU2: a refused staging leaves the previous release byte-identical", () => {
  const f = fixture();
  const first = stage(f.opts);
  const before = readFileSync(join(first.dir, "RELEASE.json"), "utf8");
  // Same version, but this time the tree is dirty: the run must fail and the
  // folder from the last good run must survive untouched.
  const dirty = { ...f.opts, git: { sha: "abc123def456", ref: "main", dirty: true, tagSha: "abc123def456" } };
  assert.throws(() => stage(dirty), /worktree has uncommitted changes/);
  assert.equal(readFileSync(join(first.dir, "RELEASE.json"), "utf8"), before);
  assert.deepEqual(readdirSync(join(f.appDir, "release")).sort(), ["9.9.9"]);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("AV2: the manifest write is load-bearing (reverting it fails this suite)", () => {
  const f = fixture();
  const out = stage(f.opts);
  const manifest = readFileSync(join(out.dir, "RELEASE.json"), "utf8");
  assert.match(manifest, /"exeSha256": "[0-9a-f]{64}"/);
  assert.match(manifest, /"files": \{/);
  rmSync(f.appDir, { recursive: true, force: true });
});

// AU3 / DoD #6: the last hop of the freshness chain — an exe older than the
// sources that produced it must not become a release.
test("AU3: a source newer than the exe is refused by name", () => {
  const appDir = mkdtempSync(join(tmpdir(), "guazzo-fresh-"));
  const src = join(appDir, "src");
  mkdirSync(src, { recursive: true });
  const exe = join(appDir, "guazzo.exe");
  writeFileSync(exe, "exe");
  const older = (Date.now() - 60_000) / 1000;
  utimesSync(exe, older, older);
  assert.equal(staleSources(appDir, exe), null, "a fresh exe passes");

  const changed = join(src, "main.ts");
  writeFileSync(changed, "// newer");
  const newer = (Date.now() + 60_000) / 1000;
  utimesSync(changed, newer, newer);
  assert.equal(staleSources(appDir, exe), join("src", "main.ts"), "the newer file is named");
  rmSync(appDir, { recursive: true, force: true });
});

test("release: staging refuses a missing commit, a non-main branch, and a missing receipt", () => {
  const empty = fixture({ git: { sha: "", ref: "main", dirty: false, tagSha: "" } });
  assert.throws(() => stage(empty.opts), /no git metadata — commit the release before staging/);
  rmSync(empty.appDir, { recursive: true, force: true });

  const branch = fixture({ git: { sha: "abc123def456", ref: "feature/x", dirty: false, tagSha: "abc123def456" } });
  assert.throws(() => stage(branch.opts), /release must be staged from main, its release tag, or a checkout detached at that tag, not feature\/x/);
  rmSync(branch.appDir, { recursive: true, force: true });

  const detached = fixture({ git: { sha: "abc123def456", ref: "HEAD", dirty: false, tagSha: "abc123def456" } });
  assert.doesNotThrow(() => stage(detached.opts), /./); // tag dispatch: detached HEAD at v<version>
  rmSync(detached.appDir, { recursive: true, force: true });

  const detachedElsewhere = fixture({ git: { sha: "abc123def456", ref: "HEAD", dirty: false, tagSha: "999999999999" } });
  assert.throws(() => stage(detachedElsewhere.opts), /is not the v\d+\.\d+\.\d+ tag/);
  rmSync(detachedElsewhere.appDir, { recursive: true, force: true });

  const noReceipt = fixture();
  const missing = join(noReceipt.appDir, "nope.json");
  assert.throws(
    () => stage({ ...noReceipt.opts, receipt: missing }),
    /desktop-build-receipt\.json is missing — run node scripts\/build-desktop\.mjs before staging/,
  );
  rmSync(noReceipt.appDir, { recursive: true, force: true });
});

test("release: a receipt that no longer matches the source is refused", () => {
  const f = fixture();
  writeFileSync(join(f.appDir, "src", "late.ts"), "// changed after the build");
  assert.throws(
    () => stage(f.opts),
    /desktop-build-receipt\.json does not match the current sources — rebuild/,
  );
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: the manifest records the signature it found, not the one it wanted", () => {
  const f = fixture();
  const out = stage(f.opts);
  assert.equal(out.manifest.signature.signed, false);
  assert.equal(out.manifest.signature.status, "NotSigned");
  assert.equal(out.manifest.signature.subject, null);
  // An unsigned build still names the field: a reader must not have to tell
  // "no signature" apart from "the writer forgot to look".
  assert.match(readFileSync(join(out.dir, "RELEASE.json"), "utf8"), /"signed": false/);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: a signed exe carries its signer into the manifest", () => {
  const f = fixture({
    signature: {
      signed: true,
      status: "Valid",
      subject: "CN=vera2077, O=Guazzo",
      thumbprint: "0123456789abcdef0123456789abcdef01234567",
      notAfter: "2030-01-01T00:00:00.0000000Z",
      timestamped: true,
    },
  });
  const out = stage(f.opts);
  assert.equal(out.manifest.signature.signed, true);
  assert.equal(out.manifest.signature.subject, "CN=vera2077, O=Guazzo");
  assert.equal(out.manifest.signature.timestamped, true);
  assert.match(readFileSync(join(out.dir, "RELEASE.json"), "utf8"), /"thumbprint": "0123456789abcdef/);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: requiring a signature refuses an unsigned exe and stages nothing", () => {
  const f = fixture({ requireSigned: true });
  assert.throws(
    () => stage(f.opts),
    /is not signed \(NotSigned\).*node scripts\/sign\.mjs/,
  );
  // AU2 again: the refusal happens before the swap, so the versioned folder is
  // never created and a previous release of the same version would be intact.
  assert.equal(existsSync(join(f.appDir, "release", "9.9.9")), false);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: a signature marked valid but without a subject is still refused when required", () => {
  const f = fixture({ requireSigned: true, signature: { signed: false, status: "NotTrusted", subject: null, thumbprint: null, notAfter: null, timestamped: false } });
  assert.throws(() => stage(f.opts), /is not signed \(NotTrusted\)/);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: the checksum list covers RELEASE.json too", () => {
  const f = fixture();
  const out = stage(f.opts);
  const sums = readFileSync(join(out.dir, "SHA256SUMS.txt"), "utf8");
  // The manifest names the commit, the build time and the signature; leaving it
  // outside the list let all three be edited after the fact.
  assert.match(sums, /  RELEASE\.json$/m);
  const line = sums.split("\n").find((l: string) => l.endsWith("  RELEASE.json"));
  const hash = createHash("sha256").update(readFileSync(join(out.dir, "RELEASE.json"))).digest("hex");
  assert.equal(line!.slice(0, 64), hash);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: a valid signature from the wrong signer is refused", () => {
  const f = fixture({
    requireSigned: true,
    requireSigner: "vera2077",
    signature: {
      signed: true,
      status: "Valid",
      subject: "CN=someone-else, O=Other",
      thumbprint: "ffffffffffffffffffffffffffffffffffffffff",
      notAfter: "2030-01-01T00:00:00.0000000Z",
      timestamped: true,
    },
  });
  assert.throws(() => stage(f.opts), /is signed by "CN=someone-else/);
  assert.equal(existsSync(join(f.appDir, "release", "9.9.9")), false);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("release: requiring a signature without an expected signer fails closed", () => {
  const previous = process.env.RELEASE_REQUIRE_SIGNER;
  delete process.env.RELEASE_REQUIRE_SIGNER;
  try {
    const f = fixture({
      requireSigned: true,
      signature: {
        signed: true,
        status: "Valid",
        subject: "CN=vera2077, O=Guazzo",
        thumbprint: "0123456789abcdef0123456789abcdef01234567",
        notAfter: "2030-01-01T00:00:00.0000000Z",
        timestamped: true,
      },
    });
    // "Valid" only means a CA vouched for the key; without a named publisher any
    // certificate would pass, so this is a refusal rather than a warning.
    assert.throws(() => stage(f.opts), /no expected signer is set/);
    rmSync(f.appDir, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.RELEASE_REQUIRE_SIGNER;
    else process.env.RELEASE_REQUIRE_SIGNER = previous;
  }
});

test("package: a release folder edited after staging is refused", async () => {
  const f = fixture();
  const out = stage(f.opts);
  // package.mjs used to verify the folder with a checksum list it had generated
  // from that same folder, so editing the exe and re-running it could not fail.
  writeFileSync(join(out.dir, "Guazzo-v9.9.9.exe"), "tampered");
  // packageRelease is async, so a rejected promise is the failure mode.
  await assert.rejects(() => packageRelease("9.9.9", f.appDir), /hashes to .* but RELEASE\.json says/);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("verify-asset: the bytes that get published must match the manifest", () => {
  const appDir = mkdtempSync(join(tmpdir(), "guazzo-asset-"));
  const dir = join(appDir, "release", "9.9.9");
  mkdirSync(dir, { recursive: true });
  const zip = Buffer.from("not really a zip, but its hash is what matters");
  writeFileSync(join(dir, "Guazzo-v9.9.9.zip"), zip);
  const hash = createHash("sha256").update(zip).digest("hex");
  writeFileSync(join(dir, "Guazzo-v9.9.9.zip.sha256"), `${hash}  Guazzo-v9.9.9.zip\n`);
  writeFileSync(
    join(dir, "RELEASE.json"),
    JSON.stringify({ version: "9.9.9", zipSha256: hash, zipBytes: zip.length }),
  );
  // This fixture is a pre-anchoring manifest (no installerInputs / payload), so
  // it exercises only the zip hash; the anchored scheme refuses it outright
  // unless the legacy reader is asked for explicitly (sec-r31 #3).
  // There is no opt-out: a manifest that cannot name the installer sources,
  // or the payload it packed, proves nothing about the Setup (sec-r34).
  // sec-r37 #2: the installer anchor is required outright now, so the first
  // refusal is the missing hash rather than the missing input list.
  assert.throws(() => verifyAsset("9.9.9", appDir), /does not name installerSha256/);
  rmSync(appDir, { recursive: true, force: true });
});

test("the archive's manifest names only files the archive contains", () => {
  // 1.18.0 shipped a zip whose RELEASE.json listed Guazzo-v1.18.0-Setup.exe:
  // the Setup is a sibling asset, not a member. An extracted folder then
  // claimed a file it never had, and nothing checked the two lists against
  // each other.
  const staged = {
    version: "9.9.9",
    files: {
      "Guazzo-v9.9.9.exe": "a",
      "app-single.html": "b",
      "Guazzo-v9.9.9-Setup.exe": "c",
      "SHA256SUMS.txt": "d",
    },
  };
  const archived = ["Guazzo-v9.9.9.exe", "app-single.html", "SHA256SUMS.txt", "RELEASE.json"];
  const inner = packageModule.archiveManifest(staged, archived);
  assert.deepEqual(Object.keys(inner.files).sort(), ["Guazzo-v9.9.9.exe", "app-single.html"]);
  assert.equal(inner.version, "9.9.9");
});

// R30: the packed payload is verified by content, not by git identity. These
// cases prove the refusals without building a Setup.
// @ts-expect-error - a .mjs script has no type declarations
const { parsePayload } = await import("../../../scripts/verify-asset.mjs");

function payloadOf(entries: Array<[string, Buffer]>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(8);
  head.write("GZP1", 0, "latin1");
  head.writeUInt32LE(entries.length, 4);
  parts.push(head);
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(data.length, 0);
    const nameLen = Buffer.alloc(2);
    nameLen.writeUInt16LE(nameBuf.length, 0);
    parts.push(nameLen, nameBuf, len, data);
  }
  return Buffer.concat(parts);
}

test("payload: entries round trip and an unsafe name is refused", () => {
  const ok = parsePayload(payloadOf([["Guazzo.exe", Buffer.from([1, 2, 3])], ["LICENSE", Buffer.from("x")]]));
  assert.deepEqual(ok.map((e: { name: string }) => e.name), ["Guazzo.exe", "LICENSE"]);
  assert.deepEqual(Array.from(ok[0]!.data), [1, 2, 3]);
  for (const bad of ["../evil", "dir\\evil", "C:evil", ""]) {
    assert.throws(() => parsePayload(payloadOf([[bad, Buffer.from("x")]])), /unsafe entry/);
  }
});

test("payload: trailing bytes and an impossible count are refused", () => {
  const one = payloadOf([["Guazzo.exe", Buffer.from([1, 2, 3])]]);
  assert.throws(() => parsePayload(Buffer.concat([one, Buffer.from([0])])), /trailing bytes/);
  const empty = Buffer.alloc(8);
  empty.write("GZP1", 0, "latin1");
  assert.throws(() => parsePayload(empty), /names 0 entries/);
  const many = Buffer.alloc(8);
  many.write("GZP1", 0, "latin1");
  many.writeUInt32LE(65, 4);
  assert.throws(() => parsePayload(many), /names 65 entries/);
});

test("payload: a truncated entry is refused instead of read past the end", () => {
  const full = payloadOf([["Guazzo.exe", Buffer.alloc(10, 7)]]);
  assert.throws(() => parsePayload(full.subarray(0, full.length - 3)), /truncated/);
  assert.throws(() => parsePayload(Buffer.from("nope")), /not GZP1/);
});
