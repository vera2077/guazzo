# Rewrite log — what actually moved, and the hash of what remained

This replaces the log that lived in `guazzo-next/REWRITE-LOG.md` until R0. That
log had a row 0 ("copy of v0.61.0") for a tree whose HEAD was 0.62.1, and its
step 3 reported 766,620 bytes for a bundle that was 772,900 bytes on disk. Its
byte column measured a generated, gitignored artifact, so it could drift without
anyone noticing.

Here the unit is **`src/main.ts`**: its line count at each step and the sha256
of its exact bytes in that commit. Both are reproducible from the repository —
`git show <commit>:src/main.ts | sha256sum` — and neither can be edited by a
rebuild.

| Step | Commit | `src/main.ts` lines | sha256 of `src/main.ts` | Module added |
| --- | --- | --- | --- | --- |
| base | `b4ea560` | 8,498 | `2dd12fa2ec13ebe4bd7a7aef4774184a9ae971d6ec0dcfc5a3bba26269f9a819` | — |
| R0.1 dialogs | `fa69ded` | 8,310 | `1acaca832b9b2552b3bfeed1dce133ae78755004e56fbfb6dbae05c0863456ab` | `src/ui/dialogs.ts` (213 lines) |
| R0.2 popups | `5a78a29` | 8,104 | `28de2ad09f405043faec05342b766320d8ec8b1bce94d5c06a8714cc4dc78c6c` | `src/ui/popup.ts` (232 lines) |
| R0.3 palette | `b16e421` | 7,945 | `0f50755b6f990ff0eb3a40e5aaf602f8f7be8649ec7871aef427f441e9d06ee5` | `src/ui/palette.ts` (189 lines) |

The three commits are one history: R0.2's parent is R0.1, R0.3's parent is R0.2.
`git log --follow src/ui/dialogs.ts` reaches `fa69ded`; the modules were copied
from the retired mirror byte-for-byte and the shell kept only an import.

After the owner merged `refactor/extract-ui` the branch's numbers changed again
with the owner's own work on the same file (AG/AI commits), so the table stops at
the extraction tip and does not pretend to track `main`. For the current count:

```
wc -l src/main.ts
node scripts/coupling.mjs
```

The log's job is to prove a move happened in the history, not to predict the
size of a file other people are editing.
