# Live voice parks with vendored instructions because omp's `instructions` replace its default

Resolves issue #811, replacing issue #801's visibility-mute guard. Verified
against the managed binary `omp/18.8.6` (linux-x64). Re-check when the bundled
omp is bumped — the risk this ADR accepts is prompt drift (§Re-check trigger).

## Findings

- omp's `live_start` accepts an optional `instructions` string, and the
  semantics are **full replacement**: a non-empty string becomes the realtime
  session's whole system-prompt appendage; omp's own default
  (`live/prompts/live-instructions.md`, baked into the bundle) is used only
  when the field is absent/empty. There is no append API. So any omp-ui text
  — a recap, pending results — rides only alongside a copy of that default,
  never on top of it.
- `live_stop` ends the realtime connection and omp discards whatever the call
  never heard: after a stop, a live-delegated turn's answer has no voice
  listener at all. A parked session therefore cannot deliver results by
  leaving a muted call open; it must store them and deliver them through the
  next `live_start`'s instructions.
- omp records audio per live session, and the microphone stays hot while a
  call is open. Muting a background tab (the #801 guard) still leaves a live
  connection listening; closing it is the honest privacy posture for a tab the
  user is not looking at.
- The base prompt lives in the bunfs region of the binary encoded UTF-16LE.
  Locate it with:

  ```bash
  B=~/.local/share/omp-ui/bin/omp
  $B --version                                  # omp/18.8.6 at time of writing
  strings -n 6 -e l "$B" | grep -F 'You: omp'   # the base prompt, UTF-16LE
  ```

  `{{firstName}}` / `{{username}}` are omp's own placeholders and ride through
  a passed `instructions` string unchanged, so the vendored copy keeps them.

Re-check trigger: every managed-binary bump (the ADR-0049 habit). Diff the
`strings -e l` extract against `LIVE_BASE_INSTRUCTIONS` in
`packages/core/src/live-voice.ts`; on drift, re-vendor verbatim — the constant
is stamped with the omp version it was extracted from.

## Decision

1. **Leave parks, return resumes.** The view-focus guard
   (`installLiveVoiceParkResumeGuard`, `view.ts`) closes an armed owner tab's
   call on leave (`parkLiveVoice`: fold the *voice recap* from the snapshot's
   turns, then `live_stop`) and reopens on enter (`startLiveVoice` with built
   instructions). `liveArmed` is the intent — set by a successful start ack,
   cleared only by explicit stop or the #808 plan hand-off's carry-over — and
   `liveParked` is the closed-call state the guard resumes from. No `live_mute`
   ever rides the visibility path again.
2. **The instructions are base + recap + pending, vendored.**
   `buildLiveInstructions` (`packages/core/src/live-voice.ts`) emits
   `LIVE_BASE_INSTRUCTIONS` verbatim, a `<voice-recap>` of `User:/Assistant:`
   lines when one exists, and a `<pending-results>` section when answers are
   waiting; empty inputs omit their sections, so a session's first call is
   exactly the vendored base. Trims: 20 turns / 6 000 chars recap (oldest
   first), 4 000 chars per pending entry with a truncation note, 16 000 total
   trimming recap before pending. `livePendingIncluded` records how many
   entries rode the start; the resumed call's first final assistant
   transcript — proof the model spoke them — clears exactly that prefix.
3. **Orphan answers restart the call, never mid-speech.** A live-delegated
   turn whose answer an open call could not have heard (no `live-delegation`
   seen during the call: the `liveCallSawDelegation` /
   `liveDelegatedTurnSeen` flags) stores its final answer as pending and
   refresh-restarts the call at the next `listening` phase — never while the
   model is speaking or working.
4. **The sidebar mirrors the runtime.** `TabRuntime` is not observable, so
   `store.liveVoice` mirrors `{armed, parked, pending}` per tab for the row's
   glyph: phase glyph while a call is open; dim speaker for armed/parked;
   signal-accent speaker while results are pending.

## Consequences

- A resume pays one reconnect's latency (~1 s) and the model re-reads a text
  recap, not audio; recall quality is the recap's, bounded by the caps above.
  This is accepted over a hot background microphone.
- The vendored constant can lag omp between bumps (§Re-check trigger); the
  worst case is a stale base prompt's behavior on resumed calls, never a
  broken start.
- `live_start`'s `instructions` rides omp's prompt-size path; if a start ever
  fails on size, record omp's server-side limit beside `LIVE_INSTRUCTION_LIMITS`
  and retune there.
- #801's `liveVisibilityMuted` and the mute-on-visibility path are gone; the
  user's own mute button is unchanged (`liveUserMuted` survives a park).
