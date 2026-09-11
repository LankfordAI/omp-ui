# Releases and updates

This guide explains what users receive from a release and how maintainers publish one. For installation, start with [Getting started](getting-started.md). See [Architecture](architecture.md) for the boundary between the persistent host, the Electron desktop client, and the managed `omp` binary.

## Unreleased

- Linux host archives now require and probe an ABI-loadable Secret Service binding. Affected v0.11.0 installs recover relocated Electron `v11` provider credentials on a later boot by reading the legacy password candidates through one bounded worker and deriving the original `userData` path from the migration journal; a locked or missing legacy item remains byte-identical and retryable. Credential workers also finish native teardown before reporting success, avoiding an intermittent packaged-host crash ([#475](https://github.com/LankfordAI/omp-ui/issues/475), [#476](https://github.com/LankfordAI/omp-ui/issues/476), [#477](https://github.com/LankfordAI/omp-ui/issues/477)).

## Choose a download

A release has ten distributable files: six desktop packages and four host archives. Replace `<version>` with the tag version without its leading `v`.

| Platform | Status | File | Use |
|---|---|---|---|
| Linux x64 | Supported | `omp-ui-<version>.AppImage` | Install and run the desktop client |
| Linux x64 | Supported | `omp-ui-host-<version>-linux-x64.tar.gz` | Persistent host: `bin/omp-ui`, `lib/node-pty`, the plan-verifier browser, the systemd unit |
| Windows x64 | Unsigned preview | `omp-ui-<version>-windows-preview-x64-setup.exe` | Per-user NSIS installer |
| Windows x64 | Unsigned preview | `omp-ui-host-<version>-win-x64.zip` | Persistent host: `bin\omp-ui.exe` and the Scheduled Task definition |
| macOS Apple Silicon | Signed preview | `omp-ui-<version>-mac-preview-arm64.dmg` | Install the desktop client |
| macOS Apple Silicon | Signed preview | `omp-ui-<version>-mac-preview-arm64.zip` | Squirrel.Mac update payload |
| macOS Apple Silicon | Signed preview | `omp-ui-host-<version>-mac-arm64.zip` | Persistent host and its LaunchAgent plist |
| macOS Intel | Signed preview | `omp-ui-<version>-mac-preview-x64.dmg` | Install the desktop client |
| macOS Intel | Signed preview | `omp-ui-<version>-mac-preview-x64.zip` | Squirrel.Mac update payload |
| macOS Intel | Signed preview | `omp-ui-host-<version>-mac-x64.zip` | Persistent host and its LaunchAgent plist |

A desktop package embeds its platform's host archive contents at `resources/host/<version>/`, so installing the desktop client installs a host; the standalone host archive is for a machine that runs omp-ui as a service without a desktop client, and for the host's own update feed. Each host archive unpacks to one version directory — `bin/omp-ui` (`bin\omp-ui.exe`), `lib/node-pty/`, `lib/` credential-worker and keyring bindings, `resources/plan-verifier/` with its `browser.manifest.json`, `resources/verifier-page/`, `resources/web/` (the browser client), and `service/` with the rendered supervisor definition — that the installer or the desktop client places under `<dataHome>/omp-ui-host/versions/<version>/` and points `current` at. See [Getting started](getting-started.md#the-host-command-and-service) for the installed layout and the `omp-ui` command.

[GitHub Releases](https://github.com/LankfordAI/omp-ui/releases/latest) is the application download and update channel. The Windows x64 work is recorded in [issue #125](https://github.com/LankfordAI/omp-ui/issues/125), and [ADR-0015](adr/0015-unsigned-windows-nsis-preview.md) keeps that installer an unsigned preview. Windows therefore reports an unknown publisher. The macOS packages are Developer ID signed and notarized previews. [Issue #124](https://github.com/LankfordAI/omp-ui/issues/124) remains open until their physical-Mac update checks and supported-release gate are complete.

Linux uses AppImage as its sole first-party supported format. Community packages may exist, but the project does not support them. The policy and cutover history are recorded in [ADR-0011](adr/0011-appimage-only-linux-distribution.md).

Install or repair the supported Linux release without root:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash
```

The installer verifies the AppImage against `SHA256SUMS.txt`, writes it to `~/.local/bin/omp-ui.AppImage`, and creates the per-user desktop entry and icons. Before touching an existing install it verifies the Electron binary's system shared-library dependencies on the staged AppImage and, if any are unresolvable, stops with the exact `sudo apt install …` command to run first. The AppImage is built with the static AppImage runtime (no FUSE2 dependency), and the installer's menu entry falls back to the runtime's extract-and-run mode when the system provides no FUSE mount support.

## Understand the release files

The ten distributables ship with ten supporting files, for 20 release assets in total:

- `latest-linux.yml` names the AppImage and supplies its SHA-512 update metadata. The AppImage blockmap is embedded, so Linux does not publish a separate blockmap file.
- `latest.yml` names the Windows installer and supplies its SHA-512 update metadata.
- `omp-ui-<version>-windows-preview-x64-setup.exe.blockmap` supports the NSIS differential download.
- `latest-mac.yml` names both DMGs and both ZIPs, with their sizes and SHA-512 digests. The matching ZIP is the Squirrel.Mac update payload for each architecture.
- `latest-host-linux.yml`, `latest-host-mac.yml`, and `latest-host-win.yml` are the host's update feeds, one per platform: `version`, `releaseDate`, and a `files` list with each architecture's archive `url`, `sha512`, `size`, and `arch` (the macOS feed lists both architectures). A running host reads the feed for its platform from `releases/latest/download/`, so a draft is invisible to it.
- `SHA256SUMS.txt` contains one SHA-256 line for each of the ten distributables.
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

## How updates behave

Three things update on their own schedule: the persistent host, the desktop client, and the managed `omp` binary. Each has its own feed, launch-check switch, card, and dismissal record. Drafts and prereleases never qualify for any of them, and every download is verified before anything is offered.

### Host updates

The host checks `latest-host-<platform>.yml` for its platform at launch (when the launch check is enabled) and on demand from **Settings → Updates**; the check, download, defer, apply, and rollback controls are host channels, so the desktop app and a browser see the same state and either can drive it. A newer release is downloaded, SHA-512-verified, and unpacked under `<dataRoot>/updates/host-<version>/` before the card appears.

Applying is a handover, not a restart of the window you are looking at. When nobody is connected and no session is live, a staged release applies immediately. Otherwise every connected client sees one shared countdown (two minutes) with **Apply now** and **Defer**; deferrals are bounded (three, thirty minutes in total), after which the countdown runs out. Apply hibernates every live session — transcripts and worktrees stay on disk, no process survives — drains the listeners, and starts the new version, which must claim the data root, load the registry, hydrate sessions, and answer an authenticated probe before the old process switches the `current` pointer and exits. If the new version never acknowledges, the old one kills it and reclaims the root; you keep the version you had. Exactly one previous version is retained, and `omp-ui rollback` (or the Settings action) runs the same handover towards it. Data migrations are never reversed by a rollback. Remote browser clients reconnect to the new host on their own; the desktop client reconnects through its host bootstrap.

### Desktop client updates

Packaged Linux, Windows, and macOS desktop builds check the latest stable GitHub release in the background at launch when the omp-ui launch check is enabled. The command palette can run the check on demand. Background lookup, metadata, and download failures stay silent, as do no-update results. An on-demand check reports its staging progress and failures. Development builds and builds without a valid stamped version do not check.

AppImage, NSIS, and macOS installs use `electron-updater`. A background check downloads and verifies a newer release before the update card appears:

- AppImage uses `latest-linux.yml` and its embedded blockmap.
- NSIS uses `latest.yml` and the matching `.exe.blockmap`.
- macOS uses `latest-mac.yml`; Squirrel.Mac applies the ZIP that matches the Mac's architecture.

A staged update does not install silently. `Restart now` quits, installs, and relaunches the desktop client; `Install when I quit` arms the staged update for the next natural quit and can be undone. Because the desktop app is a client, neither choice touches a live session: the host and its sessions keep running while the window is away, and the relaunched client reconnects. A desktop update never writes the installed or running host — the embedded host it carries is used only when no host is installed at all.
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

The host updates the managed `omp` binary separately from itself and from the desktop client. It checks the npm registry at launch when that check is enabled, or on demand from `Check for omp updates`. A missing binary offers `Install`; an older binary offers `Update now`.

The binary never downloads without that click. The host downloads to a temporary path, verifies that the candidate runs as `omp --version`, and atomically replaces the managed copy under `<dataRoot>/omp`. A failure leaves the previous binary in place. Live sessions keep the binary they already started with; only new sessions use the installed version. The three launch checks have separate switches.

## Publish a release

The [release workflow](../.github/workflows/release.yml) runs for every pushed `v*` tag. The [electron-builder configuration](../packages/desktop/electron-builder.yml) defines the desktop platform targets and the explicit Windows and macOS names; `packages/host/scripts/package-host.mjs` defines the host archive names and `scripts/release-artifacts.mjs` classifies every asset. `packaging/install.sh` defines the AppImage name expected by the supported Linux installer.

The tag is the release version. Each platform job strips its leading `v`, compares the result with `packages/desktop/package.json`, and runs the workspace-scoped `npm version <version> --no-git-tag-version` only when they differ. Running from the repository root updates the workspace package and its root lockfile entry together in that job's checkout. The workflow does not create another tag, commit the stamped files, or push them back to the source branch.

The jobs run in this order:

1. `release-linux` runs first on the self-hosted Linux runner. It installs dependencies, runs the repository typecheck and tests, stamps the version, fetches the verifier browser, builds the product, and runs `npm run build:secret-service -w @omp-ui/host` before `package:host`. The package smoke executes both hidden ABI probes from the unpacked archive, including the platform credential-binding probe, then boots `serve` on a temporary root, probes `status --json`, runs `stop`, and writes a schema-2 package evidence record. The record reports the live credential backend only as diagnostic data and records `credentials.binding: "loadable"`; an unlocked keyring is not required on the headless runner. The job then builds the AppImage with the host's `seed/<version>` embedded as `resources/host/<version>` and requires the matching update metadata, host archive, feed, and package record before upload.
2. `release-notes` depends on `release-linux`, so it starts once the draft exists and runs while the macOS and Windows builds are in flight. It checks out the full history, resolves the previous tag with `git describe --tags --abbrev=0 <tag>^`, lists the PRs merged between the two tags, groups commits by the issue or PR their subjects reference, lifts the tag's `## Unreleased` bullets into `## Highlights`, and writes the result into the draft. A failure of this job never blocks publishing: a published release with no notes beats a finished release stranded in draft, where the updater cannot see it.
3. `package-macos` and `release-windows` depend on `release-linux`, so they start only after Linux succeeds and may run concurrently.
4. `package-macos` is the reusable macOS packaging workflow, expanded to Apple Silicon and Intel. Each run installs dependencies, runs the macOS fd-sweep test, stamps the version, and runs the same host lane: fetch, build, `package:host --lane mac-<arch>`, then `smoke:package --record`. The smoke gate requires the packaged Keychain binding to load. Packaging uses the Developer ID certificate from `CSC_LINK` and `CSC_KEY_PASSWORD`. The release command disables electron-builder's built-in one-attempt notarization. A retrying `notarytool` script then submits the DMG with the Apple credentials, staples the app and DMG, and rebuilds the ZIP around the stapled app. Verification requires one thin app for the requested architecture, a valid Developer ID signature from `APPLE_TEAM_ID`, a stapled ticket, and a clean Gatekeeper assessment. Each lane uploads its package record for the manifest job.
5. `release-windows` installs dependencies, runs the core and desktop Windows tests, stamps the version, ensures the required Spectre-mitigated MSVC libraries exist, and runs the host lane for `win-x64`. The package smoke requires the packaged DPAPI binding to load before the job embeds the host and packages NSIS. Verification requires the unpacked app and ConPTY support files. The job then requires exactly one installer, its matching blockmap, a `latest.yml` that names the installer and contains SHA-512 metadata, the host archive, and `latest-host-win.yml` before uploading them, and publishes `package-record-win-x64`. It performs no Authenticode signing; this is the unsigned preview accepted by [ADR-0015](adr/0015-unsigned-windows-nsis-preview.md).
6. `release-manifest` depends on every packaging job and waits for `release-notes` to finish without gating on its result. It downloads exactly one AppImage, two DMGs, two ZIPs, one Windows installer, and four host archives. It rejects duplicate or missing names, writes the sorted ten-line `SHA256SUMS.txt`, and uploads it. It then calculates SHA-512 and size for all four macOS desktop files, writes `latest-mac.yml`, composes `latest-host-mac.yml` from both macOS host archives (`node scripts/host-feed.mjs`), and uploads both feeds. It consumes every `package-record-*` artifact and refuses records that are not schema 2, lack `credentials.binding: "loadable"`, report a skipped or failed smoke step, name the wrong architecture, or come from a source-tree run.
7. The manifest job downloads the six published update metadata files and checks their SHA-512 fields and expected distributable names. It also requires the tag version in `latest-mac.yml` and each host feed. A release is complete only after this boundary check succeeds, after which the job publishes the draft (`gh release edit <tag> --draft=false`) and verifies `isDraft` is false. Until that moment the release is invisible to `releases/latest` and the releases Atom feed, so host and desktop updates and `packaging/install.sh` resolve the last completed release rather than the one still building.

Do not rename release files by hand. The updater, installer, workflow assertions, and checksum generation all depend on the names above.

### Write the release highlights

Each release's Highlights come verbatim from the `## Unreleased` section of this document at the tag's commit. Before cutting the tag, give every shipped change one bullet there, in [`CONTEXT.md`](../CONTEXT.md) vocabulary, citing its issue as `#N`. Clear those bullets in the same version-stamp commit that precedes the tag. The generator also drops a lifted bullet whose issues all already appear in the previous release's notes, so forgetting to clear costs a duplicate only once. A bullet may link to a document relative to this file, for example `[ADR-0026](adr/0026-glass-chrome-via-backdrop-filter.md)`; the generator rewrites each such target to `https://github.com/<owner>/<repo>/blob/<tag>/docs/<target>`, leaving absolute URLs and `#anchor` targets untouched. Keep writing them relative so the local link check in [development.md](development.md) § Documentation-only changes still applies.

Every release published before the [Release Notes](../.github/workflows/release-notes.yml) workflow existed has an empty body. Run that workflow from *Actions → Run workflow* with the release's tag and `force: true` to regenerate its notes; a run without `force` leaves human-written notes untouched.

## Related guides

- [Documentation home](README.md)
- [Getting started](getting-started.md)
- [Architecture](architecture.md)
