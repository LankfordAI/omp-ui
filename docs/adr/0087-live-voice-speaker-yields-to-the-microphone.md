# Live voice goes half-duplex: the speaker yields while the mic is open

> **Status:** Accepted, 2026-11-02 ([#1024](https://github.com/LankfordAI/omp-ui/issues/1024)).

Extends [ADR-0070](0070-live-voice-holds-to-talk.md)'s microphone gate;
amends nothing. Verified against omp 18.15.0.

A live reply on speakers stuttered and cut itself off (#1024). Hold-to-talk
already mutes the mic at rest — the renderer peer's track starts disabled and
only opens while `R` or the talk button is held. But in the two windows where
the mic *is* open (a hold, and the 800 ms release tail) the assistant's own
voice leaks from the speakers back into the server's input VAD, which treats
it as `input_audio_buffer.speech_started` and truncates the in-flight
response. The fix closes the echo leak from the *speaker* side: while the call
transmits, the renderer locally pauses its own playback.

## Findings

| Fact | Where it was read |
|---|---|
| The peer's mic track is the real transmit gate; it starts disabled and every mic transition in the store funnels through `LivePeer.setMicEnabled`. | `packages/desktop/src/renderer/src/lib/live-peer.ts`; `store/slices/session-params.ts` (`setLiveTalking`, tail timer, failed-unmute rollback, park/stop peer release). |
| The release tail keeps the mic open 800 ms past the key-up so the server hears trailing silence. | `packages/core/src/live-voice.ts` `LIVE_TALK_RELEASE_TAIL_MS`; ADR-0070 decision 2. |
| `input_audio_buffer.speech_started` is the interruption signal: the realtime server truncates the in-flight response and clears sent output audio. | OpenAI Realtime API guide (developers.openai.com): server VAD mode commits user turns on speech-stopped and cuts responses on speech-started. |
| `echoCancellation: true` on the capture constraint is best-effort; it does not converge with loud speakers on Linux desktop audio, so the assistant's own voice closes the loop. | `live-peer.ts` `getUserMedia` constraints; #1024 repro on Fedora speakers. |
| omp's `live_mute` only keeps its phase machine in step; it is not the transmit gate for the renderer-owned peer. | ADR-0071; `live-peer.ts`. |

## Decision

1. **The peer is half-duplex.** `createSpeakerGate(speaker)` (in
   `live-peer.ts`) rides `setMicEnabled`: opening the mic pauses the call's
   `<audio>` element locally; closing it resumes — only if the element was
   actually playing when the hold began. State-change driven: repeated opens
   (the tail's re-press path) and closes are no-ops.
2. **The resume rule is "playing at hold start".** A reply that begins while
   the mic is open is not auto-resumed when the mic closes. This keeps the
   gate's state simple and matches intent: the pause exists to stop echo, not
   to queue audio.
3. **Genuine barge-in is untouched.** The user's voice still reaches the
   server VAD, which still truncates the response; the local pause only
   removes the echo from the loop. If the server truncated the reply during
   the hold, the later `play()` on the live-but-silent or ended stream plays
   silence or rejects — the rejection is caught, so nothing audible plays,
   which is correct: the user interrupted.

## Consequences

- Pressing to talk mid-reply silences the agent instantly (local pause),
  which is the intuitive walkie-talkie behavior anyway.
- A reply interrupted by a hold resumes from where local playback stopped
  unless the server truncated it; because audio runs ahead of playback, a
  resume can replay already-delivered tail audio of an interrupted sentence.
  Accepted: rare, self-healing on the next turn.
- Headphone users are unaffected perceptually: pausing an already-quiet echo
  path changes nothing they hear (`paused` is true at hold, so no churn
  reaches the audio stack).
- The tail length (800 ms), every wire command (`live_connect` / `live_mute`
  / `live_stop`), and all phases are unchanged. No i18n strings change.
- If a hands-free mode is ever added, it must reuse this same gate.
- Ambient noise during a hold or the tail can still interrupt — that remains
  genuine barge-in semantics; omp-ui has no server VAD control (ADR-0070
  consequence). Stutter that persists *on headphones* is a separate cause
  (playback jitter / server behavior), not this loop.
