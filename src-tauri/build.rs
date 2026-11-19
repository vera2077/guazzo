// Freshness guard: the exe embeds desktop-dist/index.html at compile time, so
// a cargo build against a stale web build would silently ship an old UI (the
// handoff-2 review's "do not trust a shipped exe built from a stale web
// build"). We refuse to compile until the web pipeline has been re-run.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn newest_under(root: &Path, out: &mut Option<(SystemTime, PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            newest_under(&path, out);
        } else if let Ok(meta) = entry.metadata() {
            if let Ok(m) = meta.modified() {
                let better = match out {
                    Some((best, _)) => m > *best,
                    None => true,
                };
                if better {
                    *out = Some((m, path.clone()));
                }
            }
        }
    }
}

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let web_index = manifest.join("../desktop-dist/index.html");
    let index_meta = match fs::metadata(&web_index) {
        Ok(m) => m,
        Err(_) => panic!(
            "desktop-dist/index.html is missing — run `node scripts/build-desktop.mjs` from app/ before cargo build"
        ),
    };
    let index_time = index_meta
        .modified()
        .expect("desktop-dist/index.html has no mtime");

    // vendor/ and package.json feed the bundle too (the banner cross-check reads
    // package.json), and a bare `cargo build` after touching them used to pass.
    for watched in ["../src", "../index.html", "../vendor", "../package.json"] {
        let path = manifest.join(watched);
        let mut newest: Option<(SystemTime, PathBuf)> = None;
        if path.is_dir() {
            newest_under(&path, &mut newest);
        } else if let Ok(meta) = fs::metadata(&path) {
            if let Ok(m) = meta.modified() {
                newest = Some((m, path));
            }
        }
        if let Some((m, p)) = newest {
            if m > index_time {
                panic!(
                    "web build is stale: {} is newer than desktop-dist/index.html — \
                     run `node scripts/build-desktop.mjs` from app/ before cargo build",
                    p.display()
                );
            }
        }
    }

    println!("cargo:rerun-if-changed=../desktop-dist/index.html");
    tauri_build::build()
}
