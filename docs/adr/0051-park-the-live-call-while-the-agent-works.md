# Park the live call while the agent works, because the controller offers no idle phase mid-turn

Resolves issue #815. Builds on ADR-0050's park/resume machinery (recap fold,
pending pipeline, `buildLiveInstructions`) and adds a second park cause: the
tab stays viewed, but the agent runs a *delegated* backend turn the voice call
has nothing to contribute to. Verified against the managed binary
`omp/18.8.6` (linux-x64).

## Findings

- During a delegated turn the controller's phase never returns to
  `listening`: it sits in `working` (and `speaking` while the model
  acknowledges), so the ADR-0050 restart hook — "restart at the next
  `listening`" — can never fire mid-turn. The park moment must come from a
  timer, not a phase.
- `live_levels` is edge-triggered: frames arrive on level *changes*, not on a
  cadence. A quiet spell therefore produces no frames at all, and "has the
  model gone quiet?" can only be answered by a scheduled deadline armed from
  the last quiet frame — counting frames would park mid-sentence during any
  pause between level edges.
- Distinguishing "the model paused between words" from "the model finished
  speaking and the work began" needs a loudness history, not an instant: the
  deadline is armed only by the first quiet frame *after* a loud one.
- `live_start` into a session whose call is still open fails (ADR-0050). Any
  close-then-reopen sequence must therefore await the `live_stop` response
  before dispatching `live_start` — wire order is load-bearing, not style.
- A renderer reload re-creates a `TabRuntime` under the same tab id, so a
  generation counter used to invalidate in-flight dispatches must live
  outside the runtime: clearing state with the runtime lets an ack from the
  old connection restore the old intent.

## Decision

1. **Delegation arms the park.** The `live-delegation` custom message (the
   same frame ADR-0050's orphan rule keys on) sets `liveWorkPark` on the
   runtime while the call is open, armed, and viewed. Nothing else arms it:
   ordinary user-prompt turns keep today's behavior — the call stays open and
   conversational.
2. **Quiet-deadline plus cap, never a frame count.** After arming, the first
   `live_levels` frame with `output >= LIVE_WORK_PARK_QUIET_RMS` marks the
   call loud; the first subsequent quiet frame schedules a
   `LIVE_WORK_PARK_QUIET_MS` deadline; any loud frame cancels it (first quiet
   frame after loud owns the deadline; re-arming on later quiet frames would
   starve it forever). `LIVE_WORK_PARK_CAP_MS` from the arm bounds the whole
   turn. Either firing closes the call through the existing `parkLiveVoice`
   path.
3. **`agent_end` stores the answer and wakes the call.** The parked call could
   not hear the final answer, so it lands in *pending voice feedback* like
   the #811 paths. For the viewed tab the wake reopens the call with the
   pending riding `buildLiveInstructions`. An unviewed parked tab stores the
   answer and lets the #811 enter guard resume it.
4. **One switch, wire-ordered.** All close-then-reopen paths (wake, orphan
   restart) ride a single-flight per-tab switch that parks any still-open call
   — awaiting its `live_stop` ack — before dispatching `live_start`, with at
   most one coalesced re-run; a wake request supersedes a queued park.
   Concurrent callers can otherwise both pass the open-call gate before the
   first ack lands and double-dispatch.
5. **A cancellation generation invalidates in-flight dispatches.**
   `live-work-park.ts` (a leaf module: slices import it, it imports no slice)
   owns a per-tab counter bumped by every explicit `stopLiveVoice` and by
   `discardTabRuntime` — module-scoped so it outlives the runtime it guards.
   Timer callbacks and switch steps capture the generation and re-verify it
   (plus owner/armed/viewed flags) before dispatching. A start ack whose
   generation moved on closes omp's fresh call with a quiet `live_stop` and
   restores nothing.
6. **The `liveWorkParking` setting gates the path; off is #811 verbatim.**
   The arm handler checks the setting when the effect runs, so flipping it off
   mid-turn changes nothing retroactively; with it off the delegation frame
   sets no flag, arms no timer, and `agent_end` wakes nothing.

## Consequences

- A delegated turn costs the call one close and one reconnect (~2 s total);
  the model re-reads a text recap plus the pending answer, same recall bounds
  as ADR-0050.
- A user who talks to the model *while* it works reopens nothing by accident:
  any loud frame cancels the quiet deadline, and only the cap can park a
  call that keeps speaking.
- The parked capsule (`live · parked`) stays clickable to stop the intent;
  the wake is automatic, a click is only ever a cancel.
- `live_levels` stays subscribe-only on the park path: the UI strip's
  rendering of levels is unchanged, and with the setting off the reducer
  touches no work-park state at all.
- The orphan restart (#811) now also wire-orders stop-before-start; the
  "restart at next `listening`" trigger is unchanged.

## Amendment (issue #818)

A plan proposal gate is also a work-parking boundary: the planning turn ends
at the gate, and an open call must not listen while a human reviews. The
proposal's `extension_ui_request` closes the call through the same single-flight
switch, and the reconnect that carries the plan artifact's full readable text
(a separate `<plan-review>` section in `buildLiveInstructions`, exempt from the
recap trim ceiling) rides that same wake — the artifact travels only in
`live_start` instructions, because omp exposes no in-call update or speak verb.
A gate whose artifact path and hash are unchanged still wakes a briefing when
the request is explicit; automatic briefings key on the gate identity so a
re-presented identical plan is not re-narrated unprompted. On execute, the
hand-off carries voice to the viewed destination: the source stop is
acknowledged before the destination start, and the gate is that no source
call stays open — not that it ended without a transport-teardown error
(#822).
