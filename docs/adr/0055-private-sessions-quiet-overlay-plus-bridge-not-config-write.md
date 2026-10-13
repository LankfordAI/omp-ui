# Private sessions ride a quiet overlay plus a roster bridge, never a config write

> **Status:** Accepted, 2026-10-13 ([#852](https://github.com/LankfordAI/omp-ui/issues/852)).

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
  (`autolearn.enabled: false`, `mnemopi.autoRetain: false`) into the lineage
  dir from the record flag; a false flag removes the artifact, so an
  ordinary session inherits omp's config untouched. `writeSessionOverlays`
  collects it, covering both argv builders and every resume identically.
  The file never names `mnemopi.autoRecall` or `memory.backend` — absence
  keeps recall alive; a live test asserts both halves.
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

## Amends / relates

- ADR-0005 (record-true overlays written at spawn) — same rail, fifth key.
- ADR-0008 (generated bridges bind the prompting root) — the guard's root
  capture and one-shot arm.
- ADR-0025 (config truth lives in omp) — quietness is a session pin; the
  user's layers are never written.
- ADR-0036 (bridges read omp settings through the config registry) — the
  live proof reads effective values the same way, which is also how it
  proves the overlay layer outranks the project layer.
