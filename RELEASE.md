# Releasing Guazzo

The order is fixed:

**commit → gate → tag → release → package, tag last.**

1. Commit the release tree. `git status --porcelain` must be empty.
2. Run the gate un-piped: `node scripts/ci.mjs`.
3. Tag the exact commit: `git tag v<version>`.
4. Run `node scripts/build-desktop.mjs` (it writes
   `desktop-build-receipt.json`), then
   `cd src-tauri && CARGO_HOME=../.cargo-home cargo build --release`
   and copy the exe to `Guazzo-v<version>.exe`.
5. Stage the artifact: `node scripts/release.mjs`, then label the exe and
   `WebView2Loader.dll` Medium as it prints. The staging step copies the
   portable `app-single.html` and writes a version-agnostic `README.txt`.
6. Package the download: `node scripts/package.mjs <version>`.
   It writes `Guazzo-v<version>.zip` and `Guazzo-v<version>.zip.sha256` in
   `release/<version>/`, updates `zipSha256`/`zipBytes` in `RELEASE.json`,
   extracts the zip, runs `sha256sum -c SHA256SUMS.txt` inside the extracted
   folder, and prints the extracted exe's integrity label.

`release.mjs` verifies the receipt against the current source tree and refuses
when the exe is older than any input, when the tree is dirty, when there is no
commit, or when the branch is not `main`.

`release.mjs` resolves `refs/tags/v<version>^{commit}` before it creates the
staging directory. It refuses when the tag is missing or names a different
commit, and prints the exact `git tag -f ...` command to fix it. The manifest
records `HEAD`, so a release cannot name a commit the tag does not cover.

The HTML artifact is reproducible: rebuilding the same commit produces the same
`artifactSha256`, so a rebuild-diff is a valid check on it. The exe is not
reproducible — PE/link timestamps change its hash even from identical inputs
(`acc401cb…` → `ecef69c2…` for 0.71.0) — so verify `exeSha256` only against
`RELEASE.json`, never by rebuilding and comparing hashes.

There is no `--allow-dirty` escape hatch: staging requires a clean `main`, a
commit, the matching tag and a matching build receipt.

## Integrity labels

A Low-integrity exe cannot create `%LOCALAPPDATA%\Guazzo\WebView2` and exits
with `os error 5`. The shipped exes and loader are labeled Medium. After
staging, the release script prints the required command:

```bat
icacls Guazzo-v<version>.exe /setintegritylevel medium
icacls WebView2Loader.dll /setintegritylevel medium
```

`package.mjs` extracts the final zip and prints the extracted exe's label. It
treats an explicitly Medium label and an inherited default Medium as healthy,
and rejects an explicit Low or High label.

## Release-folder retention

Keep the **last three releases plus the current one**. Move older folders to an
archive outside the repo or delete them. `release/` is gitignored; an
unbounded folder is how "which build did I send?" starts. The current policy
keeps at most four `release/<version>/` directories; the release manifest and
zip hash are the identity, not the folder age.

## Download and signing status

Guazzo **1.0.0 is unsigned**. Windows shows "Unknown publisher", and
SmartScreen may warn on the first launch: choose **More info → Run anyway**.
Code signing is planned, not purchased. Do not claim otherwise in release
notes.

No public download is published yet. The authoritative build is
`release/<version>/`; the first public URL will be added as a documentation-only
change, not a version bump. See [`docs/PUBLISH.md`](docs/PUBLISH.md).

The app never checks for updates and contains no network code. Update by
replacing the program folder with a newer release zip; existing
`.guazzo.json` projects keep working. There is no auto-updater and no update
check in the app.

## Fresh-clone drill

Before publishing a release, prove the committed tree builds from a new clone,
not just from this working tree:

```bash
git clone "$(git remote get-url origin)" /tmp/guazzo-clone
cd /tmp/guazzo-clone
node scripts/ci.mjs
sha256sum app-single.html
node -e "console.log(require('./release/<version>/RELEASE.json').artifactSha256)"
```

The two SHA-256 values must match. The gate is un-piped on purpose; redirecting
its output hides a failure. The exe is not reproducible, so compare only the
HTML artifact and the manifest's `exeSha256`.

## PSD import budget

The PSD import budget is 1.5 GiB. A 16384² full-canvas layer is 1.07 GB of RGBA,
so the old 512 MB cap refused files Guazzo could export. The budget remains
bounded and is checked before a `Document` or layer walk is allocated; a larger
tree is refused with the limit and the offending layer size in the message.
