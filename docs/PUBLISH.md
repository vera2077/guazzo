# Publishing Guazzo

This is the first-push and release-asset checklist. It performs no network
operation itself and invents no public URL. The authoritative build remains
`release/<version>/` until a public download exists.

## Before the first push

1. Confirm the release tree is committed, `main` is checked out, `git status
   --porcelain` is empty, and the un-piped gate is green.
2. Choose the author identity **before creating any new commits**. History so
   far records `melodi <melodi@local>`; commit authors are permanent once
   pushed. To rewrite every commit is a separate, deliberate history rewrite;
   if you accept the existing author, say so in the release notes.
3. Add the repository as `origin`. There is no remote configured locally yet.

```bash
git config user.name "Your Name"
git config user.email "you@example.com"
git remote add origin https://github.com/<user>/<repo>.git
git remote -v
git push -u origin main --tags
```

Use the web UI for the release asset. `gh` is not installed here, and this
repository intentionally has no GitHub Actions workflow: the gate needs the
local cargo mirror and vendored dependencies, and a hosted runner would fail on
every push. Build and gate locally, then upload the built zip.

## Create the release

1. Open the repository's **Releases** page in the web UI.
2. **Draft a new release**, choose the existing `v<version>` tag, and title it
   `Guazzo v<version>`.
3. Attach both files from `release/<version>/`:
   - `Guazzo-v<version>.zip`
   - `Guazzo-v<version>.zip.sha256`
4. Do not upload the bare exe separately; it is inside the zip, and the zip
   hash is the download identity.
5. Publish. Then add the public URL to `README.md` in a documentation-only
   commit; do not bump the version for that change.

## Verify the uploaded asset

Download the published zip once and check it against the local copy:

```bash
sha256sum Guazzo-v<version>.zip
cat Guazzo-v<version>.zip.sha256
```

The two hashes must match. Extract the zip and run
`sha256sum -c SHA256SUMS.txt` inside the extracted folder.

## Leak audit

Run these before the first push. They are read-only:

```bash
git grep -n -I -E 'C:\\\\Users|C:/Users|/Users/|/home/' -- . ':!vendor' ':!src-tauri/gen'
git grep -n -I -E '(api[_-]?key|secret|password|Bearer [A-Za-z0-9._-]{10,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' -- . ':!vendor' ':!src-tauri/gen'
git ls-files '*.log' '*.tmp'
git check-ignore release dist Guazzo-v1.0.0.exe foo.dll foo.guazzo.json desktop-build-receipt.json
```

The first three commands must print nothing. The last command must print every
path (they are ignored). Never commit a release folder, a build receipt, a
project file, or an exe.
