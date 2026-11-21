# Signing a release

Guazzo ships as a portable Windows exe. Windows does not require a signature to
run it, but an unsigned download shows SmartScreen's "Windows protected your PC"
panel, and a signed download shows the publisher's name instead — after the
certificate has reputation. That reputation, not the signature itself, is what
users see.

Two facts worth knowing before choosing a certificate:

- An **EV** certificate no longer bypasses SmartScreen. Microsoft's
  [code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
  page, updated 2026-11-10, says the 2024 SmartScreen update removed the
  instant-reputation behaviour EV used to buy.
- Since June 2023 the CA/Browser Forum requires every OV/EV private key to live
  in a hardware token or an HSM. This is why the routes below all involve
  something other than a `.pfx` on a laptop.

## What this repository already does

`node scripts/release.mjs` asks the exe what its signature says and writes the
answer into `RELEASE.json`:

```json
"signature": {
  "signed": true,
  "status": "Valid",
  "subject": "CN=vera2077, O=…",
  "thumbprint": "0123…",
  "notAfter": "2027-11-21T00:00:00.0000000Z",
  "timestamped": true,
  "checkedAt": "2026-11-21T18:04:11.412Z"
}
```

`"signed": false` is written explicitly for an unsigned build. A reader never
has to distinguish "no signature" from "the writer forgot to look".

Set `RELEASE_REQUIRE_SIGNED=1` (or pass `--require-signed`) and staging throws
when the answer is anything but `Valid`:

```
release: Guazzo-v1.2.0.exe is not signed (NotSigned) and signing was required —
sign it before staging: node scripts/sign.mjs "Guazzo-v1.2.0.exe"
```

The gate never verifies a signature. It runs on machines without the Windows
SDK, and `node scripts/ci.mjs` is not allowed to depend on a certificate store.
`stage()` takes the reading as an argument, so `src/engine/tests/release.test.ts`
pins the policy and the release path does the I/O.

## Route 1 — an OSS certificate from SignPath Foundation

SignPath signs open-source projects for free, with the key in their HSM. The
project must be public and built from the public repository; Apache-2.0 and a
reproducible artifact are exactly their profile. `docs/SIGNPATH-APPLICATION.md`
holds the application text.

Once the project is configured there, set these repository variables and the
`release` workflow signs without any key entering GitHub:

| kind | name |
| --- | --- |
| variable | `SIGNING_MODE=signpath` |
| variable | `SIGNPATH_ORGANIZATION_ID` |
| variable | `SIGNPATH_PROJECT_SLUG` |
| variable | `SIGNPATH_SIGNING_POLICY_SLUG` |
| variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` |
| secret | `SIGNPATH_API_TOKEN` |

The workflow uploads the unsigned exe, submits it, downloads the signed one,
and re-checks it with `node scripts/sign.mjs … --check` before staging.

## Route 2 — your own certificate

Buy an OV code-signing certificate (roughly $150–300/yr) from a CA that issues
to individuals in your jurisdiction. It arrives on a hardware token or as a
cloud-HSM credential; a `.pfx` export is usually not offered any more, and when
it is, storing it in a CI secret is the risk you are buying.

On a machine where the certificate is in the current user's store:

```pwsh
$env:SIGN_CERT_SHA1 = (Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.EnhancedKeyUsageList.ObjectId -contains "1.3.6.1.5.5.7.3.3" } |
  Select-Object -First 1).Thumbprint
node scripts/sign.mjs Guazzo-v1.2.0.exe          # sign + verify
node scripts/sign.mjs Guazzo-v1.2.0.exe --check  # report only, exits 1 if unsigned
```

Sign between `cargo build --release` and `node scripts/release.mjs`:

```
bump → gate → commit → tag → cargo build → copy exe → sign → release.mjs → package.mjs
```

Signing after staging would change the bytes the manifest hashed, and the
manifest would then describe a file nobody downloads. `release.mjs` cannot
detect that on its own — it only sees what it is given — so the order matters.

For CI with a `.pfx` (not recommended, occasionally the only option):

| kind | name |
| --- | --- |
| variable | `SIGNING_MODE=pfx` |
| secret | `SIGN_PFX_BASE64` |
| secret | `SIGN_PFX_PASSWORD` |
| secret | `SIGN_CERT_SHA1` |

The workflow imports it into the runner's temporary store, signs, then deletes
the PFX from disk. The runner is destroyed afterwards; the secret is not.

## Rules that are not preferences

- **Timestamp.** `signtool sign … /tr <url> /td SHA256`. An untimestamped
  signature stops verifying the day the certificate expires, so every release
  ever made starts warning at once. `scripts/signature.mjs` sets both flags and
  the pin fails if either disappears.
- **Never let an agent hold a key.** Microsoft's page says so explicitly. A
  signing request is a narrow, logged permission; a private key in a workspace
  is a key in every transcript that mentions it.
- **The wrong certificate is worse than none.** `sign.mjs` refuses when
  `SIGN_CERT_SHA1` is unset rather than signing with whatever `signtool` finds.
- **Do not sign a zip.** Authenticode covers a PE file. The zip's integrity is
  the SHA-256 in `RELEASE.json` and in the release notes; users verify it with
  `sha256sum -c SHA256SUMS.txt` after extracting.

## What a user can verify

```pwsh
Get-AuthenticodeSignature .\Guazzo-v1.2.0.exe | Format-List
signtool verify /pa /v .\Guazzo-v1.2.0.exe
```

and, without any certificate store at all: `sha256sum -c SHA256SUMS.txt` inside
the extracted zip, comparing against `RELEASE.json` from the same release.
