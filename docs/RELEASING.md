# Releasing Shep

This fork (`mitja/shep`) publishes macOS releases through GitHub Actions.
Pushing a version tag builds, signs, and publishes the artifacts, and the
in-app auto-updater points at this fork's latest release.

## TL;DR

```sh
# 1. Bump the version across package.json, tauri.conf.json, Cargo.toml (+ Cargo.lock)
./scripts/bump-version.sh 0.5.1        # commits "Bump version to 0.5.1 for release"

# 2. Land it on main (directly, or via PR)
git push origin main

# 3. Tag the release — this triggers the Release workflow
git tag v0.5.1-mitja.1
git push origin v0.5.1-mitja.1
```

### Tag convention

Tags carry a **fork suffix** (`-mitja.N`) so they never collide with upstream's
tags when you sync — e.g. `v0.5.1-mitja.1`, then `-mitja.2` for a re-cut of the
same version. The workflow verifies that the tag's **numeric core** (the part
before the first `-`) matches the version in `tauri.conf.json` and fails fast
otherwise, so `v0.5.1-mitja.1` requires app version `0.5.1`.

Keep the **app version itself numeric** (`x.y.z`) — Apple notarization requires
`CFBundleVersion` to be dotted integers, so a text suffix belongs only in the
tag, never in `tauri.conf.json`/`Cargo.toml`/`package.json`. Bump the numeric
version for every fork build you want existing installs to auto-update to.

Watch the run with `gh run watch` or under the repo's **Actions** tab.

## What the workflow does

`.github/workflows/release.yml` runs on `macos-14` (Apple silicon) and:

1. Verifies the tag matches the app version.
2. Builds the frontend + a native `aarch64-apple-darwin` bundle via
   [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action).
3. Signs the updater artifact with the fork's minisign key.
4. Creates a **draft** GitHub release with:
   - `shep_<version>_aarch64.dmg` — the installer
   - `shep.app.tar.gz` + `shep.app.tar.gz.sig` — the updater payload
   - `latest.json` — the updater manifest
5. Sets the release notes and publishes it as the latest release.

You can also run it manually from the Actions tab ("Run workflow") by supplying
an existing tag.

### Release notes

Notes are composed automatically as:

- the **latest upstream (`stumptowndoug/shep`) release body**, copied verbatim, followed by
- a **`Fork additions`** appendix listing the commits this fork carries on top
  of that upstream release.

## Updater signing key (required)

The Tauri updater verifies every update with a minisign signature, independent
of Apple code signing. This fork uses its **own** key:

- **Public key** — committed in `tauri.conf.json` under `plugins.updater.pubkey`.
- **Private key** — lives only in the repo secret `TAURI_SIGNING_PRIVATE_KEY`
  and locally at `~/.tauri/shep-updater-fork.key` (empty password).

> ⚠️ **Back up `~/.tauri/shep-updater-fork.key`.** If it is lost, already-installed
> apps can no longer verify updates — you would have to ship a new public key
> (which existing installs won't trust) and users would have to reinstall.

To rotate or regenerate the key:

```sh
pnpm tauri signer generate -w ~/.tauri/shep-updater-fork.key -p "" --ci -f
# copy the .pub file's contents into tauri.conf.json -> plugins.updater.pubkey
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo mitja/shep < ~/.tauri/shep-updater-fork.key
```

## Apple Developer ID signing + notarization (optional but recommended)

Without this, releases still build and run, but are only **ad-hoc signed**:

- A build you compile locally and copy to `/Applications` runs with no warning.
- A build **downloaded** from the release is quarantined by macOS and shows
  *"the developer cannot be verified"* or *"shep is damaged"* on first open.
  Bypass per machine:
  - macOS ≤ 14: right-click the app → **Open** → **Open**.
  - macOS 15+: try to open, then **System Settings → Privacy & Security → Open Anyway**.
  - or: `xattr -dr com.apple.quarantine /Applications/shep.app`

To sign + notarize so downloads open cleanly, add the secrets below. The
workflow already wires them into `tauri-action`; **no workflow changes are
needed** — the next tagged release will sign and notarize automatically.

### One-time setup

1. **Enroll** in the [Apple Developer Program](https://developer.apple.com/programs/)
   ($99/year). A free Apple ID cannot issue Developer ID certificates.
2. **Create a "Developer ID Application" certificate.** In Xcode:
   **Settings → Accounts →** add your Apple ID **→ Manage Certificates → + →
   Developer ID Application**. (Or make a CSR in Keychain Access and upload it at
   developer.apple.com → Certificates.)
3. **Find your identity + Team ID:**
   ```sh
   security find-identity -v -p codesigning
   # -> "Developer ID Application: Your Name (ABCDE12345)"
   ```
   The full string is `APPLE_SIGNING_IDENTITY`; the 10-char `ABCDE12345` is
   `APPLE_TEAM_ID`.
4. **App-specific password** for notarization: [appleid.apple.com](https://appleid.apple.com)
   → Sign-In and Security → App-Specific Passwords → **+**. That value is
   `APPLE_PASSWORD`; your Apple account email is `APPLE_ID`.
5. **Export the cert as `.p12`:** Keychain Access → **login** keychain →
   Certificates → expand *Developer ID Application…*, select **both the
   certificate and its private key** → right-click → **Export 2 items** → save
   `certificate.p12` with a password (that password is
   `APPLE_CERTIFICATE_PASSWORD`).

### Add the GitHub secrets

```sh
gh secret set APPLE_CERTIFICATE          --repo mitja/shep < <(base64 -i certificate.p12)
gh secret set APPLE_CERTIFICATE_PASSWORD --repo mitja/shep   # the .p12 export password
gh secret set APPLE_SIGNING_IDENTITY     --repo mitja/shep   # "Developer ID Application: Your Name (ABCDE12345)"
gh secret set APPLE_ID                   --repo mitja/shep   # Apple ID email
gh secret set APPLE_PASSWORD             --repo mitja/shep   # app-specific password
gh secret set APPLE_TEAM_ID              --repo mitja/shep   # ABCDE12345
```

### Verify a notarized build

```sh
spctl -a -vvv -t install /Applications/shep.app
# expect: "accepted, source=Notarized Developer ID"
```

## Local release builds

`scripts/release-build.sh` builds, signs, notarizes, and generates `latest.json`
locally. It reads signing config from a `.env` at the repo root:

```
APPLE_SIGNING_IDENTITY=Developer ID Application: Your Name (ABCDE12345)
APPLE_ID=you@example.com
APPLE_PASSWORD=app-specific-password
APPLE_TEAM_ID=ABCDE12345
TAURI_SIGNING_PRIVATE_KEY_PATH=/Users/you/.tauri/shep-updater-fork.key
```

For local builds the Developer ID cert must be installed in your Keychain
(no `.p12`/base64 needed — that's only for CI). `post-build-dmg.sh` applies the
Finder DMG layout locally; CI skips it (it needs a GUI session).

## Version numbers

`scripts/bump-version.sh <version>` keeps `package.json`, `src-tauri/tauri.conf.json`,
and `src-tauri/Cargo.toml` in sync and commits the change. Also update the `shep`
entry in `src-tauri/Cargo.lock` (a normal `cargo build`/`pnpm tauri build` will do
this; commit the result so CI stays reproducible).
