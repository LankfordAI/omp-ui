# Live voice runs on the client that starts it, so remote views can talk

> **Status:** Accepted, 2026-10-30 ([#968](https://github.com/LankfordAI/omp-ui/issues/968)).

Amends [ADR-0071](0071-live-voice-runs-on-a-renderer-owned-peer.md); reverses
the #816 gate. Verified against omp 18.14.0.

#816 hid live voice everywhere except the desktop shell on a tab this app owns
locally, because `live_start` opened the call on the session host's own
microphone and speakers. A remote web client had no audio path, and a joined
remote-instance tab would have armed another machine's microphone. ADR-0071
moved the call onto a WebRTC peer in the renderer (`live_connect`). That move
removes the reason for the gate: the peer runs in whichever renderer starts
the call, and only signaling has to reach the session host.

## Findings

| Fact | Where it was read |
|---|---|
| `live_connect {sdpOffer, voice?, instructions?}` signals the caller's offer with the OpenAI session and answers `{voice, sdpAnswer}`. omp opens no audio device for a caller-owned peer. | omp 18.14.0 binary: `rpc-mode.ts` `live_connect` case; the live controller skips its recorder when `sdpOffer` is set. |
| Every `live_*` verb rides `rpc:send`, which is a tab-routed notify: main forwards it to a joined instance, and the web server dispatches it to the same `MainBackend` handler the desktop uses. | `TAB_ROUTED_NOTIFIES` (`core/src/remote-instances.ts`), `remote-route.ts`. |
| A remote web client on loopback or HTTPS gets an answer, a connected peer, the `oai-events` data channel, `session.started`, and omp's phase frames for hold-to-talk. | Headless app smoke, 2026-10-30: a managed Chromium on the `--pane` URL, fake media device. |
| A peer that dies with its page leaves omp's half of the call open on the host: nothing on the host observes the browser's WebRTC state. | omp 18.14.0 `transport.ts`: with a caller peer, terminal events come only from the OpenAI sideband. |
| A plain `http://<lan-ip>` origin has no `navigator.mediaDevices`. | Browser secure-context rules; `docs/remote-access.md`. |

## Decision

1. **The gate is "this client can open a peer".** `canOpenLivePeer()`
   (`lib/live-peer.ts`) replaces `liveAudioLocalToClient`: it requires
   `RTCPeerConnection` and `navigator.mediaDevices.getUserMedia`. The
   composer, the composer sheet, and `startLiveVoice` all read it. The
   desktop shell, a remote web client, and a joined remote-instance tab
   pass. A non-secure origin fails and keeps the dictation microphone.
2. **Signaling routes as it already does.** No new channel: `live_connect`,
   `live_mute`, and `live_stop` ride `rpc:send` to the session host. The
   spoken-turn and recording channels (`liveTranscript:*`, `liveAudio:*`)
   join `TAB_ROUTED_REQUESTS`, so a joined remote tab's turns land in the
   owner's lineage dir with the rest of the session.
3. **A closing page ends its calls.** On `pagehide`, the store closes every
   peer this renderer owns and sends `live_stop` for each tab, fire and
   forget.
4. **A hand-off carries only this renderer's call.** The plan hand-off
   carries voice over only when this renderer owns the source's peer
   (`liveVoiceOwner`). Another client's call on the source is not stopped
   from here (#821); the source reap ends it.

## Consequences

- One call per session still holds: omp refuses a second `live_connect`
  while a call is active, and every view sees the same `live_*` frames. A
  second client that is not the owner sees the call's phase but holds no
  peer, so its hold-to-talk sends nothing (the existing owner gate).
- A page killed without `pagehide` (a crash, a dropped network) still
  leaves omp's half open until the OpenAI session ends it. omp exposes no
  peer-liveness signal for a caller-owned peer.
- The audio device picker in Settings stays desktop-only: a browser client
  uses its own system default input.
