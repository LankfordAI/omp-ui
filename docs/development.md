# Development

omp-ui is an npm workspace containing a transport-agnostic Node core, a browser-safe plan-document pipeline, the WebSocket server, the persistent host, and an Electron desktop client. This guide covers a local checkout, repository commands, tests, and contributor constraints.

Return to the [Documentation home](README.md). Read [Architecture](architecture.md) before changing package boundaries and [Releases](releases.md) before changing packaging or update behavior.

## Prerequisites

Install these tools before checking out the repository:

- Git.
- Node.js 22 or newer and its bundled npm. The current Electron package requires Node 22.12.0 or newer, so use a current Node 22 release.
- The native build tools required by `node-pty` (used by the host) and, on Linux, by the host's Secret Service addon.

`node-pty` compiles native code when a suitable prebuild is unavailable, and `package:host` always rebuilds it for the host's Node ABI. Install the tools for the platform where you develop:

- Linux: Python 3, `make`, and a C/C++ build toolchain. On Debian or Ubuntu, install them with `sudo apt install -y python3 make build-essential`.
- macOS preview: Xcode, including its command-line build tools.
- Windows preview: Python, the Visual Studio C++ build tools, the Windows SDK Desktop C++ components, and the matching MSVC Spectre-mitigated libraries.

Linux AppImage is the supported distribution. Windows and macOS packages are previews, but their development and packaging scripts remain available.

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
| Start the desktop client | `npm run dev` | Generates theme CSS, installs the Electron binary if needed, then starts `electron-vite dev --watch` as the `dev-server` flavour. It starts no host: run `npm run dev:serve` (below) in a second terminal first. |
| Start the host | `npm run dev:serve -w @omp-ui/host -- --flavor dev-server` | Bundles the host CLI with esbuild and runs `omp-ui serve` in the foreground against the `omp-ui-dev-server` data root. `--flavor dev` serves the standalone unpackaged desktop's root instead; `dev-server` is the default when the flag is omitted. |
| Build all app bundles | `npm run build` | Builds the plan-doc pipeline, the host's verifier page, Electron main/preload/renderer, then the browser bundle. |
| Package the default target | `npm run package` | Runs the Linux packaging script. |
| Preview release notes | `npm run notes` | Runs `scripts/release-notes.mjs` to render a release's notes body locally from git history and the GitHub API, for example `npm run notes -- --tag v0.9.12 --stdout`. Read-only; writes nothing to GitHub. |
| Test all workspaces | `npm test` | Runs each workspace's `test` script. The desktop test script checks generated themes before Vitest. |
| Test process-backed live proofs | `npm run test:live` | Runs the host's `test:live` script serially against real binaries: real child process groups, an authenticated loopback WebSocket, PTY/rpc-ui/shell binary flow, crash-ledger reap, and plan preflight in the packaged Chrome verifier. Skips by name when a required binary is missing; release jobs treat a skip as failure. CI runs this after `npm test`. |
| Type-check all workspaces | `npm run typecheck` | Runs each workspace's `typecheck` script. |
| Lint the repository | `npm run lint` | Runs ESLint from the root. |
| Audit visible strings | `python3 scripts/scan-visible-strings.py` | Heuristic list of renderer chrome literals that may still need an i18n `t()` key (issue #363). Read-only; triage hits by hand — brand names, hotkeys, paths, commands, and data labels are intentionally outside localization. |

## Run the two processes

A development run is two processes sharing the `omp-ui-dev-server` data root (`~/.local/share/omp-ui-dev-server` on Linux; see `resolveDataRoot` in `packages/core/src/data-root.ts`):

```bash
# Terminal 1 — the host. Foreground; Ctrl-C stops it gracefully.
npm run dev:serve -w @omp-ui/host -- --flavor dev-server

# Terminal 2 — the Electron client.
npm run dev
```

`dev:serve` sets `OMP_UI_DATA_DIR` to the flavour's root itself, serves the browser bundle from `packages/desktop/out/web` when `npm run build:web --workspace @omp-ui/desktop` has produced one (otherwise the transport only), and drives the plan verifier from `OMP_UI_VERIFIER_BROWSER` plus the page in `packages/host/dist/verifier` — with neither, preflight is degraded and answers `VERIFIER_UNAVAILABLE` rather than crashing. The client finds the host through `<dataRoot>/host.json`; with no host running it shows the recovery surface naming the `dev:serve` command and the data root instead of starting one. Point the packaged `omp-ui` CLI at the same root with `OMP_UI_DATA_DIR=~/.local/share/omp-ui-dev-server omp-ui status` when you need `status`, `pair`, or `stop` against a development host.

`npm run dev` hot reloads the renderer. Restart it when an Electron-main, preload, native-module, or startup environment change cannot be picked up by the running process; restart `dev:serve` for any change under `packages/host`, `packages/server`, or `packages/core` that the host runs. A host change never requires an Electron restart — the client reconnects.

## Workspace commands

Use npm's workspace flag for a focused task. These commands match the scripts in `packages/desktop/package.json`:

```bash
# Build only the remote browser bundle.
npm run build:web --workspace @omp-ui/desktop

# Regenerate committed theme CSS from theme-sources.json.
npm run themes:generate --workspace @omp-ui/desktop

# Fail when committed theme CSS does not match its source.
npm run themes:check --workspace @omp-ui/desktop
```

The desktop package carries no native module: `node-pty` runs only in the host and is built once, for the host's Node ABI, inside `package:host` below. There is no Electron rebuild step.

Run a single workspace's tests or type check with the same form:

```bash
npm test --workspace @omp-ui/core
npm test --workspace @omp-ui/plan-doc
npm test --workspace @omp-ui/server
npm test --workspace @omp-ui/host
npm test --workspace @omp-ui/desktop
npm run typecheck --workspace @omp-ui/core
```

`@omp-ui/host` also has `npm run test:live --workspace @omp-ui/host` for its serial process-backed proofs (real child process groups, an authenticated loopback WebSocket, the packaged Chrome verifier), which skip by name in a checkout that lacks the required binaries.

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

Process-backed live proofs live only in `packages/host` (`src/**/*.live.test.ts`);
the desktop workspace has no `test:live` script. Renderer `.live.test.tsx`
files spawn no subprocess and remain in the desktop unit suite.

## Platform packages

The root `npm run package` command selects Linux. Use the desktop workspace scripts when the target must be explicit:

```bash
# Supported Linux AppImage.
npm run package:linux --workspace @omp-ui/desktop

# macOS preview.
npm run package:mac --workspace @omp-ui/desktop

# Unsigned Windows x64 preview.
npm run package:win --workspace @omp-ui/desktop
```

Packaging runs the full desktop build first and embeds the matching host directory at `resources/host/<version>/` as the client's cold-start seed, so run `package:host` for the lane before a desktop package. macOS release signing and notarization require the release credentials described in [Releases](releases.md). The Windows script always passes `--x64`.

The persistent host has its own packaging lane, independent of electron-builder:

```bash
# Fetch the pinned Chrome for Testing the plan verifier drives, into
# packages/host/resources/plan-verifier/<os>-<arch>/ with its browser.manifest.json.
npm run fetch:verifier-browser --workspace @omp-ui/host

# Build the verifier page (packages/host/verifier) that the headless browser loads.
npm run build --workspace @omp-ui/host

# Assemble the omp-ui Node 22 single executable for this machine's lane under
# packages/host/out/<lane>/seed/<version>/ — bin/omp-ui, lib/node-pty,
# lib/<credential worker and keyring binding>, resources/{plan-verifier,
# verifier-page,web}, service/<supervisor definition> — from the pinned Node
# runtime verified against SHASUMS256.txt and its signature, node-pty built for
# that runtime's ABI, the verifier payload, and the rendered supervisor
# definition; then archive it as packages/host/out/<lane>/omp-ui-host-<version>-<lane>.tar.gz
# (Linux) or .zip (macOS, Windows), with <version>/ as the top-level directory,
# and write the lane's latest-host-<platform>.yml beside it.
npm run package:host --workspace @omp-ui/host

# Unpack that archive somewhere fresh and run it as an installer would: the SEA
# boots, node-pty loads, `serve` claims a temporary data root, `status --json`
# answers through local control, and `stop` shuts it down.
# --record <file> [--release-tag vX.Y.Z] writes the package evidence record the
# release manifest consumes.
npm run smoke:package --workspace @omp-ui/host
```

The host's version is the desktop package's version (`packages/desktop/package.json`); `packages/host/package.json` stays `0.0.0`. `package:host` builds for the running platform only (a SEA blob carries a V8 code cache for the exact binary that generated it); `--lane` names it explicitly, `--skip-node-pty` omits the native rebuild, and without a fetched verifier browser and built page it fails unless `--allow-missing-verifier` is passed. Each release lane runs fetch, build, `package:host`, and `smoke:package --record` before electron-builder, which embeds `seed/<version>` as the desktop's `resources/host/<version>`; the lane uploads the host archive and its feed beside the desktop artifacts, and the release manifest refuses a platform whose host archive, feed, or evidence record is missing ([Releases](releases.md), [ADR-0029](adr/0029-persistent-host-owns-authoritative-application.md)). A CI job, `host-package-smoke`, runs the same four commands on every push.

## Workspace layout

| Path | Responsibility | Main entries and tests |
|---|---|---|
| `packages/core` | Plain Node and TypeScript for OMP-facing behavior, including PTYs, rpc-ui framing, session files, settings, updates, and shared backend types. It must not import Electron or a transport. | Public exports start at `src/index.ts`. Tests live beside source as `src/**/*.test.ts`, including `src/rpc/*.test.ts`. |
| `packages/plan-doc` | Browser-safe HTML plan pipeline shared by the renderer and the host's verifier page: plan source parsing, structural verification, document preparation, the Mermaid and code-highlight transforms, the layout probe, and the pure theme table. Electron-free and Node-free. | Public exports start at `src/index.ts`. Tests live beside source as `src/*.test.ts`. |
| `packages/desktop` | Electron desktop client: window lifecycle, preload (desktop adapter and host bootstrap), host bootstrap and supervisor submission, OS notifier, renderer recovery, the client's own Electron update, the React renderer, the browser web entry, and packaging configuration. Depends on `@omp-ui/core` and `@omp-ui/server/protocol`, never on `@omp-ui/host`. | Electron main: `src/main/index.ts`. Preload: `src/preload/index.ts`. Desktop renderer: `src/renderer/index.html` and `src/renderer/src/main.tsx`. Browser renderer: `src/web/index.html` and `src/web/main.web.tsx`; shared raw-DOM boot UI in `src/web/boot-ui.ts`. Tests are colocated as `*.test.ts` and `*.test.tsx`. |
| `packages/server` | Node HTTP and WebSocket transport that serves the browser bundle, runs the hello handshake, and dispatches the typed backend to per-connection tables for every client — desktop renderer, browser, CLI, and joined instance. Never imports `@omp-ui/host` or `@omp-ui/plan-doc`. | Public server entry: `src/index.ts`; the wire types in `src/protocol.ts`; the Node client in `src/client.ts`. Tests live beside source as `src/*.test.ts`. |
| `packages/host` | The persistent host ([ADR-0029](adr/0029-persistent-host-owns-authoritative-application.md)): `HostApplication`, the authoritative application that only `omp-ui serve` constructs; the fixed boot order in `src/serve.ts`; the headless plan verifier; the authority claim, children ledger, migration journal and legacy readers, host credential cipher and protectors, local control, remote exposure and joined-instance proxy, OMP and host updaters, CLI, and supervisors. Imports no Electron — eslint enforces it. | Public exports start at `src/index.ts`; the CLI entry is `src/cli-main.ts`; the verifier page is `verifier/`; packaging scripts are `scripts/`. Tests live beside source as `src/**/*.test.ts`; live proofs as `src/**/*.live.test.ts`. |

The desktop and browser entries load the same renderer, and both connect over WebSocket before importing it: the browser entry to the origin that served it, the desktop entry to the host's local-control endpoint with the credential `window.ompHostBootstrap.connection()` hands it. Client effects reach the desktop client through `window.ompDesktop`. See [Architecture](architecture.md), [ADR-0002](adr/0002-transport-agnostic-core.md), and [ADR-0029](adr/0029-persistent-host-owns-authoritative-application.md) for the boundary and its rationale.

## Contributor invariants

Read [`CONTEXT.md`](../CONTEXT.md) before changing code. It defines terms such as session, live session, tab, lineage, owned session, render item, and inspector rail. Use those terms in code, issues, and commits, and respect every `_Avoid_` list. An npm workspace is the package-manager concept; a user-registered working directory is a project.

Keep these rules intact:

- Current source is authoritative when an old plan or old prose disagrees with it. Use the phase documents and ADRs for intent and rejected alternatives, then verify behavior in the implementation.
- `packages/core` stays free of Electron and transport imports. `packages/host` stays free of Electron; `packages/server` stays transport-only and never imports `@omp-ui/host` or `@omp-ui/plan-doc`. Electron-specific wiring belongs in `packages/desktop`; HTTP and WebSocket transport belongs in `packages/server`. ESLint `no-restricted-imports` enforces all three.
- A session file is the source of truth. omp-ui reads and resumes it, but never rewrites its contents. The only destructive write is an explicit, user-confirmed deletion of the whole owned lineage directory.
- One process owns the registry and live sessions: `HostApplication`, constructed only by `omp-ui serve` under a claimed data root ([ADR-0030](adr/0030-one-authority-per-data-root.md)). No client constructs a backend or spawns an OMP process. Never spawn a second OMP process for the same session. Closing a tab hides it; it does not stop the live session.
- Native transcript render items are derived state. Unknown event types add nothing rather than breaking the transcript or changing the session file.
- Search for an existing GitHub issue before filing a bug or feature request. Keep one request or defect per issue, use `CONTEXT.md` vocabulary, and do not close the issue until the change has been verified.

The full agent and contribution rules are in [`AGENTS.md`](../AGENTS.md). Review the [phase 1 PTY plan](phase-1-pty-embed.md), [phase 2 rpc-ui plan](phase-2-rpc-ui.md), [phase 3 ACP plan](phase-3-acp.md), and [ADRs](adr/) before changing a documented decision. The [session format reference](session-encoding.md) covers the on-disk JSONL format and path encoding.

## Development and test controls

The following environment variables are developer and test seams. They are not user settings, are not part of the supported settings surface, and should not appear in user setup instructions. Controls that shape sessions (`OMP_UI_OMP_PATH`, `OMP_UI_INSTALL_DIR`, `OMP_UI_TEST_MODEL`, `OMP_UI_TEST_ADVISOR`, `OMP_UI_VERIFIER_BROWSER`) are read by the **host** process — pass them to `dev:serve`, not to `npm run dev`. Controls that shape the Electron client (`OMP_UI_CDP_PORT`, `OMP_UI_APP_UPDATE_*`) go to `npm run dev`. `OMP_UI_DATA_DIR` names the root both processes share.

| Control | Development or test effect |
|---|---|
| `OMP_UI_OMP_PATH` | Adds an explicit OMP executable as the first binary-resolution candidate. If it does not exist, resolution continues to the managed copy and normal search paths. |
| `OMP_UI_INSTALL_DIR` | Overrides the directory that holds omp-ui's managed OMP executable. This is a directory, not the executable path. |
| `OMP_UI_DATA_DIR` | Replaces the whole canonical data root — registry, credential stores, `oauth-login/`, `worktrees/`, `logs/`, `updates/`, managed omp, and the host's own `host.lock`, `host.json`, `migration.json`, and `runtime/` — with the given directory, no build-flavour suffix appended. Both processes must see the same value: the host claims and serves that root, and the desktop client reads its `host.json` there. It is what the host CLI, the supervisor definitions, `dev:serve`, and `smoke:package` use to point a run at an isolated root; there is no narrower control, because moving the registry without its logs, worktrees, and credential stores would split one authority's evidence across two directories. |
| `OMP_UI_CDP_PORT` | Adds Electron's `remote-debugging-port` switch for programmatic renderer inspection. Set it only for a local development run. |
| `OMP_UI_TEST_MODEL` | Read by the host. Pins the main model of every session this host spawns — fresh or resumed, terminal or native — by passing the `provider/model[:level]` selector to OMP as `--model` and writing it into the lineage's `omp-ui-model.yml` overlay as `modelRoles.default`. It overrides the project's default-model pin and last-used model, and never rewrites a registry record. A selector OMP cannot resolve fails the spawn with OMP's own message in the tab's failure surface. |
| `OMP_UI_TEST_ADVISOR` | Read by the host. Pins only the advisor model, as `modelRoles.advisor` in the lineage's advisor overlay. The advisor's on/off posture still comes from the session record and the composer, so an advisor test under the gate still tests the advisor. |
| `OMP_UI_APP_UPDATE_ENABLE=1` | Forces app-update behavior on for an unpackaged development build. |
| `OMP_UI_HOST_UPDATE_ENABLE=1` | Read by the host. Attaches the host's own updater to a `dev`/`dev-server` host, which otherwise stays idle (a development host has no installed `current` layout to switch). The installed binary always attaches it. |
| `OMP_UI_APP_UPDATE_VERSION` | Overrides the current app version passed to the updater. |
| `OMP_UI_APP_UPDATE_FORMAT=appimage` | Supplies the development-only AppImage environment needed to reach the AppImage updater path. Other values do not select a fake package format. |
| `OMP_UI_VERIFIER_BROWSER` | Read by the host. Points an unpackaged host at a fetched plan-verifier browser directory (the `browser.manifest.json` parent that `npm run fetch:verifier-browser --workspace @omp-ui/host` writes under `packages/host/resources/plan-verifier/<os>-<arch>`). The host hashes the executable against that manifest before every launch and refuses a mismatch; it never discovers a system browser or downloads at runtime. Without the variable a development host's plan verifier is degraded and every preflight answers `VERIFIER_UNAVAILABLE`; a packaged host ignores it and reads only its own resources. The page itself comes from `npm run build --workspace @omp-ui/host`. |

Pass controls on the same command invocation so they do not leak into later runs. For example, an isolated two-process run with a local `omp` build:

```bash
# Terminal 1
OMP_UI_DATA_DIR=/tmp/omp-ui-dev-root \
OMP_UI_OMP_PATH=/absolute/path/to/omp \
npm run dev:serve -w @omp-ui/host -- --flavor dev-server

# Terminal 2
OMP_UI_DATA_DIR=/tmp/omp-ui-dev-root \
OMP_UI_CDP_PORT=9222 \
npm run dev
```

The app-update controls can contact and act on real release metadata. Use them only for a deliberate updater test, with an isolated data root and no live session you need to preserve.

### Verification runs

A run that boots the app in order to drive it over CDP should pin its sessions to a cheap model. Every live session that run spawns follows the parent's model when it delegates, so one unpinned session becomes a frontier-priced fan-out — and a dev-server host is a separate authority with its own registry, so the pins recorded by the installed host do not apply there. The pins go to the host, the CDP port to the client:

```bash
# Terminal 1
OMP_UI_DATA_DIR=/tmp/omp-ui-test-root \
OMP_UI_TEST_MODEL="openrouter/openai/gpt-5.6-luna:low" \
OMP_UI_TEST_ADVISOR="openrouter/openai/gpt-5.6-terra:low" \
npm run dev:serve -w @omp-ui/host -- --flavor dev-server

# Terminal 2
OMP_UI_DATA_DIR=/tmp/omp-ui-test-root \
OMP_UI_CDP_PORT=9223 \
npm run dev
```

That pairing — Luna as the main selector, Terra as the advisor selector — is the recommended default; `openrouter/z-ai/glm-5.3-flash:low` is the alternate main selector when a run wants the wider context. Every documented example names an OpenRouter selector, never a local endpoint: a run on a machine without that host running would fail the spawn instead of cheapening it. Re-check a selector, its thinking levels, and whether it accepts image input with `omp models find <model>`; choose one reporting `images: yes` for a run that exercises image paste, and avoid a `:batch` variant, since a verification run waits on its own output and batch delivery has no latency promise.

Three cautions:

- Always pair the gate with a throwaway `OMP_UI_DATA_DIR`. The host records a session's live model as that registry's project `lastModel`, so a polluted development root silently becomes the next run's default model.
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
npm install --package-lock-only
git diff --exit-code package-lock.json
npm run typecheck
npm test
npm run test:live
npm run build
```

The second and third commands assert that workspace metadata and `package-lock.json` agree. `npm ci` alone does not catch every workspace-version drift case.

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
