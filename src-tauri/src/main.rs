// Guazzo desktop shell — a single window wrapping the fully-offline editor.
// The frontend is the embedded self-contained build (desktop-dist/index.html);
// no network access exists anywhere in this app.
//
// The window is created HERE instead of tauri.conf.json so we can pin the
// WebView2 user-data folder to %LOCALAPPDATA%\Guazzo\WebView2. The default
// (identifier-based %LOCALAPPDATA%\com.guazzo.editor) broke when the app was
// once launched elevated: the admin run created that folder with
// Administrators ownership, and every normal unelevated launch since failed
// WebView2 init with 0x800700AA and exited silently. A fixed, separate
// location keeps unelevated launches working even if a default folder is ever
// poisoned, and config-file data_directory is unusable for this because
// Tauri only accepts RELATIVE paths there.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_runtime::ResizeDirection;
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;
use std::sync::atomic::{AtomicBool, Ordering};

// A GUI-subsystem app has no console: a bare panic exits with no visible
// effect ("double-click did nothing"). Show fatal errors in a dialog instead.
#[cfg(windows)]
fn show_info_dialog(title: &str, message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: usize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }
    let mut text: Vec<u16> = message.encode_utf16().collect();
    text.push(0);
    let mut caption: Vec<u16> = title.encode_utf16().collect();
    caption.push(0);
    // MB_ICONINFORMATION | MB_SETFOREGROUND
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x40 | 0x0001_0000) };
}

#[cfg(windows)]
fn show_fatal_dialog(message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: usize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }
    let mut text: Vec<u16> = message.encode_utf16().collect();
    text.push(0);
    let mut caption: Vec<u16> = "Guazzo - fatal error".encode_utf16().collect();
    caption.push(0);
    // MB_ICONERROR | MB_SETFOREGROUND
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10 | 0x0001_0000) };
}

// ---- native file I/O ---------------------------------------------------
// The picker comes from tauri-plugin-dialog; the bytes move through these two
// commands so no filesystem plugin (and no extra permission surface) is needed.
// Binary travels as base64 because Tauri IPC is JSON: a 5 MB PNG as a JSON
// number array would cost ~20 MB of parsing on a save.

/// base64 decoder (standard alphabet, padding optional). Avoids a dependency
/// for the single job of getting bytes out of an IPC string.
fn decode_b64(text: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in text.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' {
            continue;
        }
        let v = val(c).ok_or_else(|| format!("invalid base64 byte: {c}"))?;
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

/// Z3: ceiling on everything that crosses the IPC boundary. base64 expands by
/// 4/3 and decode holds another copy, so 512 MB of file is already ~1.4 GB of
/// peak process memory — past that the honest answer is "use a smaller file".
const MAX_IO_BYTES: usize = 512 * 1024 * 1024;

/// P4.3: the page's import cap is 256 MB (`MAX_IMPORT_BYTES`). Checking it here,
/// before `fs::read`, avoids reading, base64-ing and IPC-ing bytes that the page
/// would discard anyway.
// The page accepts up to 256 MB (docmeta MAX_IMPORT_BYTES) and a 512-tile
// project is ~179 MB of base64. 128 MB refused files the app itself saves
// (sec-r12 #5).
const MAX_OPEN_BYTES: usize = 256 * 1024 * 1024;

/// AG1: a save target belongs to the document that asked for it. Rust mints an
/// opaque handle when the user picks a file and remembers the path under it; the
/// page can only present a handle it already holds, so one document can never
/// overwrite another's file — and an export (which asks for no handle) can never
/// become a save target at all.
static SAVED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, std::path::PathBuf>>> =
    std::sync::OnceLock::new();
static NEXT_HANDLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// A session-scoped capability, not a secret: it only has to be unpredictable
/// enough that page script cannot guess another document's handle. Sequential
/// ids from 1 made "save over whatever handle N owns" a one-line guess, so the
/// value is mixed from the process's random hasher seed and the clock.
fn new_handle() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(NEXT_HANDLE.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    h.write_u128(now);
    h.finish()
}

/// AG3: the size a base64 payload can carry. Checked on the string, so the
/// decoded copy is never the thing that discovers the file was too big.
fn check_encoded_ceiling(encoded_len: usize) -> Result<(), String> {
    if encoded_len > MAX_IO_BYTES / 3 * 4 + 16 {
        return Err(format!(
            "file is too large ({} MB, limit {} MB)",
            (encoded_len / 4 * 3) / (1024 * 1024),
            MAX_IO_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// AK3: what the page is allowed to know about a saved file.
#[derive(serde::Serialize)]
struct SaveTarget {
    handle: u64,
    name: String,
}

/// The display name of a path — the only part of it that may cross IPC.
fn label_of(path: &std::path::Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled".into())
}

fn saved_slots() -> &'static std::sync::Mutex<std::collections::HashMap<u64, std::path::PathBuf>> {
    SAVED.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[derive(serde::Serialize)]
struct OpenedFile {
    name: String,
    base64: String,
}

/// AB1: a save must never leave a half-written document behind. Write a sibling
/// temp file, flush it to disk, then rename over the target — rename is atomic
/// on NTFS, so the target is either the old file or the complete new one.
fn write_atomic(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    // AU4: a file NAME, never a path. These strings reach the page, and the page
    // has no business knowing where the user keeps anything.
    let shown = label_of(path);
    // A predictable `<target>.guazzo-tmp` can be pre-created as a link by
    // another process in the folder (sec-r19 F1), so the name carries a random
    // suffix and `create_new` refuses anything that already exists.
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.guazzo-tmp", random_hex()));
    let tmp = std::path::PathBuf::from(tmp);
    // Every failure below removes the temp file: a half-written sibling left
    // behind is how a "failed" save quietly keeps 60 MB on disk.
    let fail = |what: &str, e: &std::io::Error| -> String {
        let _ = std::fs::remove_file(&tmp);
        format!("could not {what} {shown}: {e}")
    };
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| fail("create", &e))?;
        f.write_all(data).map_err(|e| fail("write", &e))?;
        f.sync_all().map_err(|e| fail("flush", &e))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| fail("replace", &e))
}

/// The page proposes a name; only its last component is allowed to reach the
/// dialog, so `..\\..\\Startup\\evil.lnk` cannot pre-fill a path (sec-r18 #4).
/// 16 random hex digits, mixed from the process's hasher seed and the clock.
fn random_hex() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("{:016x}", h.finish())
}

fn safe_file_name(name: &str) -> &str {
    std::path::Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty() && !s.starts_with('.'))
        .unwrap_or("Untitled")
}

/// Z2/AK3: no command takes a path, so the bytes only go where the user just
/// clicked. What crosses IPC is a file NAME and an opaque handle — never a
/// path, in either direction. (The comments here used to claim the same thing
/// while `open_file` returned `path.display()` inside its error strings; that
/// leaked the absolute path and is fixed below.)
#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    name: String,
    ext: String,
    base64: String,
    remember: bool,
) -> Result<Option<SaveTarget>, String> {
    // AG3: refuse on the ENCODED length, before allocating the decoded copy.
    // base64 is 4/3 of the payload, so this bounds peak memory to ~1.34x the cap
    // instead of letting a 2 GB string decode first and measuring afterwards.
    check_encoded_ceiling(base64.len())?;
    let data = decode_b64(&base64)?;
    let picked = app
        .dialog()
        .file()
        .set_file_name(safe_file_name(&name))
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .blocking_save_file();
    let Some(target) = picked else { return Ok(None) };
    let path = target
        .into_path()
        .map_err(|_| "could not resolve the chosen save location".to_string())?;
    write_atomic(&path, &data)?;
    if !remember {
        // AU1: an export DID write bytes; it just does not claim a save target.
        // Returning None here made "cancelled" and "exported" indistinguishable, so
        // the page could not tell the user which file it had just produced.
        // Handle 0 means "written, not claimable".
        return Ok(Some(SaveTarget {
            handle: 0,
            name: label_of(&path),
        }));
    }
    let handle = new_handle();
    // AK3: the page gets the display name (for the tab title) and an opaque
    // handle; the path stays in Rust.
    let name = label_of(&path);
    saved_slots().lock().unwrap().insert(handle, path);
    Ok(Some(SaveTarget { handle, name }))
}

/// AG1: "save" (as opposed to "save as") overwrites the file THIS document last
/// saved. An unknown handle means the document has never been saved, so the
/// caller falls back to the dialog instead of guessing a target.
#[tauri::command]
fn save_file_again(handle: u64, base64: String) -> Result<bool, String> {
    check_encoded_ceiling(base64.len())?;
    let data = decode_b64(&base64)?;
    let target = saved_slots().lock().unwrap().get(&handle).cloned();
    let Some(path) = target else { return Ok(false) };
    write_atomic(&path, &data)?;
    Ok(true)
}

#[tauri::command]
async fn open_file(
    app: tauri::AppHandle,
    title: String,
    exts: Vec<String>,
) -> Result<Option<OpenedFile>, String> {
    let mut builder = app.dialog().file().set_title(&title);
    let refs: Vec<&str> = exts.iter().map(|e| e.as_str()).collect();
    if !refs.is_empty() {
        builder = builder.add_filter("Supported", &refs);
    }
    let Some(target) = builder.blocking_pick_file() else { return Ok(None) };
    let path = target
        .into_path()
        .map_err(|_| "could not resolve the chosen file".to_string())?;
    // Read through one handle: a file that grows between a separate metadata
    // call and read() used to slip past the 256 MB ceiling. `take` bounds the
    // allocation even when the length changes under us.
    use std::io::Read;
    let file = std::fs::File::open(&path)
        .map_err(|e| format!("could not read {}: {e}", label_of(&path)))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("could not read {}: {e}", label_of(&path)))?;
    if meta.len() > MAX_OPEN_BYTES as u64 {
        return Err(format!(
            "{} is too large ({} MB, limit {} MB)",
            label_of(&path),
            meta.len() / (1024 * 1024),
            MAX_OPEN_BYTES / (1024 * 1024)
        ));
    }
    let mut data = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_OPEN_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|e| format!("could not read {}: {e}", label_of(&path)))?;
    if data.len() > MAX_OPEN_BYTES {
        return Err(format!(
            "{} grew while it was being opened (limit {} MB)",
            label_of(&path),
            MAX_OPEN_BYTES / (1024 * 1024)
        ));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled".into());
    Ok(Some(OpenedFile { name, base64: base64_encode(&data) }))
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ---- frameless window chrome -------------------------------------------
// The window has no OS title bar (decorations off below), so the page draws its
// own strip. These four commands give the webview the native gestures rather
// than reimplementing them: start_dragging keeps Aero snap and window shake,
// and start_resize_dragging keeps live resize smooth (a frameless window loses
// WS_THICKFRAME, so the page supplies the hit areas instead).

#[tauri::command]
fn win_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Returns the NEW maximised state so the button can swap its glyph.
#[tauri::command]
fn win_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let maximised = window.is_maximized().unwrap_or(false);
    if maximised {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(!maximised)
}

#[tauri::command]
fn win_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

/// direction: n, s, e, w, ne, nw, se, sw.
#[tauri::command]
fn win_resize(window: tauri::Window, direction: String) -> Result<(), String> {
    let dir = match direction.as_str() {
        "n" => ResizeDirection::North,
        "s" => ResizeDirection::South,
        "e" => ResizeDirection::East,
        "w" => ResizeDirection::West,
        "ne" => ResizeDirection::NorthEast,
        "nw" => ResizeDirection::NorthWest,
        "se" => ResizeDirection::SouthEast,
        "sw" => ResizeDirection::SouthWest,
        _ => return Ok(()),
    };
    window.start_resize_dragging(dir).map_err(|e| e.to_string())
}

/// set when the OS asked to close (Alt+F4, taskbar, system shutdown)
static CLOSE_REQUESTED: AtomicBool = AtomicBool::new(false);

/// AL1: the page clears the request once it has shown (and resolved) the
/// unsaved-work prompt. Without this a CANCELLED close left the flag true, so
/// the 400 ms poller re-asked forever and every dismissal stacked a new dialog
/// on top of the last one.
#[tauri::command]
fn close_ack() {
    CLOSE_REQUESTED.store(false, Ordering::SeqCst);
}

/// AB2: polled by the page; the page acks (close_ack) once it has decided.
#[tauri::command]
fn close_requested() -> bool {
    // AK3: `load`, not `swap`. The page polls this, and a swap would clear the
    // flag for a second poller (or a reload of the page) before it acted.
    CLOSE_REQUESTED.load(Ordering::SeqCst)
}

/// Close the window. The page calls this only after its own unsaved-work
/// confirmation (`closeWithGuard`), which is the same function Alt+F4 and the
/// taskbar reach through `close_requested`.
///
/// v0.63.2: this used to return early unless a *native* CloseRequested had been
/// intercepted. That check could not do what its comment claimed — code running
/// in the page can set the flag itself, so it never stopped an injected script;
/// it only stopped the app's own caption ✕, which never sets it, and the window
/// stopped closing. The unsaved guard lives in the page, and the page is what
/// CSP protects (script-src 'self' with hashed inline blocks).
#[tauri::command]
fn win_force_close(window: tauri::Window) {
    CLOSE_REQUESTED.store(false, Ordering::SeqCst);
    let _ = window.destroy();
}

fn main() {
    #[cfg(windows)]
    std::panic::set_hook(Box::new(|info| {
        show_fatal_dialog(&info.to_string());
    }));

    // One window, one WebView2 profile. A second launch would fail inside
    // WebView2 with 0x800700AA ("The requested resource is in use") and the
    // panic hook would show that as a stack trace, which reads like a crash.
    // Say what is actually true instead.
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(attrs: usize, initial: i32, name: *const u16) -> usize;
            fn GetLastError() -> u32;
        }
        let mut name: Vec<u16> = "Local\\Guazzo.SingleInstance".encode_utf16().collect();
        name.push(0);
        let handle = unsafe { CreateMutexW(0, 0, name.as_ptr()) };
        if unsafe { GetLastError() } == 183 {
            // ERROR_ALREADY_EXISTS
            show_info_dialog(
                "Guazzo is already running",
                "Guazzo opens one window at a time — switch to the window that is already open.\n\nIf you cannot see it, the previous session did not shut down: end Guazzo in Task Manager and start it again.",
            );
            return;
        }
        // Held for the life of the process; Windows closes it on exit.
        let _guard = handle;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_file,
            save_file_again,
            open_file,
            close_requested,
            win_force_close,
            close_ack,
            win_minimize,
            win_toggle_maximize,
            win_close,
            win_drag,
            win_resize
        ])
        .setup(|app| {
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("Guazzo")
            // frameless: the page draws the title strip and the window buttons
            .decorations(false)
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0)
            // Tauri installs its own drag-drop handler over WebView2's, which
            // means the page never sees a `drop` event for a file dragged in
            // from Explorer — the OS shows the copy cursor (that part is the
            // native handler) and nothing else happens. We route dropped files
            // in the page, by where the pointer let go (canvas vs tab bar), so
            // the native handler must be off for HTML5 drag and drop to reach
            // JavaScript at all.
            .disable_drag_drop_handler();
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let data_dir = std::path::PathBuf::from(local)
                    .join("Guazzo")
                    .join("WebView2");
                builder = builder.data_directory(data_dir);
            }
            let win = builder.build()?;
            // AB2: the frameless ✕ runs the page's own unsaved-work guard, and a
            // native Alt+F4 must go through the same door. So the native close is
            // refused here and the page is told to ask; `win_force_close` is the
            // only command that actually closes once the user has agreed.
            let handle = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    CLOSE_REQUESTED.store(true, Ordering::SeqCst);
                    let _ = handle.emit("guazzo:close-requested", ());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Guazzo");
}

// ---- AK4: tests for the file primitives -------------------------------
//
// These cover the parts that do not need a window: the base64 codec, the atomic
// write, and the handle map's "unknown handle" answer. Run with
// `CARGO_HOME=../.cargo-home cargo test --offline` in src-tauri.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_b64_handles_padding_junk_and_length() {
        // 'Man' has no padding, 'Ma' pads once, 'M' pads twice.
        assert_eq!(decode_b64("TWFu").unwrap(), b"Man".to_vec());
        assert_eq!(decode_b64("TWE=").unwrap(), b"Ma".to_vec());
        assert_eq!(decode_b64("TQ==").unwrap(), b"M".to_vec());
        // Whitespace is skipped, so wrapped payloads decode.
        assert_eq!(decode_b64("TW\nFu").unwrap(), b"Man".to_vec());
        assert_eq!(decode_b64("").unwrap(), Vec::<u8>::new());
        // A byte outside the alphabet is an error, not a silent zero.
        let err = decode_b64("TW*u").unwrap_err();
        assert!(err.starts_with("invalid base64 byte"), "got {err}");
        // Round trip through both halves of the codec.
        let data: Vec<u8> = (0u8..=255).collect();
        assert_eq!(decode_b64(&base64_encode(&data)).unwrap(), data);
    }

    /// The sandbox denies writes to %TEMP% (low-integrity token), so the file
    /// tests use a directory inside `target/`, which this account owns.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::path::Path::new("target").join("test-scratch").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_atomic_replaces_an_existing_file() {
        let dir = scratch("replace");
        let path = dir.join("doc.guazzo.json");
        std::fs::write(&path, b"old").unwrap();
        write_atomic(&path, b"new contents").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new contents".to_vec());
        // No temp file survives a successful write.
        assert!(!dir.join("doc.guazzo.json.guazzo-tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_atomic_write_leaves_no_temp_file() {
        let dir = scratch("failure");
        // A directory is the target: rename over it fails, and the temp file
        // must be cleaned up instead of being left beside the document.
        let target = dir.join("occupied");
        std::fs::create_dir_all(&target).unwrap();
        assert!(write_atomic(&target, b"data").is_err());
        assert!(!dir.join("occupied.guazzo-tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_file_again_refuses_an_unknown_handle() {
        // 0 is never minted (NEXT_HANDLE starts above 0), so this must be false
        // rather than writing anywhere.
        let known = saved_slots().lock().unwrap().contains_key(&u64::MAX);
        assert!(!known, "the test handle must not exist");
        assert!(!save_file_again(u64::MAX, base64_encode(b"x")).unwrap());
    }

    #[test]
    fn the_encoded_ceiling_refuses_before_decoding() {
        assert!(check_encoded_ceiling(16).is_ok());
        let too_big = MAX_IO_BYTES / 3 * 4 + 64;
        let err = check_encoded_ceiling(too_big).unwrap_err();
        assert!(err.contains("too large"), "got {err}");
    }
}
