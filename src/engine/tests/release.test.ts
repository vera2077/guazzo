import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const { stage, staleSources } = stageModule;
const { buildInputPaths } = buildInputsModule;

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
  assert.throws(() => stage(branch.opts), /release must be staged from main, not feature\/x/);
  rmSync(branch.appDir, { recursive: true, force: true });

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
