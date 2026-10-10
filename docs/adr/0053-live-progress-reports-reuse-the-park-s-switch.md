# Live progress reports reuse the work park's switch, because the controller has no speak verb

Resolves issue #826. Builds on ADR-0051's work parking: a live call parked for
a delegated backend turn stays silent until `agent_end` wakes it. For long
turns that silence reads as failure. This adds an opt-in cadence that briefly
reopens the parked call, speaks one short progress update, and parks again —
riding the exact machinery ADR-0051 already owns. Verified against the managed
binary `omp/18.8.6` (linux-x64); no new controller surface is used.

## Findings

- omp still exposes no in-call speak or update verb (ADR-0049/0050): the only
  way to make the model say a sentence is to carry it in `live_start`
  instructions. A progress report is therefore a wake whose
  `buildLiveInstructions` gains one `<progress-report>` section, assembled
  additively after the recap and exempt from the recap trim ceiling — like
  the `<plan-review>` section in ADR-0051's amendment.
- A progress wake must not be a new switch path. ADR-0051's single-flight
  per-tab switch already serialises stop-before-start and coalesces at most
  one re-run; a second timer-driven opener would double-dispatch `live_start`
  exactly the way its Decision 4 forbids.
- A progress wake may legitimately arrive while `liveWorkPark` is still set —
  that is the whole point — but ADR-0051's switch guard rejects a wake while
  the flag is set, because a wake is normally `agent_end` and the flag's
  presence would mean the reducer forgot to clear it. The guard needs a
  marker distinguishing the two, not a relaxation.
- The final answer must never queue behind a scheduled report. If a report
  wake is in flight (or queued) when `agent_end` arrives, bumping the
  generation — ADR-0051's Decision 5 — is what cancels the report's start
  before it can speak over the result. The reverse (a report bumping an
  answer) is forbidden.
- A parked call's mic window must be bounded twice: the ordinary loud→quiet
  edge arms the existing 600 ms quiet park, but if the model never speaks at
  all there is no edge, so the report window needs its own short cap.

## Decision

1. **One setting, off by default.** `liveProgressReportMinutes: number | null`
   (integer 1–1440; `null` = off) gates the cadence at fire time, not just at
   arm time, so flipping it off mid-turn stops reports at the next tick
   without touching the in-progress park.
2. **The cadence arms from the work-park arm handler.** When
   `arm-live-work-park` runs with the setting on, it stamps
   `liveWorkArmedAt` and arms a `progress` timer slot in
   `live-work-park.ts` beside the quiet/cap slots. The fire callback
   re-verifies the ADR-0051 guard shape (flag set, owner, armed, generation
   unchanged) plus `activeTabId === tabId` and `planReview === null`, builds
   the report sentence from the live transcript items (running tool names +
   intents, completed count, elapsed wall time), stores it in
   `liveProgressText`, and calls `switchLiveVoice(tabId, { mode: "wake",
   progress: true })`. It re-arms itself after the awaited switch returns —
   a skipped (unviewed) tick reschedules instead of being lost, and the
   timer list stays module-scoped like the generation counter.
3. **`progress: true` is a switch-request marker, not a new path.**
   `switchPassValid` lets a marked wake through while `liveWorkPark` is set
   (an unmarked wake keeps ADR-0051's rejection); `claimLiveSwitch` gives it
   strict-lowest precedence: a progress wake coalesces silently behind any
   queued wake, and a non-progress wake queued behind a progress wake bumps
   the generation and replaces it, mirroring the wake-behind-park rule. A
   progress wake behind a running park does *not* bump — bumping would abort
   the park mid-flight and leave the mic open.
4. **The report rides instructions and is consumed once.**
   `dispatchLiveStart` passes `rt.liveProgressText` into
   `buildLiveInstructions` only for a `progress` request and clears the field
   on both the acked and failed paths, so a sentence can never ride an
   unrelated later wake. On success the wake arms
   `LIVE_PROGRESS_REPORT_CAP_MS` through the existing cap slot with the
   ordinary park callback, closing the window even if the model stays silent.
   The work-park flag survives the entire report detour — re-parking is just
   another park, and `agent_end` still owns the eventual wake.

## Consequences

- A report costs the same one close/reconnect pair as any park/wake (~2 s),
  every N minutes; recap bounds are unchanged because the report section is
  the only instruction addition.
- Reports never fire for a tab you are not viewing, while a plan gate awaits,
  or after the turn's answer has spoken — the three checks run at fire time,
  so they hold even if you switch tabs mid-park.
- With the setting off, no `progress` field is ever set, no timer slot is
  armed, and every touched guard degenerates to ADR-0051 verbatim.
- An omp idle timeout that ends the call mid-park leaves the parked intent
  intact; the next tick's wake reopens the call to speak, same resume
  contract as #811.
