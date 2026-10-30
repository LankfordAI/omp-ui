# Live voice holds to talk, so the call stays open through delegated work

> **Status:** Accepted, 2026-10-29 ([#965](https://github.com/LankfordAI/omp-ui/issues/965), [#966](https://github.com/LankfordAI/omp-ui/issues/966)).

Supersedes [ADR-0051](0051-park-the-live-call-while-the-agent-works.md) and
[ADR-0053](0053-live-progress-reports-reuse-the-park-s-switch.md); amends
[ADR-0050](0050-live-voice-park-resume-with-vendored-instructions.md).
Verified against omp 18.13.3.

When a delegated turn finished, the voice agent stopped speaking the result
and went back to listening (#965). Work parking (#815) closed the call during
the turn, and the reopened call depended on its instructions alone to make the
model speak. Hold-to-talk (#966) replaces work parking and progress reports
(#826). Every live call opens with the microphone closed, and the user holds
`R` or the capsule's talk button to talk. Nothing closes the call mid-turn, so
omp's own final-message delivery speaks the result again. The visibility park
(#811) stays.

## Findings

| Fact | Where it was read |
|---|---|
| Parking closes the call at delegation; omp's final-message append targets an open delegation only. | omp 18.13.3 `src/live/controller.ts` `#appendFinalResponse` (needs `#activeDelegationId` on a live controller). omp-ui `reduce-agent-event.ts` stored the answer and fired `wake-live-call`; `frame-reduction.ts` reopened the call. |
| A woken call only speaks if the instructions alone make it: the controller sends nothing after connect. | omp `live/controller.ts` `start()`; `live/protocol.ts` client messages are only `delegation.context.append` and `session.close`. |
| Observed failure: session `c29ac69d`'s turn ended 18:21:25; connection `e94741a3` first persisted the *user's* speech at 18:21:49; no assistant transcript was persisted on either connection. | `~/.omp/agent/sessions/omp-ui--omp-ui--c29ac69d-…/live-transcript/*.jsonl` and the session JSONL. |
| RPC surface: `live_start {voice, instructions}`, `live_stop`, `live_mute {muted}`. No turn-detection or commit control. | omp `modes/rpc/rpc-mode.ts:2363-2389`; `live/protocol.ts` `buildLiveSessionConfig` sets only model, instructions, voice, delegation. |
| `live_mute` maps to the native WebRTC peer's `setMuted` ("enable or disable microphone transmission"); output and the delegation stay connected. | omp `live/transport.ts:383-386`; `pi-natives` `index.d.ts` `LiveWebRtcPeer.setMuted`. |
| `muted` outranks `working` and `speaking` in omp's phase: a held-closed call reports `muted` even while the model talks. | omp `live/controller.ts` `#refreshAudioPhase`. Output levels are still emitted while muted (`#handleOutputLevel`). Speech threshold `OUTPUT_ACTIVE_LEVEL = 0.015` (`live/output-activity.ts`). |
| A `live_mute` sent right after `live_start` lands before recording begins. | omp `rpc-mode.ts`: `live_start` is in `BACKGROUND_COMMANDS`; its handler synchronously reaches `RpcLiveBridge.start`, which assigns `#controller` before its first `await`. `live_mute` runs later on the serial tail. `controller.start()` applies `#muted` after connect, and `#handleMicrophoneAudio` drops samples while muted. omp-ui's `runCommand` sends the frame synchronously before its first await (`rpc-command.ts`). |
| The vendored base prompt is still identical to omp 18.13.3's `live/prompts/live-instructions.md`. | Byte comparison against the npm 18.13.3 package. |

## Decision

1. **Every start is pre-muted.** A start, resume, or reconnect sends
   `live_mute {muted:true}` right after `live_start`. omp records nothing
   until the user unmutes. If the start fails before omp builds the
   controller, the pre-mute's error is swallowed and the start's own failure
   is shown.
2. **Holding talks.** Holding `R` (focus outside any text field) or the
   capsule's talk button sends `live_mute {muted:false}` (`setLiveTalking`).
   A release re-mutes after an 800 ms tail (`LIVE_TALK_RELEASE_TAIL_MS`) so the
   server hears trailing silence.
3. **Work parking, its handoff arm, and progress reports are removed.** The
   call stays open through the agent's turn, and omp appends the final message
   to the open delegation and speaks it. The `liveWorkParking` and
   `liveProgressReportMinutes` settings are gone; `parseSettings` drops them
   from existing registries.
4. **The visibility park stays** (ADR-0050). Leaving the tab still closes the
   call; stored answers ride `<pending-results>` on return, whose wording now
   tells the model to speak immediately.
5. **The display phase is derived.** Because omp's `muted` outranks
   `speaking`, the capsule shows core's `liveDisplayPhase`, which reads the
   output level against `LIVE_OUTPUT_ACTIVE_LEVEL` and omp-ui's own talking and
   working state.
6. **The orphan restart triggers on a settled idle call.** It used to wait for
   `listening`, which a muted call never reports at rest. It now fires once the
   open call has been idle for `LIVE_ORPHAN_SETTLE_MS`.
7. **Automatic plan briefings no longer depend on mute.** No user mute toggle
   remains to gate them.

## Consequences

- omp 18.13.3 gives omp-ui no control over the realtime server's turn
  detection. While `R` is held, a long pause can still end the user's turn.
  Hold-to-talk only guarantees that nothing is heard outside a hold.
- omp's commentary appends to the open call during a turn are not suppressed,
  so a long turn costs more realtime context than a parked one did. This has
  not been measured.
- The capsule label can flicker between speaking and idle in word gaps:
  `live_levels` is edge-triggered and omp's 400 ms release hold is not visible
  to omp-ui.
- The visibility-resume path is not fixed by this decision. A headless smoke
  showed a resumed call carrying `<pending-results>` stays silent until the
  user speaks, despite the "speak immediately" wording: omp sends nothing
  after connect, and the realtime model does not open a response from
  instructions alone. Fixed by [ADR-0071](0071-live-voice-runs-on-a-renderer-owned-peer.md)
  (#967): the renderer owns the peer and appends the results.
- No hands-free mode remains. The mic-privacy reason parking existed is
  covered by hold-to-talk.
