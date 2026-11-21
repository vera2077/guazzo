#!/usr/bin/env node
/**
 * Sign one built binary with Authenticode, then prove the signature took.
 *
 * This is the step between `cargo build --release` and `node scripts/release.mjs`:
 * the manifest hashes the exe, so signing after staging would leave a hash that
 * describes a different file than the one users download.
 *
 *     node scripts/sign.mjs Guazzo-v1.2.0.exe
 *     node scripts/sign.mjs Guazzo-v1.2.0.exe --check   # report, change nothing
 *
 * Needs a code-signing certificate in the current user's store and `signtool`
 * (Windows SDK). Set SIGN_CERT_SHA1 to its thumbprint; SIGNTOOL overrides the
 * tool path; SIGN_TIMESTAMP_URL overrides the timestamp authority. With no
 * thumbprint the script refuses rather than signing with whatever it finds —
 * "signed by the wrong certificate" is worse than unsigned.
 *
 * The key never enters this process. `signtool` reads the certificate from the
 * store; in CI the store is populated from a secret or the signing happens in
 * SignPath's HSM. See docs/SIGNING.md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSignature, signExe } from "./signature.mjs";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

function defaultTarget() {
  const pkg = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8"));
  return join(APP_DIR, `Guazzo-v${pkg.version}.exe`);
}

function report(info) {
  const lines = [
    `  status:     ${info.status}`,
    `  signed:     ${info.signed ? "yes" : "no"}`,
  ];
  if (info.subject) lines.push(`  subject:    ${info.subject}`);
  if (info.thumbprint) lines.push(`  thumbprint: ${info.thumbprint}`);
  if (info.notAfter) lines.push(`  expires:    ${info.notAfter}`);
  lines.push(`  timestamp:  ${info.timestamped ? "yes (survives certificate expiry)" : "no — the signature expires with the certificate"}`);
  return lines.join("\n");
}

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const target = argv.find((arg) => !arg.startsWith("--")) ?? defaultTarget();

if (checkOnly) {
  const info = readSignature(target);
  console.log(`${target}\n${report(info)}`);
  // A check that cannot fail is not a check.
  process.exitCode = info.signed ? 0 : 1;
} else {
  try {
    const info = signExe(target);
    console.log(`signed ${target}\n${report(info)}`);
  } catch (error) {
    console.error(`sign: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
