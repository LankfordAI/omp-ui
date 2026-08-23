# Getting started

Install omp-ui, connect a model provider, register a project, and start your first session. omp-ui can install its own `omp` binary, so you do not need to install the CLI first.

## Platform status

| Platform | Status | Release package |
| --- | --- | --- |
| Linux x64 | Supported | AppImage |
| Windows x64 | Preview | Unsigned per-user NSIS installer |
| macOS Apple Silicon and Intel | Preview | Developer ID signed and notarized DMG |

Linux AppImage is the supported release. Windows and macOS builds are previews.

## Install on Linux

The download flow needs `bash`, `curl`, and `sha256sum`. It runs without root, verifies the AppImage against the release's `SHA256SUMS.txt`, installs it as `~/.local/bin/omp-ui.AppImage`, and adds an application-menu entry.

**Prerequisites.** Linux x64 is required: the Linux build is x64-only, and the installer refuses any other architecture before downloading. No FUSE setup is required for the application-menu launch: the AppImage uses the static AppImage runtime (no FUSE2/libfuse2 dependency), and the menu entry the installer writes falls back to the runtime's extract-and-run mode automatically when the system provides no FUSE mount support. omp-ui links standard desktop GUI libraries (GTK, NSS, audio, X11/Wayland) that come from the distribution. The installer verifies them and, if any are missing, stops *before changing anything* and prints the exact `sudo apt install …` command to run first.

Install the latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash
```

Install a specific release. Replace the example version if needed:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash -s -- --version v0.8.11
```

Install an AppImage that is already on disk:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash -s -- --binary "$HOME/Downloads/omp-ui-0.8.11.AppImage"
```

`--binary` copies the file you provide and does not verify it against the release checksum. Verify a downloaded AppImage before using this option.

To repair the current installation, run the latest-release command again. The installer replaces the AppImage and rewrites its desktop entry and icons. To repair while staying on a specific release, run the `--version` command with that release number.

Uninstall the application and desktop integration while keeping `~/.config/@omp-ui/desktop`:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash -s -- --uninstall
```

Uninstall and also remove that user-data directory:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash -s -- --uninstall --purge
```

Launch **omp-ui** from your application menu after installation.

## Install the Windows preview

Windows previews are x64 only. Download these two files from the [latest GitHub release](https://github.com/LankfordAI/omp-ui/releases/latest):

- `omp-ui-<version>-windows-preview-x64-setup.exe`
- `SHA256SUMS.txt`

GitHub Releases in this repository is the trusted download source. The installer is not published to npm.

Open PowerShell in the download directory and verify the one installer you downloaded:

```powershell
$installer = @(Get-ChildItem -File "omp-ui-*-windows-preview-x64-setup.exe")
if ($installer.Count -ne 1) { throw "Keep exactly one Windows preview installer in this directory" }
$installer = $installer[0]
$entry = @(Get-Content .\SHA256SUMS.txt | Where-Object {
  $parts = $_ -split '\s+', 2
  $parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $installer.Name
})
if ($entry.Count -ne 1) { throw "No unique checksum entry for $($installer.Name)" }
$expected = ($entry[0] -split '\s+', 2)[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 mismatch for $($installer.Name)" }
"SHA-256 OK: $($installer.Name)"
```

Continue only after PowerShell prints `SHA-256 OK`. The checksum protects the downloaded bytes but does not establish publisher identity.

Run the installer. Windows reports **Unknown publisher** because this preview is unsigned. In SmartScreen, select **More info**, then **Run anyway**. Never disable SmartScreen or Defender to install omp-ui.

The assisted installer installs for the current user without administrator elevation and lets you choose the installation directory.

## Install the macOS preview

Choose the DMG that matches your Mac from the [latest GitHub release](https://github.com/LankfordAI/omp-ui/releases/latest):

- Apple Silicon, including M-series processors: `omp-ui-<version>-mac-preview-arm64.dmg`
- Intel: `omp-ui-<version>-mac-preview-x64.dmg`

Download `SHA256SUMS.txt` beside the DMG. Verify only the asset you selected. For Apple Silicon, run:

```bash
grep 'omp-ui-.*-mac-preview-arm64\.dmg$' SHA256SUMS.txt | shasum -a 256 -c -
```

For an Intel DMG, change `arm64` to `x64`. Continue only when the selected DMG reports `OK`.

Open the DMG and drag **omp-ui** to **Applications**. Release builds are Developer ID signed and notarized, so they need no Gatekeeper override. If macOS rejects a current release build, stop. Do not remove quarantine attributes or bypass Gatekeeper.

## Complete first launch

1. Open omp-ui and select the gear button to open **Settings**.
2. Open **Updates**. Under **omp binary**, select **Check now**. If omp is missing, select **Install**. If an update is offered, select **Update now**.
3. Open **Providers**. Confirm that at least one model provider has a credential. omp-ui may find one in the inherited environment or, on Linux and macOS, the login shell. Otherwise, select **Add key** for your provider and save its API key.
4. Close Settings and select **Add project**. Enter or browse to the working directory you want omp to use, then select **Add project**.
5. Start a tab from the project header:
   - For a native transcript tab, select **New session**. A fresh install uses native as its default session mode.
   - For an embedded OMP terminal tab, right-click the project's plus button and select **New terminal session**. In the compact layout, open the project's actions menu and select **New terminal session**.

Native tabs render the session transcript in omp-ui. Terminal tabs run OMP's TUI in an embedded terminal. Both create owned sessions attached to the registered project. See the [user guide](user-guide.md) for session controls and the difference between owned sessions and sessions started from an external terminal.

## Understand the omp binary boundary

The omp binary installed from **Settings > Updates** is private app data. omp-ui uses that managed copy for its sessions and does not place it on your shell `PATH`. Installing or updating it in omp-ui does not make an `omp` command available in a separate terminal.

Open **Settings > About** to see the omp-ui version, omp version, resolved omp path, and omp config directory. If installation succeeds but a session cannot start, use the [troubleshooting guide](troubleshooting.md).

## Related guides

- [Documentation home](README.md)
- [User guide](user-guide.md)
- [Settings reference](settings.md)
- [Troubleshooting](troubleshooting.md)
- [Releases and updates](releases.md)
