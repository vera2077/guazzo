# R7 handover — the docs now say what the history proves

Gate base: `78a1afe (via R5 a2354e7)` — 40 files / 393 tests


Branch: `refactor/docs-truth`
Base: `a2354e7` (R5, `refactor/coupling-plan`)
Commit: `e1076d7` "R7: the rewrite docs say what the history proves, not what a rebuild printed"
Stack order: merge **R5 first** — this branch is based on it and carries `docs/REWRITE.md`.

## What was wrong

`REWRITE-LOG.md` (retired tree) reported 766,620 bytes at step 3 while the
artifact on disk was 772,900 bytes, and its row 0 called the tree a copy of
v0.61.0 while its HEAD was 0.62.1. The byte column measured `app-bundle.js`, a
gitignored build output, so it could drift on any rebuild and prove nothing.
`REWRITE.md` called steps 1-3 "pending" after they had landed and pointed step 2
at a `src/ui/menubar.ts` that never existed.

## What changed

- **`docs/REWRITE-LOG.md` (new).** The unit is `src/main.ts`: line count and
  sha256 at `b4ea560` / `fa69ded` / `5a78a29` / `b16e421`, plus the module added
  at each step (213/232/189 lines). Every hash is reproducible with
  `git show <commit>:src/main.ts | sha256sum`; no generated artifact is
  measured. The old log's false row and byte column are called out as false.
- **`docs/REWRITE.md`.** The Status column is replaced by an *Evidence (commit)*
  column. "Done" is now defined mechanically — `git merge-base --is-ancestor
  <commit> main` — so a row cannot say "pending" for a commit that is merged,
  and does not need editing at merge time. Step 2 names R0.2 + R3, matching what
  is actually on which branch; step 4 is still "next"; 5-8 have no commit.
- **`src/main.ts` / `src/ui/dialogs.ts`.** The comment
  `/** dialogs in open order; only the top one reacts to Escape/Enter */` sat
  above `let checkerPattern` in the view-transform code (N14). It now sits above
  `const modalStack` in `src/ui/dialogs.ts`, where it is true.
- **`BUILDER-BRIEF.md`.** N14 also claimed this file had stale Save-As and
  dialog-refusal passages. It does not — those were in the archived
  `guazzo-next/BUILDER-BRIEF.md`. What the app copy *is*: a 0.26.0 rename brief
  ("currently named Pigment, version 0.26.0") whose premise is long finished.
  Instead of rewriting ~300 lines of historical rename instructions, it gets a
  status banner: historical, the rename landed, current contract in `README.md`,
  rewrite plan in `docs/REWRITE.md`.

## Evidence

```
✔ CI green in 8.9s — 40 test files / 393 tests, pins, smoke, deterministic single-file build
```

(`docs/REWRITE.md` and `REWRITE-LOG.md` are prose; the code change is one moved
comment, so the gate result is the whole risk surface.)

## Merge notes

- Based on R5, not on `main`: merge `refactor/coupling-plan` first, then this.
- Does not touch `scripts/`, `src/ui/keymap.ts`, or the extracted modules except
  the dialogs comment.
- Owner's uncommitted files are untouched (this worktree was separate).
