# Troubleshooting

Start with the symptom you see. These checks use app status and supported controls. Do not edit omp-ui's registry, session JSONL files, stored credential files, or the host's `host.lock`, `host.json`, and `migration.json`.

When an app problem needs a report, export a diagnostic bundle first: **Settings → Advanced → Export diagnostic bundle…**, or the command palette's **Export diagnostic bundle…**. The zip collects the host's logs, lifecycle breadcrumbs, versions, registry state, and per-project git status in one file, with credentials scrubbed and transcripts excluded unless you tick that option ([Settings → Advanced](settings.md#advanced)). For a host or app that never starts, there is no dialog to reach — fall back to `omp-ui status` and the raw log paths below.

Two processes are involved. The **host** (`omp-ui serve`) owns sessions and logs to `<dataRoot>/logs/main.log` and `<dataRoot>/logs/breadcrumbs.log` (`~/.local/share/omp-ui/logs` on Linux; the service manager also captures its stdout — `journalctl --user -u omp-ui-host` on Linux, `<dataRoot>/logs/host.log` on macOS). The **desktop app** is a client and logs to its own `userData` (`~/.config/@omp-ui/desktop/logs/main.log` on Linux). `omp-ui status` prints both directories.

## `omp` is missing or a new session exits

### Cause

omp-ui normally runs its managed `omp` binary, kept by the host under its data root. If no managed copy exists, the host can fall back to its own `PATH` and known install locations. A host started by a service manager does not necessarily have the same `PATH` as an interactive shell, so `omp --version` in a terminal may test a different binary.

### Check

Open Settings → About. The **omp path** row is the binary omp-ui selected, and the **omp version** row is the version it read. Then open Settings → Updates and check the **omp binary** status. The About path is authoritative for the app.

A managed copy takes precedence over a copy on `PATH`. If About shows a valid binary but the new session reports that no model provider is configured, continue with [A provider or model is missing after desktop launch](#a-provider-or-model-is-missing-after-desktop-launch).

### Fix

On Settings → Updates, choose **Install** when the binary is missing or **Update now** when an update is offered. The app verifies the download before replacing its managed copy. New sessions use the installed binary; a live session keeps the process it already started.

`OMP_UI_OMP_PATH` is only a development override for testing a local `omp` build. It takes precedence over the managed copy. Do not use it to repair an installed app. Developers can find the development workflow in the [development guide](development.md).

## A provider or model is missing after desktop launch

### Cause

Provider keys enter a session's environment when `omp` starts, from the host's environment. A host started by the service manager or the desktop app may not inherit exports from an interactive shell. On Linux and macOS, the host also captures supported provider variables from the login shell once at startup. Windows has no login-shell capture. A key added after a session started cannot change that running process.

### Check

Open Settings → Providers. If the project already has a session, focus it first so the page can report that project's `.env` source. Each configured row has a source chip:

- `saved here` means the host stored the key, encrypted under its own key in the OS credential store.
- `environment` means the host process inherited it.
- `shell profile` means startup login-shell capture found it on Linux or macOS.
- `project .env` means omp-ui found a key in the focused project's dotenv files. omp loads those files itself; omp-ui only reports the key.

A row without a source chip is not configured for that scope. A search-provider key does not provide a model.

### Fix

Add the model provider key through Settings → Providers. If the write is refused with a degraded credential backend, the host could not reach the OS credential store when it started — Secret Service in your user session on Linux, the login Keychain on macOS, DPAPI on Windows. Confirm with `omp-ui status` (`credentialBackend`), unlock or start the store, then `omp-ui stop` and reopen omp-ui so the host starts again with the store available. A host installed as a lingering systemd service starts before your first login and stays degraded until it is restarted inside a session with a keyring; keys inherited from its environment still apply. On Linux or macOS you can instead export the supported variable from the login shell profile and restart the host. On Windows, set it as a user environment variable and restart the host. Do not edit omp-ui's credential storage.

Spawn a new session after the source chip appears. Existing live sessions keep their original environment. Do not re-enter a key already reported as `project .env`; it already applies to sessions spawned in that project. See [Settings](settings.md#providers) for source priority and storage behavior.

## A remote URL is unavailable

### Cause

Remote access works only while the host is running — not the desktop window, which is just one client. The default `localhost` bind is reachable from the same machine only. Other supported causes appear in Settings as a stopped listener, a port conflict, or a missing browser bundle in a development checkout.

### Check

Open Settings → Remote access. Confirm that remote access is enabled and the status says **listening on** the expected port. Copy the displayed **Connection URL** rather than reconstructing it, or run `omp-ui pair`. For another device, confirm that **Bind address** is **local network**. If the status is an error, use the message shown there; `port … is already in use` identifies a port conflict. `omp-ui status` exiting 3 means no host is running at all.

A packaged release includes the browser bundle. A `503` response that says the bundle is missing applies to a development build.

### Fix

Keep the host running; installing it as a service ([Getting started](getting-started.md#run-the-host-as-a-service)) keeps remote access up after the window closes or you log out. For another device, change the bind address to **local network**, then use the newly displayed connection URL. Choose another port in the supported range if the current port is in use.

For a development checkout with a missing bundle, run this exact command from the repository root:

```bash
npm run build:web --workspace @omp-ui/desktop
```

Restart the development host after the build so it sees the bundle. Remote access uses plain HTTP; read the exposure and sign-in guidance before enabling a LAN bind in [Remote access](remote-access.md).

## A dismissed update card does not return

### Cause

Choosing **Later** remembers the dismissal for that exact offered version. Host updates, desktop-app updates, and managed `omp` updates have separate cards, launch-check switches, and dismissal records.

### Check

Open Settings → Updates. Inspect the host, desktop, and omp binary sections separately. A remembered offer appears as **Dismissed:** followed by its version. The status line also reports manual check errors, available updates, and the installed version; the host section also reports its staged version, the last attempt, and the rollback target.

### Fix

Choose **Re-offer** in the matching section. It clears that dismissal and immediately checks again. Use **Check now** when there is no dismissed row. A dismissal never suppresses a later version.

See [Releases](releases.md#how-updates-behave) for the host handover, the desktop update paths on Linux and the Windows and macOS previews, and rollback.

## A session is absent from the sidebar

### Cause

The sidebar lists owned sessions only: sessions launched by omp-ui and sessions produced in the same process by `/new` or `/branch`. A session launched by running `omp` in a terminal is outside that scope, even when its working directory is a registered project.

A sidebar filter can also hide a matching project or session. Longer project lists show a **show more** control.

### Check

Clear the sidebar filter, expand the project, and choose **show more** if it appears. Confirm that the project path is registered and that omp-ui launched the session. Closing a tab only hides its view; its owned session remains in the sidebar, and selecting it resurfaces the tab.

### Fix

Register the project, then start the session from its **New session**, **New terminal session**, or **New worktree session** action. omp-ui does not import terminal-created history. Do not add records to the registry or move or edit session JSONL files to make one appear.

See [Projects and sessions](user-guide.md#projects-and-sessions) for the owned-session scope and sidebar controls.

## A Plan, advisor, omp, Memory, provider, or MCP change looks stale

### Cause

These controls apply at different times. Settings → General also contains defaults for future sessions, while each live session has its own Plan and advisor state. omp and Memory values are layered, and a project value can override a global value saved through Settings.

### Check

Use the timing category for the control you changed:

| Control | When it applies | What to check |
| --- | --- | --- |
| Advisor auto-reply | Immediately in open native transcript tabs | This controls replies to late advisor findings, not whether the advisor is enabled. |
| Plan format | The next time a native session enters Plan mode | It does not rewrite a plan already in progress. |
| Default agent mode | A new native session | It does not change a live or resumed session or a terminal tab. |
| Default compaction method | A fresh native session captures it; later resumes reuse that capture | It does not change a live session or any terminal-origin session. “omp configured default” defers to omp's global/project `compaction.methodOrder`. The method list (and its descriptions) tracks the installed omp binary, so an omp update can add or remove methods; a captured method the binary no longer publishes is ignored at spawn and the session defers to omp's configured order. |
| Default advisor | A new session with no remembered advisor state for that project | A project's last-used advisor setting wins. |
| Live Plan or advisor control | The current session | Change it in the session controls. An advisor change respawns that session so `omp` can bind it at process start. |
| omp model roles, omp advisor configuration, and Memory settings | The next session spawn | Settings writes the global layer. A `project` chip means the focused project's layer is still effective. Follow the installed omp description for other omp settings. |
| Provider key | The next session spawn | Check the source chip for the focused project. |
| MCP toggle | The next session spawn, or immediately in a live session that reloads MCP | Check whether the MCP manager is scoped to a working tree or to global configuration. A worktree session's manager is scoped to its checkout, which resolves the project's `.omp/` through a symlink. |

### Fix

For a live session, use its Plan and advisor controls instead of changing a default. For future sessions, change the matching General setting; toggle the advisor in a session from that project if you want to replace its remembered advisor state.

Focus a session from the affected project before checking omp, Memory, Providers, or project MCP settings. If an omp or Memory row has a `project` chip, the global write succeeded but the project's `.omp/config.yml` still wins; change or remove that project override instead of editing omp-ui state. Spawn a new session after a process-bound omp, Memory, or provider change. For MCP, open the manager from the live session and choose **reload MCP in this session**, or apply the change to the next session.

See [Settings](settings.md) for layer and timing details and [User guide](user-guide.md) for live session controls.

## The host will not start, or the app cannot reach it

### Cause

The desktop window is a client of the persistent host. When it cannot find or start one it shows a recovery surface instead of the app, with the bootstrap phase (`probing`, `installing`, `starting`, `failed`), the host and client log directories, and **Retry**, **Stop host**, and **Roll back** actions. The host refuses to start when another process owns the data root, when a child process from a crashed host cannot be proven dead, when the registry is unreadable before it has ever been adopted, or when a migration step finds disk and journal disagreeing; it exits rather than guess.

### Check

Ask the host directly; this never opens the registry and is safe while it runs:

```bash
omp-ui status
```

| Exit | State | Meaning |
| --- | --- | --- |
| `0` | `running` | A host answered an authenticated probe. The report shows its pid, version, verifier health, credential backend, service state, and log directory. |
| `3` | `absent` | No `host.json` and no `host.lock`: nothing is running for this data root. Open the desktop app, or `omp-ui service install`. |
| `4` | `unresponsive` or `incompatible` | A record or lock exists but the probe failed or the protocol ranges do not overlap. The report names the owner from `host.lock` and the reason. |
| `5` | authority conflict | Another process owns this data root: a second host from another checkout or flavour, an omp-ui release from before the host that found a claimed root, or a host still shutting down. `omp-ui serve` and the older app both exit 5 with the owner's pid, version, start time, and endpoint. |

The desktop app's recovery surface shows the same message the host logged. Read the host's own account in `<dataRoot>/logs/main.log` and `breadcrumbs.log` (every boot step leaves an `authority` breadcrumb), and the service manager's capture (`journalctl --user -u omp-ui-host` on Linux). `<dataRoot>/migration.json` lists each migration step as `open` or `committed`; an `open` `credential-handoff-v1` after a start means the credential store was locked and the step will retry next boot — that is not an error.

### Fix

| Message or state | Fix |
| --- | --- |
| Exit 5, and the named pid is a host you want | Connect through it: open the desktop app, or use `omp-ui pair`. Nothing else needs to change. |
| Exit 5, and the named pid is an old or stuck host | `omp-ui stop` asks it to hibernate and exit; it never force-kills. If the process is gone but `host.lock` still names it, the next start proves it dead and takes over by itself — never delete `host.lock` by hand. |
| Exit 5 from a pre-host omp-ui release | That release cannot open a root a host has claimed. Install the current release; do not run both. |
| `stopped: children from the previous host could not be proven dead: pid …` | A child `omp` from a crashed host is still alive or cannot be identified. Inspect and end that pid yourself, then retry; the host will not resume a session beside a process it cannot account for. |
| `stopped: registry … is corrupt or from an unknown schema; nothing was moved` | The registry could not be read before its first adoption. Nothing was quarantined; restore the file from a backup or remove the corrupt root deliberately, then retry. |
| `boot failed: MigrationConflict …` | Disk and `migration.json` disagree (for example both a legacy and a relocated copy of a store exist and differ). Nothing was touched. Keep the copy you trust, remove the other, and retry; the message names the item. |
| Recovery surface `failed` after `starting` with no host log lines | The service manager refused the start. On Linux confirm `systemd-run --user` works in your session (`systemctl --user status`); on macOS that `launchctl` can submit into your `gui/<uid>` domain; on Windows that Task Scheduler can create a task for your account. **Retry** resubmits. |
| `verifier: degraded … No usable sandbox` or a font reason in `omp-ui status` | Sessions work; every HTML plan proposal answers `VERIFIER_UNAVAILABLE`. Enable unprivileged user namespaces (`sysctl kernel.unprivileged_userns_clone=1`, or raise `user.max_user_namespaces`) and install at least one font family, then restart the host. omp-ui never runs the verifier without Chrome's sandbox. |
| Wrong version after an update, or an update that will not acknowledge | `omp-ui rollback` hands over to the one retained previous version. An update whose replacement never acknowledged has already been killed and the previous version reclaimed; `omp-ui status` reports the last attempt's outcome. |

## omp-ui won't start (Linux)

### Cause

An app-menu launch runs the AppImage with `Terminal=false`, so a failure before Electron starts — the AppImage runtime, or shared-library loading — shows no error. The window also never appears if a previous omp-ui window is still alive: the desktop client is single-instance per `userData`, and a second launch exits silently while the first holds Chromium's single-instance lock. A host that is running is not the problem here — the window connects to it — but a host that cannot start shows the recovery surface described above rather than an empty window.

### Check

Run the AppImage from a terminal so the error is visible:

```bash
~/.local/bin/omp-ui.AppImage
```

Anything stuck holding the client's single-instance lock (the host, `omp-ui serve`, is a different process and may legitimately be listed):

```bash
pgrep -a omp-ui
```

If an `omp-ui.AppImage` process is listed, it is the previous window; a new launch exits while it lives. Architecture sanity (the Linux build is x64-only):

```bash
uname -m
```

If a process runs but no window appears:

```bash
tail -50 ~/.config/@omp-ui/desktop/logs/main.log
```

### Fix

| Terminal signature | Fix |
| --- | --- |
| FUSE mount error text (`dlopen(): error loading libfuse.so.2`, `No suitable fusermount binary found`, `Cannot mount AppImage`) | Applies to direct launches only (terminal or file manager) — the application-menu entry and `~/.local/bin/omp-ui-desktop` avoid FUSE entirely. Re-run the installer to get the current static-runtime AppImage. For direct launches, `sudo apt install fuse3`, or run `APPIMAGE_EXTRACT_AND_RUN=1 ~/.local/bin/omp-ui.AppImage`. |
| `error while loading shared libraries: …` | Re-run the installer; it verifies the Electron binary's system libraries and prints the exact `sudo apt install …` command. Older installers: install the package that provides the named library. |
| `Exec format error` | The machine is not x64. The Linux build is x64-only. |
| Silent immediate exit | A previous omp-ui window is still alive and holds the single-instance lock. Find it with `pgrep -a omp-ui.AppImage`, kill it, then relaunch. Killing the window never touches your sessions; they belong to the host. |

## A release download needs verification

### Cause

The Linux installer downloads `SHA256SUMS.txt` and verifies the AppImage automatically. Manual downloads need the matching release manifest. A checksum verifies downloaded bytes against that manifest; it does not by itself establish publisher identity.

### Check

Use assets only from the project's GitHub Releases page. Confirm the platform and architecture before installing. Linux AppImage is supported. Windows and macOS builds are previews; Windows is unsigned, while macOS previews are signed and notarized.

### Fix

For Linux, use the supported [`packaging/install.sh`](../packaging/install.sh) command from [Getting started](getting-started.md). For a manually downloaded AppImage or preview asset, follow the checksum procedure in [Releases](releases.md) rather than copying a command from elsewhere. Stop if the selected asset does not match its manifest entry.
