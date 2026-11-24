# Signing a release

Guazzo ships **unsigned**. Windows does not require a signature to run it, but an
unsigned download shows SmartScreen's "Windows protected your PC" panel to
first-time users; when a `winget` manifest is available, installing through it
or an equivalent package manager is the way most people avoid that panel
(installs from a package manager do not carry Mark-of-the-Web, so the
browser-level warning never happens).

This page records what is true so that a future decision is not made on folklore.

## What a certificate does and does not buy

- **EV no longer bypasses SmartScreen.** Microsoft's
  [code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
  page (updated 2026-11-10) states the 2024 SmartScreen change removed EV's
  instant reputation. Paying $400+/year for SmartScreen is no longer a reason to
  buy one.
- **OV and Azure Artifact Signing behave the same as each other** for SmartScreen:
  reputation builds over time, initial warnings expected. Signing consecutive
  releases with one identity is what lets that reputation accumulate.
- **Azure Artifact Signing** is about $9.99/month and needs no hardware token, but
  individual developers are limited to the USA and Canada, and organisations to
  the USA, Canada, the EU and the UK.
- **OV certificates** are $150–300/year from DigiCert, Sectigo, GlobalSign and
  others, and since June 2023 the CA/Browser Forum requires the private key in a
  hardware token or HSM. Certum's open-source certificate is the cheapest
  realistic route (~€69 first year including the smartcard and reader, €29
  renewal), and its setup is an afternoon of driver and card-manager work.
- **Self-signed certificates are not a distribution option**: they block
  installation for anyone who has not installed the root.

## What this repository does today

`node scripts/release.mjs` asks the exe what its signature says and writes the
answer into `RELEASE.json`:

```json
"signature": { "signed": false, "status": "NotSigned" }
```

`"signed": false` is written explicitly, so a reader never has to distinguish
"no signature" from "the writer forgot to look".

If a certificate ever exists, the same manifest records it:

```json
"signature": {
  "signed": true,
  "status": "Valid",
  "subject": "CN=vera2077, O=…",
  "thumbprint": "0123…",
  "notAfter": "2027-11-21T00:00:00.0000000Z",
  "timestamped": true
}
```

## If you sign later

Order matters: the manifest hashes the exe, so signing after staging would
describe a file nobody downloads.

```
bump → gate → tag → cargo build → copy exe → sign → release.mjs → package.mjs
```

- `node scripts/sign.mjs Guazzo-v<version>.exe` signs and verifies in place.
- `node scripts/sign.mjs … --check` reports only, exit 1 when unsigned.
- `RELEASE_REQUIRE_SIGNED=1` turns an unsigned result into a staging refusal.
- Signature policy is enforced locally by `release.mjs` when you stage: set
  `RELEASE_REQUIRE_SIGNED=1` and `RELEASE_REQUIRE_SIGNER` to require a valid
  Authenticode signature from a named publisher. `.github/workflows/release.yml`
  is a gate only — it does not sign and cannot add a signature to the exe you
  already built and verified, so no CI variable can make an unsigned byte signed.
