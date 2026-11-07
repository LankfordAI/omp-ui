# Private sessions ride a quiet overlay plus a roster bridge, never a config write

> **Status:** Accepted, 2026-10-13 ([#852](https://github.com/LankfordAI/omp-ui/issues/852)).
> Amended 2026-11-07 for the Hindsight passive channel
> ([#1094](https://github.com/LankfordAI/omp-ui/issues/1094)) — see
> "Amendment: the Hindsight channel needs a child-env pin too".

A **private session** (CONTEXT.md) must never write to the memory system
while staying fully normal otherwise: transcript persists, recall still
works, nothing global changes. omp 18.10.0 gates memory writes through two
config channels — `autolearn.enabled` (lesson capture) and
`mnemopi.autoRetain` (passive retain of completed turns, default true) —
plus four agent-invocable tools (`memory_edit`, `retain`, `learn`,
`manage_skill`). There is no per-tool `.enabled` key and no rpc "disable
memory" verb, so quietness needs both rails omp-ui already owns: the
per-lineage `--config` overlay (ADR-0005) and a generated bridge (ADR-0008
discipline).

Verified against the omp 18.10.0 binary:

- `omp config get <key>` **ignores `--config`** — the flag parses but the
  subcommand reads global layers only. What the overlay changes is the
  session's effective `ctx.settings`, which is the layer the live test reads
  through the config-registry lookup API (ADR-0036); the overlay outranks
  even a project `.omp/config.yml` that pins the same keys true.
- `mnemopi.autoRetain` defaults to true and `autolearn.enabled` seeds to
  true (ADR-0025's `seedMemoryDefaults`), so quietness must *pin false* —
  deleting or omitting is not enough.
- No `<tool>.enabled` config key exists for any of the four write tools;
  removal is a live-session operation: `setActiveToolPresentation` with the
  filtered enabled set and the intersection of mounted xd:// names (the
  capabilities bridge's apply seam), falling back to
  `setActiveToolsByName`.
- `mnemopi.autoRecall` (recall into the first turn) and `memory.backend`
  are the *read* channels. Naming them would make private mean
  read-amnesia, which is not the promise.

## Why not the obvious routes

- **Writing the user's global config** (`omp config set
  mnemopi.autoRetain false` at spawn): destroys the user's setting the
  moment a private session starts, races parallel sessions on the same
  whole-file rewrite, and there is no safe restore point if the app dies
  mid-session. ADR-0025 keeps config truth in the user's layers; a
  per-session overlay expresses the same pin without touching them.
- **`--tools=` at spawn**: one argv touch per builder plus the
  spawn-request allowlist for a value that is a record field, and it takes
  a closed roster — omp-ui must not re-derive the full default tool list
  (dynamic registrations from extensions would fall off it).
- **Re-arming the bridge on every session event**: a re-arm on `/new` or
  `/branch` would silently re-disable the four tools even after the user
  deliberately re-enabled one mid-session; the user's own toggle wins, so
  the arm is one-shot per process via `initialCommands` — the same rail the
  knowledge-vault guidance and plan bridge ride, so it lands before the
  first turn on fresh spawn and resume alike.

## Decision

**Per-lineage quiet overlay + one-shot generated roster bridge; the flag is
record state and nothing else.**

- `OwnedSessionRecord.private: boolean` (required-with-false, the #294
  convention: absent normalizes to false at parse time, a non-boolean drops
  the record). `NewSpawnRequestBase.private?: boolean` parses only on the
  `new` origin — a resume never re-decides it. It is never a project
  default and never enters last-used spawn state; a fork copies the source
  record's flag.
- `packages/core/src/private-overlay.ts` writes `omp-ui-private.yml`
  (`autolearn.enabled: false`, `mnemopi.autoRetain: false`, and since #1094
  `hindsight.autoRetain: false`) into the lineage dir from the record flag;
  a false flag removes the artifact, so an ordinary session inherits omp's
  config untouched. `writeSessionOverlays` collects it, covering both argv
  builders and every resume identically. The file never names
  `mnemopi.autoRecall`, `hindsight.autoRecall`, or `memory.backend` /
  `hindsight.apiUrl` — absence keeps recall alive and the user's chosen
  backend in place; a live test asserts both halves.
- `packages/core/src/private-guard-extension.ts` is the generated bridge:
  the `/omp-ui-private` command binds the first prompting root (prompt
  prototype, ADR-0008), reads the enabled roster, filters the four write
  tools, and applies through the presentation setter — the capabilities
  bridge's exact seam. Nothing to remove is a no-op; a runtime with neither
  setter gets one `ui.notify` warning, never a throw: a private session's
  passive pins (the overlay) are still in force, and silently pretending
  the tools are gone would be worse than naming the gap.
- rpc-ui spawns arm the command through `initialCommands` when the record
  is private, and the knowledge-vault write guidance is suppressed for
  private sessions (guidance that invites memory writes contradicts the
  pin). PTY sessions get the passive overlay only — no tool removal —
  because their tool roster lives in an embedded TUI omp-ui does not
  command; the issue records this accepted gap.

## Amendment: the Hindsight channel needs a child-env pin too (#1094, 2026-11-07)

Hindsight adds a third passive write channel: `hindsight.autoRetain`
(default true) subscribes to `agent_end`, and
`maybeRetainOnAgentEnd` ships the transcript to the configured server on the
`hindsight.retainEveryNTurns` cadence. Removing the four explicit tools does
not touch it — it is not a tool path — and the original overlay simply never
named the key. Private sessions could therefore submit transcripts at the
configured cadence; the original report observed enabled runtime state,
not an actual private transcript upload.

Two facts from the installed runtime change the shape of the fix:

- The overlay still works at the settings layer: with `hindsight.autoRetain`
  pinned false in `omp-ui-private.yml`, the live session resolves the gate
  off even when the project layer pins it true, while
  `hindsight.autoRecall` and `memory.backend` stay untouched (the same
  write-quiet, recall-enabled boundary as Mnemopi).
- The key is **environment-backed**: upstream's handle reads
  `HINDSIGHT_AUTO_RETAIN` with no config fallback, and a set env var
  outranks every settings layer including this overlay. On a machine where
  the user exported it true, the overlay alone loses — so a per-spawn
  overlay cannot be the whole pin for this one channel.

**Decision:** private spawns pin `HINDSIGHT_AUTO_RETAIN=false` in the child
environment, beside the overlay. `privateChildEnv(pin)` (core) returns the
one-key env for a private record and nothing for an ordinary one;
`RpcClientOpts.childEnv` and `spawnOmp`'s matching option merge it over the
sanitized base env at spawn only. It is child-scoped by construction:
omp-ui's own `process.env` is never mutated, an ordinary session's spawn
carries no key and keeps honoring the user's exported value, and the warm
pool can never serve a private spawn (reservation excludes private records
and its template resets the flag), so the cold boot is the only site that
needs it. Both argv builders pass it, so native and PTY, new and resume all
carry the pin from the record — same "derived every launch" rule as the
overlay.

**Outbox boundary.** Explicit-tool memories queued before a private session
starts remain upstream outbox state, eligible for omp's own startup drain.
This change suppresses new automatic transcript retention; it does not
delete or suppress delivery of previously queued memories. PTY sessions
still have the explicit-tool limitation described above. Old-outbox
delivery is distinct from retaining the current private transcript.

Verified against the installed binary with a controlled loopback Hindsight
sink (`packages/desktop/src/main/hindsight-retention-live.test.ts`): an
ordinary session with the env exported true posts its transcript at
`retainEveryNTurns: 1`; a private spawn of the same scope posts **nothing**
— across `agent_end` and across SIGTERM — while its recall request still
arrives; and the control scope (overlay written, env exported true, pin
removed) retains exactly as the trap predicts, proving the sink sees
submissions and that the child-env pin — not the overlay alone — is what
keeps the private scope silent. The settings-layer half and the env outrank
ride in `private-guard-live.test.ts`'s probe pair.

## Amends / relates

- ADR-0005 (record-true overlays written at spawn) — same rail, fifth key.
- ADR-0008 (generated bridges bind the prompting root) — the guard's root
  capture and one-shot arm.
- ADR-0025 (config truth lives in omp) — quietness is a session pin; the
  user's layers are never written.
- ADR-0036 (bridges read omp settings through the config registry) — the
  live proof reads effective values the same way, which is also how it
  proves the overlay layer outranks the project layer.
