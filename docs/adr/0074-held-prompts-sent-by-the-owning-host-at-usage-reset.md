# Held prompts are sent by the owning host at the usage reset

> **Status:** Accepted, 2026-10-30 ([#986](https://github.com/LankfordAI/omp-ui/issues/986)).

When a subscription's usage window runs out, the user has to come back hours
later to send the next prompt. omp-ui already knows when the window resets:
the limits bridge (issue #673) publishes each rate window with `resetsAtMs`,
and a turn that failed on the limit carries omp's `Flag.UsageLimit` bit
(`errorId & 0x80000`, `UsageLimit: 524288` in omp 18.14.0). Nothing acted on
either. This ADR records how a **Held prompt** is kept and sent.

## Decision

**The composer offers it only when the session is limited.** `usageResetMs`
(core `held-prompt.ts`) returns the earliest future reset of a window at or
above 100%, or — after the last assistant message ended on the usage-limit
class — the fullest window's future reset (a provider can report the binding
window just under 100%). Null hides **send at reset (Tue 14:05)**. Commands
(`/`, `!`) are never held; neither is anything on a terminal tab, which has no
prompt channel main may inject into.

**The owning host's main process owns it.** `session:holdPrompt`,
`session:cancelHeldPrompt`, and `session:sendHeldPromptNow` join
`TAB_ROUTED_REQUESTS`, so a remote session's prompt waits on its host. The
record carries the card's view (`OwnedSessionRecord.heldPrompt`: id, a
400-character prose preview, attachment counts, `sendAtMs`, `sentAtMs`,
attempts, error); the wire text and image bytes ride `held-prompt.json` in the
lineage dir, so the state broadcast stays small. The composer builds the same
wire text `sendPrompt` would (document block, image routing suffix), and PDF
scratch paths are materialized on the owner before the hold, like any send
(ADR-0044). One prompt per session; a new hold replaces it.

**`HeldPromptScheduler` is a frame observer.** It is registered last in
`SessionManager.frameObservers`, so it reads the turn latch and answer gates
the earlier observers settle. One timer covers the earliest `sendAtMs`, capped
at 60 s so a deadline missed while the machine slept fires within a minute of
resume (the SnoozeClock rule, ADR-0068 addendum #979). It also syncs at boot.

At `resetAtMs + 60 s`:

- a live session that has sent `ready`, is not mid-turn, not waiting on the
  user, not model-held (#932), and has no pending operation gets the prompt
  through `rpcSend` — the path renderer prompts take;
- a session that is not running is resumed (at most once per 60 s per tab,
  the fleet-wake throttle) and the prompt rides the spawn's `initialCommands`,
  last, and never while the spawn booted model-held.

**The outcome is read from frames.** The prompt's command id is
`omp-ui-held-prompt-<id>`. A rejected response sets `error` and the card waits
for the user; nothing retries a rejection. A success stamps `sentAtMs`. At the
next terminal `agent_end`, a turn whose last assistant message ended on the
usage-limit class re-arms (`sendAtMs` null, `attempts` + 1): the scheduler
pulls `/omp-ui-limits` and takes the next reported reset. Any other end
consumes the prompt and deletes the artifact. omp keeps the failed user
message in its history, as it does for any failed turn.

**Never sent twice.** A record whose `sentAtMs` is set when its process dies
(or at boot with no live process) is cleared, never re-sent: omp already
holds the prompt in its transcript. Cancel and Send now refuse a prompt that
was already sent. A malformed `heldPrompt` on disk normalizes to null rather
than dropping the session record (the `reviewRoster` rule).

## Rejected alternatives

- **omp's `retry.waitForUsageReset`.** It makes omp's own retry layer sleep
  through a provider-stated reset, but only while the delay fits under
  `retry.maxDelayMs` (default 5 minutes; probed in the 18.14.0 binary as
  `waitForUsageReset === true && … ye <= de`), inside a live process, for a
  turn that already started. It cannot hold a prompt across hours, a
  hibernation, or an app restart.
- **Renderer-side timers.** They miss resets while no window is open and
  disagree across joined clients — the reason ADR-0068's timed snooze put
  its clock in main.
- **Holding the prompt in omp's follow-up queue.** A queued follow-up drains
  at the next clean turn end, not at a wall-clock time, and dies with the
  process.
- **A general scheduled-prompt feature.** Issue #987 covers arbitrary times;
  here the reset is known exactly and needs no schedule UI. #987 can later
  subsume this record field.

## Consequences

- A limited session can be left alone: the next prompt goes out by itself,
  even if the session hibernated or omp-ui restarted meanwhile.
- The card is the only surface: no sidebar badge or notification is added.
- A provider whose usage report carries no reset time never offers the hold.
