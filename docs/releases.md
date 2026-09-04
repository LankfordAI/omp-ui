# Releases and updates

This guide explains what users receive from a release and how maintainers publish one. For installation, start with [Getting started](getting-started.md). See [Architecture](architecture.md) for the boundary between the Electron desktop app and the managed `omp` binary.

## Unreleased

- Settings → Providers gains a **Subscriptions** group: sign in to a ChatGPT subscription (`openai-codex`) through the provider's own browser flow, with sign-out and the signed-in account identity. Sign-in runs in a bare, session-less omp process; the credential stays in omp's auth broker, shared with terminal omp (issue #368).

## Choose a download

A release has exactly six distributable files. Replace `<version>` with the tag version without its leading `v`.

| Platform | Status | File | Use |
|---|---|---|---|
| Linux x64 | Supported | `omp-ui-<version>.AppImage` | Install and run omp-ui |
| Windows x64 | Unsigned preview | `omp-ui-<version>-windows-preview-x64-setup.exe` | Per-user NSIS installer |
| macOS Apple Silicon | Signed preview | `omp-ui-<version>-mac-preview-arm64.dmg` | Install omp-ui |
| macOS Apple Silicon | Signed preview | `omp-ui-<version>-mac-preview-arm64.zip` | Squirrel.Mac update payload |
| macOS Intel | Signed preview | `omp-ui-<version>-mac-preview-x64.dmg` | Install omp-ui |
| macOS Intel | Signed preview | `omp-ui-<version>-mac-preview-x64.zip` | Squirrel.Mac update payload |

[GitHub Releases](https://github.com/LankfordAI/omp-ui/releases/latest) is the application download and update channel. The Windows x64 work is recorded in [issue #125](https://github.com/LankfordAI/omp-ui/issues/125), and [ADR-0015](adr/0015-unsigned-windows-nsis-preview.md) keeps that installer an unsigned preview. Windows therefore reports an unknown publisher. The macOS packages are Developer ID signed and notarized previews. [Issue #124](https://github.com/LankfordAI/omp-ui/issues/124) remains open until their physical-Mac update checks and supported-release gate are complete.

Linux uses AppImage as its sole first-party supported format. Community packages may exist, but the project does not support them. The policy and cutover history are recorded in [ADR-0011](adr/0011-appimage-only-linux-distribution.md).

Install or repair the supported Linux release without root:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash
```

The installer verifies the AppImage against `SHA256SUMS.txt`, writes it to `~/.local/bin/omp-ui.AppImage`, and creates the per-user desktop entry and icons. Before touching an existing install it verifies the Electron binary's system shared-library dependencies on the staged AppImage and, if any are unresolvable, stops with the exact `sudo apt install …` command to run first. The AppImage is built with the static AppImage runtime (no FUSE2 dependency), and the installer's menu entry falls back to the runtime's extract-and-run mode when the system provides no FUSE mount support.

## Understand the release files

The six distributables ship with seven supporting files, for 13 release assets in total:

- `latest-linux.yml` names the AppImage and supplies its SHA-512 update metadata. The AppImage blockmap is embedded, so Linux does not publish a separate blockmap file.
- `latest.yml` names the Windows installer and supplies its SHA-512 update metadata.
- `omp-ui-<version>-windows-preview-x64-setup.exe.blockmap` supports the NSIS differential download.
- `latest-mac.yml` names both DMGs and both ZIPs, with their sizes and SHA-512 digests. The matching ZIP is the Squirrel.Mac update payload for each architecture.
- `SHA256SUMS.txt` contains one SHA-256 line for each of the six distributables.
- `SHA256SUMS-macos-arm64.txt` and `SHA256SUMS-macos-x64.txt` each cover that architecture's DMG and ZIP. The workflow creates them during platform verification, then creates the combined manifest after all platforms finish.

The SHA-256 manifests and update metadata detect corrupt or substituted bytes. They do not establish publisher identity. macOS gets publisher identity from Developer ID signing and notarization. The Windows preview has no equivalent trusted Authenticode signature yet.

### Language assets

Every package includes the English and Korean UI catalogs and the bundled Pretendard Variable Korean fallback face. The font adds about 2.06 MB to the unpacked renderer assets; it is emitted byte-for-byte into both desktop and remote-web builds. The Settings → General language choice applies locally with no additional download, while session and terminal content remain unmodified.

To verify one downloaded file, place it beside `SHA256SUMS.txt` and select only its line. For example:

```bash
grep 'omp-ui-.*\.AppImage$' SHA256SUMS.txt | sha256sum -c -
```

On macOS, verify the Apple Silicon DMG with:

```bash
grep 'omp-ui-.*-mac-preview-arm64\.dmg$' SHA256SUMS.txt | shasum -a 256 -c -
```

Continue only when the selected file reports `OK`.

## How application updates behave

Packaged Linux, Windows, and macOS builds check the latest stable GitHub release in the background at launch when the omp-ui launch check is enabled. The command palette can run the check on demand. Drafts and prereleases do not qualify. Background lookup, metadata, and download failures stay silent, as do no-update results. An on-demand check reports its staging progress and failures. Development builds and builds without a valid stamped version do not check.

AppImage, NSIS, and macOS installs use `electron-updater`. A background check downloads and verifies a newer release before the update card appears:

- AppImage uses `latest-linux.yml` and its embedded blockmap.
- NSIS uses `latest.yml` and the matching `.exe.blockmap`.
- macOS uses `latest-mac.yml`; Squirrel.Mac applies the ZIP that matches the Mac's architecture.

A staged update does not install silently. `Restart now` asks for confirmation when live sessions exist, then quits, installs, and relaunches. `Install when I quit` arms the staged update for the next natural quit and can be undone. A natural quit still goes through the live-session quit guard. Once the user confirms a quit, omp-ui stops its processes; neither update choice preserves running work.
On macOS, the wrapper download completes before Squirrel.Mac finishes its native preparation. After `Restart now`, omp-ui immediately displays `Applying update…` and removes the update actions. The app may remain open for several minutes while a large ZIP is prepared, then quits and relaunches automatically. A native preparation failure remains visible as an update error instead of leaving an apparently inert restart control.

`Later` on an available offer remembers that release version during background checks. After an auto-updatable package is staged, `Later` only hides the ready card; it does not remove the staged download or undo `Install when I quit`. A manual check bypasses a remembered dismissal.

### Legacy Linux installs

The project stopped publishing deb, rpm, and standalone Flatpak packages after v0.4.0. Those packages cannot find a same-format asset in current releases, so their old update path fails closed with `expected asset missing from release`.

Migrate once by running the canonical installer:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash
```

After migration, updates use the supported in-place AppImage path. The skipped bridge release and the reason it was safe to remove the three legacy formats are documented in [ADR-0011](adr/0011-appimage-only-linux-distribution.md).

### Managed omp updates

omp-ui updates its managed `omp` binary separately from the desktop application. It checks the npm registry at launch when that check is enabled, or on demand from `Check for omp updates`. A missing binary offers `Install`; an older binary offers `Update now`.

The binary never downloads without that click. omp-ui downloads to a temporary path, verifies that the candidate runs as `omp --version`, and atomically replaces the managed copy. A failure leaves the previous binary in place. Live sessions keep the binary they already started with; only new sessions use the installed version. The omp and omp-ui launch checks have separate switches.

## Publish a release

The [release workflow](../.github/workflows/release.yml) runs for every pushed `v*` tag. The [electron-builder configuration](../packages/desktop/electron-builder.yml) defines the platform targets and the explicit Windows and macOS names. `packaging/install.sh` defines the AppImage name expected by the supported Linux installer.

The tag is the release version. Each platform job strips its leading `v`, compares the result with `packages/desktop/package.json`, and runs the workspace-scoped `npm version <version> --no-git-tag-version` only when they differ. Running from the repository root updates the workspace package and its root lockfile entry together in that job's checkout. The workflow does not create another tag, commit the stamped files, or push them back to the source branch.

The jobs run in this order:

1. `release-linux` runs first on the self-hosted Linux runner. It installs dependencies, runs the repository typecheck and tests, stamps the version, builds the AppImage, and requires exactly one AppImage plus a `latest-linux.yml` that names it and contains SHA-512 metadata. It creates the GitHub release as a **draft** if it does not exist yet, with `--verify-tag`, a title equal to the version without `v`, and empty notes. It then uploads the AppImage and Linux metadata.
2. `release-macos` and `release-windows` both depend on `release-linux`, so they start only after Linux succeeds and may run concurrently.
3. `release-macos` expands to Apple Silicon and Intel jobs. Each installs dependencies, runs the macOS fd-sweep test, stamps the version, rebuilds `node-pty` for its architecture, and packages one DMG and one ZIP. Packaging uses the Developer ID certificate from `CSC_LINK` and `CSC_KEY_PASSWORD`. The release command disables electron-builder's built-in one-attempt notarization. A retrying `notarytool` script then submits the DMG with the Apple credentials, staples the app and DMG, and rebuilds the ZIP around the stapled app. Verification requires one thin app and native module for the requested architecture, a valid Developer ID signature from `APPLE_TEAM_ID`, Gatekeeper acceptance, and a valid app staple. Each job uploads its DMG, ZIP, and architecture-specific SHA-256 manifest.
4. `release-windows` installs dependencies, runs the core and desktop Windows tests, stamps the version, ensures the required Spectre-mitigated MSVC libraries exist, rebuilds `node-pty` for Electron x64, and packages NSIS with certificate discovery disabled. Verification requires the unpacked app, x64 native modules, and ConPTY support files. The job then requires exactly one installer, its matching blockmap, and a `latest.yml` that names the installer and contains SHA-512 metadata before uploading all three. It performs no Authenticode signing; this is the unsigned preview accepted by [ADR-0015](adr/0015-unsigned-windows-nsis-preview.md).
5. `release-manifest` depends on successful Linux, macOS, and Windows jobs. It downloads exactly one AppImage, two DMGs, two ZIPs, and one Windows installer. It rejects duplicate or missing names, writes the sorted six-line `SHA256SUMS.txt`, and uploads it. It then calculates SHA-512 and size for all four macOS files, writes `latest-mac.yml`, and uploads the feed.
6. The manifest job downloads the three published update metadata files and checks their SHA-512 fields and expected distributable names. It also requires the tag version in `latest-mac.yml`. A release is complete only after this boundary check succeeds, after which the job publishes the draft (`gh release edit <tag> --draft=false`) and verifies `isDraft` is false. Until that moment the release is invisible to `releases/latest` and the releases Atom feed, so application updates and `packaging/install.sh` resolve the last completed release rather than the one still building.

Do not rename release files by hand. The updater, installer, workflow assertions, and checksum generation all depend on the names above.

## Related guides

- [Documentation home](README.md)
- [Getting started](getting-started.md)
- [Architecture](architecture.md)
