/**
 * closeloop.ts — the one-prompt-at-a-time latch behind the window close (AL1/AM4).
 *
 * The bug this replaces: the native window can ask to close (Alt+F4, taskbar,
 * system shutdown) while the page is *also* running its own unsaved-work prompt
 * from the ✕ button, and the 400 ms poller can fire again before the first
 * prompt is answered. `closeWithGuard` guarded that with a module-level boolean
 * that nothing exercised, so "Keep editing" stacked a second identical dialog on
 * top of the first one.
 *
 * Small enough to unit-test, which is the point of extracting it: the ordering
 * (acquire, ask, release, ack) lives in the caller, the invariant lives here.
 */
export interface CloseLoop {
  /** true when this caller owns the prompt; false when one is already open */
  begin(): boolean;
  /** release the latch, whether the prompt was answered or abandoned */
  end(): void;
  readonly open: boolean;
}

export function createCloseLoop(): CloseLoop {
  let open = false;
  return {
    begin(): boolean {
      if (open) return false;
      open = true;
      return true;
    },
    end(): void {
      open = false;
    },
    get open(): boolean {
      return open;
    },
  };
}
