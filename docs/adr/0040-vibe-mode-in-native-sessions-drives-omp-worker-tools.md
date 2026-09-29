# Vibe mode drives OMP's own worker tools, not a parallel director

`/vibe` — OMP's director mode, where a root session spawns and steers worker
screens through the `vibe_*` tools — is offered in rpc-ui tabs as a composer
command family, a HUD chip, and a worker roster in the Agents pane. It is
delivered by a **per-lineage generated extension** (ADR-0003, ADR-0007,
ADR-0008) passed with `-e` at spawn, and every worker it reports is OMP's own
runtime state: omp-ui invokes the tools' `execute` implementations rather than
re-implementing worker semantics, and never asks the model to role-play a
director.

## Why not the obvious routes

Verified against omp 18.4.2 by driving a real `--mode=rpc-ui` process:

- **No rpc command and no rpc-reachable slash command exist.** The
  `RpcCommand` union has no vibe variant, and the `/vibe` spec is
  `handleTui`-only: over rpc-ui the line would reach the model as literal
  prompt text — an agent turn that *talks about* spawning workers (the exact
  failure ADR-0024 refuses for `/goal`). The composer intercepts the family and
  dispatches a hidden `omp-ui-vibe command <json>` prompt to the bridge
  instead.
- **The control surface is the tools themselves.** `vibe_spawn`, `vibe_send`,
  `vibe_wait`, `vibe_kill`, and `vibe_list` mount only while the mode is on
  (`activateVibeTools`), and the bridge drives them through
  `session.getToolByName(name)` after activating — so spawn semantics, worker
  naming, tier selection, and screen teardown stay OMP's. This is the
  difference from the goal bridge: there was no tool surface to call there,
  here there is exactly one, and using anything else would fork worker
  semantics into omp-ui.
- **`get_state` reports no vibe mode.** Like plan and goal, the mode lives on
  `AgentSession` (`getVibeModeState` / `setVibeModeState`), which
  `ExtensionContext` does not expose; the bridge captures the root by wrapping
  `AgentSession.prototype.prompt` (ADR-0007's patch) and reads mode plus
  roster from it.

## The channel

Existing frame types only; the router claims `omp-ui:vibe` ahead of the generic
extension-status handling:

- `ui.setStatus("omp-ui:vibe", <json>)` publishes a `VibeSnapshot` — the
  availability verdict and its reason, whether the mode is on, the worker
  roster (state, tier, turn count; `parked` and killed rows are omp-ui-side
  views of transcript-surviving and explicitly-killed workers), and any
  correlated command result. Monotonic per process (`revision`) plus a digest
  of the payload it describes, so a stale or duplicate publish loses and a
  malformed publish leaves the last good snapshot standing. While the mode is
  on the bridge polls the roster every 1.5 s, because workers move without a
  command.
- Results ride the snapshot, correlated by `requestId`: a command row settles
  from what the runtime actually did, never from an ack, and never from a
  model turn (ADR-0024's ban on self-prompting the root applies verbatim).

Ownership lives in the process that answers, not the tab id
(`VibeStatusTracker` in main keys on `processKey`, adopts a replaced
process's key, retires a superseded bridge's frames), and
`SessionSummary.vibe` carries the newest snapshot to late subscribers and
rehydrating renderers.

## Restore, teardown, and the mode slot

- **A resume re-arms the mode from the transcript.** OMP's runtime writes
  worker lifecycle entries as `custom:vibe-session-lifecycle` records; on
  resume the bridge replays them, re-arms a saved-on mode whose process died,
  and marks workers whose transcripts survived but whose screens did not
  `parked`. Killed workers stay killed: omp-ui tombstones explicit kills
  instead of resurrecting them, and a killed worker's screen simply disappears
  from OMP's own list.
- **Exit goes through OMP's teardown — and distrusts it.** `runModeExitTeardown`
  increments a transition counter, awaits the work callback, and *discards its
  return value*: the bridge carries the verdict in a box the callback closes
  over, so a teardown failure settles the command with the real reason instead
  of an empty one.
- **One mode slot, three bridges.** Entry and exit join the chain shared with
  the plan and goal bridges under `Symbol.for("omp-ui:mode-transition")`, and
  every pair is refused in both halves: vibe entry checks Plan and an
  unfinished goal; goal start checks vibe (ADR-0024's symmetric veto); plan
  entry checks vibe. The renderer disables the toggles with the reason, and the
  generated bridges refuse the raw-RPC path and the race window.
- **Arm order is mcp → goal → vibe → plan.** The vibe restore re-checks the
  goal bridge's restored state before re-arming a saved mode, and a plan
  command must never run against an unrestored slot.
- **Live worker work holds the process awake.** Hibernation consults the vibe
  snapshot beside the goal veto: mode on with work in flight vetoes; an idle
  roster or a mode that is off does not.

## Accepted deltas from the TUI

Per the plan (issue #683): explicit-kill tombstones instead of OMP's own
roster memory; no rehydration of killed workers; no `suspendScope`; no
director-prompt argument on entry; no scope-exited marker. None of these
changes who owns worker semantics — OMP does — and each keeps the bridge
inside APIs omp 18.4.2 actually exposes.
