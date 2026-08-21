# A stalled turn end gets a diagnostic at the turn-end and a bounded continue

When the model stream goes silent mid-turn, omp's provider watchdog aborts the
turn (`stopReason: "error"`, the timeout `errorId` bit, the watchdog message),
and omp deliberately never retries a turn that already emitted content — a
retry re-runs the model call from the top and re-emits the partial output
(issue #250's incident: kimi-k3 via OpenRouter died mid-`ask`, and the only
artifacts were an error receipt and a card mislabelled "cancelled"). omp-ui's
own stall watchdog (`streamStallAbortSeconds`, issue #248) aborts the same way
on its side. Either way the session process stays alive and idle with nothing
carrying the work forward, and the diagnostic notice from issue #100 never
posted, because `stallNotice` was only reachable from `auto_retry_start`
frames — and a stall interrupted after content produces no retry. The user had
zero signal that anything had happened. Issue #251 asks for the continuation;
this ADR records the shape of the answer.

## The classification

A turn's end is *stall-classified* when its terminal assistant message (the
`message_end` immediately before `agent_end`, remembered by the store as
`lastTurn`) carries `stopReason: "error"` plus either the timeout `errorId`
bit or the provider's stall message. That reuses the existing classifier
constants from the issue #100 diagnostic verbatim. The class deliberately
excludes two neighbours: a user interrupt (`stopReason: "aborted"`, which the
transcript already renders truthfully) and non-stall errors (a provider 5xx,
a refusal, context overflow — the receipt's `error` chip is their surface).
The same class drives two independent reactions:

- **The diagnostic is unconditional.** Every stall-classified error turn-end
  posts the issue #100 `warn` notice, computed by the existing `stallNotice`
  against the terminal message's fields. It posts whether or not the switch
  below is on, and whether or not a continue is dispatched.
- **The continue is a switch.** App-level `stallAutoContinue` (Settings →
  General), default on, mirroring `advisorAutoReply` and matching the
  app-level posture of the stall watchdog itself.

## The continue

`PromptRoute` gains `stall_continue`, which rides `streamingBehavior:
"followUp"` exactly as `advisor_reply` does (ADR-0012): the prompt is queued
behind any turn that started in the gap, never steering an active turn, and it
never titles the session. The new renderer module `lib/stall-continue.ts`
owns the decision: `StallContinueWatcher` is a single-event trigger — the
`agent_end` handler calls it when the turn died to a stall-classified end —
so unlike the advisor watcher it holds no transcript baseline; what it shares
with ADR-0012 is the loop-guard shape, because the continue turn is itself a
model call and can itself stall.

The guard has the same three mechanics as the advisor fold: a 1.5 s settle
window before dispatch, so a user who sees the error and types "continue"
themselves wins the race (their prompt resets the guard and cancels the
pending dispatch); a cap of `STALL_CONTINUE_MAX` (2) consecutive
auto-continues per session, since a persistently dead provider would loop
forever without one, and at the cap a single `warn` notice explains that a
prompt re-arms it; and reset on any *user-originated* prompt — composer
routes, abort-and-prompt, plan-execute dispatch, history reload. An
auto-prompt (`advisor_reply`, `stall_continue`) resets neither watcher: an
auto-prompt is not human direction. The dispatch itself posts an `info`
notice, so the follow-up is never mistaken for something the user typed.

At fire time the store re-checks the gates, not just at trigger time: the tab
exists, the switch is on, the status is `ready`, no `exited` entry, no pending
extension question, no plan gate. A process that dies or hibernates inside
the settle window therefore never receives a continue, and a re-boot or erase
cancels the watcher state so no stale count survives a process restart.

## The companion label

The same incident exposed that every terminal path settled still-running tool
cards to `cancelled` — indistinguishable from a user cancellation (issue
#250). `ToolItem.status` gains `aborted`: cards settled because the turn died
(error end, RPC failure, process death, hibernation) read `aborted`, rendered
with a copper chip — the established "attention" tone — while a user interrupt
(`stopReason: "aborted"`) and any other end keep `cancelled`. The reducer
derives the target from the turn's terminal assistant message; the store's
failure and exit paths pass it explicitly, since process death is an abort by
definition.

## Why not the obvious routes

- **Retry the provider call.** Impossible in omp-ui — the workaround-only
  mandate (AGENTS.md) bars upstream changes — and unsafe anyway: omp refuses
  to retry after content precisely because a retry re-emits the partial
  output. Pre-content stalls already have omp's own retry net when
  `retry.enabled` is set; this ADR covers the continuation side, which omp
  leaves to the user.
- **Dispatch from the main process.** A desktop renderer and a remote browser
  renderer each run their own watcher: at most one dispatch each, serialized
  by the followUp queue, each capped at 2. True cross-renderer dedup would
  require main-process dispatch ownership — a separate change. The inherited
  ADR-0012 posture is adequate while the cap bounds the total spend.
- **Per-session composer switch.** No natural home in the composer strip
  without a new control cluster; the app-level switch matches the stall
  watchdog, which is also app-level-only. Deferred to a v2 candidate.
- **Do the same for terminal tabs.** A PTY carries no prompt channel omp-ui
  may inject into (ADR-0012's exclusion, unchanged).
- **Auto-continue for non-stall errors.** A provider 5xx or a refusal is a
  different failure with a different right answer; the classifier keeps the
  continue scoped to stream stalls, and the `aborted` label still tells the
  truth for the rest.

## Consequences

- **A stalled turn end is never silent again.** The diagnostic posts at the
  turn-end even when no retry fired, and — with the default — the session
  continues itself instead of sitting idle.
- **Automatic spend is bounded.** Two continue turns per stall episode, then a
  visible `warn` and a stop, re-armed by the user.
- **The transcript tells the truth.** `aborted` vs `cancelled` distinguishes
  "the turn died" from "the user cancelled", which is what issue #250 was
  about; the diagnostic and the continue notices name the mechanism in the
  transcript where it happened.
- **The on-disk transcript is untouched.** Both reactions are renderer state
  over the same frames omp already sends; resuming a hibernated session later
  sees the original record.
- **Subagent stalls are out of scope.** Subagent events ride `subagent_*`
  frames and the root agent receives the failure as a task result; the
  root-only `agent_end` trigger cannot misfire on them.
