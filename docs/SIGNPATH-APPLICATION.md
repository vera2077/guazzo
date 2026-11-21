# SignPath Foundation — application text

SignPath Foundation signs open-source Windows projects for free, with the
signing key in their HSM. This is the application, written to be pasted into
their form field by field. The project facts are true as of v1.1.1; update the
version and hashes at the top of `docs/releases/` before submitting.

## Project

**Name:** Guazzo

**Repository:** https://github.com/vera2077/guazzo

**Latest release:** https://github.com/vera2077/guazzo/releases/latest

**Licence:** Apache-2.0 (`LICENSE`, `NOTICE`)

**Maintainer:** vera2077 (@vera2077), sole author of all 235 commits

**Language / stack:** TypeScript (browser UI), Rust (Tauri 2 shell), no runtime
dependencies in the artifact

## Form fields (paste these)

The application form asks for four free-text fields and three choices. The
personal ones (name, email) are the applicant's; these are the project's.

**Tagline**

> A fully offline, Photoshop-shaped image editor for Windows: layers, groups, masks, PSD import/export, and a single-file browser build.

**Category:** Graphics

**Description** (a paragraph, no version numbers, no dependency list)

> Guazzo is a desktop image editor for Windows that works entirely offline. It
> provides the layer-based workflow photographers and illustrators expect —
> layers and nested groups, masks, selections, adjustment layers, filters, text
> and vector tools — and reads and writes Photoshop PSD files, so it can sit
> beside Photoshop instead of asking anyone to abandon it. The same source also
> compiles to a single self-contained HTML file, so the editor runs in a browser
> with no installation, no account and no network access. It is written by one
> maintainer, released under Apache-2.0, and ships as a portable executable with
> no installer, no telemetry and no auto-update.

**Build system:** GitHub Actions (`.github/workflows/ci.yml` for the gate,
`.github/workflows/release.yml` for the release and the signing request).

**Reputation** — answer honestly. The repository was published on 2026-11-21 and
has no stars, forks or press coverage, so a "widely used" claim would be false;
what exists is verifiability, and that is what the field should say:

> Guazzo is new: published November 2026, no download history and no press
> coverage yet, so there is no adoption evidence to offer. What can be checked
> today: every release is reproducible from a tagged commit (rebuilding a clean
> clone produces a byte-identical artifact), the repository runs a gate of 604
> tests and 85 static invariants on every push, `RELEASE.json` names the exact
> commit and records that the tree was clean, the licence is Apache-2.0, and the
> only vendored dependency is ag-psd (MIT). I am applying before wider
> distribution specifically so that the first users receive a signed binary
> rather than an "Unknown publisher" warning.

If they decline on maturity rather than on eligibility, the fallback is
Certum's open-source tier (individual, smartcard) — see `docs/SIGNING.md`.

## What it is

A fully offline, Photoshop-shaped image editor for Windows: layers and nested
groups, masks, ~30 filters, 13 adjustment kinds, selections, pen and text tools,
healing, transform and crop, PSD import and export, project save/load with
autosave recovery, and native file dialogs. The distributed build is a single
portable exe (Tauri/WebView2, ≈4.9 MB) plus `WebView2Loader.dll`; the repository
also builds the same application as one self-contained HTML file that runs in any
modern browser.

## Why we are applying

The exe is distributed directly from GitHub Releases. Without a signature,
Windows SmartScreen shows "Windows protected your PC" to every first-time user,
and the publisher is "Unknown publisher". There is no installer and no store
listing, so Authenticode is the only identity signal the download can carry.

The project has no revenue and no company behind it; an OV certificate
(≈$150–300/yr, plus hardware-token requirements) is out of proportion to a
single-maintainer editor that is given away.

## Build instructions

Runs on Windows with Node 22.x and a Rust toolchain (GNU or MSVC).

```pwsh
git clone https://github.com/vera2077/guazzo.git
cd guazzo
npm install --no-audit --no-fund
node scripts/ci.mjs                      # gate: 59 test files / 600 tests, static pins, smoke, deterministic single-file build
cargo build --release --manifest-path src-tauri/Cargo.toml
cp src-tauri/target/release/guazzo.exe "Guazzo-v1.1.1.exe"
node scripts/release.mjs 1.1.1           # stages release/1.1.1/
node scripts/package.mjs                 # builds the deterministic zip
```

CI runs the same gate on every push and pull request:
`.github/workflows/ci.yml`, and the release job is `.github/workflows/release.yml`
with `SIGNING_MODE=signpath` (the configuration this application is asking for).

## Reproducibility

The single-file artifact is byte-identical when rebuilt from a tag by a third
party:

| release | artifact SHA-256 |
| --- | --- |
| v1.0.0 | `a191abf745ffaf1a6f812cee824c3ed0b7521fe8309013b14b118e970e68e292` |
| v1.1.0 | `c5ec0019ef280aca8683402b77f63c4f83b468cd5592cd95e0a7e9a19c7aa877` |
| v1.1.1 | `a8808d0fd9b24e97dfe62a8ab1e284d2aeea6c2d99697ebbc0a00bbfacacc0dc` |

Procedure used to verify (documented in `docs/PUBLISH.md`): clone with
`-c core.autocrlf=true`, check out the release tag, `git check-attr eol -- src/main.ts`
must report `lf`, then `npm install && npx tsc && node scripts/single-file.mjs`
and compare `app-single.html` to the hash in `release/<version>/RELEASE.json`.

The exe itself is not bit-reproducible: the PE header carries the linker's
timestamp. The zip's contents are pinned by `SHA256SUMS.txt` and `RELEASE.json`,
and the artifact embedded in the exe is verified against the same hash.

## What we are asking for

- Signing of `Guazzo-v<version>.exe` produced by `.github/workflows/release.yml`
  on a tag push, using the release workflow's artifact as input.
- A signing policy that requires the artifact to originate from
  `github.com/vera2077/guazzo` (the same repository the public build comes from).

## What we will do in return

- Never ship a binary that was not built from a tagged commit of the public
  repository; `RELEASE.json` records the commit and `git status` must be clean.
- Keep the build instructions and the reproducibility check in the repository,
  so anyone can confirm a signed binary matches the published source.
- Credit SignPath Foundation in the release notes of the first signed release,
  as their guidelines ask.
- Route every future release through the same CI job; no signing from a
  developer machine, and no private key stored in the repository or in an
  agent's workspace.

## Contact

vera2077 — via GitHub issues or the address on the GitHub profile.
