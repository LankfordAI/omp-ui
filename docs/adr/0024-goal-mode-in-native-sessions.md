# Goal mode, driven by the same generated-extension discipline

The `/goal` family (`goal`, `guided-goal`, and the `set` / `show` / `pause` /
`resume` / `drop` / `budget` subcommands) is offered in rpc-ui tabs as a composer
command family, a HUD chip, and a hibernation veto. It is delivered by a
**per-lineage generated extension** (ADR-0003, ADR-0007, ADR-0008) passed with
`-e` at spawn, and every goal it reports is OMP's own runtime state — omp-ui
never keeps a parallel goal record and never asks the model to role-play one.

## Why not the obvious routes

Verified against omp 18.1.10 by driving a real `--mode=rpc-ui` process:

- **No rpc command exists.** The `RpcCommand` union has no goal variant, as with
  plan mode and the advisor.
- **`/goal` is a prose prompt under rpc-ui.** Its spec is `handleTui`-only, so a
  forwarded `/goal pause` is not a command at all: it reaches the model as
  literal text and starts an agent turn that *talks about* pausing. A UI built on
  that path would report state the runtime never entered. omp-ui therefore
  intercepts the family in the composer and dispatches a hidden command to the
  bridge instead.
- **The TUI's own gate is unusable here.** The interactive continuation loop is
  gated on `goal.continuationModes` containing `"interactive"`; rpc-ui is not
  that mode, so nothing starts the next turn. The bridge replicates the TUI's
  800 ms settle timer and starts continuations through `promptCustomMessage`.
- **`get_state` reports no goal.** Nothing in the payload names goal state, so —
  as with plan mode — the client could not read it back and would have to invent
  it. It does not: the bridge publishes OMP's reduced `GoalSnapshot`.

## What is actually reachable

`AgentSession.goalRuntime` carries the whole API (`createGoal`, `replaceGoal`,
`resumeGoal`, `pauseGoal`, `dropGoal`, `onBudgetMutated`, `onThreadResumed`,
`clearAccounting`, `buildContinuationPrompt`, `completeGoalFromTool`), and
`getGoalModeState` / `setGoalModeState` carry the mode. `ExtensionContext` still
exposes no `AgentSession`, so the bridge patches
`AgentSession.prototype.prompt` to capture the root, exactly as ADR-0007 does:
the patch is wrapped, every method the flow calls is admitted before it is used,
and any failure publishes `available: false` with the reason. The feature
degrades to absent, never to half-working.

Two frame types that already exist carry the channel, so the frame router grew no
new cases — only a claim of `omp-ui:goal` ahead of the generic extension-status
handling:

- `ui.setStatus("omp-ui:goal", <json>)` publishes `GoalSnapshot`, monotonic per
  process (`revision`) plus the digest of the payload it describes. Stale or
  duplicate revisions lose to what the client already holds; a malformed payload
  is dropped and the last good snapshot stands.
- `ui.confirm("omp-ui:goal-drop:<id>", …)` requests the destructive confirmation.
  `ExtensionDialogHost` answers it like any other bridge dialog, and a dialog
  that is never answered simply leaves the goal in place.

Results ride the snapshot, correlated by `requestId`: the renderer dispatches a
hidden `omp-ui-goal command <json>` prompt, so a command row settles from what the
runtime actually did rather than from an acknowledgement that only proves the
dispatch was accepted.

Ownership lives in the process that answers, not the tab id: the status tracker in
main keys on `processKey`, adopts a new key when a lineage's process is replaced,
and retires frames from a superseded bridge. That is what keeps a restarted or
branched session from showing a goal its current runtime no longer has.

## Consequences

- **Arm before plan.** Every rpc-ui spawn sends the goal arm command first, so a
  restored goal answers Plan mode's unfinished-goal check before Plan can be
  entered around it (ADR-0007's channel is joined at the same point in the
  chain).
- **An active goal blocks Plan entry, in both halves.** The renderer disables the
  toggle with the reason, and the generated plan bridge refuses the raw RPC path
  and the race window, with OMP's `goal` tool the only writer of `complete`.
- **A running goal holds the process awake.** Hibernation must not kill the loop
  that is doing the work, so the hibernation tracker consults the goal snapshot
  before its `plan-handoff` early return. A paused or budget-limited idle goal
  owns no loop and applies no veto.
- **Auto-prompts defer to the goal.** Advisor reply and stall auto-continue are
  gated while a goal owns the session: an automatic prompt must not restart a
  goal the user paused or exhausted. Diagnostics still render — the gate is on
  dispatch, not display.
- **Session-local tool enabling is one-way.** The bridge enables the `goal` tool
  through `setActiveToolPresentation` and never restores a whole-roster snapshot,
  so a roster the user edited in the capabilities viewer survives; disabling the
  tool during an active goal pauses it rather than stranding it.
- **The budget is OMP's.** `budget` sets a total, not an increment, and the
  accounting the chip shows is OMP's `tokensUsed`; omp-ui does not meter tokens.
- **Continuation needs a clean turn end.** A continuation is scheduled only after
  a clean `agent_end` with a tool-producing turn, and OMP's own no-progress guard
  pauses with its own reason text. Verified on the real binary: one
  `goal-continuation` custom record per clean end, `mode` entries of `goal` and
  `goal_paused`, and a pause with `Goal continuation made no tool progress;
  resume to continue.` after a repeated non-productive turn.
