# Development

omp-ui is an npm workspace containing a transport-agnostic Node core, an Electron desktop app, and the server used by remote browser clients. This guide covers a local checkout, repository commands, tests, and contributor constraints.

Return to the [Documentation home](README.md). Read [Architecture](architecture.md) before changing package boundaries and [Releases](releases.md) before changing packaging or update behavior.

## Prerequisites

Install these tools before checking out the repository:

- Git.
- Node.js 22 or newer and its bundled npm. The current Electron package requires Node 22.12.0 or newer, so use a current Node 22 release.
- The native build tools required by `node-pty` on Linux.

`node-pty` ships Node-API prebuilds for Windows and macOS, so `npm install` compiles it only on Linux. Node-API is ABI-stable across Node and Electron, so the copy npm installs is the copy that ships in every package; nothing rebuilds it for Electron. Install the platform tools:

- Linux: Python 3, `make`, and a C/C++ build toolchain. On Debian or Ubuntu, install them with `sudo apt install -y python3 make build-essential`.
- macOS: Xcode command-line tools for `codesign`, `hdiutil`, and `notarytool`.
- Windows preview: no native toolchain; electron-builder bundles NSIS.

Linux AppImage and macOS packages are the supported distributions. Windows packages are previews, but their development and packaging scripts remain available.

## Check out and install

Clone the repository and create a branch for the change:

```bash
git clone https://github.com/LankfordAI/omp-ui.git
cd omp-ui
git checkout -b docs/my-change
npm install
```

Run commands from the repository root unless a command says otherwise. Commit `package-lock.json` whenever a dependency or workspace version change updates it.

## Root commands

The root scripts delegate to the npm workspaces where appropriate.

| Task | Command | What it runs |
|---|---|---|
| Install dependencies | `npm install` | Installs the root and all workspace dependencies. |
| Start the desktop app | `npm run dev` | Generates theme CSS, installs the Electron binary if needed, then starts `electron-vite dev --watch`. |
| Start the desktop app headless | `npm run dev:headless` | Same as `npm run dev`, but Chromium runs on its headless Ozone platform so no window is mapped on your display. Uses a dedicated userData identity, a throwaway registry with OS notifications off, and CDP on `127.0.0.1:9223`. With `-- --pane` the run also serves its UI over loopback HTTP; see [Verification runs](#verification-runs). Linux only. For agent verification runs; see [Verification runs](#verification-runs). |
| Build all app bundles | `npm run build` | Generates themes, builds Electron main/preload/renderer, then builds the remote web bundle. |
| Package the default target | `npm run package` | Runs the Linux packaging script. |
| Preview release notes | `npm run notes` | Runs `scripts/release-notes.mjs` to render a release's notes body locally from git history and the GitHub API, for example `npm run notes -- --tag v0.9.12 --stdout`. Read-only; writes nothing to GitHub. |
| Test all workspaces | `npm test` | Runs each workspace's `test` script. The desktop test script checks generated themes before Vitest. |
| Test process-backed live proofs | `npm run test:live` | Runs the desktop `src/main/**/*-live.test.ts` integration proofs serially against the real omp binary. Skips cleanly when no omp binary is installed. CI runs this after `npm test`. |
| Type-check all workspaces | `npm run typecheck` | Runs each workspace's `typecheck` script. |
| Lint the repository | `npm run lint` | Runs ESLint from the root. |
| Audit visible strings | `python3 scripts/scan-visible-strings.py` | Heuristic list of renderer chrome literals that may still need an i18n `t()` key (issue #363). Read-only; triage hits by hand — brand names, hotkeys, paths, commands, and data labels are intentionally outside localization. |

`npm run dev` hot reloads the desktop renderer. Restart it when a main-process, preload, native-module, or startup environment change cannot be picked up by the running process.

## Workspace commands

Use npm's workspace flag for a focused task. These commands match the scripts in `packages/desktop/package.json`:

```bash
# Build only the remote browser bundle.
npm run build:web --workspace @omp-ui/desktop

# Prove the installed node-pty addon loads and spawns a shell inside Electron.
npm run smoke:pty --workspace @omp-ui/desktop

# Electron-runtime smoke of the shipped browser pane host; writes
# out/browser-pane-smoke/summary.json. CI runs --once on Linux: the self-hosted
# runner for same-repo events, a hosted runner (headless Ozone, Xvfb fallback)
# for fork pull requests.
npm run smoke:browser-pane --workspace @omp-ui/desktop

# Regenerate committed theme CSS from theme-sources.json.
npm run themes:generate --workspace @omp-ui/desktop

# Fail when committed theme CSS does not match its source.
npm run themes:check --workspace @omp-ui/desktop
```

The browser-pane smoke reports `frameProcessMs` for main-thread base64 decoding,
JPEG-header inspection and frame assembly. It does not measure Chromium's
asynchronous JPEG compression. The host smoke covers raster density, input,
agent screenshots and clock stamping, but bypasses desktop delivery: local
panes paint from a tab-capture `MediaStream`, and joined remote-instance panes
from MessagePort JPEGs. Use a full `dev:headless` run to measure desktop
painting, input-to-paint latency, ACK backpressure, hidden-tab filtering and
renderer reload recovery. Send pane text input only with an editable element
focused: on Electron 43.2.0, `insertText` with nothing focused hangs the pane
renderer (#656). Keep workload, density,
quality and GPU mode fixed between baseline and changed runs; report software
rendering separately. Verify the raster marker and JPEG payload size throughout:
the pre-existing accelerated static-canvas resize defect (#653) can otherwise
turn a detailed fixture into an almost empty image. A retained image of seeded
pixels avoids that fixture failure without reducing frame dimensions or quality.

No lane rebuilds `node-pty` for Electron: the addon is Node-API, so the copy
`npm ci` installs — a prebuild on Windows and macOS, a node-gyp build on Linux —
is the copy electron-builder packs. The package verifiers only prove that copy
exists on disk, so every packaging lane and CI run `smoke:pty` first. It
relaunches itself as the Electron binary with `ELECTRON_RUN_AS_NODE=1` (no
display needed), spawns a shell through `node-pty`, and fails if the addon
cannot load or spawn under the exact Electron the package embeds (issue #484).
The macOS prebuild stores its `spawn-helper` non-executable, and a copied tree
keeps that mode into the packaged app, so `scripts/ensure-node-pty-exec.cjs`
ORs the exec bit back in: as the desktop workspace's `postinstall` (every
`npm ci`/`npm install` and the smoke itself), as electron-builder's `afterPack`
hook so a local `package:mac` is safe without the smoke, and as an assertion in
`verify-macos-package.sh` (issue #489).

Run a single workspace's tests or type check with the same form:

```bash
npm test --workspace @omp-ui/core
npm test --workspace @omp-ui/desktop
npm test --workspace @omp-ui/server
npm run typecheck --workspace @omp-ui/core
```

Vitest accepts a test path after `--`. The path is relative to the selected workspace:

```bash
npm test --workspace @omp-ui/core -- src/paths.test.ts
npm test --workspace @omp-ui/desktop -- src/main/app-update.test.ts
```

The desktop unit suite caps Vitest at 4 worker processes on local machines
(CI keeps full parallelism), so a full local run stays interactive. For a
tighter loop, run only affected tests from `packages/desktop`:

```bash
npx vitest run --changed
```

The desktop `test` script does not run the process-backed live proofs
(`src/main/**/*-live.test.ts`, real omp spawns); run them on demand with
`npm run test:live --workspace @omp-ui/desktop`. Renderer `.live.test.tsx`
files spawn no subprocess and remain in the unit suite.

## Platform packages

The root `npm run package` command selects Linux. Use the desktop workspace scripts when the target must be explicit:

```bash
# Supported Linux AppImage.
npm run package:linux --workspace @omp-ui/desktop

# macOS package.
npm run package:mac --workspace @omp-ui/desktop

# Unsigned Windows x64 preview.
npm run package:win --workspace @omp-ui/desktop
```

Packaging runs the full desktop build first. macOS release signing and notarization require the release credentials described in [Releases](releases.md). The Windows script always passes `--x64`.

## Workspace layout

| Path | Responsibility | Main entries and tests |
|---|---|---|
| `packages/core` | Plain Node and TypeScript for OMP-facing behavior, including PTYs, rpc-ui framing, session files, settings, updates, and shared backend types. It must not import Electron or a transport. | Public exports start at `src/index.ts`. Tests live beside source as `src/**/*.test.ts`, including `src/rpc/*.test.ts`. |
| `packages/desktop` | Electron shell, backend orchestration, preload bridge, React renderer, remote web entry, and packaging configuration. | Main process: `src/main/index.ts`. Preload: `src/preload/index.ts`. Desktop renderer: `src/renderer/index.html` and `src/renderer/src/main.tsx`. Browser renderer: `src/web/index.html` and `src/web/main.web.tsx`. Tests are colocated as `*.test.ts` and `*.test.tsx`. |
| `packages/server` | Node HTTP and WebSocket transport that serves the browser bundle and exposes the same typed backend used by the desktop renderer. | Public server entry: `src/index.ts`. Tests live beside source as `src/*.test.ts`. |

The desktop and browser entries load the same renderer. Electron reaches the backend through the sandboxed preload and IPC. The browser entry installs the WebSocket backend before it imports renderer code. See [Architecture](architecture.md) and [ADR-0002](adr/0002-transport-agnostic-core.md) for the boundary and its rationale.

## Contributor invariants

Read [`CONTEXT.md`](../CONTEXT.md) before changing code. It defines terms such as session, live session, tab, lineage, owned session, render item, and inspector rail. Use those terms in code, issues, and commits, and respect every `_Avoid_` list. An npm workspace is the package-manager concept; a user-registered working directory is a project.

Keep these rules intact:

- Current source is authoritative when an old plan or old prose disagrees with it. Use the phase documents and ADRs for intent and rejected alternatives, then verify behavior in the implementation.
- `packages/core` stays free of Electron and transport imports. Electron-specific wiring belongs in `packages/desktop`; HTTP and WebSocket transport belongs in `packages/server`.
- A session file is the source of truth. omp-ui reads and resumes it, but never rewrites its contents. The only destructive write is an explicit, user-confirmed deletion of the whole owned lineage directory.
- One main process owns the registry and live sessions. Never spawn a second OMP process for the same session. Closing a tab hides it; it does not stop the live session.
- Native transcript render items are derived state. Unknown event types add nothing rather than breaking the transcript or changing the session file.
- Search for an existing GitHub issue before filing a bug or feature request. Keep one request or defect per issue, use `CONTEXT.md` vocabulary, and do not close the issue until the change has been verified.

The full agent and contribution rules are in [`AGENTS.md`](../AGENTS.md). Review the [phase 1 PTY plan](phase-1-pty-embed.md), [phase 2 rpc-ui plan](phase-2-rpc-ui.md), [phase 3 ACP plan](phase-3-acp.md), and [ADRs](adr/) before changing a documented decision. The [session format reference](session-encoding.md) covers the on-disk JSONL format and path encoding.

## Development and test controls

The following environment variables are developer and test seams. They are not user settings, are not part of the supported settings surface, and should not appear in user setup instructions.

| Control | Development or test effect |
|---|---|
| `OMP_UI_OMP_PATH` | Adds an explicit OMP executable as the first binary-resolution candidate. If it does not exist, resolution continues to the managed copy and normal search paths. |
| `OMP_UI_INSTALL_DIR` | Overrides the directory that holds omp-ui's managed OMP executable. This is a directory, not the executable path. |
| `OMP_UI_REGISTRY_PATH` | Replaces the main process's default `registry.json` path, which isolates a development run's app state. |
| `OMP_UI_CDP_PORT` | Adds Electron's `remote-debugging-port` switch for programmatic renderer inspection. The switch is Chromium-wide, so every browser pane page is also a tokenless target on that port beside the app renderer. Set it only for a local development run. |
| `OMP_UI_HEADLESS=1` | Selects the `@omp-ui/desktop-dev-headless` userData identity so a headless verification run never collides with — or focuses — an interactive dev instance. Set by `npm run dev:headless`; it changes nothing else. |
| `OMP_UI_TEST_MODEL` | Pins the main model of every session this app instance spawns — fresh or resumed, terminal or native — by passing the `provider/model[:level]` selector to OMP as `--model` and writing it into the lineage's `omp-ui-model.yml` overlay as `modelRoles.default`. It overrides the project's default-model pin and last-used model, and never rewrites a registry record. A selector OMP cannot resolve fails the spawn with OMP's own message in the tab's failure surface. |
| `OMP_UI_TEST_ADVISOR` | Pins only the advisor model, as `modelRoles.advisor` in the lineage's advisor overlay. The advisor's on/off posture still comes from the session record and the composer, so an advisor test under the gate still tests the advisor. |
| `OMP_UI_APP_UPDATE_ENABLE=1` | Forces app-update behavior on for an unpackaged development build. |
| `OMP_UI_APP_UPDATE_VERSION` | Overrides the current app version passed to the updater. |
| `OMP_UI_APP_UPDATE_FORMAT=appimage` | Supplies the development-only AppImage environment needed to reach the AppImage updater path. Other values do not select a fake package format. |

Pass controls on the same command invocation so they do not leak into later runs. For example:

```bash
OMP_UI_OMP_PATH=/absolute/path/to/omp \
OMP_UI_REGISTRY_PATH=/tmp/omp-ui-registry.json \
OMP_UI_CDP_PORT=9222 \
npm run dev
```

The app-update controls can contact and act on real release metadata. Use them only for a deliberate updater test, with an isolated registry and no live session you need to preserve.

### Verification runs

A run that boots the app in order to drive it over CDP should pin its sessions to a cheap model. Every live session that run spawns follows the parent's model when it delegates, so one unpinned session becomes a frontier-priced fan-out — and a dev-server launch is a separate app instance with its own registry, so the pins recorded by the packaged app do not apply there.

```bash
OMP_UI_TEST_MODEL="openrouter/openai/gpt-5.6-luna:low" \
OMP_UI_TEST_ADVISOR="openrouter/openai/gpt-5.6-terra:low" \
npm run dev:headless
```

Verification runs boot the app headless. `dev:headless` maps no window and takes no focus, isolates the run's userData and registry (`OMP_UI_REGISTRY_PATH` defaults to a fresh temp file; whichever registry the run uses gets `desktopNotifications` forced off), sizes the virtual screen to 1600x1000, and exposes CDP on `127.0.0.1:9223`; set `OMP_UI_REGISTRY_PATH` or `OMP_UI_CDP_PORT` to override. Extra Chromium switches pass through from the workspace: `npm run dev:headless --workspace @omp-ui/desktop -- --no-sandbox`. Reach for `npm run dev` only when a human needs to see the window. One headless instance runs at a time: a second one exits on the single-instance lock.

To verify the Getting started checklist's first-launch gates, a throwaway registry is not enough: the binary row reads `resolveOmpBinary()`, whose PATH scan finds the managed copy whenever the run is launched from a shell inside the packaged app (that PATH starts with `~/.local/share/omp-ui/bin`), and the provider row additionally sees ambient env, the login shell's rc exports, and subscription accounts. Simulate a virgin machine by clearing the environment:

```bash
env -i HOME=$(mktemp -d) PATH=/usr/bin:/bin SHELL=/bin/bash \
    XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR TMPDIR=/tmp \
    OMP_UI_INSTALL_DIR=$(mktemp -d)/bin \
npm run dev:headless --workspace @omp-ui/desktop
```

`OMP_UI_INSTALL_DIR` redirects both binary resolution and the checklist's Install download target, so the download lands in the temp dir instead of the real managed dir. Expect all four rows pending with their actions; clicking Install runs the real GitHub download and flips row 1. Without an OS credential store (what `env -i` also removes), saving a key from Settings refuses to store it — by design, the page says so — so exercise the connected state by exporting a provider variable instead (`OPENROUTER_API_KEY=…` before `env`, giving `source: "environment"`).

Pass `--pane` instead of a Chromium switch — `npm run dev:headless --workspace @omp-ui/desktop -- --pane` — and the run additionally serves its own UI over loopback HTTP so it can be watched live in another omp-ui instance's browser pane (issue #553). The launcher seeds `remoteEnabled`, `remoteBind: "localhost"`, a free `remotePort`, and a fresh `remoteToken` into the registry it uses (these keys win even in a user-supplied `OMP_UI_REGISTRY_PATH`, which otherwise keeps all its other settings), spawns `vite build --watch --config vite.web.config.ts` so the served `out/web` bundle stays current, and prints one line:

```
dev:headless: pane=http://127.0.0.1:PORT/?t=TOKEN
```

An agent loads that URL with `browser.open(...)` from a *different* omp-ui instance: the browser-pane guard (#531) denies a pane page access to its own instance's remote port, so an instance cannot watch itself. Over HTTP the pane covers the full renderer, but native-window-only surfaces (title bar overlay, window state, menus, OS notifications, spellcheck, pane sizing) stay out of reach and remain covered by CDP on the hidden instance. Two runtime races are accepted in dev: a rare rebuild can empty `out/web` for a moment (`emptyOutDir: true`), so a pane reload racing a `vite build --watch` cycle 503s — reload again; and if another process binds the probed port between the launcher's free-port probe and the app's bind, the settings page reports the port-in-use error while the printed URL is already stale.

That pairing — Luna as the main selector, Terra as the advisor selector — is the recommended default; `openrouter/z-ai/glm-5.3-flash:low` is the alternate main selector when a run wants the wider context. Every documented example names an OpenRouter selector, never a local endpoint: a run on a machine without that host running would fail the spawn instead of cheapening it. Re-check a selector, its thinking levels, and whether it accepts image input with `omp models find <model>`; choose one reporting `images: yes` for a run that exercises image paste, and avoid a `:batch` variant, since a verification run waits on its own output and batch delivery has no latency promise.

Three cautions:

- Always pair the gate with a throwaway `OMP_UI_REGISTRY_PATH`. The renderer records a session's live model as that registry's project `lastModel`, so a polluted development registry silently becomes the next run's default model.
- Subagents follow the gate only while OMP's `task.agentModelOverrides` has no entry for their agent type. Setting `task.showResolvedModelBadge` makes each delegated session's resolved model visible in the transcript.
- Read the main model from OMP's own report — the `model_change` entry in the transcript or the composer's model button. The composer's advisor chip instead shows the session record's or OMP's configured advisor model, because OMP reports no resolved advisor model over rpc-ui: the authoritative check for `OMP_UI_TEST_ADVISOR` is the lineage's `omp-ui-advisor.yml`. Under a spawn gate the chips invert that: the gate's selectors are what the child actually runs, so the composer and PlanReview show the gated model read-only, tagged `DEV/TEST`, with a tooltip stating that this app instance overrides the advisor model and that saved choices are unchanged. The advisor on/off switch still writes the session record's own choice — the gate changes only the resolved model, never the saved tuple.
- A gated run never records: the registry's per-session `advisorModel`/model pins and the project `lastModel` keep user-level values, so an ungated launch of the same registry sees the previous saved choices, not the gate's selectors.

### Feedback dialogs

Lifecycle confirmations (stop / mode switch / remove project) and backend error notices no longer use `window.alert`/`window.confirm`. They render as DOM `alertdialog` elements through the shared overlay stack (`AppFeedback`), so keyboard, automation, and remote clients drive them like any other UI. One dialog shows at a time: the oldest error notice outranks a pending confirmation without dropping that decision, and dismissing the last notice restores the confirmation. While a confirmation's effect is in flight the dialog is locked (Escape, backdrop, and close are no-ops, Cancel disabled) and the action cannot double-dispatch. Tests drive this through the store — the harness's native dialog stubs now throw — and the DOM carries focus affordances (`data-modal-initial-focus`) asserted by the component tests.

For the agent *driving* the run, rather than the app it drives, OMP's own settings are the lever and no omp-ui code is involved: `omp config set task.agentModelOverrides '{"task":"openrouter/openai/gpt-5.6-luna:low"}'`, `omp config set task.prewalk true`, and `prewalk.enabled` plan on the strong model and then drop to the `smol` role at the first edit.

## Continuous integration order

The main CI job uses Node 22 and runs these commands in order:

```bash
npm ci
npm run smoke:pty --workspace @omp-ui/desktop
npm run lint
npm install --package-lock-only
git diff --exit-code package-lock.json
npm run typecheck
node --test scripts/release-artifacts.test.mjs
node --test scripts/release-notes.test.mjs
node --test scripts/close-landed-issues.test.mjs
npm test
npm run test:live
npm run build
npm run smoke:browser-pane --workspace @omp-ui/desktop -- --once
```

The `npm install --package-lock-only` and `git diff --exit-code package-lock.json` pair asserts that workspace metadata and `package-lock.json` agree. `npm ci` alone does not catch every workspace-version drift case.

### Self-hosted Linux pool

Same-repo CI, `release-linux`, and the nightly `linux-x64` lane run on the org's self-hosted Linux pool; jobs request `[self-hosted, gfx1201]` (the runners register with labels `linux,rocm,gfx1201`). The runner container registers `--ephemeral`, and the supervisor restarts it between jobs, but the same image filesystem comes back: a warm `~/.npm` and `~/.cache` and a mounted host Docker socket. Treat the pool as stateful — cache hits and host-visible mounts are the norm, and nothing on the release path asserts otherwise. Issue #629 proposed a dedicated fresh-container pool to change that contract; the pool will not be deployed, and its isolation detector was removed. A label no registered runner serves queues jobs forever instead of failing them — retargeting to that undeployed pool stalled every main-branch run for hours (issue #631).

The runner image and the compose-based supervisor live in `LankfordAI/Actions-Runner` under `Dockerfiles/ActionsRunner/`.

## Pull request reviews

This repository uses [CodeRabbit](https://coderabbit.ai) for **advisory** AI
reviews on pull requests. It is not a merge gate: there is no CodeRabbit GitHub
Actions workflow, no required status check, and no secret, and merging stays a
human decision. The behaviour lives in `.coderabbit.yaml` in the repository root
so it is version controlled.

Reviews use the *chill* profile, never auto-approve, keep their summary in the
walkthrough, skip the walkthrough poem, and disable the docstring and unit-test
generation finishing touches. `AGENTS.md`, `CONTEXT.md`, and
`docs/architecture.md` are loaded as coding guidelines, with architecture applied
to every path, so reviews respect the transport-agnostic core boundary of
[ADR-0002](adr/0002-transport-agnostic-core.md) and the vocabulary in
[CONTEXT.md](../CONTEXT.md).

### Activation (organization owner)

1. Install the CodeRabbit GitHub App from
   [github.com/apps/coderabbit](https://github.com/apps/coderabbit), choosing
   "Only select repositories" and selecting `LankfordAI/omp-ui`. An organization
   owner must approve the installation.
2. CodeRabbit detects the repository's open-source status and applies the OSS
   entitlement. Eligibility and rate limits are managed by CodeRabbit, not by
   `.coderabbit.yaml`, so this repository stores no key and needs no billing
   setup.
3. Open a pull request that contains `.coderabbit.yaml`. CodeRabbit reads the
   configuration from the branch under review and posts an advisory review.

### Manual review and configuration inspection

On any pull request, drive the review from a comment:

- `@coderabbitai review` runs, or re-runs, a review of the current head.
- `@coderabbitai configuration` prints the resolved configuration in YAML with a
  comment per setting naming its source — repository YAML, UI settings, or
  defaults — which is how you confirm `.coderabbit.yaml` parsed and took effect.

The schema URL in the first line of `.coderabbit.yaml` gives editor validation of
the file itself.

## Documentation-only changes

Do not add a runtime test solely to validate prose. For edited Markdown files, run this local path check and list the files after `-`. It checks relative links and image targets without making network requests:

```bash
node --input-type=module - docs/development.md <<'NODE'
import fs from "node:fs";
import path from "node:path";

let failed = false;
for (const file of process.argv.slice(2)) {
  const markdown = fs.readFileSync(file, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
    if (fs.existsSync(path.resolve(path.dirname(file), target))) continue;
    console.error(`${file}: missing ${raw}`);
    failed = true;
  }
}
if (failed) process.exit(1);
NODE
```

The check verifies local targets, not GitHub heading anchors or external URLs. Review changed anchors in GitHub's Markdown preview.
