# Experiments configured in conversation

> **Status:** Accepted, 2026-09-17 ([#567](https://github.com/LankfordAI/omp-ui/issues/567)).

The **New experiment** dialog (ADR-0030) asks the user for everything the loop
needs — goal, metric, direction, boundaries — in a checkout the user often has
not read. Issue #567 lets the main model configure an experiment instead: the
user asks for one in a native session, the model reads the codebase, interviews
the user, and when the user confirms, calls a new `propose_experiment` tool
registered by the autoresearch bridge every rpc-ui spawn already loads. The
tool blocks on a `select` whose title carries a sentinel plus the JSON spec;
the renderer recognizes the sentinel and opens the existing dialog prefilled.
**Launch** runs the ADR-0030 launch unchanged and then answers the select with
`launched:<json>` so the model learns what actually started; closing the dialog
answers `revise` and the conversation continues. The experiment session stays
a separate worktree session — the interview session is not the loop's home.

## Why not the obvious routes

- **A one-shot drafting call (`omp -p` or similar).** Tool-less, it can only
  reshape the user's sentence — it cannot read the checkout, so its metric and
  command guesses are hallucinated. Tool-scoped to a headless session, it
  cannot ask the user anything: the interview is the feature. And a draft that
  arrives fully-formed skips the confirmation the plan mode precedent
  (ADR-0007/#312) treats as the whole point of a gate.
- **Arming `/autoresearch` in the interview session.** One worktree per
  experiment (ADR-0030) is what gives the loop its branch, its baseline, and
  its provenance record; the interview usually starts at the project checkout
  the user is already working in. Reusing that session would either launch at
  the checkout with no isolation or rewrite CONTEXT.md's "New experiment"
  contract mid-flight. Context crosses over through the tool's optional
  `brief`, which the kickoff appends instead.
- **A main-process gate tracker like plan mode's.** Main tracks the plan gate
  because it must validate the artifact before any client may answer (#312 §6).
  There is nothing to validate here: the `select` is an ordinary blocking
  dialog, so `DialogGateTracker` already carries `awaitingHumanAnswer`,
  hibernation, the stall watchdog, and `pendingDialogs` for it with zero main
  changes. The renderer splits the sentinel frame out of its generic queue at
  reconciliation so the two clients' lists never disagree (#555 machinery).
- **A provider API call from omp-ui.** Model credentials live in omp; omp-ui
  holds none (and acquiring any would fork configuration that ADR-0002 exists
  to keep single-sourced). The interview must be the session's own main model
  anyway — it is the one holding the conversation.

## Decision

The bridge registers `propose_experiment` at load with `pi.zod` schemas; a
runtime without `pi.registerTool` publishes `proposeUnavailable` on the
snapshot and everything else keeps working. The tool normalizes snake_case
parameters into the wire's `ExperimentProposal` (core's total parser is shared
by both sides, so neither accepts what the other rejects), caps the sentinel
title at 16 KiB, and blocks on `ctx.ui.select(SENTINEL + JSON, ["launch",
"revise"])`. The renderer intercepts the frame in `frame-reduction` exactly
like `parsePlanReviewTitle`, holds it on the tab as `experimentProposal`, and
opens the dialog bound to that tab. Launch answers only after the spawn
resolves — the tool result then tells the model the truth, including a branch
name it did not choose and any field the user edited. Cancel, Escape, and the
backdrop all answer `revise`; there is no deferral state. A malformed payload
falls through to the generic dialog rather than trapping the agent, and a
bare `launch` answer there maps to "dismissed": nothing launches without the
form. Two entry points start the interview: the dialog's **Configure with the
agent** button (fresh rpc-ui session, clean context) and
`/autoresearch start <text>` in a live tab (the model the user is already
talking to).

## Consequences

The interview needs no new transcript item kind, no new main-process state,
and no upstream changes: the pending proposal reads as a human-answer wait in
the sidebar because `experimentProposal` joins the existing
`awaitingHumanAnswer` derivation. `NewExperimentSpec` gains a `brief` field
that is deliberately not an `init_experiment` parameter — it rides the kickoff
prompt only. Because the answer is sent after `spawnSession` resolves, a
rejected spawn leaves the gate pending and the dialog open with git's message,
exactly like a failed blank-form launch; the user retries or cancels. On a
remote instance (ADR-0028) two clients can race the same gate; the losing
answer is a stale `extension_ui_response`, the documented #555 posture.
