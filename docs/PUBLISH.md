# Publishing Guazzo

This is the first-push and release-asset checklist. It performs no network
operation itself and invents no public URL. The authoritative build remains
`release/<version>/` until a public download exists.

CI provides a **release gate**, not a publisher: `.github/workflows/release.yml`
checks out the dispatched commit and runs `node scripts/ci.mjs`. It never builds
the exe, stages a folder, signs, packages, verifies assets, or uploads anything.
Releases are cut by hand, from the locally staged folder, as described below.

## Identity

History was rewritten before the first push so that every commit is authored and
committed by the project account, not by the machine that happened to build it:

```
vera <54594800+vera2077@users.noreply.github.com>
```

`v1.0.0` is an annotated tag on the release commit — the same commit named in
`release/1.0.0/RELEASE.json`, and the commit this file and `.gitattributes`
landed in. `release.mjs` refuses to stage a version whose tag is not at `HEAD`,
so the two cannot drift.

The address is GitHub's noreply form (`<id>+<login>@users.noreply.github.com`),
so commits link to the account without publishing a real inbox. If a different
address is preferred, change it in `git config` **and** in RELEASE.json's
`commit` is unaffected — only future commits carry the new identity.

## Before the first push

1. Confirm the release tree is committed, `main` is checked out, `git status
   --porcelain` is empty, and the un-piped gate is green:

   ```bash
   node scripts/ci.mjs > /tmp/ci.log 2>&1; echo CI_EXIT=$?
   ```

   `release.mjs` additionally refuses to stage when an **untracked build input**
   exists (for example `src/engine/wasm.ts`): the build receipt hashes those
   files, so an untracked source can change the shipped bytes while a
   tracked-only dirty check stays green. Unrelated untracked tool directories
   (`rust/`, `.r41-head-main.ts`) are ignored.

2. Create an **empty** repository (no README, no licence file — both already
   exist here) at <https://github.com/vera2077/guazzo>. A different name is fine;
   it only changes the URL below.

3. Add it as `origin`, then push `main` and the tags:

   ```bash
   git remote add origin https://github.com/vera2077/guazzo.git
   git remote -v
   git push -u origin main --tags
   ```

   `gh` is not installed in the build sandbox and the sandbox has no stored
   credential, so the first push must come from a shell that has one (HTTPS token
   or SSH key). Nothing else about the repository needs changing.

There are two workflows. `.github/workflows/ci.yml` checks out the repo on
`windows-latest`, installs Node 22, runs `npm install`, and executes
`node scripts/ci.mjs`. That is the whole gate — tests, static pins, the headless
smoke run, the version lockstep check, and the deterministic single-file build —
and none of it needs the cargo mirror or a WebView2 toolchain, so a hosted
runner can run it. `.github/workflows/release.yml` is the same gate dispatched
by hand on the commit or tag you intend to release: checkout, Node 22, install,
`node scripts/ci.mjs`. It is a gate only — there is no cargo build, no staging,
no signing, no packaging and no upload step in it. Building the **exe** happens
locally (`cargo build --release` needs the mirror and a WebView2 linker);
neither workflow attempts it.

Pushing that file needs a token with **Workflows: Read and write**. A
fine-grained PAT with only Contents and Administration is refused with
`refusing to allow a Personal Access Token to create or update workflow`. Either
add the scope or paste the file through the GitHub web UI.

## Reproducibility drill (run once, from a fresh clone)

The published artifact must be derivable from the tag, not from this working
directory. In an empty directory:

```bash
git clone https://github.com/vera2077/guazzo.git guazzo-verify
cd guazzo-verify
git checkout v1.0.0

# Node >= 22.18. pnpm is the pinned package manager; npm works too.
corepack enable && pnpm install --frozen-lockfile
# or: npm install --no-audit --no-fund

node node_modules/typescript/bin/tsc
node scripts/single-file.mjs

sha256sum app-single.html
# must equal RELEASE.json's artifactSha256:
#   1.0.0 -> a191abf745ffaf1a6f812cee824c3ed0b7521fe8309013b14b118e970e68e292
```

If that hash differs, the checkout changed the bytes: check `git config
core.autocrlf` (the repository ships `.gitattributes` forcing LF) before
suspecting the code. The exe is **not** reproducible byte-for-byte — a PE header
carries a linker timestamp — so `exeSha256` is only verifiable against
`RELEASE.json`, never by rebuilding. That is why CI cannot publish: a
runner-built exe is a different binary from the one you staged and verified.

## Signing (optional, and the manifest says whether it happened)

An unsigned exe is shippable; it shows SmartScreen's "Windows protected your PC"
panel to first-time users. `docs/SIGNING.md` covers the routes; the short
version:

- `node scripts/sign.mjs Guazzo-v<version>.exe` signs and verifies in place.
- Sign **before** `release.mjs`: the manifest hashes the exe, so signing after
  staging would describe a file nobody downloads. The order is
  `bump → gate → tag → cargo build → copy → sign → release.mjs → package.mjs`.
- `release.mjs` records what it found in `RELEASE.json` (`"signed": false` when
  unsigned); `RELEASE_REQUIRE_SIGNED=1` and `RELEASE_REQUIRE_SIGNER` turn an
  unsigned or wrong-signer result into a staging refusal when you stage locally.
- The release workflow does **not** sign and does not enforce a signature. CI
  cannot add a signature to the binary you already staged, so signing stays a
  local step of the manual procedure.

## Create the release

The publish step is manual on purpose: the exe is not byte-reproducible (the PE
header carries a linker timestamp), so a binary built on a runner is a different
file with a different `RELEASE.json` than the one you staged and verified. The
`release` workflow is `workflow_dispatch` only and is a **gate**: tag pushes run
`ci` and nothing else, and no workflow uploads an asset. Dispatch the gate on
the commit or tag you intend to ship, then upload the files yourself from a
shell that has your credential (or through the web UI).

1. Write the release body first, at `docs/releases/v<version>.md`, and commit it.
   Staging copies it into the release folder as `RELEASE-NOTES.md` and refuses to
   run without it, because the folder is wiped and rebuilt on every restage.
2. Run the gate locally (`node scripts/ci.mjs`) and dispatch
   `.github/workflows/release.yml` on the same commit.
3. Open the repository's **Releases** page in the web UI.
4. **Draft a new release**, choose the `v<version>` tag, and title it
   `Guazzo <version>`.
5. Attach the files from `release/<version>/` that you built and verified
   locally: `Guazzo-v<version>.zip`, `Guazzo-v<version>.zip.sha256`, and — when
   you built it — `Guazzo-v<version>-Setup.exe` and its `.sha256`.
6. Paste `release/<version>/RELEASE-NOTES.md` as the release body — it is the
   staged copy of `docs/releases/v<version>.md`. The notes are not inside the
   zip: they describe the archive, they are not a payload file.
7. Do not upload the bare exe separately; it is inside the zip, and the zip
   hash is the download identity.
8. Publish. Then add the public URL to `README.md` in a documentation-only
   commit; do not bump the version for that change.

## Verify the uploaded asset

Download the published zip once and check it against the local copy:

```bash
sha256sum Guazzo-v1.0.0.zip
cat Guazzo-v1.0.0.zip.sha256
```

The two hashes must match. Extract the zip and run
`sha256sum -c SHA256SUMS.txt` inside the extracted folder.

## Leak audit

Run these before the first push. They are read-only:

```bash
git grep -n -I -E 'C:\\Users|C:/Users|/Users/|/home/' -- . ':!vendor' ':!src-tauri/gen'
git grep -n -I -E '(api[_-]?key|secret|password|Bearer [A-Za-z0-9._-]{10,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' -- . ':!vendor' ':!src-tauri/gen'
git ls-files '*.log' '*.tmp'
git check-ignore release dist Guazzo-v1.1.0.exe foo.dll foo.guazzo.json desktop-build-receipt.json
```

The first three commands must print nothing. The last command must print every
path (they are ignored). Never commit a release folder, a build receipt, a
project file, or an exe.

## The Setup is built locally, from the committed payload

`build-setup.mjs` writes `installer/assets/payload.bin` from the staged release
files, and `verify-asset.mjs` refuses a payload that is not the one committed at
`RELEASE.json`'s commit. The order is therefore:

1. `node scripts/build-setup.mjs <version>` — packs the payload and builds the Setup.
2. `git add installer/assets/payload.bin && git commit -m "chore: <version> payload"`.
3. `node scripts/release.mjs <version>` — re-stages with the payload commit as `commit`.
4. `node scripts/build-setup.mjs <version>` — regenerates the same bytes.
5. `node scripts/package.mjs <version>` then `node scripts/verify-asset.mjs <version>`.

Without step 2 the verification fails with "differs from the shipped payload":
that is the point — a published installer must be rebuildable from its tag.
None of this runs in the release workflow; it is part of the manual cut.
