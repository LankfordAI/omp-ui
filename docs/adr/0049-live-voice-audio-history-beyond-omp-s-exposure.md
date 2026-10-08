# Live voice audio history is built from refs because omp exposes no output audio

Resolves the omp-ui side of issue #809. Verified against the managed binary `omp/18.8.6` (linux-x64). Re-check before any release that bumps the managed omp past the version named in "Re-check trigger".

## Findings

- omp's live-voice RPC surface is `live_start` / `live_stop` / `live_mute` and three event frames: `live_phase`, `live_levels`, `live_end`. The binary's RPC schema strings enumerate exactly those; there is no frame, verb, or resource that carries audio in either direction. `strings`-level search for `live_audio` in the bundle: zero hits.
- The Realtime API protocol itself has an `output_audio.delta` event, and the bundle contains a `LiveWebRtcPeer` client that consumes it for playback. But the agent-facing reducer that turns session events into what RPC observers see contains the case as an explicit no-op (`case "output_audio.delta": ... break;`): the assistant's spoken audio reaches the browser's speaker and is dropped. It is never written to disk and never re-exposed.
- Nothing is persisted: `find ~/.omp -type f \( -name '*.wav' -o -name '*.pcm' -o -name '*.opus' \)` returns nothing after live sessions. There is no capture env surface either (`LIVE_DUMP`, `PI_LIVE` produce no strings hits).
- Consequence for history: after a live session ends, even the transcript text of the assistant's replies is only reconstructible from `turn.done` digests, and the audio itself is gone from every layer. omp-ui cannot offer "replay what the assistant said" from anything omp provides today.

Reproduce on any machine with the managed binary:

```bash
B=~/.local/share/omp-ui/bin/omp          # the binary the app actually spawns
$B --version                             # omp/18.8.6 at time of writing
strings -n 6 "$B" | grep -E 'name: "live_' | sort -u      # live_start/live_stop/live_mute only
strings -n 6 "$B" | grep -E "live_(phase|levels|end|audio)" # frames: phase/levels/end only
strings -n 6 "$B" | grep -c live_audio                      # 0
find ~/.omp -type f \( -name '*.wav' -o -name '*.pcm' -o -name '*.opus' \)
```

Re-check trigger: every managed-binary bump. If a future omp emits an audio-bearing frame or persists takes, this ADR's ref scheme should be superseded by omp's own ids rather than extended.

## Decision

1. **omp-ui references recordings; it never fabricates them.** A `Voice recording reference` is `v1/<sessionId>/<connectionId>/<role>/<turn>` (`formatLiveAudioRef` / `parseLiveAudioRef` in `packages/core/src/live-voice.ts`). The reference is the contract: whether bytes exist behind it is a runtime answer (`ready` / `unavailable` / `incomplete`), never baked into the reference. No TTS regeneration, no loopback capture, no placeholder audio — an unavailable reference renders as unavailable.
2. **Identity is per-connection, minted in the renderer at connect.** `startLiveVoice` mints a UUID (`randomUuid()`) for the attempt and stores it as `LiveSnapshot.connectionId`; every start mints a fresh one, and an ended snapshot keeps the last one for reference building. omp's turn numbers restart at 0 each connection, so session+turn alone would alias two connections' turn 0 onto one file; the connection id makes storage keys collision-free without depending on omp for identity.
3. **Storage is omp-ui-owned, confined, and delete-by-lineage.** Takes land under `<lineageDir>/live-audio/<connectionId>/<role>-<turn>.wav`. `listLiveAudio` / `readLiveAudio` (`packages/desktop/src/main/live-audio.ts`, channels `liveAudio:list` / `liveAudio:read`) take only a `tabId`, resolve the lineage dir the way the confined plan reader does, and confine by lexical check plus realpath containment. A ref whose path escapes the lineage dir, whose file is missing, or that exceeds the 32 MiB cap answers `unavailable`; a `.partial` sibling answers `incomplete`. References outlive the bytes: parsing never requires the file to exist.
4. **The renderer state is derived, not stored.** `loadLiveRecording` builds the ref from the tab's owned session id plus the snapshot's `connectionId`; a missing session id or `connectionId` answers `unavailable` without dispatching. The transcript strip probes each final assistant turn once per `(connectionId, turn)` and marks the row with a disabled speaker affordance naming the constraint when the answer is `unavailable` — the honest state the user sees today for every row, since no omp exposes output audio (finding 1).

## Consequences

- Today every affordance renders `unavailable` on every build. That is the point: the UI, store, channels, storage, and ref grammar ship finished, so the day omp surfaces assistant audio (or records takes) the only change is the writer that drops `.wav` files plus a `ready` branch — no schema migration, no identity rewiring.
- Storage is per-lineage, so deleting a session deletes its recordings through the existing lineage deletion path; archiving carries them; nothing lives in a global scratch dir.
- The reference grammar is versioned by prefix (`v1/`). A future omp-native audio id is a new prefix, not an amendment.
