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
  onCancel?: () => void;
}

const modalStack: HTMLElement[] = [];
let modalCount = 0;

/** True while any dialog (including a custom one) is on screen. */
export function modalOpen(): boolean { return modalCount > 0; }
/** Custom overlays (palette, help panel) must register so shortcuts stay inert. */
export function enterModal(): void { modalCount++; }
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
  ok.className = "btn primary";
  ok.textContent = opts?.okLabel ?? "OK";
  // single: dialogs whose only sane action is OK (About) — a Cancel button
  // next to it is noise, the user asked for it to go.
  if (opts?.single) row.append(ok);
  else row.append(cancel, ok);
  if (opts?.narrow) panel.classList.add("narrow");
  panel.appendChild(row);
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
    if (ev.key === "Escape") { ev.stopPropagation(); close(); return; }
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
      const t = ev.target as HTMLElement | null;
      if (t instanceof HTMLTextAreaElement || t?.tagName === "BUTTON") return;
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
    if (onOk() === false) return;
    close();
  };
  window.addEventListener("keydown", onKey, true);
  if (!opts?.single) cancel.addEventListener("click", () => { const cb = opts?.onCancel; close(); cb?.(); });
  ok.addEventListener("click", runOk);
}

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

export function ask(title: string, message: string, okLabel = "Continue"): Promise<boolean> {
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
