/**
 * Stage a release folder: the exe, its loader DLL, the licence, the notices, a
 * checksum list and a manifest that names the commit the binary came from.
 *
 * The order is fixed: commit -> gate -> tag -> release, tag last. Staging
 * resolves refs/tags/v<version>^{commit} before it creates the staging directory
 * and refuses when the tag is missing or names a different commit — a manifest
 * whose commit is not the tagged commit is the bug this check exists for.
 *
 * AV2: this file is importable and `stage()` is exercised by
 * `src/engine/tests/release.test.ts` in a temp directory. Before that the only
 * thing checking it was a pin grepping this source for the string "RELEASE.json",
 * which the allow-list below also contains — a tautology that could not fail.
 *
 * AU2: validation happens before anything is deleted, and the new folder is built
 * in a staging directory and renamed into place, so a refused run leaves the
 * previous release byte-identical instead of wiping it and then complaining.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative } from "node:path";
import { buildInputPaths, RECEIPT_NAME, verifyBuildReceipt } from "./build-inputs.mjs";
import { REQUIRE_SIGNED_ENV, REQUIRE_SIGNER_ENV, readSignature, requireSignature, signatureManifest } from "./signature.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

export const RELEASE_FILES = [
  ["exe", "exe"],
  ["WebView2Loader.dll", "dll"],
  ["artifact", "app-single.html"],
  ["LICENSE", "license"],
  ["THIRD-PARTY-NOTICES.md", "notices"],
];

export const RELEASE_README = "README.txt";
export const RELEASE_NOTES = "RELEASE-NOTES.md";

// The release body is authored, not generated. It lives in the repo so a restage
// cannot destroy it: staging wipes release/<version>/ and rewrites a known file
// list, which once deleted hand-written notes that existed only in that folder.
export function notesPath(appDir, version) {
  return join(appDir, "docs", "releases", `v${version}.md`);
}

export function releaseReadme(version) {
  return `Guazzo v${version} — quick start

1. Extract this folder anywhere. There is no installer and no admin rights.
2. Run Guazzo-v${version}.exe. Keep WebView2Loader.dll beside it.
3. If Windows says "Unknown publisher", choose More info -> Run anyway.
4. Never run the app as administrator.
5. Prefer a browser tab? Open app-single.html instead.
6. Verify this download: sha256sum -c SHA256SUMS.txt

This build is unsigned, so SmartScreen may warn on first launch. Code signing
is planned, not purchased.

Guazzo never checks for updates and contains no network code. To update,
replace this folder with a newer release; your .guazzo.json projects keep
working.
`;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function gitState(appDir = APP_DIR, version = "") {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim();
    const ref = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim();
    // Tracked modifications only: an untracked directory that belongs to another
    // tool (this workspace has one) must not block a release, and it cannot get
    // into a staged artifact because staging copies named files.
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: appDir, encoding: "utf8",
    }).trim().length > 0;
    let tagSha = "";
    if (version) {
      try {
        tagSha = execFileSync("git", ["rev-parse", `refs/tags/v${version}^{commit}`], {
          cwd: appDir,
          encoding: "utf8",
        }).trim();
      } catch {
        tagSha = "";
      }
    }
    return { sha, ref, dirty, tagSha };
  } catch {
    return { sha: "", ref: "", dirty: false, tagSha: "" };
  }
}

/**
 * Build `release/<version>/` and return its manifest. Throws (after touching
 * nothing) when the tree is dirty, has no commit, or the exe is missing.
 */

/**
 * AU3 / DoD #6: refuse to stage a build that is older than its own sources.
 * The freshness chain in build-desktop covers `src/` -> bundle -> page, and
 * cargo's build.rs covers page -> crate; this closes the last hop, exe vs the
 * files that produced it, so "shipped" can never mean "shipped yesterday's code".
 */
export function staleSources(appDir, exePath) {
  const newest = { file: null, m: 0 };
  for (const rel of buildInputPaths(appDir)) {
    const file = join(appDir, rel);
    if (!existsSync(file)) continue;
    const m = statSync(file).mtimeMs;
    if (m > newest.m) { newest.m = m; newest.file = file; }
  }
  if (!newest.file) return null;
  const exeM = statSync(exePath).mtimeMs;
  return newest.m > exeM ? relative(appDir, newest.file) : null;
}

export function stage(o) {
  assertVersion(o.version, "release: stage");
  if (!o.git.sha) throw new Error("no git metadata — commit the release before staging");
  if (o.git.dirty) {
    throw new Error("the worktree has uncommitted changes — commit them before staging");
  }
  // main when run from a checkout, or the release tag itself when the workflow
  // is dispatched on that tag: the tag has to point at HEAD either way, which
  // the check below enforces. Refusing the tag made every CI run fail at the
  // first step.
  const onMain = o.git.ref === "main";
  const onReleaseTag = /^v\d+\.\d+\.\d+$/.test(o.git.ref);
  // A workflow_dispatch on a tag checks out a detached HEAD, so `--abbrev-ref`
  // answers "HEAD" while the tag still names this commit: accept that shape and
  // let the tagSha check below prove the tag is the one being released.
  const onDetachedReleaseTag = o.git.ref === "HEAD" && o.git.tagSha === o.git.sha && !!o.git.tagSha;
  if (!onMain && !onReleaseTag && !onDetachedReleaseTag) {
    if (o.git.ref === "HEAD" && o.git.tagSha) {
      throw new Error(
        `a checkout detached at ${o.git.sha.slice(0, 7)} is not the v${o.version} tag (${o.git.tagSha.slice(0, 7)}) — dispatch on the tag or check out main`,
      );
    }
    throw new Error(
      `release must be staged from main, its release tag, or a checkout detached at that tag, not ${o.git.ref}`,
    );
  }
  if (!o.git.tagSha) {
    throw new Error(
      `no v${o.version} tag at HEAD — tag after the gate, before staging: git tag -f v${o.version} HEAD`,
    );
  }
  if (o.git.tagSha !== o.git.sha) {
    throw new Error(
      `v${o.version} points at ${o.git.tagSha.slice(0, 7)}, not HEAD ${o.git.sha.slice(0, 7)} — move it to the release commit: git tag -f v${o.version} HEAD`,
    );
  }
  const receipt = verifyBuildReceipt(o.appDir, o.receipt ?? join(o.appDir, RECEIPT_NAME));
  const notes = o.notes ?? notesPath(o.appDir, o.version);
  if (!existsSync(notes)) {
    throw new Error(
      `no release notes at docs/releases/v${o.version}.md — write the release body there before staging`,
    );
  }
  const sources = [
    [o.exe, `Guazzo-v${o.version}.exe`],
    [o.dll, "WebView2Loader.dll"],
    [o.artifact, "app-single.html"],
    [o.license, "LICENSE"],
    [o.notices, "THIRD-PARTY-NOTICES.md"],
  ];
  for (const [src, name] of sources) {
    if (!src || !existsSync(src)) throw new Error(`missing ${name} (${src}) — build it first`);
  }

  const stale = staleSources(o.appDir, o.exe);
  if (stale) {
    throw new Error(`${stale} is newer than ${o.exe} — rebuild before staging (build-desktop then cargo)`);
  }

  // stage() is exported; main() validating is not enough (sec-r7 #4).
  const version = assertVersion(o.version, "release: stage");
  const outDir = join(o.appDir, "release", version);
  // Build beside the destination, then swap. A failure here leaves `outDir` as it
  // was, including the previous release of the same version.
  // A predictable name can collide with a concurrent run; mkdtemp is atomic and
  // private, and the swap below removes it either way. mkdtemp needs the parent.
  mkdirSync(join(o.appDir, "release"), { recursive: true });
  const stagingDir = mkdtempSync(join(o.appDir, "release", ".staging-"));

  try {
    const sums = [];
    // The staged bytes are what ships, so they are the only thing hashed: the
    // checksum list and RELEASE.json read one map. Hashing the source path
    // instead let a file change between the copy and the manifest, naming a
    // hash that was never packaged.
    const stagedHash = new Map();
    for (const [src, name] of sources) {
      const dest = join(stagingDir, name);
      copyFileSync(src, dest);
      const digest = sha256(dest);
      stagedHash.set(name, digest);
      sums.push(`${digest}  ${name}`);
    }
    writeFileSync(join(stagingDir, RELEASE_README), releaseReadme(o.version));
    sums.push(`${sha256(join(stagingDir, RELEASE_README))}  ${RELEASE_README}`);
    copyFileSync(notes, join(stagingDir, RELEASE_NOTES));
    // The notes describe the archive and are not an entry inside it, so they are
    // not covered by the checksum list the archive carries: `sha256sum -c` runs
    // against the extracted zip, which has no notes file to read. Their hash is
    // in RELEASE.json instead, next to every other staged file. The list is
    // written after the manifest, because the manifest is covered by it too.

    // The exe is the only file a user is asked to trust. Record what its
    // signature actually says: `signed: false` is a fact about this build, not
    // an omission, and a job that meant to sign must not publish quietly
    // without one.
    const exeInStaging = join(stagingDir, `Guazzo-v${o.version}.exe`);
    const signature = o.signature ?? readSignature(exeInStaging, { run: o.run });
    if (o.requireSigned ?? process.env[REQUIRE_SIGNED_ENV] === "1") {
      requireSignature(
        signature,
        `Guazzo-v${o.version}.exe`,
        o.requireSigner ?? process.env[REQUIRE_SIGNER_ENV],
      );
    }

    const manifest = {
      version: o.version,
      commit: o.git.sha,
      ref: o.git.ref,
      dirty: o.git.dirty,
      builtAt: new Date().toISOString(),
      exeSha256: sha256(join(stagingDir, `Guazzo-v${o.version}.exe`)),
      artifactSha256: o.artifact && existsSync(o.artifact) ? sha256(o.artifact) : null,
      buildReceiptSha256: sha256(o.receipt ?? join(o.appDir, RECEIPT_NAME)),
      buildInputsSha256: receipt.digest,
      signature: signatureManifest(signature),
      files: {
        ...Object.fromEntries(sources.map(([, name]) => [name, stagedHash.get(name)])),
        [RELEASE_README]: sha256(join(stagingDir, RELEASE_README)),
        [RELEASE_NOTES]: sha256(join(stagingDir, RELEASE_NOTES)),
      },
    };
    writeFileSync(join(stagingDir, "RELEASE.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    // The manifest makes claims (commit, builtAt, signature) and used to be the
    // one shipped file outside the checksum list, so it could be edited after
    // the fact without `sha256sum -c` noticing.
    sums.push(`${sha256(join(stagingDir, "RELEASE.json"))}  RELEASE.json`);
    writeFileSync(join(stagingDir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);

    // Exactly the shipped set: four files plus the checksum list and the manifest.
    // A stray file did not come from this function.
    const expected = new Set([
      ...sources.map(([, n]) => n),
      RELEASE_README,
      RELEASE_NOTES,
      "SHA256SUMS.txt",
      "RELEASE.json",
    ]);
    for (const name of readdirSync(stagingDir)) {
      if (!expected.has(name)) throw new Error(`unexpected file in the release: ${name}`);
    }

    // Swap with a backup: rm-then-rename leaves no release at all when the
    // rename fails, and a Windows EPERM from an open handle in the old folder is
    // the ordinary case rather than a corrupt disk.
    const backup = `${outDir}.prev-${process.pid}`;
    rmSync(backup, { recursive: true, force: true });
    const hadPrevious = existsSync(outDir);
    if (hadPrevious) renameSync(outDir, backup);
    try {
      renameSync(stagingDir, outDir);
    } catch (err) {
      if (hadPrevious) renameSync(backup, outDir);
      throw err;
    }
    rmSync(backup, { recursive: true, force: true });
    return { dir: outDir, manifest, sums };
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

async function main() {
  const die = (msg) => {
    console.error(`release: ${msg}`);
    process.exit(1);
  };

  // The four carriers must agree before anything is staged: a release whose About
  // box says a different number than its exe is the bug this check exists for.
  const { check } = await import("./bump.mjs");
  try {
    check();
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  // The version becomes a directory name below release/, and staging renames
  // and deletes that directory. Four carriers agreeing only means they agree
  // (a "../.." would delete outside release/) — sec-r5.
  const version = assertVersion(
    JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version,
    "release",
  );
  const exe = join(APP_DIR, `Guazzo-v${version}.exe`);

  if (process.argv.includes("--print")) {
    console.log(`release: v${version} would contain`);
    for (const [, name] of RELEASE_FILES) console.log(`  ${name}`);
    if (existsSync(exe)) console.log(`  Guazzo-v${version}.exe sha256 ${sha256(exe)}`);
    process.exit(0);
  }

  if (process.argv.includes("--require-signed")) process.env[REQUIRE_SIGNED_ENV] = "1";
  if (process.argv.includes("--allow-dirty")) {
    die("--allow-dirty is not accepted — commit the tree and stage from main");
  }
  const git = gitState(APP_DIR, version);
  let staged;
  try {
    staged = stage({
      appDir: APP_DIR,
      version,
      exe,
      dll: join(APP_DIR, "WebView2Loader.dll"),
      license: join(APP_DIR, "LICENSE"),
      notices: join(APP_DIR, "THIRD-PARTY-NOTICES.md"),
      artifact: join(APP_DIR, "app-single.html"),
      git,
      receipt: join(APP_DIR, RECEIPT_NAME),
    });
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const bytes = statSync(join(staged.dir, basename(staged.dir) === version ? `Guazzo-v${version}.exe` : exe)).size;
  console.log(`release: staged ${basename(staged.dir)} (${Object.keys(staged.manifest.files).length + 2} files, exe ${bytes} bytes)`);
  if (staged.manifest.commit) console.log(`  commit ${staged.manifest.commit.slice(0, 12)} (${staged.manifest.ref})`);
  const sig = staged.manifest.signature;
  console.log(
    sig.signed
      ? `  signed: ${sig.subject}`
      : `  unsigned (${sig.status}) — SmartScreen will warn on first run`,
  );
  for (const line of staged.sums) console.log(`  ${line}`);
  console.log(`\nNext — label the binaries Medium, or the exe cannot start WebView2:`);
  for (const name of [`Guazzo-v${version}.exe`, "WebView2Loader.dll"]) {
    console.log(`  icacls "${join(staged.dir, name)}" /setintegritylevel medium`);
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
