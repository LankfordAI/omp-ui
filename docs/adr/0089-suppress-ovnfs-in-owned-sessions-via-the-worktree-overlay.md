# Owned sessions suppress ovnfs through the worktree overlay, never a global write

> **Status:** Accepted, 2026-11-06 ([#1071](https://github.com/LankfordAI/omp-ui/issues/1071)).

omp 18.17 turned ovnfs from opt-in into **auto-enable when its binary is
found**: `ovnfsCommand` resolves a nonblank `ovnfs.path` or falls back to
`ovnfs` on PATH, and discovery alone changes agent behavior — the system
prompt tells every agent it MUST open an ovnfs checkout "not `git worktree
add`, `git clone` or `cp -r`", allowed isolated tasks run inside daemon
checkouts under `isolation.backend: auto`, and `grep`/`glob` below a mount are
answered by the daemon. [ADR-0018](0018-worktree-checkouts-in-app-data.md)
owns app-data Git worktree **sessions**; it says nothing about daemon-managed
mounts, and a daemon checkout never enters
`OwnedSessionRecord.worktree` — so the sidebar's project identity (#63), the
branch diff pane, Finish worktree, and `reclaimCheckouts` (which accepts only
recorded checkouts in the canonical app-data slot) cannot adopt, finish, or
reclaim one. omp-ui is the worktree authority for the sessions it owns, so
**every owned session pins ovnfs off**, carried by the existing per-lineage
worktree overlay ([ADR-0038](0038-session-scoped-approval-mode-via-config-overlay.md)
rail, [ADR-0055](0055-private-sessions-quiet-overlay-plus-bridge-not-config-write.md)
precedent): `writeWorktreeOverlay` now writes

```yaml
worktree:
  onStart: off
  onExit: keep
ovnfs:
  path: "<absLineageDir>"
```

## Scope of the policy

- **In scope:** every omp-ui-owned session, both carriers. Terminal (PTY) and
  native (rpc-ui) spawns both collect overlays through
  `writeSessionOverlays` in `packages/desktop/src/main/spawn-config.ts` —
  `spawnOmp` and `RpcClient` each pass every entry as `--config` — so one
  writer covers both, and every resume, relaunch, hibernation wake, worktree
  conversion, and chat spawn restates it from the same code path.
- **Out of scope, deliberately:** any omp process omp-ui does not own. An
  `omp` the user starts in a terminal — same project, same machine, same
  global config — keeps ovnfs entirely. The pin is per-lineage state; omp-ui
  never writes the global omp config (the rule that also shaped ADR-0055),
  never mutates PATH for a child, and never deletes or hides the user's
  binary.
- **No opt-in and no settings row.** The worktree keys above already have none
  because no "on" state is honest for them; `ovnfs.path` joins that rule by
  the same reasoning. There is no per-session override and no inherit state:
  a session that could re-enable ovnfs is exactly the session whose checkouts
  omp-ui cannot see. A user who wants daemon checkouts runs omp outside
  omp-ui, where nothing pins it.

## Why this mechanism, and why it holds

**The path must be non-executable by construction, not by convention.** A
blank `ovnfs.path` is not an off switch — the resolver trims and falls back to
`ovnfs` on PATH, so blank means "enabled". The pin therefore names a path that
cannot be an executable on any platform, and that path is **the lineage
directory itself** (`path.resolve(lineageDir)` in `writeWorktreeOverlay`).
A directory is not an executable anywhere: POSIX `execve` answers `EISDIR` or
`EACCES` even when its mode carries the execute bits, and Windows
`CreateProcess` refuses to start one. The lineage dir is the exact path the
overlay write itself requires — `writeLineageArtifact` creates it before
writing this very file and it dies with the lineage — so the guarantee is a
precondition of the rail, not an extra object to create, defend, or reclaim:
there is no sentinel file to plant a program over, and no error path where a
squatting executable could survive us. If the overlay write fails, the pin is
absent like every other overlay's value would be, and the rail's existing
fail-soft warning covers it — there is no fake guarantee to swallow an error
for. OMP treats a configured command it cannot run as "no ovnfs found" and
takes its native isolation fallback untouched — that resolution, not merely
the setting value, is what the live proof asserts.

**The overlay layer outranks every user layer that could re-enable discovery.**
`--config` is omp's per-run override rail: [ADR-0055](0055-private-sessions-quiet-overlay-plus-bridge-not-config-write.md)
live-proved against omp 18.10.0 that an overlay beats a project
`.omp/config.yml` pinning the same keys the other way, and `omp config get`
ignores `--config` entirely, so only the session's effective settings are
truth. This ADR's proof extends that to the **global agent layer**: with
`~/.omp/agent/config.yml` naming the real ovnfs binary and every
ovnfs-bearing PATH directory stripped from the child, the owned session still
suppresses discovery. Those are the only two inputs `ovnfsCommand` reads, so
nothing left can re-enable it inside an owned session.

**Native isolation stays native.** The overlay deliberately does not name
`isolation.backend` or `task.isolation.enabled`: both keep omp's own defaults
(`auto`, false), so the PAL still picks the best native backend for isolated
tasks and a user's explicit settings are respected. Suppression removes the
ovnfs discovery that would have diverted `auto`, rather than overriding the
user's backend choice — which is also why pinning `isolation.backend` to a
native value was rejected below: it would change behavior on machines with no
ovnfs at all, and it leaves the separate-checkout directive and daemon search
discovery in place.

## Considered Options

- **Blank or omitted `ovnfs.path` (rejected)** — falls back to PATH; not an
  off switch.
- **Strip ovnfs from the child's PATH (rejected)** — mutates the environment
  a session's every subprocess inherits (a shell tool could still find the
  binary by absolute path or install another one), does nothing about a
  configured `ovnfs.path`, and is invisible in the lineage artifacts that make
  a spawn inspectable.
- **Pin a native `isolation.backend` (rejected)** — bypasses ovnfs for
  isolated tasks only: the system-prompt directive and daemon-backed
  `grep`/`glob` discovery stay live, and it overrides a backend the user chose.
- **Write the global omp config (rejected)** — repo rule; also wrong in kind:
  it would suppress ovnfs for sessions omp-ui does not own.
- **Support coexistence instead (rejected as policy, 2026-11-06)** — adopting
  daemon checkouts into omp-ui's record/lifecycle was weighed against this
  gate's live evidence: the checkout and its `.omp-ovnfs-checkout.json`
  sidecar outlive a settled parent with no omp-ui surface that lists, finishes,
  or reclaims them, and the directive fires from discovery alone with no
  opt-in to gate. The user's decision is suppression for owned sessions.

## Live evidence

`packages/desktop/src/main/ovnfs-isolation-live.test.ts` (npm run test:live)
drives `omp --mode=rpc-ui` against a real ovnfs daemon and mount, scoped to
its temp base through `OVNFS_STATE`/`OVNFS_MOUNT`, and asserts runtime
outcomes only: the isolated task's applied stamp lands in the parent outside
any mount, `git worktree list --porcelain` never changes, no daemon state or
mount root is ever created, a user-level global `ovnfs.path` pin is outranked,
and the no-ovnfs control run is byte-identical to the suppressed run. Removing
the `ovnfs.path` line from the production writer fails all three arms, so no
arm passes on a machine where ovnfs merely could not run.

Binary provenance for both sides: managed `omp/18.17.0`, SHA-256
`a4ce6001ab1012ca835f4184d675437531bd1ac477a7ba8424ed0b5476e9e4cb`; upstream
`stencil-hq/ovnfs` v0.1.1 (MIT, Go), official release asset
`ovnfs_0.1.1_linux_amd64.tar.gz`, SHA-256
`17d926d1f51f2b60b194a51ba4bccf216f87b74d762ea0382acf274ce4c67725`, verified
against the release's own `ovnfs_0.1.1_checksums.txt`; extracted binary SHA-256
`0e7d1019f6d2ae5ae8f1753dfc022e5a9343d94f4544fb8529bd63b8dc1b1b75`. omp
requires admin protocol 5, which that release reports.

## Consequences

- An owned session whose machine has ovnfs installed now behaves exactly as
  one whose machine does not: git worktrees for separate copies, native
  isolation backends, native search. Nothing in the UI advertises this, and
  nothing about a session without ovnfs changes at all — that equality is what
  the control arm pins.
- The overlay grew a second concern beside the worktree keys, so its name
  undersells it; it stays one file on purpose: one artifact per spawn means
  one thing to inspect in a diagnostics bundle and one write order to reason
  about. It is fail-soft like its siblings — if the write throws, the spawn
  proceeds without the pins and logs `[worktree] could not write the overlay:`,
  which now would also lose ovnfs suppression. That is the accepted trade for
  never blocking a launch on an overlay.
- **Only Linux x64 is live-proven.** Every claim above was observed on
  linux-x64 with the managed `omp/18.17.0`. The Windows arm rests on documented
  OS semantics (`CreateProcess` refuses a directory; `path.join` yields
  backslashes, which `yamlQuote` escapes and YAML restores), not on a run here.
  A spot check on a Windows member — one owned session with ovnfs installed,
  asserting the isolated child lands outside any mount — is the outstanding
  verification, and it belongs to whoever first runs omp-ui there.
- **Suppression steers omp; it does not sandbox a shell.** The pin removes
  ovnfs from everything omp itself resolves — the directive, the isolation
  backend, daemon-backed search — which is what takes agents off daemon
  checkouts in practice. It cannot make an `ovnfs` binary unrunnable from the
  session's own `bash` tool: a command that names the binary by path, or
  starts the daemon with an explicit `--state`, runs whatever it likes, exactly
  as it can run `git worktree add` by hand. That residual is the same one the
  worktree pins have always had (explicit checkout commands were never ours to
  block), and closing it properly would mean a sandbox omp-ui does not own;
  ovnfs's own documentation says it "isolates files, not processes: it is not a
  sandbox". What suppression changes is that nothing in the session's own
  prompt or tooling points an agent there any more.
- **The pin is written unconditionally, with no version gate.** omp-ui's
  harness floor is omp 18.16.0, where the key does not exist at all: that
  release's own binary contains no `ovnfs` string, so our overlay names a
  setting it has never heard of. That is safe — verified against the official
  `omp-linux-x64` asset of v18.16.0 (SHA-256
  `6498ed785bab00d2926e0387e0ec02362d6d45f1c3d0d1b57c1618b7f95c9264`), which
  boots `--mode=rpc-ui --config <the pin>` to its `ready` frame with empty
  stderr. A separate check against 18.17.0 with a wholly foreign
  `bogus.key` overlay confirmed the same: an unknown `--config` key is ignored,
  never a startup error (and `lineage-artifact.ts` records that a *malformed*
  overlay would be one, which is why every write stays well-formed). Gating on
  `omp --version` like the `out://` overlay does would only add a probe
  subprocess and a stale-cache path for no behavior change: on an omp without
  the key there is nothing to suppress, and pinning a directory that already
  exists costs nothing. It also means suppression cannot be lost by a
  version-skew bug in our own gate.
- A future omp that renames `ovnfs.path` silently loses suppression. That is
  why the live proof's floor is `18.17.0` and why its assertions are runtime
  outcomes — child cwd, applied bytes, daemon state — rather than prompt text
  or embedded source strings: a rename surfaces as a red live test, not as a
  green one reading a string that no longer means anything.

## Amends / relates

- [ADR-0018](0018-worktree-checkouts-in-app-data.md) — app-data worktree
  sessions; this ADR settles the neighbouring gap it left open: checkouts
  omp-ui does not own and cannot own.
- [ADR-0038](0038-session-scoped-approval-mode-via-config-overlay.md) — the
  per-lineage `--config` overlay rail, and why a pin needs no honest "off"
  control.
- [ADR-0055](0055-private-sessions-quiet-overlay-plus-bridge-not-config-write.md)
  — same rail for a policy that must not touch global config; source of the
  `--config` outranks-project-layer and `omp config get` blindness findings.
- Issue #833 — the `worktree.onStart` / `worktree.onExit` pins this overlay
  already carried, unchanged here.
