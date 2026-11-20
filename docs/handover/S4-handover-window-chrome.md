# Step 4 handover — shell chrome mounted by a module

Branch: `refactor/window-chrome`
Base: `e1e9eb7` (main, v0.66.0 AM3)
Commit: `911b766` "Step 4: the window chrome is mounted by src/ui/windowchrome.ts"
Gate (base `e1e9eb7`): `41 test files / 402 tests, 54 pins, smoke, deterministic`


## What moved

`src/main.ts` lost `buildFindButton`, `buildWindowChrome` and its local
`toggleMaximise` (94 lines deleted, 8,280 → 8,196). `src/ui/windowchrome.ts`
(134 lines) now owns:

- the Find button (`.topfind`, opens the palette through `deps.openPalette`);
- the caption buttons (`.winctl`: minimise, maximise/restore, close);
- the caption drag region (`pointerdown` on the host, skipping controls);
- the seven resize grips (`.rs-edge`, appended to `document.body`);
- the maximise↔restore icon swap.

`main.ts` mounts it once:

```ts
mountWindowChrome(topbar, {
  onClose: () => void closeWithGuard(),
  openPalette: () => openCommandPalette(commandEntries()),
});
```

The OS close-request poller (`takeCloseRequest` → `closeWithGuard`) stays in the
shell; it is session logic, not chrome.

## Acceptance, measured

| # | Check | Result |
| --- | --- | --- |
| 1 | exports `mountWindowChrome(host: HTMLElement…)` | `export function mountWindowChrome(host: HTMLElement, deps: WindowChromeDeps)` — see deviation |
| 2 | `grep -c "buildWindowChrome" src/main.ts` = 0 | 0 (also `buildFindButton` = 0) |
| 3 | no `src/ui/*.ts` imports `src/main.ts` | held; existing static pin green |
| 4 | gate green on the branch commit, branch `refactor/window-chrome` | `41 files / 402 tests, 54 pins` |
| 5 | a probe that goes red and is reverted | below |

## Deviation: the signature takes dependencies

The handoff asks for `mountWindowChrome(host: HTMLElement)`. The close button
must run the unsaved-changes guard (AB2), and Find must open the palette whose
entries are built from the shell's menus. A one-argument mount could only get
them by calling `windowClose()` directly (losing the guard) or by growing a
setter registry inside the module (the `setCloseAllMenus` pattern R3 removed).
Both are worse than a two-field dependency object, so the signature is
`mountWindowChrome(host, deps)` and this is the one acceptance line that is not
literal. The module never imports the shell, which is the invariant that matters.

The module stays callable outside Tauri — the Find button exists in the browser
build; the caption buttons, drag and grips are gated by `isTauri()` *inside* the
module, so the smoke build still mounts the part it can see.

## Probe

Direct call, i.e. the regression this step exists to prevent:

```
button("win-close", "Close", () => { void windowClose(); }, "danger")
```

with the matching import. Rebuild, then:

```
✖ pin: window chrome is mounted by src/ui/windowchrome.ts
    src/ui/windowchrome.ts calls windowClose directly — the unsaved-changes guard is gone
✖ pin: artifact is not stale            (the revert raced the rebuild)
```

Revert and rebuild → `pins: 54/54 static invariants hold`, gate green.

## H3: the structural pin

`scripts/pins.mjs` gains "window chrome is mounted by src/ui/windowchrome.ts":
module exports the mount, shell no longer defines `buildWindowChrome`, shell
actually calls it, the module does not mention `windowClose`, and it does use
`deps.onClose()` (comments stripped first, same rule as the `onOk` pin).

The handoff's example pin ("no document state at module scope") cannot pass
until step 8, which the plan itself makes a non-goal; adding it today would turn
the gate red for a state the plan says is allowed to exist. The chrome pin is
the step-4 equivalent: it grades ownership of the code that just moved.

## Merge notes

- Based on current `main`; no other branch required.
- Touches `src/main.ts` only where the chrome was; conflicts with R3's branch
  are possible because both edit the top-strip area — merge R3 first.
