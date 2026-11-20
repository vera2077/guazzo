# R5 handover — the rewrite gets a metric and a plan that can fail

Gate base: `78a1afe` — 40 files / 393 tests


**Branch:** `refactor/coupling-plan` (in `app/`)
**Base:** `78a1afe` "AH5: the accelerator table is the contract (ui/keymap.ts, bidirectional test)"
**Commit:** `a2354e7` "R5: measure the rewrite by coupling, not by lines"
**Merge check:** `git -C app merge-tree --write-tree main refactor/coupling-plan` at `78a1afe` → clean (exit 0).

## Why this replaces the old plan

`guazzo-next/REWRITE.md` measured progress in **lines moved**, so R0's 555-line
extraction read as progress while the shell's coupling to document state did not
change at all. Its step 5 ("session container: must reach 115 of 264 functions,
44 %") was the whole rewrite compressed into one commit — and it was the reason
step 4 (chrome, nine injected handles, circular `topbar` import) stayed stuck
behind it.

## The metric

`scripts/coupling.mjs` parses `src/main.ts` with the TypeScript AST (already a
dev dependency) and counts top-level function declarations whose body mentions
`doc, activeLayer, history, flat, flatDirty, selMask, selRect`.

```
coupling: 98/272 top-level functions in src/main.ts touch document state (36%)
  per state: doc=69 activeLayer=44 history=9 flat=8 flatDirty=41 selMask=37 selRect=28
```

`--verbose` lists the 98 names, `--json` is machine-readable. Baseline recorded
at `78a1afe`.

## The gate now enforces it

`scripts/pins.mjs` gains `["rewrite coupling does not grow", …]` with
`COUPLING_BASELINE = 98`: a change that welds one more function to document
state fails the static stage and names the rise. The constant is lowered in the
same commit that moves state out — never raised to make a refactor fit.

Gate at this commit: `✔ CI green in 9.3s — 40 test files / 393 tests, pins,
smoke, deterministic single-file build`.

## The plan (`docs/REWRITE.md`)

Steps 1–3 are recorded as done with the commits that did them (dialogs
`fa69ded`, popups `5a78a29`, palette `b16e421`) and an acceptance that is a grep
rather than a feeling. The remaining rows name the responsibility, the target
module, and a one-line falsifiable acceptance:

- **4 chrome** → `src/ui/windowchrome.ts`, `mountWindowChrome(host)`; unblocked
  by **DOM ownership** — a module owns everything inside the host it is given,
  so it no longer needs the shell's `topbar` or nine handles. Pin: no
  `src/ui/*.ts` imports `src/main.ts`.
- **5 tabs** → `src/ui/tabs.ts`; the eight tab functions are currently at
  `main.ts:3141–3560`; acceptance: they move, main.ts falls ≥ 300 lines,
  coupling ≤ baseline − 6 (the coupled functions in that cluster).
- **6 history/flat** → `src/ui/history.ts` + `src/core/flat.ts`; acceptance:
  `grep -c flatDirty src/main.ts` falls ≥ 15, coupling ≤ previous − 4.
- **7 selection** → `src/core/selection.ts`; acceptance: selMask/selRect
  mentions fall ≥ 20, coupling ≤ previous − 8.
- **8 session container** → explicit **non-goal** until `main.ts < 2,000` lines.

## Notes for the owner

- New file `docs/`, new script `scripts/coupling.mjs`, `scripts/pins.mjs`
  extended; nothing else touched.
- The branch merges cleanly onto `78a1afe`. Your working tree had uncommitted
  changes (`package.json`, `scripts/pins.mjs`, `scripts/single-file.mjs`,
  `src-tauri/Cargo.{toml,lock}`) while this branch was built; they were not
  touched — commit or stash before checking the branch out.
- If you disagree with the numbers in the acceptance column, change the table in
  `docs/REWRITE.md`; the coupling baseline is one constant in `pins.mjs`.
