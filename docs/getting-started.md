# Getting started

Install omp-ui, connect a model provider, register a project, and start your first session. omp-ui can install its own `omp` binary, so you do not need to install the CLI first. Installing the desktop app also installs the **persistent host** — the background process that owns your sessions — so nothing else is required for a normal desktop install; the [host command and service](#the-host-command-and-service) section covers running it without a desktop, as a login service, or on a machine with no display.

## Platform status

| Platform | Status | Release package |
| --- | --- | --- |
| Linux x64 | Supported | AppImage |
| Windows x64 | Preview | Unsigned per-user NSIS installer |
| macOS Apple Silicon and Intel | Preview | Developer ID signed and notarized DMG |

Linux AppImage is the supported release. Windows and macOS builds are previews.

## Install on Linux

The download flow needs `bash`, `curl`, and `sha256sum`. It runs without root, verifies the AppImage against the release's `SHA256SUMS.txt`, installs it as `~/.local/bin/omp-ui.AppImage`, writes the launcher `~/.local/bin/omp-ui-desktop` (which starts the AppImage with the right FUSE fallback), and adds an application-menu entry that runs that launcher. `~/.local/bin/omp-ui` is reserved for the host command described below; an older installer's wrapper at that path is removed on upgrade so the host can take it.

**Prerequisites.** Linux releases support x64 Ubuntu 24.04 LTS, the current Fedora release, and an Arch-derived distribution. Other modern x64 glibc desktop distributions may work, but they are outside the supported release matrix. The installer refuses other architectures before downloading.

No FUSE setup is required for application-menu launches. The AppImage uses the static AppImage runtime and has no FUSE2 or libfuse2 dependency. The menu entry falls back to the runtime's extract-and-run mode when the system has no FUSE mount support.

omp-ui links standard desktop GUI libraries such as GTK, NSS, audio, X11, and Wayland from the distribution. Before changing an installation, the installer asks the host's dynamic linker to resolve those libraries. If any are unresolved, it stops and prints the full resolver output with general package-manager guidance. Package names vary by distribution, so the installer does not promise an exact install command.

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

Uninstall the application and desktop integration while keeping your data (the host's data root `~/.local/share/omp-ui` and the client's `~/.config/@omp-ui/desktop`):

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash -s -- --uninstall
```

Uninstall and also remove that user data:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash -s -- --uninstall --purge
```

Uninstalling the desktop app leaves an installed host and its service alone; stop and remove those with `omp-ui service uninstall` (add `--purge-data --yes` to delete the data root as well) before or after.

Launch **omp-ui** from your application menu after installation. The first launch after installing finds no running host, installs the host the app carries, starts it through your login session's service manager, and connects; a plain status surface shows the phase (`probing`, `installing`, `starting`), the data root, the client and host log directories, the host version and pid, and the service manager in use, and boots the app by itself once the host is ready. If the host cannot start it stays on that surface with **Retry**, **Stop host**, and **Roll back**.

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

Upgrading from a release that had no host: the first launch hands your existing data to the new host once — projects, sessions, stored provider keys, joined instances, worktree checkouts, and logs move from the app's `userData` into the host's data root, and stored credentials are re-encrypted under the host's own key in your OS credential store (Secret Service, Keychain, or DPAPI). The move is journalled and resumable; if the credential store is locked at the time, the host keeps serving and finishes that step on its next start. Nothing is copied twice and no plaintext is written. See [Troubleshooting](troubleshooting.md#the-host-will-not-start-or-the-app-cannot-reach-it) if the app reports a migration or authority conflict.

1. Open omp-ui and select the gear button to open **Settings**.
2. Open **Updates**. Under **omp binary**, select **Check now**. If omp is missing, select **Install**. If an update is offered, select **Update now**.
3. Open **Providers**. Confirm that at least one model provider has a credential. omp-ui may find one in the inherited environment or, on Linux and macOS, the login shell. Otherwise, select **Add key** for your provider and save its API key.
4. Close Settings and select **Add project**. Enter or browse to the working directory you want omp to use, then select **Add project**.
5. Start a tab from the project header:
   - For a native transcript tab, select **New session**. A fresh install uses native as its default session mode.
   - For an embedded OMP terminal tab, right-click the project's plus button and select **New terminal session**. In the compact layout, open the project's actions menu and select **New terminal session**.

Native tabs render the session transcript in omp-ui. Terminal tabs run OMP's TUI in an embedded terminal. Both create owned sessions attached to the registered project. See the [user guide](user-guide.md) for session controls and the difference between owned sessions and sessions started from an external terminal.

## Understand the omp binary boundary

The omp binary installed from **Settings > Updates** is private app data, kept by the host under its data root. The host uses that managed copy for its sessions and does not place it on your shell `PATH`. Installing or updating it in omp-ui does not make an `omp` command available in a separate terminal.

Open **Settings > About** to see the omp-ui version, omp version, resolved omp path, and omp config directory. If installation succeeds but a session cannot start, use the [troubleshooting guide](troubleshooting.md).

## The host command and service

The desktop app is a client. The process that owns your projects, sessions, credentials, and remote access is the persistent host, `omp-ui serve`; a browser on another device and the desktop window are both views of it. The desktop app installs the host for you and starts it on demand, so most users never run these commands. Run them when you want the host to survive logout or reboot, to run omp-ui on a machine with no display, or to inspect or stop it.

### Installed layout

| Platform | Host versions | Active version | Stable command | Data root |
| --- | --- | --- | --- | --- |
| Linux | `~/.local/share/omp-ui-host/versions/<version>/` (`$XDG_DATA_HOME` when set) | `~/.local/share/omp-ui-host/current` → a version directory | `~/.local/bin/omp-ui` → `current/bin/omp-ui` | `~/.local/share/omp-ui/` |
| macOS | `~/Library/Application Support/omp-ui-host/versions/<version>/` | `~/Library/Application Support/omp-ui-host/current` | `~/.local/bin/omp-ui` | `~/Library/Application Support/omp-ui/` |
| Windows | `%LOCALAPPDATA%\omp-ui-host\versions\<version>\` | `%LOCALAPPDATA%\omp-ui-host\bin` — a junction to the active version's `bin` | `%LOCALAPPDATA%\omp-ui-host\bin\omp-ui.exe` | `%LOCALAPPDATA%\omp-ui\` |

A version directory holds `bin/omp-ui` (the Node single executable), `lib/node-pty`, the credential worker, `resources/plan-verifier` (the pinned headless Chrome the plan preflight uses), and `service/` with the rendered service definition. The data root holds `registry.json`, the encrypted `provider-keys.json` and `remote-instances.json`, `worktrees/`, `logs/`, `updates/`, the managed omp, and the host's own `host.lock`, `host.json` (its local endpoint and credentials, readable only by you), `migration.json`, and `runtime/`. The desktop app's own `userData` (`~/.config/@omp-ui/desktop` on Linux) keeps only window state, the Chromium profile, and client logs. On Linux the AppImage stays at `~/.local/bin/omp-ui.AppImage` and its launcher at `~/.local/bin/omp-ui-desktop` ([ADR-0011](adr/0011-appimage-only-linux-distribution.md)); `omp-ui desktop` runs the launcher when it exists, else the AppImage.

### The `omp-ui` command

| Command | What it does |
| --- | --- |
| `omp-ui serve` | Runs the host in the foreground against the data root. It never daemonizes; the service definitions below run exactly this. Ctrl-C or SIGTERM hibernates live sessions and exits cleanly. |
| `omp-ui status [--json]` | Reads `host.json` and `host.lock`, probes the host with a two-second authenticated request, and reports its runtime, owner, versions and protocol range, staged update, last update attempt, rollback target, verifier health, credential backend, service state, and log directory. It never opens the registry, so it is safe while the host runs. |
| `omp-ui pair [--all] [--json]` | Prints the sign-in URL for a running host's remote access — the password URL when a password is set, the token URL otherwise, or the loopback URL when remote access is off. `--all` also prints the token URLs, labelled as full-access credentials. Never prints the desktop credential. |
| `omp-ui stop [--timeout <s>]` | Asks the host to hibernate its sessions, stop shells, drain its listeners, and exit; waits up to the timeout (default 30 s). Never force-kills. A host that is not running counts as success. |
| `omp-ui rollback` | Asks the host to hand over to its retained previous version (see [Releases](releases.md#host-updates)). |
| `omp-ui service install` | Writes the platform's service definition for the current user and starts it. |
| `omp-ui service status [--json]` | Reports whether the definition exists, whether it is omp-ui's own, whether it is running, and the host report above. |
| `omp-ui service uninstall [--purge-data --yes]` | Stops the host, then removes the definition. The data root is preserved unless both `--purge-data` and `--yes` are given. |
| `omp-ui desktop` | Launches the installed desktop client: `~/.local/bin/omp-ui-desktop` or the AppImage on Linux, `/Applications/omp-ui.app` on macOS, the NSIS install on Windows. |
| `omp-ui` (no command) | Launches the desktop client when it is installed; otherwise prints this help and exits 0. |

Exit codes are fixed so scripts can branch on them:

| Code | Meaning |
| --- | --- |
| `0` | Completed, or the host is healthy. |
| `1` | Another operational failure. |
| `2` | Usage or configuration error. |
| `3` | Absent: no host is running for this data root. |
| `4` | Present but unhealthy, unresponsive, or incompatible with this command's protocol. |
| `5` | Authority conflict: another process owns the data root, or a pre-host omp-ui refused to open a root a host has claimed. |
| `6` | Unsupported platform, unavailable service manager, or a permission failure (for example lingering could not be enabled, or another program's definition sits at omp-ui's path). |

`OMP_UI_DATA_DIR` points every command at a different data root; without it the command uses the platform's default above.

### Run the host as a service

Without a service, the desktop app starts the host on demand as a transient job in your login session — `systemd-run --user` on Linux, `launchctl submit` on macOS, a one-shot Scheduled Task on Windows — and the host lives until you stop it or log out. `omp-ui service install` promotes that same identity to a definition that starts at login:

| Platform | Definition | Lifetime |
| --- | --- | --- |
| Linux | `~/.config/systemd/user/omp-ui-host.service` — `Restart=on-failure`, `RestartSec=5`, five starts per minute. `install` runs `loginctl enable-linger` for your user and refuses (exit 6) unless it can prove `Linger=yes`. | Starts at boot and survives logout, because of lingering. `systemctl --user status omp-ui-host` and `journalctl --user -u omp-ui-host` show it. |
| macOS | `~/Library/LaunchAgents/ai.lankford.omp-ui.host.plist` — `RunAtLoad`, `KeepAlive` on unsuccessful exit, 10 s throttle. | From login to logout for that user. macOS has no user-level linger and omp-ui installs no LaunchDaemon, so the host stops when you log out. |
| Windows | Scheduled Task `\LankfordAI\omp-ui Host` — current user, at logon, interactive token, least privilege, five one-minute retries. | While that user is logged on. No Session 0 service is created. |

On every platform the definition runs the stable command's `serve` with `OMP_UI_DATA_DIR` set to the default data root. `service install` converges: an identical definition is left alone, an omp-ui-owned one is rewritten, and a definition owned by something else is refused rather than replaced. `service uninstall` stops the host first and never orphans a running one.

The host's credential store must be reachable from the session it runs in. On Linux that is Secret Service (the GNOME keyring or KWallet's Secret Service interface) in your user session; on macOS your login Keychain; on Windows DPAPI for your account. When the store is locked or absent at start — a lingering systemd service before your first login is the common case — the host still starts and serves sessions, but reports a degraded credential backend in `omp-ui status`: stored provider keys are not injected, and saving a key or joining a remote instance is refused until the store is available. Keys inherited from the service's environment and, on Linux and macOS, captured from your login shell still apply.

The plan preflight runs a headless Chrome inside the host. It needs Chrome's own sandbox — omp-ui never disables it — which on Linux means unprivileged user namespaces (`sysctl kernel.unprivileged_userns_clone=1` or `user.max_user_namespaces` above zero on distributions that gate them) and at least one installed font family for layout measurement. Without either, sessions and plans still work, but every HTML plan proposal answers `VERIFIER_UNAVAILABLE` until the machine is fixed; `omp-ui status` names the reason under `verifier`.

macOS and Windows service behaviour is implemented to this specification and exercised in continuous integration only on the release matrix (signed and notarized macOS builds, the current-user Scheduled Task context on Windows); Linux is the supported platform.

## Related guides

- [Documentation home](README.md)
- [User guide](user-guide.md)
- [Settings reference](settings.md)
- [Troubleshooting](troubleshooting.md)
- [Releases and updates](releases.md)
