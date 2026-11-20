# R4 handover — one showModal contract, and a refusal that can actually refuse

Gate base: `c93ccd8` — 39 files / 386 tests


**Branch:** `refactor/modal-contract` (in `app/`)
**Base:** `c93ccd8` "AI5: palette rows run their own closure…"
**Commit:** `251333f` "R4: one ShowModal type; a refused OK and Enter keep the dialog open"
**Merge check:** `git -C app merge-tree --write-tree main refactor/modal-contract` at `2d9531a` (v0.63.0) → clean, exit 0.

## What the handoff asked for

R4 (N8/N9): one `showModal` type all adapters forward, and Enter must honour the
refusal contract the OK button already honours.

## What changed

- `src/ui/dialogs.ts`
  - new `export type ShowModal = typeof showModal;`
  - Enter path was `ev.preventDefault(); close(); onOk();`; now it runs
    `if (onOk() === false) return;` before `close()`, matching the OK button.
- `src/ui/newdoc.ts`, `src/ui/tonal.ts`, `src/ui/exportdlg.ts`
  - each dep field is `showModal: ShowModal;` instead of a hand-written copy.
- `src/main.ts` (tonal adapter)
  - `() => { onOk(); tonalPanel.refreshHistogram(); }` →
    `() => { if (onOk() === false) return false; tonalPanel.refreshHistogram(); }`
- `scripts/ui-smoke.mjs` — the New Document block now opens the dialog twice with
  units pinned to px and asserts the contract (see evidence below).

## Two things the tests revealed (both real, both fixed here)

1. **The New Document refusal was unreachable.** `newdoc.ts` validated
   `dimensionsPx()`, i.e. the output of `dimensionsToPixels`, which clamps to
   `1..MAX_DIM` by contract (`src/engine/tests/docmeta.test.ts`, "clamps to
   MAX_DIM and never returns 0"). So `w < 1` and `w > MAX_DIM` could never be
   true: a zero width silently created a 1×1 document. The dialog now computes
   `rawPixels()` from the raw fields (`unitToPx`) for validation, then creates
   the document from those validated values.
2. **`dialogs.ts` Enter duplicated the pre-v0.62.1 OK bug.** It closed the
   dialog before running `onOk`, so a refused callback lost its error line with
   its own DOM. Fixed as above.

## Evidence

- `node scripts/ci.mjs` in the branch: `✔ CI green in 4.8s — 39 test files / 386
  tests, pins, smoke, deterministic single-file build`.
- Smoke (New Document):
  - opens with units `px`, `64 × 64`, fires **Enter at the window shim** → dialog
    closes and adds exactly one tab. (Firing at the input is not enough: the
    shim's `El.fire` bubbles along `parentNode`, so a window-level listener never
    runs. This assertion is what proves the right handler is under test.)
  - reopens, sets width/height 0, clicks OK → overlay still present,
    `.ndlg-error` non-empty; fires Enter → still present and non-empty; then
    64 × 64 OK closes it and adds one more tab.
  - The dialog inherits the last preset (Letter = inches); 64 there would be
    19,200 px > MAX_DIM, hence the explicit `px` pin.
- Probes (reverted immediately after):
  - `close(); onOk();` instead of the refusal check → exit 1,
    `SMOKE FAIL: a refused Enter must keep the New dialog open too`.
  - Before the `rawPixels` fix, a zero-width OK closed the dialog and created a
    tab — the assertion `a refused OK must keep the New dialog open` failed.

## The part of R4's acceptance that TypeScript cannot give you

The handoff said "reverting `newdoc.ts` to `() => void` fails tsc". It does not,
and no dep typing can make it: a probe compiled with this repo's tsc (`--strict`)
shows both `const lossy: Lossy = real` and `const strict: Strict = lossyFn`
compile, as does `const cb: () => void | false = cbVoid`. TypeScript deliberately
treats a `void`-returning function as assignable in both directions. So the type
consolidation is documentation and adapter correctness; the enforceable guard is
the behavioural smoke assertion above. The report to the owner should say this
plainly rather than claim a compile-time refusal gate that does not exist.

## Merge notes for the owner

- The branch is one commit on `c93ccd8`; it merges cleanly onto `2d9531a`
  (v0.63.0) via `merge-tree`.
- Your working tree had uncommitted edits (`package.json`, `scripts/pins.mjs`,
  `scripts/single-file.mjs`, `src-tauri/Cargo.{toml,lock}`) while this branch was
  built; none were touched. Commit or stash before checking the branch out.
- R6's `dispatchKey` extraction can build directly on this branch: the Enter/OK
  contract it tests is now the same code path.
