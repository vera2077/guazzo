# winget

`manifests/g/Guazzo/Guazzo/<version>/` holds the three YAML files winget needs
for the per-user installer: the version stub, the installer, and the `en-US`
locale. They are generated, not hand-edited:

```
node scripts/build-setup.mjs <version>   # builds dist/Guazzo-v<version>-Setup.exe
node scripts/winget.mjs <version>        # writes the manifests from that file's hash
winget validate --manifest packaging/winget/manifests/g/Guazzo/Guazzo/<version>
```

The installer URL points at the GitHub release asset, so the manifests must be
generated **after** the asset is uploaded and never before: a manifest whose
hash and URL disagree is rejected by the validation pipeline.

## Submitting

`winget install Guazzo.Guazzo` only resolves once the manifests are in
[`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs):

1. Fork `microsoft/winget-pkgs`.
2. Copy `manifests/g/Guazzo/Guazzo/<version>/` into the fork at the same path.
3. Commit, push, and open a PR titled `New package: Guazzo.Guazzo version <version>`.
4. The validation pipeline checks that the URL downloads, the hash matches, and
   the installer runs with `--silent`. A human reviewer merges it.

Nothing in this repository can do steps 1–4: a submission is a signed-in PR to
someone else's repository. Once the first version is accepted, later versions
are a one-file PR each (`wingetcreate update Guazzo.Guazzo --version <new>`).
