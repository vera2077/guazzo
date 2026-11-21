# Handover documents

These are working documents from the refactor and feature slices. They describe
the state at the commit named in each file, not the current tree. Use them to
understand why a module exists; use the code and the gate for what it does now.

| Document | Covers |
| --- | --- |
| [`B1-handover-session-history.md`](B1-handover-session-history.md) | Phase B slice 1: the session owns the undo stack and the panel's collapse state. |
| [`B2-handover-flat-cache-wiring.md`](B2-handover-flat-cache-wiring.md) | Wiring the flat composite cache into one owner. |
| [`B3-handover-derived-revision.md`](B3-handover-derived-revision.md) | Derived invalidation, one preview counter, typed snapshots. |
| [`R3-handover-menu-bar.md`](R3-handover-menu-bar.md) | Moving the menu bar into `src/ui/popup.ts`. |
| [`R4-handover-modal-contract.md`](R4-handover-modal-contract.md) | One `showModal` contract and a refusal path that can refuse. |
| [`R5-handover-coupling.md`](R5-handover-coupling.md) | The coupling metric and a refactor plan that can fail. |
| [`R6-handover-behaviour-tests.md`](R6-handover-behaviour-tests.md) | Behavioural tests for the extracted UI modules. |
| [`R7-handover-docs.md`](R7-handover-docs.md) | Making the documentation match the history. |
| [`S4-handover-window-chrome.md`](S4-handover-window-chrome.md) | Mounting shell chrome from a module. |
| [`S5-handover-tabs.md`](S5-handover-tabs.md) | The tab strip and its flush contract. |
| [`S5-scoping-tabs.md`](S5-scoping-tabs.md) | A decision memo on why eight tab functions did not move. |
| [`panel-slice-checklist.md`](panel-slice-checklist.md) | The six acceptance checks for the layer-panel tree slice (v0.71.0). |
