# Troubleshooting

Start with the symptom you see. These checks use app status and supported controls. Do not edit omp-ui's registry, session JSONL files, or stored credential files.

[Documentation home](README.md) · [Getting started](getting-started.md) · [User guide](user-guide.md) · [Settings](settings.md) · [Remote access](remote-access.md) · [Releases](releases.md)

## `omp` is missing or a new session exits

### Cause

omp-ui normally runs its managed `omp` binary. If no managed copy exists, it can fall back to the desktop app's `PATH` and known install locations. A desktop launch does not necessarily have the same `PATH` as an interactive shell, so `omp --version` in a terminal may test a different binary.

### Check

Open Settings → About. The **omp path** row is the binary omp-ui selected, and the **omp version** row is the version it read. Then open Settings → Updates and check the **omp binary** status. The About path is authoritative for the app.

A managed copy takes precedence over a copy on `PATH`. If About shows a valid binary but the new session reports that no model provider is configured, continue with [A provider or model is missing after desktop launch](#a-provider-or-model-is-missing-after-desktop-launch).

### Fix

On Settings → Updates, choose **Install** when the binary is missing or **Update now** when an update is offered. The app verifies the download before replacing its managed copy. New sessions use the installed binary; a live session keeps the process it already started.

`OMP_UI_OMP_PATH` is only a development override for testing a local `omp` build. It takes precedence over the managed copy. Do not use it to repair an installed app. Developers can find the development workflow in the [development guide](development.md).

## A provider or model is missing after desktop launch

### Cause

Provider keys enter a session's environment when `omp` starts. A desktop launch may not inherit exports from an interactive shell. On Linux and macOS, omp-ui also captures supported provider variables from the login shell once during app startup. Windows has no login-shell capture. A key added after a session started cannot change that running process.

### Check

Open Settings → Providers. If the project already has a session, focus it first so the page can report that project's `.env` source. Each configured row has a source chip:

- `saved here` means omp-ui stored the key in the OS credential store.
- `environment` means the desktop process inherited it.
- `shell profile` means startup login-shell capture found it on Linux or macOS.
- `project .env` means omp-ui found a key in the focused project's dotenv files. omp loads those files itself; omp-ui only reports the key.

A row without a source chip is not configured for that scope. A search-provider key does not provide a model.

### Fix

Add the model provider key through Settings → Providers. If no OS credential store is available, omp-ui refuses the write. On Linux or macOS, export the supported variable from the login shell profile and restart omp-ui. On Windows, set it as a user environment variable and restart omp-ui. Do not edit omp-ui's credential storage.

Spawn a new session after the source chip appears. Existing live sessions keep their original environment. Do not re-enter a key already reported as `project .env`; it already applies to sessions spawned in that project. See [Settings](settings.md#providers) for source priority and storage behavior.

## A remote URL is unavailable

### Cause

Remote access works only while the desktop app is running. The default `localhost` bind is reachable from the same machine only. Other supported causes appear in Settings as a stopped server, a port conflict, or a missing browser bundle in a development checkout.

### Check

Open Settings → Remote access. Confirm that remote access is enabled and the status says **listening on** the expected port. Copy the displayed **Connection URL** rather than reconstructing it. For another device, confirm that **Bind address** is **local network**. If the status is an error, use the message shown there; `port … is already in use` identifies a port conflict.

A packaged release includes the browser bundle. A `503` response that says the bundle is missing applies to a development build.

### Fix

Keep the desktop app open. For another device, change the bind address to **local network**, then use the newly displayed connection URL. Choose another port in the supported range if the current port is in use.

For a development checkout with a missing bundle, run this exact command from the repository root:

```bash
npm run build:web --workspace @omp-ui/desktop
```

Turn remote access off and on after the build so the server checks the bundle again. Remote access uses plain HTTP; read the exposure and sign-in guidance before enabling a LAN bind in [Remote access](remote-access.md).

## A dismissed update card does not return

### Cause

Choosing **Later** remembers the dismissal for that exact offered version. omp-ui updates and managed `omp` updates have separate cards, launch-check switches, and dismissal records.

### Check

Open Settings → Updates. Inspect the omp-ui and omp binary sections separately. A remembered offer appears as **Dismissed:** followed by its version. The status line also reports manual check errors, available updates, and the installed version.

### Fix

Choose **Re-offer** in the matching section. It clears that dismissal and immediately checks again. Use **Check now** when there is no dismissed row. A dismissal never suppresses a later version.

See [Releases](releases.md) for the supported update paths on Linux and the Windows and macOS previews.

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
| Default compaction method | A fresh native session captures it; later resumes reuse that capture | It does not change a live session or any terminal-origin session. “omp configured default” defers to omp's global/project `compaction.methodOrder`. |
| Default advisor | A new session with no remembered advisor state for that project | A project's last-used advisor setting wins. |
| Live Plan or advisor control | The current session | Change it in the session controls. An advisor change respawns that session so `omp` can bind it at process start. |
| omp model roles, omp advisor configuration, and Memory settings | The next session spawn | Settings writes the global layer. A `project` chip means the focused project's layer is still effective. Follow the installed omp description for other omp settings. |
| Provider key | The next session spawn | Check the source chip for the focused project. |
| MCP toggle | The next session spawn or an explicit restart | Check whether the MCP manager is scoped to the project or to global configuration. |

### Fix

For a live session, use its Plan and advisor controls instead of changing a default. For future sessions, change the matching General setting; toggle the advisor in a session from that project if you want to replace its remembered advisor state.

Focus a session from the affected project before checking omp, Memory, Providers, or project MCP settings. If an omp or Memory row has a `project` chip, the global write succeeded but the project's `.omp/config.yml` still wins; change or remove that project override instead of editing omp-ui state. Spawn a new session after a process-bound omp, Memory, or provider change. For MCP, open the manager from the live session and choose **restart session to apply**, or apply the change to the next session.

See [Settings](settings.md) for layer and timing details and [User guide](user-guide.md) for live session controls.

## omp-ui won't start (Linux)

### Cause

An app-menu launch runs the AppImage with `Terminal=false`, so a failure before Electron starts — the AppImage runtime, or shared-library loading — shows no error. The window also never appears if a previous omp-ui process is still alive: omp-ui is single-instance, and a second launch exits silently while the first instance keeps the single-instance lock.

### Check

Run the AppImage from a terminal so the error is visible:

```bash
~/.local/bin/omp-ui.AppImage
```

Anything stuck holding the single-instance lock:

```bash
pgrep -a omp-ui
```

If a process is listed, it is the previous instance; a new launch exits while it lives. Architecture sanity (the Linux build is x64-only):

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
| FUSE mount error text (`dlopen(): error loading libfuse.so.2`, `No suitable fusermount binary found`, `Cannot mount AppImage`) | Applies to direct launches only (terminal or file manager) — the application-menu entry avoids FUSE entirely. Re-run the installer to get the current static-runtime AppImage. For direct launches, `sudo apt install fuse3`, or run `APPIMAGE_EXTRACT_AND_RUN=1 ~/.local/bin/omp-ui.AppImage`. |
| `error while loading shared libraries: …` | Re-run the installer; it verifies the Electron binary's system libraries and prints the exact `sudo apt install …` command. Older installers: install the package that provides the named library. |
| `Exec format error` | The machine is not x64. The Linux build is x64-only. |
| Silent immediate exit | A previous omp-ui instance is still alive and holds the single-instance lock. Find it with `pgrep -a omp-ui`, kill it, then relaunch. |

## A release download needs verification

### Cause

The Linux installer downloads `SHA256SUMS.txt` and verifies the AppImage automatically. Manual downloads need the matching release manifest. A checksum verifies downloaded bytes against that manifest; it does not by itself establish publisher identity.

### Check

Use assets only from the project's GitHub Releases page. Confirm the platform and architecture before installing. Linux AppImage is supported. Windows and macOS builds are previews; Windows is unsigned, while macOS previews are signed and notarized.

### Fix

For Linux, use the supported [`packaging/install.sh`](../packaging/install.sh) command from [Getting started](getting-started.md). For a manually downloaded AppImage or preview asset, follow the checksum procedure in [Releases](releases.md) rather than copying a command from elsewhere. Stop if the selected asset does not match its manifest entry.
