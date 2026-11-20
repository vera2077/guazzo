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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

export const RELEASE_FILES = [
  ["exe", "exe"],
  ["WebView2Loader.dll", "dll"],
  ["LICENSE", "license"],
  ["THIRD-PARTY-NOTICES.md", "notices"],
];

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function gitState(appDir = APP_DIR, version = "") {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim();
    const ref = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: appDir, encoding: "utf8" }).trim().length > 0;
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
  const consider = (file) => {
    if (!existsSync(file)) return;
    const m = statSync(file).mtimeMs;
    if (m > newest.m) { newest.m = m; newest.file = file; }
  };
  // Only the TypeScript that is compiled into the page counts as a source: the
  // staged artefacts (exe, dll, LICENSE, notices) may legitimately sit beside it.
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) consider(full);
    }
  };
  walk(join(appDir, "src"));
  for (const f of ["index.html", "package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "vendor/ag-psd-bundle.js"]) {
    consider(join(appDir, f));
  }
  if (!newest.file) return null;
  const exeM = statSync(exePath).mtimeMs;
  return newest.m > exeM ? relative(appDir, newest.file) : null;
}

export function stage(o) {
  if (!o.git.sha && !o.allowDirty) {
    throw new Error("no git metadata — pass --allow-dirty to stage a release that cannot be tied to a commit");
  }
  if (o.git.dirty && !o.allowDirty) {
    throw new Error(
      "the worktree has uncommitted changes — commit them, or pass --allow-dirty to ship a build that is not the commit above",
    );
  }
  if (!o.allowDirty) {
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
  }
  const sources = [
    [o.exe, `Guazzo-v${o.version}.exe`],
    [o.dll, "WebView2Loader.dll"],
    [o.license, "LICENSE"],
    [o.notices, "THIRD-PARTY-NOTICES.md"],
  ];
  for (const [src, name] of sources) {
    if (!existsSync(src)) throw new Error(`missing ${name} (${src}) — build it first`);
  }

  const stale = staleSources(o.appDir, o.exe);
  if (stale) {
    throw new Error(`${stale} is newer than ${o.exe} — rebuild before staging (build-desktop then cargo)`);
  }

  const outDir = join(o.appDir, "release", o.version);
  // Build beside the destination, then swap. A failure here leaves `outDir` as it
  // was, including the previous release of the same version.
  const stagingDir = join(o.appDir, "release", `.staging-${process.pid}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  try {
    const sums = [];
    for (const [src, name] of sources) {
      const dest = join(stagingDir, name);
      copyFileSync(src, dest);
      sums.push(`${sha256(dest)}  ${name}`);
    }
    writeFileSync(join(stagingDir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);

    const manifest = {
      version: o.version,
      commit: o.git.sha,
      ref: o.git.ref,
      dirty: o.git.dirty,
      builtAt: new Date().toISOString(),
      exeSha256: sha256(join(stagingDir, `Guazzo-v${o.version}.exe`)),
      artifactSha256: o.artifact && existsSync(o.artifact) ? sha256(o.artifact) : null,
      files: Object.fromEntries(sources.map(([src, name]) => [name, sha256(src)])),
    };
    writeFileSync(join(stagingDir, "RELEASE.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // Exactly the shipped set: four files plus the checksum list and the manifest.
    // A stray file did not come from this function.
    const expected = new Set([...sources.map(([, n]) => n), "SHA256SUMS.txt", "RELEASE.json"]);
    for (const name of readdirSync(stagingDir)) {
      if (!expected.has(name)) throw new Error(`unexpected file in the release: ${name}`);
    }

    rmSync(outDir, { recursive: true, force: true });
    renameSync(stagingDir, outDir);
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

  const version = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version;
  const exe = join(APP_DIR, `Guazzo-v${version}.exe`);

  if (process.argv.includes("--print")) {
    console.log(`release: v${version} would contain`);
    for (const [, name] of RELEASE_FILES) console.log(`  ${name}`);
    if (existsSync(exe)) console.log(`  Guazzo-v${version}.exe sha256 ${sha256(exe)}`);
    process.exit(0);
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
      allowDirty: process.argv.includes("--allow-dirty"),
    });
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const bytes = statSync(join(staged.dir, basename(staged.dir) === version ? `Guazzo-v${version}.exe` : exe)).size;
  console.log(`release: staged ${basename(staged.dir)} (${Object.keys(staged.manifest.files).length + 2} files, exe ${bytes} bytes)`);
  if (staged.manifest.commit) console.log(`  commit ${staged.manifest.commit.slice(0, 12)} (${staged.manifest.ref})`);
  for (const line of staged.sums) console.log(`  ${line}`);
  console.log(`\nNext — label the binaries Medium, or the exe cannot start WebView2:`);
  for (const name of [`Guazzo-v${version}.exe`, "WebView2Loader.dll"]) {
    console.log(`  icacls "${join(staged.dir, name)}" /setintegritylevel medium`);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) await main();
