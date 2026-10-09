# Live transcript history is persisted per connection because omp exposes none

Resolves issue #817. Extends ADR-0049's finding (verified against the managed binary `omp/18.8.6`, linux-x64) from audio to text: what omp does not persist, omp-ui stores itself under the session's lineage dir. Re-check before any release that bumps the managed omp past the version named in "Re-check trigger".

## Findings

- ADR-0049 finding 1 covers audio; the same holds for text. The binary's RPC schema carries `LiveTranscriptEvent` — "Accumulated text of one realtime turn; replaces earlier frames with the same `role` and `turn`" — a transient frame stream with snapshot semantics, emitted while observers are attached. No verb, resource, or frame reads older turns back, and nothing writes them to disk: after a call ends, the realtime turns exist in no store omp owns. (The agent session's own jsonl under `~/.omp/agent/sessions/` carries delegated agent traffic — not the spoken exchange; the voice chatter of a greeting-only call never reaches it, and nothing in omp-ui reads those files.)
- The composer strip renders `LiveSnapshot.turns` only, and `startLiveVoice` patches a fresh `emptyLiveSnapshot()` on every (re)start: each park/resume (#811/#815) resets `turns` to `[]`, and a clean `live_end` collapsed the strip entirely. The spoken text was visible only during the connection that spoke it.
- The park recap (`liveRecap` in `TabRuntime`) is not a transcript surface: capped at 20 turns / 6 000 chars (`LIVE_INSTRUCTION_LIMITS`), wiped by an explicit stop (`clearLiveVoiceState`), and process-local — a reload loses it. Raising its cap would defeat the token-saving measures of #811/#815.
- Reproduce on any machine with the managed binary:

```bash
B=~/.local/share/omp-ui/bin/omp          # the binary the app actually spawns
$B --version                             # omp/18.8.6 at time of writing
strings -n 6 "$B" | grep -E 'name: "live_' | sort -u   # live_start/live_stop/live_mute only — no history verb
strings -n 6 "$B" | grep -m1 LiveTranscriptEvent       # one transient frame def, "replaces earlier frames"
find ~/.omp -type d -name 'live-transcript' | wc -l    # 0 — omp writes no live transcript dir
```

## Decision

1. **The renderer appends finals as they arrive.** The frame reducer's `live_transcript` case dispatches `liveTranscript:append` for every frame with `final: true`, keyed by the `connectionId` the renderer minted at `live_start` — the same identity #809's refs use (ADR-0049 decision 2). Append-on-final-frame beats fold-on-park: a process death or app quit mid-call loses at most the one non-final partial, matching the recap's existing "cut off" honesty.
2. **Storage is one append-only JSONL file per connection**: `<lineageDir>/live-transcript/<connectionId>.jsonl`, line shape `{"role","turn","text"}` — `final` is implied because only finals are written. One file per connection makes `(connectionId, role, turn)` collision-free without a shared index. Confinement is `live-audio.ts`'s: UUID-grammar id, lexical check plus realpath containment, every failure path answers empty/skip, never a throw. Connections sort by file `mtime` ascending; duplicate rows for the same key (two renderer clients) collapse to the last occurrence at read time.
3. **The strip renders disk history plus the snapshot.** `LiveVoiceStrip` reads `liveTranscript:read` on mount and on the `ended` flip, merges history minus the connection the snapshot represents (the snapshot owns that connection's rows, partials included), and renders whenever any row or error exists — a clean end no longer erases the exchange. A history row's Play carries its own `connectionId`, so replay targets the connection that spoke it.
4. **Display only — the model's context stays capped.** `buildLiveInstructions` keeps its 20-turn / 6 000-char recap exactly as #811/#815 require. The persisted transcript never feeds the voice model; the two surfaces never share a code path.

## Consequences

- Transcript lifetime equals session lifetime for free: delete/archive already move the whole lineage dir (ADR-0003), and a fork's destination session starts with its own empty history dir.
- Old sessions with no `live-transcript/` dir read `[]` and render exactly the pre-feature behavior.
- The store is omp-ui-owned, so the day omp persists its own transcript history, this layer is replaced wholesale — channels, files, and all — rather than reconciled with omp's.
