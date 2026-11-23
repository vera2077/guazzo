//! Guazzo Setup.
//!
//! One binary, three roles: installer window, `--silent` installer for scripts,
//! and `--uninstall` (it copies itself into the install folder under the name
//! `uninstall.exe`, so Apps & Features has something to run).
//!
//! Everything here is written against user32/gdi32/shell32/comctl32 directly.
//! An installer that needs a package manager to build is an installer that can
//! stop building; the payload is embedded, so this file is the whole program.

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

const MAGIC: &[u8; 4] = b"GZP1";
const PAYLOAD: &[u8] = include_bytes!("../assets/payload.bin");
const VERSION: &str = match option_env!("GUAZZO_SETUP_VERSION") {
    Some(v) => v,
    None => "0.0.0",
};

// ---------------------------------------------------------------------------
// Win32 bindings, kept to the smallest set this program actually calls.
// ---------------------------------------------------------------------------

type Hwnd = isize;
type Hinstance = isize;
type Hfont = isize;

const WS_CHILD: u32 = 0x4000_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_CAPTION: u32 = 0x00C0_0000;
const WS_SYSMENU: u32 = 0x0008_0000;
const WS_MINIMIZEBOX: u32 = 0x0002_0000;
const WS_BORDER: u32 = 0x0080_0000;
const WS_TABSTOP: u32 = 0x0001_0000;
const WS_DISABLED: u32 = 0x0800_0000;
const ES_AUTOHSCROLL: u32 = 0x0080;
const ES_MULTILINE: u32 = 0x0004;
const ES_READONLY: u32 = 0x0800;
const ES_AUTOVSCROLL: u32 = 0x0040;
const WS_VSCROLL: u32 = 0x0020_0000;

const WM_CREATE: u32 = 0x0001;
const WM_DESTROY: u32 = 0x0002;
const WM_CLOSE: u32 = 0x0010;
const WM_COMMAND: u32 = 0x0111;
const WM_SETFONT: u32 = 0x0030;
const WM_CTLCOLORSTATIC: u32 = 0x0138;
const WM_APP_PROGRESS: u32 = 0x8001;
const WM_APP_DONE: u32 = 0x8002;

const PBM_SETPOS: u32 = 0x0402;

const SW_HIDE: i32 = 0;
const SW_SHOW: i32 = 5;

const DEFAULT_GUI_FONT: i32 = 17;
const COLOR_WINDOW_PLUS_ONE: isize = 6;

const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;

const BIF_RETURNONLYFSDIRS: u32 = 0x0001;
const BIF_EDITBOX: u32 = 0x0010;
const BIF_NEWDIALOGSTYLE: u32 = 0x0040;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[repr(C)]
struct WndClassW {
    style: u32,
    lpfn_wnd_proc: Option<unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: Hinstance,
    h_icon: isize,
    h_cursor: isize,
    hbr_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct Msg {
    hwnd: Hwnd,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt: Point,
}

#[repr(C)]
struct BrowseInfoW {
    hwnd_owner: Hwnd,
    pidl_root: *mut std::ffi::c_void,
    display_name: *mut u16,
    title: *const u16,
    flags: u32,
    lpfn: Option<unsafe extern "system" fn(Hwnd, u32, isize, isize) -> i32>,
    lparam: isize,
    image: i32,
}

#[repr(C)]
struct InitCommonControlsEx {
    size: u32,
    icc: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Hinstance;
    fn GetLastError() -> u32;
}

#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(class: *const WndClassW) -> u16;
    fn CreateWindowExW(
        ex_style: u32,
        class: *const u16,
        window: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: Hwnd,
        menu: isize,
        instance: Hinstance,
        param: isize,
    ) -> Hwnd;
    fn DefWindowProcW(hwnd: Hwnd, msg: u32, w: usize, l: isize) -> isize;
    fn GetMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32) -> i32;
    fn TranslateMessage(msg: *const Msg) -> i32;
    fn DispatchMessageW(msg: *const Msg) -> isize;
    fn PostMessageW(hwnd: Hwnd, msg: u32, w: usize, l: isize) -> i32;
    fn SendMessageW(hwnd: Hwnd, msg: u32, w: usize, l: isize) -> isize;
    fn DestroyWindow(hwnd: Hwnd) -> i32;
    fn PostQuitMessage(code: i32);
    fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
    fn UpdateWindow(hwnd: Hwnd) -> i32;
    fn EnableWindow(hwnd: Hwnd, enable: i32) -> i32;
    fn SetWindowTextW(hwnd: Hwnd, text: *const u16) -> i32;
    fn GetWindowTextW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
    fn SetFocus(hwnd: Hwnd) -> Hwnd;
    fn GetSystemMetrics(index: i32) -> i32;
    fn MessageBoxW(hwnd: Hwnd, text: *const u16, caption: *const u16, utype: u32) -> i32;
    fn SetBkMode(hdc: isize, mode: i32) -> i32;
    fn SetTextColor(hdc: isize, color: u32) -> u32;
    fn LoadCursorW(instance: isize, name: isize) -> isize;
}

#[link(name = "gdi32")]
extern "system" {
    fn GetStockObject(index: i32) -> isize;
    fn CreateFontW(
        height: i32,
        width: i32,
        escapement: i32,
        orientation: i32,
        weight: i32,
        italic: u32,
        underline: u32,
        strike: u32,
        charset: u32,
        out_precision: u32,
        clip_precision: u32,
        quality: u32,
        pitch: u32,
        face: *const u16,
    ) -> Hfont;
}

#[link(name = "comctl32")]
extern "system" {
    fn InitCommonControlsEx(init: *const InitCommonControlsEx) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    fn SHBrowseForFolderW(info: *const BrowseInfoW) -> *mut std::ffi::c_void;
    fn SHGetPathFromIDListW(pidl: *const std::ffi::c_void, path: *mut u16) -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *mut std::ffi::c_void, coinit: u32) -> i32;
    fn CoTaskMemFree(ptr: *mut std::ffi::c_void);
}

/// UTF-16 for every Win32 call. A trailing NUL is included; the Vec must stay
/// alive for the duration of the call (which is why callers bind it first).
fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}


/// Absolute path to a Windows system tool. Spawning `reg` or `powershell` by
/// bare name lets a planted `reg.exe` in the install or working directory run
/// with Setup's privileges (sec-r18 #3); the system copy is not negotiable.
fn system32(name: &str) -> PathBuf {
    // %SystemRoot% is inherited from the parent process and can be pointed
    // anywhere; the API returns the directory Windows itself uses.
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetSystemDirectoryW(buffer: *mut u16, length: u32) -> u32;
        }
        let mut buf = [0u16; 260];
        // SAFETY: buf is a valid, exclusively-borrowed 260-wide buffer.
        let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) };
        if n > 0 && (n as usize) < buf.len() {
            let text = String::from_utf16_lossy(&buf[..n as usize]);
            return PathBuf::from(text).join(name);
        }
    }
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    root.join("System32").join(name)
}

/// A folder "is under" a root only when the next character is a separator:
/// `C:\Users\melodi2` starts with `C:\Users\melodi` but is not inside it.
fn under_root(root: &str, text: &str) -> bool {
    let mut root = root.trim_end_matches('\\').to_string();
    if root.is_empty() {
        return false;
    }
    root.push('\\');
    text.starts_with(&root)
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// Parse the generated payload: `GZP1`, u32 count, then per file
/// `u16 name length, name, u32 byte length, bytes`.
fn files() -> Vec<(String, &'static [u8])> {
    let mut out = Vec::new();
    if PAYLOAD.len() < 8 || &PAYLOAD[0..4] != MAGIC {
        return out;
    }
    let count = u32::from_le_bytes([PAYLOAD[4], PAYLOAD[5], PAYLOAD[6], PAYLOAD[7]]) as usize;
    let mut at = 8usize;
    for _ in 0..count {
        if at + 2 > PAYLOAD.len() {
            break;
        }
        let nlen = u16::from_le_bytes([PAYLOAD[at], PAYLOAD[at + 1]]) as usize;
        at += 2;
        if at + nlen + 4 > PAYLOAD.len() {
            break;
        }
        let name = String::from_utf8_lossy(&PAYLOAD[at..at + nlen]).to_string();
        at += nlen;
        let len =
            u32::from_le_bytes([PAYLOAD[at], PAYLOAD[at + 1], PAYLOAD[at + 2], PAYLOAD[at + 3]])
                as usize;
        at += 4;
        if at + len > PAYLOAD.len() {
            break;
        }
        out.push((name, &PAYLOAD[at..at + len]));
        at += len;
    }
    out
}

// ---------------------------------------------------------------------------
// Paths, versions, install detection
// ---------------------------------------------------------------------------

fn local_appdata() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn default_dir() -> PathBuf {
    local_appdata().join("Programs").join("Guazzo")
}

fn shortcut_path() -> Option<PathBuf> {
    env::var_os("APPDATA").map(|a| {
        PathBuf::from(a)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Guazzo.lnk")
    })
}

/// The folder the previous install went to, read from the Apps & Features
/// entry. An upgrade must find the copy that exists, not guess the default.
fn installed_location() -> Option<PathBuf> {
    let out = hidden(Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe")).args([
        "-NoProfile",
        "-Command",
        "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Guazzo' -ErrorAction SilentlyContinue).InstallLocation",
    ]))
    .output()
    .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}

/// The version Setup wrote last time. Absent on installs from before 1.17.4,
/// which is itself information: older.
fn installed_version(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("version.txt")).ok()?;
    let text = text.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn looks_installed(dir: &Path) -> bool {
    dir.join("Guazzo.exe").is_file()
}

/// Can this program create `dir` right now? Used to pick a starting folder on a
/// machine where the default is not writable for the token Setup runs under.
/// Existence is not writability: a folder left by an earlier version, or one
/// created by another account, can be readable and still refuse a new file.
fn probe_dir(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".guazzo-write-test");
    let ok = fs::write(&probe, b"x").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

fn fallback_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(local_appdata().join("Guazzo"));
    if let Some(appdata) = env::var_os("APPDATA") {
        out.push(PathBuf::from(appdata).join("Guazzo"));
    }
    if let Some(home) = env::var_os("USERPROFILE") {
        let home = PathBuf::from(home);
        out.push(home.join("Guazzo"));
        out.push(home.join("Documents").join("Guazzo"));
    }
    if let Ok(me) = env::current_exe() {
        if let Some(here) = me.parent() {
            out.push(here.join("Guazzo"));
        }
    }
    out
}

/// A folder Setup will write into, as a policy rather than a permission test.
///
/// `--dir` is user input and this process runs with the user's rights, so a
/// mistyped or scripted path can point at a place Windows starts programs from
/// (a Startup folder) or at the system directory. Those writes would succeed
/// and then run next sign-in. Installation stays inside the user's own profile
/// or the folder Setup itself was run from; anything else is refused by name.
fn dir_allowed(dir: &Path) -> Result<(), String> {
    for part in dir.components() {
        if matches!(part, std::path::Component::ParentDir | std::path::Component::CurDir) {
            return Err(format!(
                "Refusing to install into {}.\n\nThe folder has a relative step (.) or (..) in it.",
                dir.display()
            ));
        }
    }
    // Resolve what exists, so a junction or a symlinked profile root is judged
    // by where it really points rather than by the string that names it.
    let resolved = if dir.is_dir() {
        fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
    } else {
        dir.parent()
            .and_then(|p| fs::canonicalize(p).ok())
            .map(|p| p.join(dir.file_name().unwrap_or_default()))
            .unwrap_or_else(|| dir.to_path_buf())
    };
    // canonicalize() returns a \\?\C:\... verbatim path on Windows; the
    // prefix is not part of the location and would defeat every comparison.
    let text = resolved
        .to_string_lossy()
        .replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .to_lowercase();
    let forbidden = ["\\windows\\system32", "\\windows\\syswow64", "\\startup\\"];
    for part in forbidden {
        if text.contains(part) || text.ends_with(part.trim_end_matches('\\')) {
            return Err(format!(
                "Refusing to install into {}.\n\nThat folder is used by Windows to start programs.",
                dir.display()
            ));
        }
    }
    let roots = ["LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP"];
    for name in roots {
        if let Some(root) = env::var_os(name) {
            let root = root.to_string_lossy().replace('/', "\\").to_lowercase();
            if under_root(&root, &text) {
                return Ok(());
            }
        }
    }
    // The folder Setup is running from is also allowed: a portable download
    // that cannot write its default location installs beside itself.
    if let Ok(me) = env::current_exe() {
        if let Some(here) = me.parent() {
            let here = here.to_string_lossy().replace('/', "\\").to_lowercase();
            if under_root(&here, &text) {
                return Ok(());
            }
        }
    }
    Err(format!(
        "Refusing to install into {}.\n\nGuazzo installs inside your user profile. \
         Choose a folder under %LOCALAPPDATA% or beside Setup.",
        dir.display()
    ))
}

/// The preferred folder if it can really take a file, else the first fallback
/// that can. Existence alone is not enough: a folder left by an earlier version
/// or protected by a security tool can be listed and still refuse writes.
fn first_writable(preferred: &Path) -> Option<PathBuf> {
    if probe_dir(preferred) {
        return Some(preferred.to_path_buf());
    }
    for candidate in fallback_dirs() {
        if candidate == preferred {
            continue;
        }
        if dir_allowed(&candidate).is_err() {
            continue;
        }
        if probe_dir(&candidate) {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Shortcut, registry, uninstall registration
// ---------------------------------------------------------------------------

fn make_shortcut(dir: &Path) -> Result<(), String> {
    let Some(lnk) = shortcut_path() else {
        return Ok(());
    };
    let target = dir.join("Guazzo.exe");
    // Paths travel in the environment. `ps_quote` doubled only the ASCII
    // apostrophe, but PowerShell also treats U+2018/U+2019/U+201A/U+201B as
    // quote characters, so a folder name could close the literal and append a
    // statement. Environment variables are not parsed as script text.
    let script = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:GUAZZO_LNK); \
         $s.TargetPath=$env:GUAZZO_TGT; $s.WorkingDirectory=$env:GUAZZO_WD; \
         $s.IconLocation=$env:GUAZZO_ICO; $s.Save()";
    let out = hidden(Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe")).args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]))
    .env("GUAZZO_LNK", &lnk)
    .env("GUAZZO_TGT", &target)
    .env("GUAZZO_WD", dir)
    .env("GUAZZO_ICO", format!("{},0", target.display()))
    .output()
    .map_err(|e| format!("could not run PowerShell: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

fn reg(args: &[&OsStr]) -> bool {
    // Quiet: a machine policy may forbid the write, and a console window
    // flashing an error at somebody who double-clicked Setup is worse than a
    // silent best-effort. The uninstaller tolerates a missing key.
    hidden(Command::new(system32("reg.exe")).args(args))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn register_uninstall(dir: &Path) {
    const KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Guazzo";
    let exe = dir.join("Guazzo.exe");
    let uninstall = dir.join("uninstall.exe");
    let uninstall_cmd = format!("\"{}\" --uninstall", uninstall.display());
    let quiet_cmd = format!("\"{}\" --uninstall --silent", uninstall.display());
    let icon = format!("{},0", exe.display());
    let pairs: [(&str, &str); 8] = [
        ("DisplayName", "Guazzo"),
        ("DisplayVersion", VERSION),
        ("Publisher", "Vera"),
        ("InstallLocation", &dir.display().to_string()),
        ("DisplayIcon", &icon),
        ("UninstallString", &uninstall_cmd),
        ("QuietUninstallString", &quiet_cmd),
        ("InstallDate", ""),
    ];
    for (name, value) in pairs {
        if name == "InstallDate" {
            continue;
        }
        reg(&[
            OsStr::new("add"),
            OsStr::new(KEY),
            OsStr::new("/v"),
            OsStr::new(name),
            OsStr::new("/t"),
            OsStr::new("REG_SZ"),
            OsStr::new("/d"),
            OsStr::new(value),
            OsStr::new("/f"),
        ]);
    }
    for flag in ["NoModify", "NoRepair"] {
        reg(&[
            OsStr::new("add"),
            OsStr::new(KEY),
            OsStr::new("/v"),
            OsStr::new(flag),
            OsStr::new("/t"),
            OsStr::new("REG_DWORD"),
            OsStr::new("/d"),
            OsStr::new("1"),
            OsStr::new("/f"),
        ]);
    }
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

/// The only names Setup itself puts in the install folder. A folder containing
/// anything else is somebody else's, and Setup must not delete it.
const PAYLOAD_NAMES: [&str; 7] = [
    "Guazzo.exe",
    "WebView2Loader.dll",
    "app-single.html",
    "LICENSE",
    "README.txt",
    "THIRD-PARTY-NOTICES.md",
    "version.txt",
];

fn holds_only_our_install(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "uninstall.exe" || PAYLOAD_NAMES.contains(&name.as_str()) {
            continue;
        }
        return false;
    }
    true
}

fn log_failure(dir: &Path, message: &str) -> Option<PathBuf> {
    let body = format!(
        "Guazzo {VERSION} setup\ntarget: {}\nversion: {}\n\n{}\n",
        dir.display(),
        VERSION,
        message
    );
    // Beside the setup file first: that is the folder the user can open, and
    // the temp folder is not always writable (locked-down or redirected).
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(parent) = env::current_exe()
        .ok()
        .and_then(|p| fs::canonicalize(p).ok())
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        candidates.push(parent.join("guazzo-setup.log"));
    }
    candidates.push(env::temp_dir().join("guazzo-setup.log"));
    for path in candidates {
        if fs::write(&path, &body).is_ok() {
            return Some(path);
        }
    }
    None
}

/// Create the install folder, and survive the two states Windows reports as
/// "access denied" but which are not permissions at all: a folder removed
/// seconds ago that is still pending delete, and a folder left by an earlier
/// install whose files Setup is replacing.
fn ensure_dir(dir: &Path) -> Result<(), String> {
    if dir.is_dir() {
        // Existing is not the same as safe to write into: --dir is user input,
        // and "install into D:\Apps" must not overwrite the files already
        // there. An earlier Guazzo install is the one exception.
        let empty = fs::read_dir(dir).map(|mut r| r.next().is_none()).unwrap_or(false);
        if empty || is_our_install(dir) {
            return Ok(());
        }
        return Err(format!(
            "{} is not empty and does not look like a Guazzo install.\n\n             Setup will not overwrite files it did not write. Choose an empty\n             folder with Change…, or remove that folder first if it is an old copy.",
            dir.display()
        ));
    }
    if dir.exists() {
        return Err(format!(
            "{} exists but is not a folder. Move it aside and run Setup again.",
            dir.display()
        ));
    }
    let mut last = String::new();
    for _ in 0..20 {
        match fs::create_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        if dir.is_dir() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    // A stale install is the one failure the retry cannot fix by waiting.
    if dir.is_dir() && holds_only_our_install(dir) {
        // Delete our files, never the folder: `holds_only_our_install` is a
        // name check, so a user's tree whose subfolders happen to use payload
        // names must not be recursively removed (sec-r11 #5).
        for name in PAYLOAD_NAMES {
            let _ = fs::remove_file(dir.join(name));
        }
        let _ = fs::remove_file(dir.join("uninstall.exe"));
        if fs::create_dir_all(dir).is_ok() {
            return Ok(());
        }
    }
    Err(format!(
        "could not create {}: {last}\n\n\
         Windows says this when the folder is still being deleted, when an old\n\
         copy of Guazzo is still running, or when that folder is read-only.\n\
         Close Guazzo. If the folder exists and cannot be written to — some\n\
         folder-redirection and sandbox tools do this — choose another folder\n\
         with Change…",
        dir.display()
    ))
}

fn post_progress(hwnd: Option<Hwnd>, done: usize, total: usize) {
    let Some(hwnd) = hwnd else { return };
    let pct = if total == 0 {
        100
    } else {
        ((done as f64 / total as f64) * 100.0).round() as usize
    };
    let pct = pct.min(100);
    unsafe {
        PostMessageW(hwnd, WM_APP_PROGRESS, pct, 0);
    }
}

/// Sixteen hex characters from the clock and the pid. Setup has no crate for
/// randomness and does not need cryptographic quality: the point is that an
/// attacker cannot predict or pre-create the temp name.
fn random_hex() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut x = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    let mut out = String::with_capacity(16);
    for _ in 0..16 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.push(char::from_digit((x & 0xf) as u32, 16).unwrap_or('0'));
    }
    out
}

/// A sibling temp path that nobody can pre-create: the fixed `<name>.new`
/// names were follow-able, so a planted link made Setup truncate another file.
fn temp_sibling(final_path: &Path) -> PathBuf {
    let name = final_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    final_path.with_file_name(format!(".{name}.{}.new", random_hex()))
}

fn write_chunked(
    path: &Path,
    bytes: &[u8],
    hwnd: Option<Hwnd>,
    done: &mut usize,
    total: usize,
) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| {
        format!(
            "could not write {}\n\n{e}\n\nIf Guazzo is running, close it and run Setup again.",
            path.display()
        )
    })?;
    for chunk in bytes.chunks(256 * 1024) {
        file.write_all(chunk)
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
        *done += chunk.len();
        post_progress(hwnd, *done, total);
    }
    Ok(())
}

fn install(dir: &Path, shortcuts: bool, hwnd: Option<Hwnd>) -> Result<Vec<String>, String> {
    let list = files();
    if list.is_empty() {
        return Err("the setup payload is missing or damaged".into());
    }
    ensure_dir(dir)?;
    let me = env::current_exe().map_err(|e| format!("could not locate this program: {e}"))?;
    let me_size = fs::metadata(&me).map(|m| m.len() as usize).unwrap_or(0);
    let total = list.iter().map(|(_, b)| b.len()).sum::<usize>() + me_size;
    let mut done = 0usize;
    // Stage first, rename after: a failure part-way used to leave a folder with
    // a new exe and an old page, which is worse than no install at all.
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (name, bytes) in &list {
        let final_path = path_of(dir, name);
        let temp = temp_sibling(&final_path);
        if let Err(e) = write_chunked(&temp, bytes, hwnd, &mut done, total) {
            for (t, _) in &staged { let _ = fs::remove_file(t); }
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
        staged.push((temp, final_path));
    }
    // Copy ourselves in as the uninstaller: one binary, two roles, and no second
    // download for the user to keep track of.
    for (temp, final_path) in &staged {
        if let Err(e) = fs::rename(temp, final_path) {
            for (t, _) in &staged { let _ = fs::remove_file(t); }
            return Err(format!("could not finish writing {}: {e}", final_path.display()));
        }
    }
    let uninstaller = dir.join("uninstall.exe");
    if me != uninstaller {
        let temp_un = temp_sibling(&uninstaller);
        if let Err(e) = fs::copy(&me, &temp_un) {
            return Err(format!("could not write the uninstaller: {e}"));
        }
        fs::rename(&temp_un, &uninstaller).map_err(|e| format!("could not finish writing the uninstaller: {e}"))?;
        done += me_size;
        post_progress(hwnd, done, total);
    }
    let version_path = dir.join("version.txt");
    let version_temp = temp_sibling(&version_path);
    if let Ok(mut vf) = fs::OpenOptions::new().write(true).create_new(true).open(&version_temp) {
        if vf.write_all(VERSION.as_bytes()).is_ok() {
            let _ = fs::rename(&version_temp, &version_path);
        } else {
            let _ = fs::remove_file(&version_temp);
        }
    }
    post_progress(hwnd, total, total);

    // A missing shortcut is a warning, not a failed install: the files are in
    // place and Apps & Features knows about them, so the user can still start
    // Guazzo from the install folder and remove it properly.
    let mut warnings = Vec::new();
    if shortcuts {
        if let Err(message) = make_shortcut(dir) {
            warnings.push(format!(
                "The Start-menu shortcut could not be created ({message}). Start Guazzo from\n{}",
                dir.display()
            ));
        }
    }
    register_uninstall(dir);
    Ok(warnings)
}

fn path_of(dir: &Path, name: &str) -> PathBuf {
    dir.join(name)
}

/** A folder is ours only if the pieces we always install are both present.
 *  Anything else — a typo in --dir, a wrapper forwarding args, Setup.exe run
 *  from Downloads — must not turn `--uninstall` into "delete that folder". */
fn is_our_install(dir: &Path) -> bool {
    // Builds before 1.17.4 wrote no version.txt, and the Update path offers to
    // upgrade exactly those folders — so the exe and the page identify a
    // legacy install by themselves (sec-r16 #1). The version file, when it
    // exists, must still parse.
    let legacy = dir.join("Guazzo.exe").is_file() && dir.join("app-single.html").is_file();
    if !dir.join("version.txt").exists() {
        return legacy;
    }
    // Three signals, because two file names is not "this is our folder":
    // the exe, the page, and a version file that parses as a version.
    let version_ok = fs::read_to_string(dir.join("version.txt"))
        .map(|v| {
            let v = v.trim();
            // "1..3" passes a bare `all(is_ascii_digit)` because an empty
            // segment is vacuously all-digits — and this is the only guard
            // before --uninstall deletes files (sec-r14 L3).
            // A prerelease ("1.18.0-beta.1") is a version the release scripts
            // build; only the numeric core is checked (sec-r15 #2).
            v.split('-').next().unwrap_or("").split('.').count() == 3
                && v.split('-').next().unwrap_or("").split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        })
        .unwrap_or(false);
    dir.join("Guazzo.exe").is_file() && dir.join("app-single.html").is_file() && version_ok
}

/// Windows paths are case-insensitive and can be spelled with either separator,
/// so `PathBuf == PathBuf` is the wrong question to ask of a registry value.
fn same_dir(a: &Path, b: &Path) -> bool {
    let ca = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca.to_string_lossy().eq_ignore_ascii_case(&cb.to_string_lossy())
}

fn uninstall(dir: &Path) {
    // Only a folder that is actually registered may remove the shortcut and
    // the Apps & Features entry: `--uninstall --dir <someone else's folder>`
    // used to unregister a real install while deleting a stranger's files.
    let registered = installed_location()
        .map(|p| same_dir(&p, dir))
        .unwrap_or(false);
    if registered {
        if let Some(lnk) = shortcut_path() {
            let _ = fs::remove_file(lnk);
        }
        let _ = hidden(Command::new(system32("reg.exe")).args([
            "delete",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Guazzo",
            "/f",
        ]))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    }
    // Delete the files Setup wrote, and nothing else. The old loop removed
    // every entry in the folder, which contradicted "Your documents are
    // untouched" the moment somebody kept a file there.
    for name in PAYLOAD_NAMES {
        let _ = fs::remove_file(dir.join(name));
    }
    // The uninstaller is still running and cannot delete itself, so a hidden
    // PowerShell waits for this process to exit and then removes the file and
    // the folder. `ping`/`timeout` were tried first and both are unreliable
    // here: ping needs a network stack and timeout needs a console.
    let me = env::current_exe().unwrap_or_else(|_| dir.join("uninstall.exe"));
    // Only ever delete paths inside the folder being removed. Running setup from
    // a downloads folder with --uninstall must not delete the downloaded file.
    let inside = me.starts_with(dir);
    // Inside: this is the installed uninstaller, so remove it and then the
    // folder. Outside: Setup was run from Downloads, and the folder is the
    // only thing to remove — the downloaded exe is the user's file.
    // Not -Recurse: the folder may still hold a file the user put there, and
    // "Your documents are untouched" has to survive uninstall too. A folder
    // that is empty after our files go disappears; one that is not stays.
    if !inside {
        let _ = fs::remove_file(dir.join("uninstall.exe"));
    }
    let script = if inside {
        "Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:GUAZZO_ME -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $env:GUAZZO_DIR -Force -ErrorAction SilentlyContinue"
    } else {
        "Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:GUAZZO_DIR -Force -ErrorAction SilentlyContinue"
    };
    let _ = hidden(Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe")).args([
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        script,
    ]))
    .env("GUAZZO_ME", &me)
    .env("GUAZZO_DIR", dir)
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn();
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Choose,
    Installing,
    Done,
    Error,
}

struct Ui {
    hwnd: Hwnd,
    title: Hwnd,
    subtitle: Hwnd,
    path_label: Hwnd,
    path_edit: Hwnd,
    browse: Hwnd,
    note: Hwnd,
    status: Hwnd,
    progress: Hwnd,
    error: Hwnd,
    done: Hwnd,
    done_path: Hwnd,
    primary: Hwnd,
    cancel: Hwnd,
    dir: String,
    note_text: String,
    shortcuts: bool,
    stage: Stage,
    installing: bool,
}

static UI: Mutex<Option<Ui>> = Mutex::new(None);
static DONE_HWND: AtomicIsize = AtomicIsize::new(0);
static INSTALLING: AtomicBool = AtomicBool::new(false);
static RESULT: Mutex<Option<Result<Vec<String>, String>>> = Mutex::new(None);

const ID_PRIMARY: usize = 101;
const ID_CANCEL: usize = 102;
const ID_BROWSE: usize = 103;

fn lock_ui() -> std::sync::MutexGuard<'static, Option<Ui>> {
    UI.lock().unwrap_or_else(|e| e.into_inner())
}

/// Take the UI state out of the shared slot, run `f` with the mutex unlocked,
/// then put it back. Windows sends notifications (EN_CHANGE, WM_COMMAND) while
/// a control is being updated, and those notifications re-enter the window
/// procedure. Holding a non-reentrant mutex across `SetWindowTextW` therefore
/// deadlocks the UI thread; a nested call finds the slot empty and does nothing.
fn with_ui<R>(f: impl FnOnce(&mut Ui) -> R) -> Option<R> {
    let mut ui = lock_ui().take()?;
    let out = f(&mut ui);
    *lock_ui() = Some(ui);
    Some(out)
}

unsafe fn child(
    parent: Hwnd,
    class: &str,
    text: &str,
    style: u32,
    x: i32,
    y: i32,
    cw: i32,
    ch: i32,
    font: isize,
    id: usize,
) -> Hwnd {
    let class = w(class);
    let text = w(text);
    let hwnd = CreateWindowExW(
        0,
        class.as_ptr(),
        text.as_ptr(),
        WS_CHILD | WS_VISIBLE | style,
        x,
        y,
        cw,
        ch,
        parent,
        id as isize,
        GetModuleHandleW(std::ptr::null()),
        0,
    );
    SendMessageW(hwnd, WM_SETFONT, font as usize, 1);
    hwnd
}

unsafe fn set_text(hwnd: Hwnd, text: &str) {
    let text = w(text);
    SetWindowTextW(hwnd, text.as_ptr());
}

unsafe fn visible(hwnd: Hwnd, shown: bool) {
    ShowWindow(hwnd, if shown { SW_SHOW } else { SW_HIDE });
}

unsafe fn enabled(hwnd: Hwnd, on: bool) {
    EnableWindow(hwnd, if on { 1 } else { 0 });
}

unsafe fn build_children(hwnd: Hwnd) -> Ui {
    let instance = GetModuleHandleW(std::ptr::null());
    let seg = w("Segoe UI");
    let body_font = CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, 5, 0, seg.as_ptr());
    let small_font = CreateFontW(-13, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, 5, 0, seg.as_ptr());
    let title_font = CreateFontW(-26, 0, 0, 0, 600, 0, 0, 0, 1, 4, 0, 5, 0, seg.as_ptr());
    let gui = body_font;
    let symbol = w("Segoe UI Symbol");
    let big_font = CreateFontW(-34, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, 5, 0, symbol.as_ptr());

    let title = child(hwnd, "STATIC", &format!("Guazzo {VERSION}"), 0, 28, 22, 526, 36, title_font, 0);
    let subtitle = child(hwnd, "STATIC", "", 0, 28, 62, 526, 52, gui, 0);
    let path_label = child(hwnd, "STATIC", "Install folder", 0, 28, 122, 526, 18, gui, 0);
    let path_edit = child(
        hwnd,
        "EDIT",
        "",
        WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL,
        28,
        142,
        416,
        28,
        gui,
        0,
    );
    let browse = child(hwnd, "BUTTON", "Change…", WS_TABSTOP, 452, 142, 102, 28, gui, ID_BROWSE);
    let note = child(hwnd, "STATIC", "", 0, 28, 176, 526, 54, small_font, 0);
    let status = child(hwnd, "STATIC", "Installing…", 0, 28, 208, 526, 20, gui, 0);
    let progress = child(hwnd, "msctls_progress32", "", WS_BORDER, 28, 232, 526, 18, gui, 0);
    let error = child(
        hwnd,
        "EDIT",
        "",
        WS_BORDER | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
        28,
        74,
        526,
        176,
        small_font,
        0,
    );
    let done = child(hwnd, "STATIC", "", 0, 28, 92, 526, 44, big_font, 0);
    DONE_HWND.store(done, Ordering::SeqCst);
    let done_path = child(hwnd, "STATIC", "", 0, 28, 146, 526, 64, small_font, 0);
    let primary = child(hwnd, "BUTTON", "Install", WS_BORDER | WS_TABSTOP, 330, 288, 224, 34, gui, ID_PRIMARY);
    let cancel = child(hwnd, "BUTTON", "Cancel", WS_BORDER | WS_TABSTOP, 236, 288, 86, 34, gui, ID_CANCEL);

    let _ = instance;
    Ui {
        hwnd,
        title,
        subtitle,
        path_label,
        path_edit,
        browse,
        note,
        status,
        progress,
        error,
        done,
        done_path,
        primary,
        cancel,
        dir: String::new(),
        note_text: String::new(),
        shortcuts: true,
        stage: Stage::Choose,
        installing: false,
    }
}

unsafe fn refresh_choose(ui: &mut Ui) {
    let dir = PathBuf::from(&ui.dir);
    let version = installed_version(&dir);
    let marker = looks_installed(&dir);
    let (subtitle, button) = match (&version, marker) {
        (Some(v), _) if *v == VERSION => (
            format!(
                "Guazzo {VERSION} is already installed in this folder. Reinstalling replaces every \
                 file with a fresh copy. Your documents are untouched."
            ),
            "Reinstall",
        ),
        (Some(v), _) => (
            format!(
                "Guazzo {v} is installed in this folder. This will update it to {VERSION}. Your \
                 documents are untouched."
            ),
            "Update",
        ),
        (None, true) => (
            format!(
                "An older copy of Guazzo is installed in this folder. This will update it to \
                 {VERSION}."
            ),
            "Update",
        ),
        (None, false) => (
            format!(
                "Guazzo will be installed in the folder below. It needs no administrator rights \
                 and leaves the rest of Windows alone."
            ),
            "Install",
        ),
    };
    set_text(ui.subtitle, &subtitle);
    set_text(ui.primary, button);
    let mut note = ui.note_text.clone();
    if !note.is_empty() {
        note.push_str("\n\n");
    }
    note.push_str("To remove Guazzo later, use Settings ▸ Apps.");
    set_text(ui.note, &note);
    let path = w(&ui.dir);
    SetWindowTextW(ui.path_edit, path.as_ptr());
}

unsafe fn show_stage(ui: &mut Ui, stage: Stage) {
    ui.stage = stage;
    match stage {
        Stage::Choose => {
            visible(ui.title, true);
            visible(ui.subtitle, true);
            visible(ui.path_label, true);
            visible(ui.path_edit, true);
            visible(ui.browse, true);
            visible(ui.note, true);
            visible(ui.status, false);
            visible(ui.progress, false);
            visible(ui.error, false);
            visible(ui.done, false);
            visible(ui.done_path, false);
            visible(ui.primary, true);
            visible(ui.cancel, true);
            enabled(ui.primary, true);
            enabled(ui.browse, true);
            enabled(ui.path_edit, true);
            set_text(ui.cancel, "Cancel");
            refresh_choose(ui);
            SetFocus(ui.primary);
        }
        Stage::Installing => {
            visible(ui.title, true);
            visible(ui.subtitle, false);
            visible(ui.path_label, false);
            visible(ui.path_edit, false);
            visible(ui.browse, false);
            visible(ui.note, false);
            visible(ui.status, true);
            visible(ui.progress, true);
            visible(ui.error, false);
            visible(ui.done, false);
            visible(ui.done_path, false);
            visible(ui.primary, false);
            visible(ui.cancel, true);
            enabled(ui.cancel, false);
            set_text(ui.status, "Installing…");
            SendMessageW(ui.progress, PBM_SETPOS, 0, 0);
        }
        Stage::Done => {
            visible(ui.title, false);
            visible(ui.subtitle, false);
            visible(ui.path_label, false);
            visible(ui.path_edit, false);
            visible(ui.browse, false);
            visible(ui.note, false);
            visible(ui.status, false);
            visible(ui.progress, false);
            visible(ui.error, false);
            visible(ui.done, true);
            visible(ui.done_path, true);
            visible(ui.primary, true);
            visible(ui.cancel, true);
            enabled(ui.primary, true);
            enabled(ui.cancel, true);
            set_text(ui.primary, "Run Guazzo");
            set_text(ui.cancel, "Close");
            SetFocus(ui.primary);
        }
        Stage::Error => {
            visible(ui.title, true);
            visible(ui.subtitle, false);
            visible(ui.path_label, false);
            visible(ui.path_edit, false);
            visible(ui.browse, false);
            visible(ui.note, false);
            visible(ui.status, false);
            visible(ui.progress, false);
            visible(ui.error, true);
            visible(ui.done, false);
            visible(ui.done_path, false);
            visible(ui.primary, true);
            visible(ui.cancel, true);
            enabled(ui.primary, true);
            enabled(ui.cancel, true);
            set_text(ui.primary, "Try again");
            set_text(ui.cancel, "Close");
            SetFocus(ui.primary);
        }
    }
}

fn read_path_edit(ui: &Ui) -> String {
    let mut buf = [0u16; 1024];
    unsafe {
        let len = GetWindowTextW(ui.path_edit, buf.as_mut_ptr(), buf.len() as i32);
        if len <= 0 {
            return String::new();
        }
        from_wide(&buf[..len as usize])
    }
}

fn start_install(ui: &mut Ui) {
    if ui.installing {
        return;
    }
    let chosen = read_path_edit(ui);
    if !chosen.trim().is_empty() {
        ui.dir = chosen.trim().to_string();
    }
    let mut dir = ui.dir.clone();
    if !probe_dir(Path::new(&dir)) {
        match first_writable(Path::new(&dir)) {
            Some(alt) => {
                dir = alt.display().to_string();
                ui.dir = dir.clone();
                ui.note_text = format!(
                    "Windows would not let Setup write to that folder. Installing to {} instead.",
                    dir
                );
                unsafe {
                    set_text(ui.path_edit, &dir);
                    refresh_choose(ui);
                }
            }
            None => {
                ui.note_text = String::new();
                unsafe {
                    set_text(
                        ui.error,
                        "Setup cannot write to that folder, and none of the usual folders\n                         would accept a file either.\n\nUse Change... to pick a folder you can write to,\n                         for example one you make in your Documents folder, then press Install again.",
                    );
                    show_stage(ui, Stage::Error);
                }
                return;
            }
        }
    }
    let shortcuts = ui.shortcuts;
    let hwnd = ui.hwnd;
    ui.installing = true;
    INSTALLING.store(true, Ordering::SeqCst);
    unsafe { show_stage(ui, Stage::Installing) };
    std::thread::spawn(move || {
        let outcome = install(Path::new(&dir), shortcuts, Some(hwnd));
        if let Err(message) = &outcome {
            log_failure(Path::new(&dir), message);
        }
        *RESULT.lock().unwrap_or_else(|e| e.into_inner()) = Some(outcome);
        unsafe {
            PostMessageW(hwnd, WM_APP_DONE, 0, 0);
        }
    });
}

fn finish_install() {
    let outcome = RESULT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    with_ui(|ui| {
    ui.installing = false;
    INSTALLING.store(false, Ordering::SeqCst);
    match outcome {
        Some(Ok(warnings)) => {
            let dir = ui.dir.clone();
            unsafe {
                SendMessageW(ui.progress, PBM_SETPOS, 100, 0);
                set_text(ui.done, &format!("✔  Guazzo {VERSION} is installed"));
                let mut text = format!("{}\n\nTo remove it later, use Settings ▸ Apps.", dir);
                for warning in &warnings {
                    text.push_str("\n\n");
                    text.push_str(warning);
                }
                set_text(ui.done_path, &text);
                show_stage(ui, Stage::Done);
            }
        }
        Some(Err(message)) => unsafe {
            let mut text = message;
            if let Some(log) = log_failure(Path::new(&ui.dir), &text) {
                text.push_str(&format!("\n\nA copy of this message is in\n{}", log.display()));
            }
            set_text(ui.error, &text);
            show_stage(ui, Stage::Error);
        },
        None => {
            unsafe {
                set_text(ui.error, "Setup lost track of the installation. Try again.");
                show_stage(ui, Stage::Error);
            }
        }
    }
    });
}

fn browse_for_folder(owner: Hwnd) -> Option<String> {
    unsafe {
        let title = w("Choose where to install Guazzo");
        let mut display = [0u16; 260];
        let info = BrowseInfoW {
            hwnd_owner: owner,
            pidl_root: std::ptr::null_mut(),
            display_name: display.as_mut_ptr(),
            title: title.as_ptr(),
            flags: BIF_RETURNONLYFSDIRS | BIF_EDITBOX | BIF_NEWDIALOGSTYLE,
            lpfn: None,
            lparam: 0,
            image: 0,
        };
        let pidl = SHBrowseForFolderW(&info);
        if pidl.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let ok = SHGetPathFromIDListW(pidl, buf.as_mut_ptr());
        CoTaskMemFree(pidl);
        if ok == 0 {
            return None;
        }
        Some(from_wide(&buf))
    }
}

fn on_command(id: usize) {
    with_ui(|ui| match (id, ui.stage) {
        (ID_PRIMARY, Stage::Choose) => start_install(ui),
        (ID_PRIMARY, Stage::Error) => unsafe { show_stage(ui, Stage::Choose) },
        (ID_PRIMARY, Stage::Done) => {
            let exe = PathBuf::from(&ui.dir).join("Guazzo.exe");
            let _ = Command::new(&exe).spawn();
            unsafe { DestroyWindow(ui.hwnd) };
        }
        (ID_CANCEL, Stage::Installing) => {}
        (ID_CANCEL, _) => unsafe { DestroyWindow(ui.hwnd); },
        (ID_BROWSE, Stage::Choose) => {
            let hwnd = ui.hwnd;
            if let Some(folder) = browse_for_folder(hwnd) {
                ui.dir = folder;
                unsafe { refresh_choose(ui) };
            }
        }
        _ => {}
    });
}

unsafe fn set_progress(pct: usize) {
    with_ui(|ui| {
        if ui.stage != Stage::Installing {
            return;
        }
        SendMessageW(ui.progress, PBM_SETPOS, pct.min(100), 0);
        set_text(ui.status, &format!("Installing… {pct}%"));
    });
}

unsafe extern "system" fn wnd_proc(hwnd: Hwnd, msg: u32, w: usize, l: isize) -> isize {
    match msg {
        WM_CREATE => {
            let ui = build_children(hwnd);
            *lock_ui() = Some(ui);
            0
        }
        WM_COMMAND => {
            let id = w & 0xffff;
            on_command(id);
            0
        }
        WM_APP_PROGRESS => {
            unsafe { set_progress(w) };
            0
        }
        WM_APP_DONE => {
            finish_install();
            0
        }
        WM_CTLCOLORSTATIC => {
            if DONE_HWND.load(Ordering::SeqCst) == l as isize {
                SetTextColor(w as isize, 0x003C_7A10);
            }
            SetBkMode(w as isize, 1);
            GetStockObject(0) as isize
        }
        WM_CLOSE => {
            let installing = INSTALLING.load(Ordering::SeqCst);
            if !installing {
                unsafe { DestroyWindow(hwnd) };
            }
            0
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, w, l) },
    }
}

fn run_window(dir: String, shortcuts: bool, note: String) -> i32 {
    unsafe {
        let _ = CoInitializeEx(std::ptr::null_mut(), 2);
        let mut icc = InitCommonControlsEx {
            size: std::mem::size_of::<InitCommonControlsEx>() as u32,
            icc: 0x0000_0020,
        };
        InitCommonControlsEx(&mut icc);

        let instance = GetModuleHandleW(std::ptr::null());
        let class_name = w("GuazzoSetupWindow");
        let cursor = LoadCursorW(0, 32512); // IDC_ARROW
        let class = WndClassW {
            style: 0x0003,
            lpfn_wnd_proc: Some(wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: instance,
            h_icon: 0,
            h_cursor: cursor,
            hbr_background: COLOR_WINDOW_PLUS_ONE,
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class_name.as_ptr(),
        };
        RegisterClassW(&class);
        let title = w(&format!("Guazzo {VERSION} Setup"));
        let width = 598;
        let height = 372;
        let x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - height) / 2;
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            x,
            y,
            width,
            height,
            0,
            0,
            instance,
            0,
        );
        if hwnd == 0 {
            return 1;
        }
        with_ui(|ui| {
            ui.dir = dir;
            ui.note_text = note;
            ui.shortcuts = shortcuts;
            refresh_choose(ui);
            show_stage(ui, Stage::Choose);
        });
        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);
        let mut msg = Msg {
            hwnd: 0,
            message: 0,
            w_param: 0,
            l_param: 0,
            time: 0,
            pt: Point { x: 0, y: 0 },
        };
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    0
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn win_ask(title: &str, text: &str) -> bool {
    let (t, m) = (w(text), w(title));
    unsafe { MessageBoxW(0, t.as_ptr(), m.as_ptr(), 0x0000_0004 | 0x0000_0020) == 6 }
}

fn win_say(title: &str, text: &str) {
    let (t, m) = (w(text), w(title));
    unsafe {
        MessageBoxW(0, t.as_ptr(), m.as_ptr(), 0x0000_0000 | 0x0000_0040);
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let silent = args.iter().any(|a| a == "--silent" || a == "/S" || a == "/s");
    let do_uninstall = args.iter().any(|a| a == "--uninstall");
    let shortcuts = !args.iter().any(|a| a == "--no-shortcut");
    let explicit = args
        .iter()
        .position(|a| a == "--dir")
        .and_then(|pos| args.get(pos + 1))
        .map(PathBuf::from);

    if let Some(wanted) = &explicit {
        if let Err(why) = dir_allowed(wanted) {
            if let Some(log) = log_failure(wanted, &why) {
                let _ = log;
            }
            if !silent {
                win_say("Guazzo", &why);
            }
            std::process::exit(1);
        }
    }

    if do_uninstall {
        let mut dir = explicit.clone().unwrap_or_default();
        // Without --dir the folder to remove is the one this file is running
        // from, not the default install path: a user who chose a different
        // folder would otherwise leave the installation behind and delete a
        // folder that is not theirs.
        if explicit.is_none() {
            if let Some(parent) = env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf))
            {
                dir = parent;
            }
        }
        if !is_our_install(&dir) {
            // Refuse rather than guess. `--dir` is user input, and without this
            // check `--uninstall --silent --dir <any folder>` deleted every
            // entry in it (install-side guard was never consulted here).
            let message = format!(
                "Refusing to remove {}\n\nThat folder does not look like a Guazzo installation.",
                dir.display()
            );
            if let Some(log) = log_failure(&dir, &message) {
                let _ = log;
            }
            if !silent {
                win_say("Guazzo", &message);
            }
            std::process::exit(1);
        }
        if !silent
            && !win_ask(
                "Remove Guazzo?",
                &format!("Remove Guazzo from\n{}?", dir.display()),
            )
        {
            return;
        }
        uninstall(&dir);
        if !silent {
            win_say("Guazzo", "Guazzo has been removed. Your documents are untouched.");
        }
        return;
    }

    if silent {
        let preferred = explicit.clone().unwrap_or_else(|| {
            installed_location()
                .filter(|p| p.is_dir() && dir_allowed(p).is_ok())
                .unwrap_or_else(default_dir)
        });
        let dir = first_writable(&preferred).unwrap_or(preferred);
        match install(&dir, shortcuts, None) {
            Ok(_) => {}
            Err(mut message) => {
                if let Some(log) = log_failure(&dir, &message) {
                    message.push_str(&format!(
                        "\n\nA copy of this message is in\n{}",
                        log.display()
                    ));
                }
                eprintln!("setup: {message}");
                std::process::exit(1);
            }
        }
        return;
    }

    // Interactive: pick the folder the previous install used, else the default,
    // and step aside if this token cannot write there. A folder-redirection or
    // sandbox tool can make the default read-only for the process that launches
    // Setup even though the same user can write it from Explorer.
    let mut note = String::new();
    let mut dir = if let Some(explicit) = explicit {
        explicit
    } else {
        let preferred = installed_location()
            .filter(|p| p.is_dir() && dir_allowed(p).is_ok())
            .unwrap_or_else(default_dir);
        if probe_dir(&preferred) {
            preferred
        } else {
            let mut chosen = None;
            for candidate in fallback_dirs() {
                if probe_dir(&candidate) {
                    chosen = Some(candidate);
                    break;
                }
            }
            match chosen {
                Some(candidate) => {
                    note = format!(
                        "Windows would not let Setup write to {}\nThis folder will be used instead — you can pick another one.",
                        preferred.display()
                    );
                    candidate
                }
                None => preferred,
            }
        }
    };
    if !dir.is_absolute() {
        dir = env::current_dir().unwrap_or_default().join(dir);
    }
    std::process::exit(run_window(
        dir.display().to_string(),
        shortcuts,
        note,
    ));
}
