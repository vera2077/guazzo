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

#[tauri::command]
fn write_bytes(path: String, base64: String) -> Result<u64, String> {
    let data = decode_b64(&base64)?;
    std::fs::write(&path, &data).map_err(|e| format!("could not write {path}: {e}"))?;
    Ok(data.len() as u64)
}

#[tauri::command]
fn read_bytes(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    Ok(base64_encode(&data))
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

fn main() {
    #[cfg(windows)]
    std::panic::set_hook(Box::new(|info| {
        show_fatal_dialog(&info.to_string());
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![write_bytes, read_bytes])
        .setup(|app| {
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("Guazzo")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0);
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let data_dir = std::path::PathBuf::from(local)
                    .join("Guazzo")
                    .join("WebView2");
                builder = builder.data_directory(data_dir);
            }
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Guazzo");
}
