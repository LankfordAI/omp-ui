# @omp-ui/host-lite

Headless omp-ui fleet member (issue #1010): a Node process that owns its own
data directory, spawns omp sessions with the same session code the desktop
ships, and answers the fleet join protocol over `@omp-ui/server`'s remote
transport. A desktop app joins it exactly like any other remote instance —
there is no second join protocol, and this package has zero Electron imports.

## Run

```sh
omp-ui-lite serve     # start the member; first run mints a token and prints the join URL
omp-ui-lite status    # reachable/unreachable probe of the local listener (exit 0/3)
```

Join from an owner app: **Settings → Remote instances → paste the URL**.
System service: `packaging/omp-ui-lite.service` + `loginctl enable-linger "$(id -un)"`.
Install script: `packaging/install.sh` (linux-x64 v1; checksum-verified release asset,
node-pty unpacked adjacent to the binary — see `NODE_PATH` in the unit).

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `OMP_UI_LITE_HOME` | data root (registry, machine key, instance id) | `<dataHome>/omp-ui-lite[-dev]`, mirroring the desktop root's parent |
| `OMP_UI_LITE_KEY_FILE` | 32-byte key file for the credential cipher (must be mode 0600) | unset → protector chain below |

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
Traffic: only `REMOTE_PROXY_CHANNELS` (see `packages/core/src/remote-instances.ts`)
— tab-routed session traffic, project proxy channels, favorites, vault names,
stats, and the fleet exec/terminal/project legs. Channels that physically need a
window are **absent from the table**, not denied.

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
