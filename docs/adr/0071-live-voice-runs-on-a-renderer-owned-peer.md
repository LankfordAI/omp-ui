# Live voice runs on a renderer-owned peer, so a resumed call can be told its results

> **Status:** Accepted, 2026-10-30 ([#967](https://github.com/LankfordAI/omp-ui/issues/967)). Amended by [ADR-0072](0072-live-voice-runs-on-the-client-that-starts-it.md): the peer runs in whichever client starts the call.

Amends [ADR-0050](0050-live-voice-park-resume-with-vendored-instructions.md),
[ADR-0070](0070-live-voice-holds-to-talk.md), and
[ADR-0049](0049-live-voice-audio-history-beyond-omp-s-exposure.md).
Verified against omp 18.14.0.

A call that reopens after a visibility park (#811) carried the stored answer
in `<pending-results>`, but the voice never said it: it waited for the user to
talk first (#967). omp's own controller sends nothing on a new call, and its
RPC verbs cannot make the model speak. omp 18.14.0 added `live_connect`, which
runs the call on a WebRTC peer the RPC client owns. That peer's `oai-events`
data channel is the one client path that can make the model speak first.

## Findings

| Fact | Where it was read |
|---|---|
| The controller sends nothing after connect. Its only client messages are `delegation.context.append` (needs an open delegation) and `session.close`. | omp 18.14.0 binary, `live/controller.ts` `start()`, `live/protocol.ts` builders. |
| `live_start` runs omp's native peer. `live_connect {sdpOffer, voice?, instructions?}` runs the call on the caller's peer and returns `{voice, sdpAnswer}`. Both are off the serial chain. | omp 18.14.0 `modes/rpc/rpc-mode.ts` (`live_start`/`live_connect` case; the background command set `bash`, `predict_word`, `live_start`, `live_connect`, `btw_cancel`, `abort_branch_summary`); `rpc-live.ts` `start()`; changelog 18.14.0 (upstream #17013). |
| omp sends no `live_levels` for a caller-owned peer: the native peer's level callback is the only source. | Probe: 0 `live_levels` frames over a `live_connect` call. `live/transport.ts` emits levels only from `LiveWebRtcPeer`. |
| `live_mute` still drives omp's phase on a `live_connect` call (`listening` → `muted`), but it cannot reach the caller's microphone. | Probe; `transport.ts` `setMuted` touches only the native peer. |
| `response.create` on the data channel is refused, and omp ends the call: `"response.create requires a session with Responses delegation."` | Probe. |
| `session.update` cannot change instructions: `"Instructions cannot be updated after initialization."` | Probe. |
| `session.context.append` with no channel (speakable) gets a spoken response. With `channel: "commentary"` the model keeps the context and stays silent. Each append is capped at 500 bytes. | Probes; omp's `chunkContextText` cap `500`; codex `CONTEXT_APPEND_MAX_BYTES`. |
| The model does not read its session instructions back. A call told it was "Bartholomew" whose user's dog is "Waffles" answered "I'm ChatGPT … I don't know your dog's name". A plan briefing asked for in instructions described a plan the call was never given. | Probes, both through `live_connect` instructions. omp builds the same signaling body for `live_start` (`buildLiveSessionConfig`). |
| A final message appended alone got "Hmm." A silent commentary recap, then omp's `"Agent Final Message":\n\n…` append, got the result spoken (`It printed "flamingo."`). | Headless app smoke, 2026-10-30. |
| The vendored base prompt is still identical to omp 18.14.0's `live-instructions.md`. | UTF-16 byte comparison against the binary. |

## Decision

1. **The renderer owns the call's peer.** `lib/live-peer.ts` opens the
   microphone (echo cancellation, noise suppression, auto gain), plays the
   remote track, meters both RMS levels at 10 Hz, and opens the `oai-events`
   data channel. It gathers ICE fully before it hands omp the offer, because
   omp's signaling POST does not trickle. The store sends `live_connect`
   instead of `live_start` and applies the returned `sdpAnswer`.
2. **Hold-to-talk gates the peer's track.** The track starts disabled.
   `setLiveTalking` enables it, then sends `live_mute {muted:false}` to keep
   omp's phase machine in step. A release disables it again after the tail.
3. **The peer reports levels.** `reportLiveLevels` replaces the
   `live_levels` frame case, so the speaking display and the orphan
   restart's idle check keep working.
4. **A resumed call is told its conversation, then its results.** Once the
   data channel reports `session.started`, the store appends the voice
   recap on the commentary channel, then every carried pending answer as
   omp's own `"Agent Final Message"` frame (speakable), split at 500 bytes.
   The instructions still carry the base prompt, the recap, and
   `<pending-results>`, so pending accounting is unchanged.
5. **Every stop releases the peer first.** `live_stop`, `live_end`, peer
   failure, and runtime teardown close the microphone and speaker. A peer
   that fails mid-call ends omp's half with `live_stop`, and the usual
   `live_end` fold parks an armed session.
6. **The harness floor rises to omp 18.14.0** (`NATIVE_LIVE_MIN_OMP` and
   `MIN_SUPPORTED_OMP`): older omp has no `live_connect`.

## Consequences

- A mic or peer failure now surfaces in omp-ui's own error strip
  (`composer.live.micUnavailable`, `composer.live.audioFailed`). omp's
  device errors no longer apply.
- The browser's `getUserMedia` uses the system default input. The audio
  device picker still changes the system default, so it still works.
- The plan-review briefing (#818) is still carried only by instructions,
  which the model does not read. That is a separate defect,
  [#1001](https://github.com/LankfordAI/omp-ui/issues/1001). This decision
  only fixes the delivery of pending results.
- Output audio now reaches the renderer as a WebRTC track, so ADR-0049's
  "omp exposes no output audio" no longer limits omp-ui. Recording it is
  still not built.
