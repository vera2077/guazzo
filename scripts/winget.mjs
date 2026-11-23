#!/usr/bin/env node
/**
 * Write the winget manifests for a released version.
 *
 * winget-pkgs wants three files per version under manifests/<first letter>/<Publisher>/<Package>/
 * <Version>/: the version stub, the installer, and the default locale. They are
 * generated here rather than hand-edited so the hash and the URL cannot drift
 * from the artifact that was actually published.
 *
 * Usage: node scripts/winget.mjs [version]
 * Then:  winget validate --manifest packaging/winget/manifests/g/Guazzo/Guazzo/<version>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The version becomes a path and a file name; a bare join would follow "..". */
function safeVersion(v, where) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(String(v))) {
    console.error(`${where}: "${v}" is not a version — refusing to build paths from it`);
    process.exit(1);
  }
  return String(v);
}

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const version = safeVersion(process.argv[2] ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "winget");
// Prefer the copy that is actually published in release/<v>/: dist/ holds the
// build output, and the two are not byte-identical (PE timestamps).
const released = join(root, "release", version, `Guazzo-v${version}-Setup.exe`);
const setup = existsSync(released) ? released : join(root, "dist", `Guazzo-v${version}-Setup.exe`);

let bytes;
try {
  bytes = readFileSync(setup);
} catch {
  console.error(`winget: ${setup} does not exist — run scripts/build-setup.mjs ${version} first`);
  process.exit(1);
}
const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
const url = `https://github.com/vera2077/guazzo/releases/download/v${version}/Guazzo-v${version}-Setup.exe`;
const dir = join(root, "packaging", "winget", "manifests", "g", "Guazzo", "Guazzo", version);
mkdirSync(dir, { recursive: true });

const files = {
  "Guazzo.Guazzo.yaml": `# Created with Guazzo's own generator (scripts/winget.mjs).
# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json

PackageIdentifier: Guazzo.Guazzo
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`,
  "Guazzo.Guazzo.installer.yaml": `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json

PackageIdentifier: Guazzo.Guazzo
PackageVersion: ${version}
Platform:
  - Windows.Desktop
MinimumOSVersion: 10.0.17763.0
InstallerType: exe
Scope: user
InstallModes:
  - interactive
  - silent
  - silentWithProgress
UpgradeBehavior: install
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
  - Architecture: x64
    InstallerUrl: ${url}
    InstallerSha256: ${sha256}
    InstallerSwitches:
      Silent: --silent
      SilentWithProgress: --silent
    ProductCode: Guazzo
    AppsAndFeaturesEntries:
      - DisplayName: Guazzo
        Publisher: vera
        DisplayVersion: ${version}
        ProductCode: Guazzo
ManifestType: installer
ManifestVersion: 1.6.0
`,
  "Guazzo.Guazzo.locale.en-US.yaml": `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json

PackageIdentifier: Guazzo.Guazzo
PackageVersion: ${version}
PackageLocale: en-US
Publisher: vera
PublisherUrl: https://github.com/vera2077
PublisherSupportUrl: https://github.com/vera2077/guazzo/issues
PackageName: Guazzo
PackageUrl: https://github.com/vera2077/guazzo
License: Apache-2.0
LicenseUrl: https://github.com/vera2077/guazzo/blob/main/LICENSE
Copyright: Copyright 2026 vera
ShortDescription: Offline, Photoshop-shaped image editor for Windows.
Description: >-
  Guazzo is a fully offline image editor with layers, groups, masks, 27 blend
  modes, selections, live adjustment layers, fill layers, filters, text with
  per-run styling, smart objects, PSD import and export, and a Tauri/WebView2
  shell. No account, no telemetry, and no network code at all.
Moniker: guazzo
Tags:
  - image-editor
  - photo-editor
  - paint
  - photoshop
  - offline
  - psd
ReleaseNotesUrl: https://github.com/vera2077/guazzo/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`,
};

for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(dir, name), text);
  console.log(`winget: ${join(dir, name)}`);
}
console.log(`winget: sha256 ${sha256}`);
