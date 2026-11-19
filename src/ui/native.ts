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

function internals(): TauriInternals | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ && typeof w.__TAURI_INTERNALS__.invoke === "function"
    ? w.__TAURI_INTERNALS__
    : null;
}

/** true when running inside the desktop shell (not the browser single-file build) */
export function isTauri(): boolean {
  return internals() !== null;
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
  const api = internals();
  if (!api) return null;
  const filters = [{ name: extension.toUpperCase(), extensions: [extension] }];
  const path = await api.invoke<string | null>("plugin:dialog|save", {
    options: {
      title: `Save ${extension.toUpperCase()}`,
      defaultPath: suggestedName,
      filters,
      canCreateDirectories: true,
    },
  });
  if (!path) return null;
  await api.invoke<number>("write_bytes", { path, base64: toBase64(bytes) });
  return path;
}

/**
 * Show the platform open dialog and read the chosen file.
 * `extensions` filters the picker; pass an empty array for "all files".
 */
export async function openNative(
  extensions: string[],
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const api = internals();
  if (!api) return null;
  const filters = extensions.length
    ? [{ name: extensions.map((e) => e.toUpperCase()).join(" / "), extensions }]
    : undefined;
  const picked = await api.invoke<string | string[] | null>("plugin:dialog|open", {
    options: { title: "Open", multiple: false, directory: false, filters },
  });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return null;
  const base64 = await api.invoke<string>("read_bytes", { path });
  const name = path.split(/[\\/]/).pop() ?? "untitled";
  return { name, bytes: fromBase64(base64) };
}
