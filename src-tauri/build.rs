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
    for watched in ["../src", "../index.html", "../vendor", "../package.json", "../LICENSE", "../THIRD-PARTY-NOTICES.md"] {
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
    println!("cargo:rerun-if-changed=app.manifest");

    // MinGW's GCC specs link `default-manifest.o` unconditionally, so the exe would
    // carry two RT_MANIFEST resources and every release printed ".rsrc merge failure:
    // multiple non-default manifests". The loader honours the first (ours), but a
    // duplicate resource is not something to ship and a warning nobody can act on is
    // noise. Shadow the toolchain file with an empty object of the same name ahead of
    // it in the compiler's file search: `%:if-exists(default-manifest.o)` then finds
    // nothing worth adding and exactly one manifest survives.
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        if let Ok(rustc) = std::env::var("RUSTC") {
            let shim = Path::new(&out_dir).join("manifest-shim");
            let _ = fs::create_dir_all(&shim);
            let src = shim.join("empty.rs");
            let obj = shim.join("default-manifest.o");
            fs::write(&src, "// intentionally empty: an object with no resource section\n")
                .expect("write manifest shim source");
            let compiled = std::process::Command::new(&rustc)
                .args(["--crate-type=lib", "--crate-name", "manifest_shim", "--emit=obj"])
                .arg("-O")
                .arg("-o")
                .arg(&obj)
                .arg(&src)
                .status();
            if matches!(compiled, Ok(s) if s.success()) {
                let prefix = shim.display().to_string().replace('\\', "/");
                println!("cargo:rustc-link-arg=-B{prefix}/");
            }
        }
    }

    // One manifest, all of it. tauri-build's default manifest is Common Controls v6
    // only, and rustc's windows-gnu toolchain embeds its own (long path aware,
    // as-invoker) unconditionally, so the two met in the resource directory and the
    // linker kept whichever came first -- the shipped exe had no longPathAware and
    // every release printed ".rsrc merge failure: multiple non-default manifests".
    // Declaring the whole set here means the manifest Windows reads is the one we
    // wrote, and the duplicate can no longer disagree with it about anything.
    let attributes = tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("app.manifest")),
    );
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri-build failed: {error:#}");
    }
}
