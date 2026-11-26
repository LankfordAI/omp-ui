# @omp-ui/host-lite

Headless omp-ui fleet member (issue #1010): a Node process that owns its own
data directory, spawns omp sessions with the same session code the desktop
ships, and answers the fleet join protocol over `@omp-ui/server`'s remote
transport. A desktop app joins it exactly like any other remote instance —
there is no second join protocol, and this package has zero Electron imports.

## Run

```sh
omp-ui-lite serve                                     # start the member; first run mints a token
omp-ui-lite status                                    # reachable/unreachable probe of the local listener
omp-ui-lite token [--url]                             # print the persisted join token (or tokenized template URL)
omp-ui-lite --version                                 # print the stamped omp-ui-lite version
omp-ui-lite routines [status]                         # show host-local Routines gate, spend defaults, and run counts
omp-ui-lite routines enable [--warn <usd>] [--max <usd>]  # opt into Routines on this host (atomic with optional caps)
omp-ui-lite routines disable                          # pause Routines without reaping live runs
omp-ui-lite routines spend [--warn <usd>] [--max <usd>]   # update host-wide default spend caps (when enabled)
```

Join from an owner app: **Settings → Remote instances → paste the URL**.
Container deployment: [`docker/README.md`](docker/README.md) and [`docker/compose.yaml`](docker/compose.yaml) (`ghcr.io/lankfordai/omp-ui-lite`).
System service: `packaging/omp-ui-lite.service` + `loginctl enable-linger "$(id -un)"`.
Install script: `packaging/install.sh` (linux-x64 v1; checksum-verified release asset,
`session-bundle.mjs`, `package.json`, and `node_modules` unpacked adjacent to the binary in `~/.local/lib/omp-ui-lite/`).
## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `OMP_UI_LITE_HOME` | data root (registry, machine key, instance id, `lite.lock`, `control.sock`) | `<dataHome>/omp-ui-lite[-dev]`, mirroring the desktop root's parent |
| `OMP_UI_LITE_KEY_FILE` | 32-byte key file for the credential cipher (must be mode 0600) | unset → protector chain below |
| `OMP_UI_LITE_ROUTINES` | boot-time override for `routinesEnabled` (`1`/`true` or `0`/`false`; takes precedence on restart over prior CLI toggles when set in `service.env`) | unset → persisted registry value (`false` on fresh installs) |
| `OMP_UI_LITE_OMP` | explicit path to the `omp` binary | unset → searches `PATH` via `resolveOmpBinary` |
| `OMP_UI_LITE_BUNDLE` | explicit path to `session-bundle.mjs` | unset → `../lib/omp-ui-lite/session-bundle.mjs` (SEA), `./session-bundle.mjs`, or `../dist/session-bundle.mjs` |
| `OMP_UI_LITE_CONTAINER` | set `1`/`true` in immutable container images for `packageFormat: "container"` and redeploy-only Fleet upkeep | unset (`false`) |
Settings that mirror the desktop's remote-access page (`remoteEnabled`,
`remoteBind`, `remotePort`, `remoteToken`) persist in this root's registry, not
Electron userData.

## Credentials

Provider keys and machine secrets seal through `src/credentials`: AES-256-GCM,
single-line `v1lite:` envelopes, protectors in priority order
`OMP_UI_LITE_KEY_FILE` → OS Secret Service (seam; deferred) → `<root>/machine.key` (0600).
**Trust boundary:** the file protector is OS-user-grade secrecy — anyone who can
read your home directory can read the key. Same grade as any file-based seal;
there is no secure enclave on a headless box, and this package does not pretend
otherwise. Lite seals and desktop `safeStorage` seals are mutually unreadable by
design (opaque binary vs tagged string; namespaces never overlap).

## What a member answers

Handshake: `instance:identity` (`{ instanceId, version }`) and `state:get`
(full `BackendState`, same shape the desktop builds — the owner's parser is fixed).
Projects resolve and backfill `repositoryKey` so checkouts unify across hosts.
Traffic: only `REMOTE_PROXY_CHANNELS` (see `packages/core/src/remote-instances.ts`)
— tab-routed session traffic, fleet exec/terminal/project/session/provider-key legs
plus `fleet:sessionSummary`, git/branch/worktree control with live `HeadWatcherHub`
(`branch:changed`) and `PullRequestPoller`, composer file/mention/advisor/model-catalog
and session-reference UX, project settings and scoped capabilities/MCP/watchdog/council
controls, favorites, the eight `routines:*` channels, `models:readChat`, and
lineage-confined `plan:read`. Desktop-only surfaces (windows, browser/device panes,
`dir:browse`, `stall:cap`, vaults, artifacts, OS notifications, bare-metal updates),
secondary headless subsystems (`stats:*`, `autoresearch:*`, `session:pack-*`/`ingest-*`,
`auth:export/import-bundle`, `liveAudio:*`/`liveTranscript:*`), and host-local settings
setters (`settings:setRoutinesEnabled`, `settings:setRoutineSpendDefaults`) are
**absent from the table**, not denied. Operator Routines mutations ride the
OS-user-only local control socket (`<dataDir>/control.sock`, mode `0600`) or an
exclusive-lock-guarded offline CLI write when no daemon owns `<dataDir>/lite.lock`.

## Ground rules for contributors

1. Zero edits to `packages/desktop`, `packages/core`, `packages/server` from this
   package's work — the whole point is a blast radius of one directory (#479 lesson).
2. Session behavior comes from current main via `scripts/bundle-session.mjs`
   (esbuild over the desktop sources with Electron leaves shimmed); the bundle
   **fails to build** if the runtime-Electron closure grows — do not paper over
   that failure, fix the seam.
3. No OS-keychain assumptions; no update feed or supervisor here (members are
   disposable by design).

## Tests

`npm run test -w @omp-ui/host-lite` · proof: `node proofs/join-two-instances.mjs`
(two instances, real transport, fake session bundles).
