/**
 * Authenticode: read what a binary's signature says, and never call an unsigned
 * binary signed.
 *
 * The gate does not touch this file. Verifying a signature needs the built exe
 * and a Windows API, and a unit test that shells out to PowerShell is a test
 * that fails on a machine without the SDK. `stage()` takes the reading as an
 * argument instead, so the policy is testable and the I/O lives here.
 *
 * Two rules the release path depends on:
 *   - the manifest records what was *found*, not what was *requested*; an
 *     unsigned build stages as `"signed": false` rather than omitting the field;
 *   - `RELEASE_REQUIRE_SIGNED=1` turns "found unsigned" into a refusal, so a
 *     release job that intends to sign cannot quietly publish without it.
 *
 * Nothing in this file accepts, stores or logs a private key. Signing is
 * `signtool` with a certificate that is already in a store (or, in CI, in
 * SignPath's HSM); the key never passes through this process.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const SIGNTOOL_ENV = "SIGNTOOL";
export const THUMBPRINT_ENV = "SIGN_CERT_SHA1";
export const TIMESTAMP_ENV = "SIGN_TIMESTAMP_URL";
export const REQUIRE_SIGNED_ENV = "RELEASE_REQUIRE_SIGNED";
/** who the signature must belong to: a subject substring or a thumbprint */
export const REQUIRE_SIGNER_ENV = "RELEASE_REQUIRE_SIGNER";
export const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

/** What a manifest says about a binary that carries no signature. */
export const UNSIGNED = Object.freeze({
  signed: false,
  status: "NotSigned",
  subject: null,
  thumbprint: null,
  notAfter: null,
  timestamped: false,
});

function runOrThrow(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Read the Authenticode state of one file.
 *
 * Returns `status: "Unavailable"` when the platform or the API is missing —
 * that is not a signature failure, it is "this machine cannot tell", and the
 * caller decides what to do about it. `Valid` is the only status that means
 * signed; `NotTrusted` means signed by a certificate this machine does not
 * trust, which for a release is the same as unsigned.
 */
export function readSignature(exe, { run = runOrThrow } = {}) {
  if (!existsSync(exe)) throw new Error(`signature: ${exe} does not exist`);
  if (process.platform !== "win32") return { ...UNSIGNED, status: "Unavailable" };

  const literal = exe.replace(/'/g, "''");
  const script = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${literal}';`,
    "$c = $s.SignerCertificate;",
    "$r = [ordered]@{",
    "  Status = [string]$s.Status;",
    "  Subject = $(if ($c) { $c.Subject } else { $null });",
    "  Thumbprint = $(if ($c) { $c.Thumbprint } else { $null });",
    "  NotAfter = $(if ($c) { $c.NotAfter.ToString('o') } else { $null });",
    "  Timestamped = [bool]($s.TimeStamperCertificate)",
    "};",
    "$r | ConvertTo-Json -Compress",
  ].join(" ");

  let raw;
  try {
    raw = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  } catch {
    return { ...UNSIGNED, status: "Unavailable" };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw).trim());
  } catch {
    return { ...UNSIGNED, status: "Unreadable" };
  }

  const status = String(parsed.Status ?? "Unknown");
  return {
    signed: status === "Valid",
    status,
    subject: parsed.Subject ? String(parsed.Subject) : null,
    thumbprint: parsed.Thumbprint ? String(parsed.Thumbprint) : null,
    notAfter: parsed.NotAfter ? String(parsed.NotAfter) : null,
    timestamped: parsed.Timestamped === true,
  };
}

/**
 * The manifest fragment. Fixed shape on purpose: a reader never has to ask
 * whether a field is absent because the build was unsigned or because the
 * writer forgot it.
 */
export function signatureManifest(info) {
  const reading = info ?? UNSIGNED;
  return {
    signed: reading.signed === true,
    status: String(reading.status ?? "Unknown"),
    subject: reading.subject ?? null,
    thumbprint: reading.thumbprint ?? null,
    notAfter: reading.notAfter ?? null,
    timestamped: reading.timestamped === true,
    checkedAt: new Date().toISOString(),
  };
}

/** Refuse an unsigned binary, naming the step that fixes it. */
export function requireSignature(info, exe, expected) {
  if (info?.signed !== true) {
    const status = info?.status ?? "Unknown";
    throw new Error(
      `release: ${exe} is not signed (${status}) and signing was required — ` +
        `sign it before staging: node scripts/sign.mjs "${exe}"`,
    );
  }
  // "Valid" only says a CA vouched for the key. Without an expected identity any
  // valid certificate — including one issued to somebody else — would pass.
  const want = String(expected ?? process.env[REQUIRE_SIGNER_ENV] ?? "").trim();
  if (!want) {
    throw new Error(
      `release: ${exe} is signed but no expected signer is set — set ${REQUIRE_SIGNER_ENV} ` +
        `to the publisher's subject substring or thumbprint`,
    );
  }
  const normal = (v) => String(v ?? "").replace(/\s+/g, "").toUpperCase();
  const needle = normal(want);
  const subject = String(info.subject ?? "");
  const thumbprint = String(info.thumbprint ?? "");
  if (!normal(subject).includes(needle) && !normal(thumbprint).includes(needle)) {
    throw new Error(
      `release: ${exe} is signed by "${subject || "(no subject)"}" but ${REQUIRE_SIGNER_ENV}=${want} ` +
        `was expected — refusing to publish someone else's binary`,
    );
  }
}

export function findSigntool(env = process.env, { run = runOrThrow } = {}) {
  const explicit = env[SIGNTOOL_ENV];
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`signature: ${SIGNTOOL_ENV}=${explicit} does not exist`);
    return explicit;
  }
  if (process.platform !== "win32") return null;
  try {
    const out = run("where", ["signtool.exe"]);
    const first = String(out).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Sign one file in place and return the reading of the result.
 *
 * The certificate must already be in a store — `SIGN_CERT_SHA1` is a thumbprint,
 * not a key. Timestamping is not optional: an untimestamped signature stops
 * verifying the day the certificate expires.
 */
export function signExe(exe, options = {}) {
  const env = options.env ?? process.env;
  const run = options.run ?? runOrThrow;
  const thumbprint = options.thumbprint ?? env[THUMBPRINT_ENV];
  const timestampUrl = options.timestampUrl ?? env[TIMESTAMP_ENV] ?? DEFAULT_TIMESTAMP_URL;
  if (!thumbprint) {
    throw new Error(
      `signature: no certificate thumbprint — set ${THUMBPRINT_ENV} to the thumbprint of a ` +
        `code-signing certificate in the current user's store`,
    );
  }
  const signtool = options.signtool ?? findSigntool(env, { run });
  if (!signtool) {
    throw new Error(`signature: signtool not found — install the Windows SDK or set ${SIGNTOOL_ENV}`);
  }
  run(signtool, ["sign", "/fd", "SHA256", "/tr", timestampUrl, "/td", "SHA256", "/sha1", thumbprint, exe]);
  const info = readSignature(exe, { run });
  if (!info.signed) {
    throw new Error(`signature: signtool finished but the file is ${info.status} — nothing was signed`);
  }
  return info;
}
