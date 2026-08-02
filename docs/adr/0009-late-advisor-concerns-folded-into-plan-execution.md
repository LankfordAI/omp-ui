# Late advisor concerns are folded into plan execution

Plan mode (ADR-0007) and the advisor (ADR-0005, ADR-0008) coexist in a rpc-ui
session. When the planner submits a plan through `xd://propose`, the advisor's
review of that drafting turn can land **after** the review pane is presented.
That review was invisible to the user's execute/refine decision and was never
carried into the implementation — for the fresh and compacted execute contexts
the implementer lived in a context that never saw the source session's advisor
cards at all. This ADR records how omp-ui surfaces and actions those late
concerns on **execute** (and deliberately not on refine).

## The timing that makes this hard

The advisor reviews a turn when the turn ends (`onTurnSuccess`), and omp runs
it async to the primary loop (ADR-0008). The review gate blocks **inside** the
plan turn itself: the extension's `select` does not resolve until the user
answers. Therefore the plan turn's review cannot exist while the gate is open —
and at verdict time the transcript's `advisory` cards are reviews of *earlier*
turns, not the plan being decided. A fold that read the current transcript at
verdict time would promote stale, unrelated findings.

The two verdicts differ in whether they end the turn:

- **Execute** — the extension's tool result tells the agent to stop and wait
  for a separate implementation prompt. The turn ends promptly, the advisor
  reviews it, and the review lands right after.
- **Refine** — the tool result tells the agent to keep working in the same
  turn: "incorporate [the notes], revise …, then write its title to
  `xd://propose` again". The turn does not end at the verdict, so a deferred
  steer would race the planner's in-flight revision and could arrive after it
  has already re-proposed. And refine needs no explicit fold: the planner
  revises in this same session, where the advisor's notes are already injected
  into its context.

## The handoff

Only execute waits. The renderer answers the verdict immediately (omp's agent
is blocked on it), snapshots the transcript item baseline, and — when the
session has a **configured advisor** — waits, bounded (15s), for advisor
findings appended after the baseline. A finding can arrive in either of two
shapes: a standalone `advisory` card and/or notes attached to the plan turn's
tool result. The settle trigger and the fold are one function that reads the
same collection — every finding appended after the baseline, deduplicated on
`advisor|severity|note` — so either delivery shape settles the wait and no
review is double-folded. On settle, the notes are folded into the
implementation prompt as explicit instructions (severity preserved), in every
execute context: same session, same session after compaction, or the freshly
spawned session seeded with the plan. If the bounded deadline passes without a
review, dispatch proceeds clean, unfiltered. A per-review switch in the pane,
default on, disables the wait and restores today's immediate dispatch;
sessions without a configured advisor never wait.

## Why not the obvious routes

- **Render the live advisories in the review pane.** The drafting review has
  not happened while the gate is open, so the pane could only show reviews of
  earlier turns — misleading at the exact moment a verdict is being chosen.
- **Fold the current transcript at verdict time.** Same stale-card problem; the
  plan-drafting review is definitionally absent until the gate resolves.
- **Defer refine the same way.** Unsound per the timing above: the extension
  keeps the planner in the same turn, the review cannot land while a deferred
  steer waits, and the revising planner already sees the injected notes.
- **New omp surface to read the advisor session.** The notes are already in the
  session transcript omp-ui owns; the correlation is a transcript item baseline.
  No new wire contract, no text parse of `/advisor dump`.

## Consequences

- **Fresh and compacted execution stop losing the review.** They are the real
  gap: their implementers never see the source session's advisor cards, and the
  fold is the only channel that carries the plan review to them.
- **The wait is bounded and opt-out.** A slow advisor costs at most 15s and the
  session proceeds cleanly; switch off (or no configured advisor) and behavior
  is exactly today's.
- **Only the drafting turn's review is folded.** The baseline excludes every
  finding already present at the verdict, so older findings are never promoted
  onto the current decision.
- **Refine is untouched.** Its user notes steer immediately; the advisor's
  input remains the injected notes in the revising session.
