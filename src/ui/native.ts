/**
 * native.ts — desktop file I/O.
 *
 * In the Tauri shell the platform's own open/save pickers are used, so saving a
 * document lands on the user's disk where they expect it (the browser build can
 * only ever "download"). Everything here degrades to `null`/`false` outside
 * Tauri, and callers keep their existing browser path — the single-file build
 * must never depend on this module doing anything.
 *
 * The pickers come from tauri-plugin-dialog; the bytes travel through two small
 * Rust commands (`write_bytes` / `read_bytes`) so no filesystem plugin and no
 * extra permission surface is needed. IPC is JSON, so binary is base64 in both
 * directions: a 5 MB PNG as a JSON number array would cost tens of MB to parse.
 */

interface TauriInternals {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}
interface TauriGlobal {
  core?: { invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

/**
 * The IPC bridge, found by two independent routes on purpose: if an upgrade ever
 * renames `__TAURI_INTERNALS__`, `isTauri()` used to return false and the app
 * silently became the *browser* build — Save downloaded instead of saving, no
 * window buttons, no error anywhere. `__TAURI__` is the other documented global.
 */
function bridge(): TauriInternals | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals; __TAURI__?: TauriGlobal };
  const direct = w.__TAURI_INTERNALS__;
  if (direct && typeof direct.invoke === "function") return direct;
  const g = w.__TAURI__;
  const alt = g?.core?.invoke ?? g?.invoke;
  if (typeof alt === "function") return { invoke: alt };
  return null;
}

/** true when running inside the desktop shell (not the browser single-file build) */
export function isTauri(): boolean {
  return bridge() !== null;
}

/**
 * AE5: a shell that has the internals object but no callable invoke is a broken
 * shell, not a browser — say so instead of quietly degrading.
 */
export function shellHealth(): string | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  const looksNative = typeof w.__TAURI_INTERNALS__ !== "undefined" || typeof w.__TAURI__ !== "undefined";
  return looksNative && bridge() === null ? "the desktop bridge is present but has no invoke()" : null;
}

/** 32 KiB chunks: String.fromCharCode(...) over a whole megabyte blows the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Show the platform save dialog and write `bytes` there.
 * Returns the chosen path, or null when the user cancelled / this is a browser.
 * Throws only when the dialog was dismissed by an actual error, so callers can
 * distinguish "user said no" (silent) from "write failed" (report it).
 */
export async function saveNative(
  suggestedName: string,
  extension: string,
  bytes: Uint8Array,
): Promise<string | null> {
  const api = bridge();
  if (!api) return null;
  // Z2: Rust owns the picker, so this command takes no path — it can only write
  // where the user just clicked in the native dialog, never to a path a script
  // named. Returns the saved path, or null when the dialog was cancelled.
  const saved = await api.invoke<string | null>("save_file", {
    name: suggestedName,
    ext: extension,
    base64: toBase64(bytes),
  });
  return saved ?? null;
}

export async function openNative(
  extensions: string[],
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const api = bridge();
  if (!api) return null;
  // Same rule as saveNative: the path never appears in JS. Rust runs the picker,
  // enforces the size ceiling and hands back the bytes.
  const picked = await api.invoke<{ name: string; base64: string } | null>("open_file", {
    title: "Open",
    exts: extensions,
  });
  if (!picked) return null;
  return { name: picked.name, bytes: fromBase64(picked.base64) };
}

export async function windowMinimize(): Promise<void> {
  const t = bridge();
  if (!t) return;
  try { await t.invoke("win_minimize", {}); } catch { /* window is gone */ }
}

export async function windowToggleMaximize(): Promise<boolean> {
  const t = bridge();
  if (!t) return false;
  try { return Boolean(await t.invoke<boolean>("win_toggle_maximize", {})); } catch { return false; }
}

export async function windowClose(): Promise<void> {
  const t = bridge();
  if (!t) return;
  try { await t.invoke("win_close", {}); } catch { /* closing */ }
}

/** Native window drag (also gives Aero snap / shake on Windows). */
export async function windowStartDrag(): Promise<void> {
  const t = bridge();
  if (!t) return;
  try { await t.invoke("win_drag", {}); } catch { /* ignore */ }
}

/** Native resize drag for the frameless window: n, s, e, w, ne, nw, se, sw. */
export async function windowStartResize(direction: string): Promise<void> {
  const t = bridge();
  if (!t) return;
  try { await t.invoke("win_resize", { direction }); } catch { /* ignore */ }
}

/**
 * AB2: the OS close path (Alt+F4, taskbar, shutdown) is refused by Rust so the
 * page can run the same unsaved-work confirmation the ✕ uses. The page polls
 * this: it returns true once per request and clears the flag.
 */
export async function takeCloseRequest(): Promise<boolean> {
  const t = bridge();
  if (!t) return false;
  try { return (await t.invoke<boolean>("close_requested", {})) === true; } catch { return false; }
}

/** Close for real — only after the page has confirmed with the user. */
export async function windowForceClose(): Promise<void> {
  const t = bridge();
  if (!t) return;
  try { await t.invoke("win_force_close", {}); } catch { /* closing */ }
}

/**
 * AB3: overwrite the file this session last saved, without a dialog. Returns
 * false when nothing has been saved yet (the caller then shows the dialog).
 * The path lives in Rust; the page never sees or supplies one.
 */
export async function saveNativeAgain(bytes: Uint8Array): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  const saved = await api.invoke<string | null>("save_file_again", { base64: toBase64(bytes) });
  return typeof saved === "string";
}
