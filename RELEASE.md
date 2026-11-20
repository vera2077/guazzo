# Releasing Guazzo

The order is fixed:

**commit → gate → tag → release, tag last.**

1. Commit the release tree. `git status --porcelain` must be empty.
2. Run the gate un-piped: `node scripts/ci.mjs`.
3. Tag the exact commit: `git tag v<version>`.
4. Stage the artifact: `node scripts/release.mjs`, then label the two binaries Medium as it prints.

`release.mjs` resolves `refs/tags/v<version>^{commit}` before it creates the staging directory. It refuses when the tag is missing or names a different commit, and prints the exact `git tag -f ...` command to fix it. The manifest records `HEAD`, so a release cannot name a commit the tag does not cover.

`--allow-dirty` remains an escape hatch for a throwaway build; it skips the commit and tag checks and must never be used for a published release.
