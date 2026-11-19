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

/// AB3: where the last save went, so Ctrl+S can overwrite it without a dialog.
/// The path still never crosses the IPC boundary — the page only says "again".
static LAST_SAVE: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

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
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".guazzo-tmp");
    let tmp = std::path::PathBuf::from(tmp);
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("could not create {}: {e}", tmp.display()))?;
        f.write_all(data)
            .map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("could not flush {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace {}: {e}", path.display())
    })
}

/// Z2: the webview never names a path. Rust owns the picker, so the bytes it
/// writes can only go where the user just clicked — there is no command an
/// injected script could call with `C:\Windows\…`.
#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    name: String,
    ext: String,
    base64: String,
) -> Result<Option<String>, String> {
    let data = decode_b64(&base64)?;
    if data.len() > MAX_IO_BYTES {
        return Err(format!(
            "file is too large ({} MB, limit {} MB)",
            data.len() / (1024 * 1024),
            MAX_IO_BYTES / (1024 * 1024)
        ));
    }
    let picked = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .blocking_save_file();
    let Some(target) = picked else { return Ok(None) };
    let path = target
        .into_path()
        .map_err(|e| format!("could not resolve the chosen path: {e}"))?;
    write_atomic(&path, &data)?;
    *LAST_SAVE.lock().unwrap() = Some(path.clone());
    Ok(Some(path.display().to_string()))
}

/// AB3: "save" (as opposed to "save as") overwrites the file this session last
/// wrote. Rust keeps the path, so a compromised page still cannot pick one.
#[tauri::command]
fn save_file_again(base64: String) -> Result<Option<String>, String> {
    let data = decode_b64(&base64)?;
    if data.len() > MAX_IO_BYTES {
        return Err(format!("file is too large ({} MB)", data.len() / (1024 * 1024)));
    }
    let target = LAST_SAVE.lock().unwrap().clone();
    let Some(path) = target else { return Ok(None) };
    write_atomic(&path, &data)?;
    Ok(Some(path.display().to_string()))
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
        .map_err(|e| format!("could not resolve the chosen path: {e}"))?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if meta.len() > MAX_IO_BYTES as u64 {
        return Err(format!(
            "{} is too large ({} MB, limit {} MB)",
            path.display(),
            meta.len() / (1024 * 1024),
            MAX_IO_BYTES / (1024 * 1024)
        ));
    }
    let data = std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
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

/// AB2: polled by the page; reading clears it so one request is handled once.
#[tauri::command]
fn close_requested() -> bool {
    CLOSE_REQUESTED.swap(false, Ordering::SeqCst)
}

/// Close only after the page has run its unsaved-work confirmation.
#[tauri::command]
fn win_force_close(window: tauri::Window) {
    let _ = window.destroy();
}

fn main() {
    #[cfg(windows)]
    std::panic::set_hook(Box::new(|info| {
        show_fatal_dialog(&info.to_string());
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_file,
            save_file_again,
            open_file,
            close_requested,
            win_force_close,
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
            .min_inner_size(900.0, 600.0);
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
