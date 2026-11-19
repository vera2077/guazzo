// Pigment desktop shell — a single window wrapping the fully-offline editor.
// The frontend is the embedded self-contained build (desktop-dist/index.html);
// no network access exists anywhere in this app.
//
// The window is created HERE instead of tauri.conf.json so we can pin the
// WebView2 user-data folder to %LOCALAPPDATA%\Pigment\WebView2. The default
// (identifier-based %LOCALAPPDATA%\com.pigment.editor) broke when the app was
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
    let mut caption: Vec<u16> = "Pigment - fatal error".encode_utf16().collect();
    caption.push(0);
    // MB_ICONERROR | MB_SETFOREGROUND
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10 | 0x0001_0000) };
}

fn main() {
    #[cfg(windows)]
    std::panic::set_hook(Box::new(|info| {
        show_fatal_dialog(&info.to_string());
    }));

    tauri::Builder::default()
        .setup(|app| {
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("Pigment")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0);
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let data_dir = std::path::PathBuf::from(local)
                    .join("Pigment")
                    .join("WebView2");
                builder = builder.data_directory(data_dir);
            }
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pigment");
}
