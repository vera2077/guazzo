import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
const { stage, staleSources } = stageModule;

function fixture(overrides: Record<string, unknown> = {}) {
  const appDir = mkdtempSync(join(tmpdir(), "guazzo-release-"));
  const src = join(appDir, "src");
  mkdirSync(src, { recursive: true });
  const files = {
    exe: join(src, "guazzo.exe"),
    dll: join(src, "WebView2Loader.dll"),
    license: join(src, "LICENSE"),
    notices: join(src, "THIRD-PARTY-NOTICES.md"),
  };
  for (const [name, path] of Object.entries(files)) writeFileSync(path, `fake ${name}`);
  return {
    appDir,
    opts: {
      appDir,
      version: "9.9.9",
      ...files,
      git: { sha: "abc123def456", ref: "main", dirty: false },
      ...overrides,
    },
  };
}

test("AV2: a clean tree stages a folder whose manifest names the commit", () => {
  const f = fixture();
  const out = stage(f.opts);
  assert.equal(out.manifest.commit, "abc123def456");
  assert.equal(out.manifest.dirty, false);
  assert.match(readFileSync(join(out.dir, "RELEASE.json"), "utf8"), /"commit": "abc123def456"/);
  assert.deepEqual(readdirSync(out.dir).sort(), [
    "Guazzo-v9.9.9.exe",
    "LICENSE",
    "RELEASE.json",
    "SHA256SUMS.txt",
    "THIRD-PARTY-NOTICES.md",
    "WebView2Loader.dll",
  ]);
  rmSync(f.appDir, { recursive: true, force: true });
});

test("AV2: a dirty tree is refused instead of staged with a false commit", () => {
  const f = fixture({ git: { sha: "abc123def456", ref: "main", dirty: true } });
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
  const dirty = { ...f.opts, git: { sha: "abc123def456", ref: "main", dirty: true } };
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
