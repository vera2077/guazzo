# Publishing Guazzo

This is the first-push and release-asset checklist. It performs no network
operation itself and invents no public URL. The authoritative build remains
`release/<version>/` until a public download exists.

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

There is one GitHub Actions workflow, `.github/workflows/ci.yml`: it checks out
the repo on `windows-latest`, installs Node 22, runs `npm install`, and executes
`node scripts/ci.mjs`. That is the whole gate — tests, static pins, the headless
smoke run, the version lockstep check, and the deterministic single-file build —
and none of it needs the cargo mirror or a WebView2 toolchain, so a hosted
runner can run it. Building the **exe** still happens locally
(`cargo build --release` needs the mirror and a WebView2 linker); the workflow
never attempts it.

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
`RELEASE.json`, never by rebuilding.

## Create the release

1. Open the repository's **Releases** page in the web UI.
2. **Draft a new release**, choose the existing `v1.0.0` tag, and title it
   `Guazzo 1.0.0`.
3. Attach both files from `release/1.0.0/`:
   - `Guazzo-v1.0.0.zip`
   - `Guazzo-v1.0.0.zip.sha256`
4. Paste `release/1.0.0/RELEASE-NOTES.md` as the release body.
5. Do not upload the bare exe separately; it is inside the zip, and the zip
   hash is the download identity.
6. Publish. Then add the public URL to `README.md` in a documentation-only
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
git grep -n -I -E 'C:\\\\Users|C:/Users|/Users/|/home/' -- . ':!vendor' ':!src-tauri/gen'
git grep -n -I -E '(api[_-]?key|secret|password|Bearer [A-Za-z0-9._-]{10,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' -- . ':!vendor' ':!src-tauri/gen'
git ls-files '*.log' '*.tmp'
git check-ignore release dist Guazzo-v1.1.0.exe foo.dll foo.guazzo.json desktop-build-receipt.json
```

The first three commands must print nothing. The last command must print every
path (they are ignored). Never commit a release folder, a build receipt, a
project file, or an exe.
