# Releasing Guazzo

The order is fixed:

**commit → gate → tag → release, tag last.**

1. Commit the release tree. `git status --porcelain` must be empty.
2. Run the gate un-piped: `node scripts/ci.mjs`.
3. Tag the exact commit: `git tag v<version>`.
4. Stage the artifact: `node scripts/release.mjs`, then label the two binaries Medium as it prints.

`release.mjs` resolves `refs/tags/v<version>^{commit}` before it creates the staging directory. It refuses when the tag is missing or names a different commit, and prints the exact `git tag -f ...` command to fix it. The manifest records `HEAD`, so a release cannot name a commit the tag does not cover.

The HTML artifact is reproducible: rebuilding the same commit produces the same `artifactSha256`, so a rebuild-diff is a valid check on it. The exe is not reproducible — PE/link timestamps change its hash even from identical inputs (`acc401cb…` → `ecef69c2…` for 0.71.0) — so verify `exeSha256` only against `RELEASE.json`, never by rebuilding and comparing hashes.

`--allow-dirty` remains an escape hatch for a throwaway build; it skips the commit and tag checks and must never be used for a published release.
