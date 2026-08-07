# An advisor review that lands on an idle session is answered by a reply

A session-scoped advisor (ADR-0005) reviews a turn only when that turn ends,
and omp runs the review async to the primary loop (ADR-0008). When the reviewed
turn is the session's **last**, the review lands *after* the `agent finished`
marker: the live rpc-ui session is idle, the `advisory` render item is
display-only, and the main model never answers it. The user reads the finding;
the agent never sees it. ADR-0009 already solves this timing — but for exactly
one path, the plan-execute gate, where `PlanConcernWatcher` holds the
implementation dispatch until the drafting turn's review lands and folds its
concerns into the implementation prompt. Issue #104 asks for the general case:
whenever the advisor speaks, the main model answers. This ADR records how
omp-ui closes that gap for every idle turn, not just the planned one.

## The timing that makes this hard

Nothing in omp reopens a finished turn. The advisor's review is appended to the
transcript omp-ui already owns, and a transcript append is not a prompt — it
carries no obligation for the primary loop, which has already resolved. So the
window ADR-0009 exploited (a verdict the renderer was about to answer anyway)
does not exist here: on an idle session there is no dispatch left to hold, only
a dispatch to *originate*.

Two further properties of the delivery shape the mechanism:

- **One review arrives in more than one frame.** A finding appears as a
  standalone `advisory` card and/or as notes attached to the turn's tool
  results, and the two shapes land in separate frames. A session-scoped
  advisor set can also post several reviews of the same turn. Reacting per
  frame would emit several prompts for one review.
- **The reply turn is itself a turn, so it is itself reviewed.** An advisor
  that comments on the reply produces a new finding on a now-idle session,
  which is precisely the input this fold reacts to. Unbounded, it ping-pongs.

## The reply

When advisor findings land in a live rpc-ui session's transcript while that
session is idle, omp-ui auto-dispatches them back into **the same session** as
a follow-up prompt. `PromptRoute` gains `advisor_reply`, which rides omp's
`streamingBehavior: "followUp"` — the same behaviour a queued follow-up uses,
so the prompt is delivered as new work rather than steered into a turn that is
not running. The new renderer module `lib/advisor-reply.ts` owns the decision:
`AdvisorReplyWatcher` is fed on each transcript update, asks the store whether
the tab may reply at all (idle, switch on, under the cap), and collects every
finding appended after its baseline.

Rather than react to the first frame, the watcher waits for a quiet window —
`ADVISOR_REPLY_SETTLE_MS` (1.5 s) with no further findings — and then answers
the whole batch in one prompt. That is what the two delivery shapes and the
multi-advisor case require: batching turns one review (or one burst of reviews)
into one reply instead of burning a loop-guard slot per frame. On dispatch the
watcher emits an `info` transcript `notice` naming the count, so the follow-up
prompt is never mistaken for something the user typed.

The prompt body reuses ADR-0009's collection core verbatim. `noteKey`,
`collectNewConcerns`, and `renderConcernsBlock` move out of `plan-concerns.ts`
into the shared `lib/advisor-concerns.ts`, with the instruction lead lifted to a
parameter: the plan fold passes `PLAN_CONCERNS_LEAD`, this fold passes
`ADVISOR_REPLY_LEAD`, and both get the same deduplicated, severity-preserving
instruction block. Two folds, one collector — not a second channel with its own
notion of what an advisor finding is.

The loop guard is a cap: `ADVISOR_REPLY_MAX` (2) consecutive auto-replies per
session, after which the fold stops and posts the cap as a `warn` transcript
`notice` telling the user that a prompt re-arms it. Any non-reply prompt resets
the counter — a user prompt, a plan dispatch, a history reload — because each of
those means the session moved on under someone else's direction. "Never reply
to a review of a reply" was folded into that cap rather than kept as a separate
rule: the cap already covers it (a review of a reply is the second consecutive
reply and dies at the boundary), and one number plus one reset rule is a guard
a maintainer can hold in their head, where a second rule about provenance would
need the reply's own findings tracked back through the transcript.

## Why not the obvious routes

- **Filter by severity, replying only to warnings and above.** The ask is
  *always respond* — a nit the advisor bothered to raise is either worth a fix
  or worth an explicit "no change warranted", and the lead asks for exactly
  that. A threshold would silently reintroduce the unread-finding case this ADR
  exists to remove.
- **Keep the anti-ping-pong rule separate from the cap.** Two guards that both
  stop the same runaway is one guard too many; see above.
- **New omp surface to read the advisor session.** The notes are already in the
  session transcript omp-ui owns; the correlation is a transcript item baseline.
  No new wire contract, no text parse of `/advisor dump` — the same reason
  ADR-0009 gave, and it holds unchanged here.
- **Persist the per-session switch to the registry.** `RpcTabState.advisorReply`
  is renderer state, default on, re-applied by `bootRpcTab` so the advisor's
  required relaunch does not silently lose it. It has no effect on session
  spawn, so paying the `core/types.ts` → `registry.ts` → `channels.ts` →
  `main/backend.ts` thread for a view-level toggle is not warranted. If it must
  survive an app restart it becomes an `OwnedSessionRecord` field, as a separate
  change.
- **Do the same for terminal tabs.** A PTY carries no prompt channel omp-ui may
  inject into — an attachment already has to become a scratch file to cross it
  (ADR-0006) — and what an omp TUI does with its own advisor is omp's affair,
  not omp-ui's. rpc-ui only.

## Consequences

- **An advisor finding is never display-only again.** On an idle rpc-ui session
  the main model answers every review, including the last turn's, which was the
  one case no path covered.
- **The plan fold and this fold cannot drift.** They share
  `advisor-concerns.ts`, so a change to what counts as a finding, or to how
  findings are deduplicated and rendered, lands in both at once. Only the lead
  differs.
- **The runaway is bounded and visible.** At most two consecutive auto-replies,
  and the stop is a `warn` notice in the transcript rather than silence, so a
  user who wanted a third knows to send a prompt.
- **Switching off restores today's behaviour exactly.** The composer's advisor
  control carries the per-session switch; off means the `advisory` card is
  display-only again, per session, with no effect on any other tab.
- **The reply turn is reviewed like any other.** That is intended — the advisor
  gets to check the fix — and it is the reason the cap, not the settle window,
  is what makes this fold terminate.
