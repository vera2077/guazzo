// The modal system, extracted from main.ts (rewrite step 1).
//
// What it owns: the overlay markup, the focus trap, the modal STACK (nested
// dialogs such as About ▸ Licence must not both close on one Escape), and the
// in-app replacements for alert/confirm/prompt — a frameless app must not
// borrow the browser's chrome, and a blocking confirm freezes the paint loop.
//
// What it does NOT own: any knowledge of the document. Callers pass a body
// element and an onOk callback; that is the whole contract.

export interface ModalOptions {
  single?: boolean;
  narrow?: boolean;
  onClose?: () => void;
  okLabel?: string;
  /** "neutral" when OK is the destructive answer (close without saving) */
  okKind?: "neutral";
  onCancel?: () => void;
  /**
   * Called once after the footer exists, so a caller can gate OK on its own
   * fields (Select and Mask disables it for an already-feathered selection).
   * The button and Enter still share `runOk`; a disabled OK refuses both.
   */
  onControls?: (controls: { ok: HTMLButtonElement; cancel: HTMLButtonElement }) => void;
}

/** dialogs in open order; only the top one reacts to Escape/Enter */
const modalStack: HTMLElement[] = [];
let modalCount = 0;

/** True while any dialog (including a custom one) is on screen. */
export function modalOpen(): boolean { return modalCount > 0; }
/** Custom overlays (palette, help panel) must register so shortcuts stay inert. */
export function enterModal(): void { modalCount++; }

/**
 * Register a non-`showModal` surface (the command palette) in the same stack, so
 * a dialog underneath it does not also close on one Escape. `modalCount` alone
 * answered "is a modal open?" but not "which one is on top".
 */
export function enterModalLayer(node: HTMLElement): void {
  modalStack.push(node);
  modalCount++;
}

export function leaveModalLayer(node: HTMLElement): void {
  const at = modalStack.lastIndexOf(node);
  if (at >= 0) modalStack.splice(at, 1);
  modalCount = Math.max(0, modalCount - 1);
}
export function leaveModal(): void { modalCount = Math.max(0, modalCount - 1); }

export function showModal(
  title: string,
  body: HTMLElement,
  /** return false to refuse closing (a form that failed validation) */
  onOk: () => void | false,
  opts?: ModalOptions,
): void {
  // Appended to <body>, not #canvas-host: an absolute overlay inside the canvas
  // column left the panels clickable while a "modal" was open.
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const panel = document.createElement("div");
  panel.className = "modal";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", title);
  const h = document.createElement("h3");
  h.textContent = title;
  panel.appendChild(h);
  panel.appendChild(body);
  const row = document.createElement("div");
  row.className = "foot";
  const cancel = document.createElement("button");
  cancel.className = "btn subtle";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  // ui11: "Close anyway" used to be the accent button — the most inviting
  // control in the most consequential dialog. Destructive answers are neutral.
  ok.className = opts?.okKind === "neutral" ? "btn" : "btn primary";
  ok.textContent = opts?.okLabel ?? "OK";
  // single: dialogs whose only sane action is OK (About) — a Cancel button
  // next to it is noise, the user asked for it to go.
  if (opts?.single) row.append(ok);
  else row.append(cancel, ok);
  if (opts?.narrow) panel.classList.add("narrow");
  panel.appendChild(row);
  opts?.onControls?.({ ok, cancel });
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  modalCount++;
  modalStack.push(overlay);
  // Focus containment (independent analysis, UX finding 1): remember what had
  // focus so closing returns the user where they were, and keep Tab inside the
  // dialog — otherwise Tab walks into the canvas and the panels behind it.
  const opener = document.activeElement as HTMLElement | null;
  // Walk the tree by hand instead of querySelectorAll: the headless UI gate's
  // DOM shim has no selector engine, and this dialog's focus order is just
  // document order of the controls inside the panel.
  const focusables = (): HTMLElement[] => {
    const out: HTMLElement[] = [];
    const walk = (el: HTMLElement) => {
      for (const child of Array.from(el.children) as HTMLElement[]) {
        if (child.hasAttribute("disabled")) continue;
        // A control hidden with display:none cannot take focus, so including it
        // in the tab ring makes forward Tab dead-end on it (the shim's focus()
        // does not model layout, so only a real layout check catches this).
        if (typeof child.getClientRects === "function" && child.getClientRects().length === 0) continue;
        const tag = child.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") out.push(child);
        else if (child.getAttribute("tabindex") !== null && child.getAttribute("tabindex") !== "-1") out.push(child);
        walk(child);
      }
    };
    walk(panel);
    return out;
  };
  const firstField = body.querySelector<HTMLElement>("input, select, textarea, button") ?? focusables()[0];
  firstField?.focus();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const at = modalStack.lastIndexOf(overlay);
    if (at >= 0) modalStack.splice(at, 1);
    overlay.remove();
    modalCount = Math.max(0, modalCount - 1);
    window.removeEventListener("keydown", onKey, true);
    if (opener && opener.isConnected) opener.focus();
    opts?.onClose?.();
  };
  const onKey = (ev: KeyboardEvent) => {
    // nested dialogs (About ▸ Licence) must not both close on one Escape
    if (modalStack[modalStack.length - 1] !== overlay) return;
    // Escape is Cancel. It used to call close() alone, which fires onClose but
    // never onCancel — so `ask()` never settled, `await ask(...)` in the close
    // guard never returned, its `finally` never acked the OS request, and the
    // close latch stayed open for the rest of the session: one Escape on
    // "Unsaved changes" made the window unquittable with the work still in it.
    if (ev.key === "Escape") { ev.stopPropagation(); runCancel(); return; }
    if (ev.key === "Tab") {
      const list = focusables();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      ev.preventDefault();
      const step = ev.shiftKey ? -1 : 1;
      const next = (at < 0 ? (ev.shiftKey ? 0 : -1) : at) + step;
      list[(next + list.length) % list.length]!.focus();
      return;
    }
    if (ev.key === "Enter") {
      // Tag checks, not instanceof: the test DOM installs no HTML*Element
      // constructors, and a gate that only passes in Electron is not a gate.
      const t = ev.target as (HTMLElement & { type?: string }) | null;
      const tag = (t?.tagName ?? "").toUpperCase();
      if (tag === "TEXTAREA" || tag === "BUTTON") return;
      // ui11: Enter on a <select> or a slider belongs to that control. Treating
      // it as OK made Enter in Export's format list export the file.
      if (tag === "SELECT") return;
      if (tag === "INPUT" && (t?.type === "range" || t?.type === "checkbox" || t?.type === "radio")) return;
      ev.preventDefault();

      // The same contract as the OK button (it used to close first and call
      // onOk() second, destroying the validation message with its own DOM).
      runOk();

    }
  };
  // AL2: one OK path. The button and Enter must not be able to disagree about
  // whether a refusal closes the dialog, so both call this and nothing else
  // invokes onOk() (pinned in scripts/pins.mjs).
  const runOk = (): void => {
    if (ok.disabled) return;
    if (onOk() === false) return;
    close();
  };
  window.addEventListener("keydown", onKey, true);
  // One cancel path, exactly like runOk: the button and Escape must not be able
  // to disagree about whether onCancel ran. `single` dialogs have no Cancel.
  const runCancel = (): void => {
    const cb = opts?.onCancel;
    close();
    cb?.();
  };
  if (!opts?.single) cancel.addEventListener("click", runCancel);
  ok.addEventListener("click", runOk);
}

/**
 * One signature for every caller that only forwards showModal. Four hand-copied
 * deps drifted (newdoc/tonal/exportdlg/main adapters): each dropped either the
 * refusal return or the options bag, and a dropped refusal is silent because
 * `() => void` is assignable to `() => void | false`.
 */
export type ShowModal = typeof showModal;

/**
 * In-app replacements for `window.alert` / `window.confirm` (analysis, UX
 * finding: the frameless shell showed a browser-chrome dialog with its own
 * title bar, and a confirm block stops the whole paint loop).
 *
 * `notify` is fire-and-forget — the existing call sites all just report an
 * error and carry on. `ask` returns a promise, so the caller awaits a real
 * decision instead of freezing.
 */
/**
 * A one-field prompt, replacing `window.prompt` for the preset name flows.
 * Resolves to null when cancelled, so `if (!label) return;` keeps working.
 */
export function askPrompt(title: string, message: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.className = "stack";
    const p = document.createElement("p");
    p.className = "label";
    p.style.whiteSpace = "pre-wrap";
    p.textContent = message;
    body.appendChild(p);
    const field = document.createElement("div");
    field.className = "field";
    const input = document.createElement("input");
    input.type = "text";
    input.value = initial;
    field.appendChild(input);
    body.appendChild(field);
    let answered = false;
    showModal(title, body, () => { if (!answered) { answered = true; resolve(input.value); } }, {
      onCancel: () => { if (!answered) { answered = true; resolve(null); } },
    });
    input.focus();
    input.select();
  });
}

export function notify(title: string, message: string, opts?: { narrow?: boolean }): void {
  const body = document.createElement("div");
  body.className = "stack";
  const p = document.createElement("p");
  p.className = "label";
  p.style.whiteSpace = "pre-wrap";
  p.textContent = message;
  body.appendChild(p);
  showModal(title, body, () => { /* nothing to do */ }, { single: true, ...opts });
}

export function ask(
  title: string,
  message: string,
  okLabel = "Continue",
  okKind?: "neutral",
): Promise<boolean> {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.className = "stack";
    const p = document.createElement("p");
    p.className = "label";
    p.style.whiteSpace = "pre-wrap";
    p.textContent = message;
    body.appendChild(p);
    // `answered` guards double-resolution: OK runs onOk, Cancel/Escape run
    // onCancel, and neither may win twice (a promise settles once, but the
    // closure would otherwise call resolve on an already-closed dialog).
    let answered = false;
    showModal(title, body, () => { if (!answered) { answered = true; resolve(true); } }, {
      okLabel,
      okKind,
      onCancel: () => { if (!answered) { answered = true; resolve(false); } },
    });
  });
}


/** A read-only document (licence, notices) in its own scrollable dialog. */
export function showTextDialog(title: string, text: string): void {
  const body = document.createElement("div");
  body.className = "about";
  const pre = document.createElement("pre");
  pre.className = "notices";
  pre.textContent = text;
  body.appendChild(pre);
  showModal(title, body, () => {}, { single: true, narrow: true });
}
