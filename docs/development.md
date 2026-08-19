# Development

omp-ui is an npm workspace containing a transport-agnostic Node core, an Electron desktop app, and the server used by remote browser clients. This guide covers a local checkout, repository commands, tests, and contributor constraints.

Return to the [Documentation home](README.md). Read [Architecture](architecture.md) before changing package boundaries and [Releases](releases.md) before changing packaging or update behavior.

## Prerequisites

Install these tools before checking out the repository:

- Git.
- Node.js 22 or newer and its bundled npm. The current Electron package requires Node 22.12.0 or newer, so use a current Node 22 release.
- The native build tools required by `node-pty`.

`node-pty` compiles native code when a suitable prebuild is unavailable. Install the tools for the platform where you develop:

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
| Start the desktop app | `npm run dev` | Generates theme CSS, installs the Electron binary if needed, then starts `electron-vite dev --watch`. |
| Build all app bundles | `npm run build` | Generates themes, builds Electron main/preload/renderer, then builds the remote web bundle. |
| Package the default target | `npm run package` | Runs the Linux packaging script. |
| Test all workspaces | `npm test` | Runs each workspace's `test` script. The desktop test script checks generated themes before Vitest. |
| Type-check all workspaces | `npm run typecheck` | Runs each workspace's `typecheck` script. |
| Lint the repository | `npm run lint` | Runs ESLint from the root. |

`npm run dev` hot reloads the desktop renderer. Restart it when a main-process, preload, native-module, or startup environment change cannot be picked up by the running process.

## Workspace commands

Use npm's workspace flag for a focused task. These commands match the scripts in `packages/desktop/package.json`:

```bash
# Build only the remote browser bundle.
npm run build:web --workspace @omp-ui/desktop

# Rebuild node-pty for Electron or a target architecture.
npm run rebuild:native --workspace @omp-ui/desktop

# Regenerate committed theme CSS from theme-sources.json.
npm run themes:generate --workspace @omp-ui/desktop

# Fail when committed theme CSS does not match its source.
npm run themes:check --workspace @omp-ui/desktop
```

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
| `OMP_UI_CDP_PORT` | Adds Electron's `remote-debugging-port` switch for programmatic renderer inspection. Set it only for a local development run. |
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

## Continuous integration order

The main CI job uses Node 22 and runs these commands in order:

```bash
npm ci
npm install --package-lock-only
git diff --exit-code package-lock.json
npm run typecheck
npm test
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
