# The native transcript renders a bounded tail window

Resolves issue #867. A native (rpc-ui) tab keeps every render item reduced
since its last boot — `loadHistory` runs only at boot and a compaction merely
appends a marker — and `TranscriptView` mapped all of them into DOM, while
every tab stays mounted and `App` re-renders them all.

## Findings

Measured 2026-10-16 against a real goal-mode session (4,002 render items:
1,991 assistant messages, 2,006 tool results, 9 compactions, 57 subagents
since its last resume), versus rendering only its newest 150 items:

| Measurement | Full transcript | Newest 150 items |
|---|---|---|
| DOM elements (real `TranscriptView`, jsdom) | 97,688 | 3,922 |
| Tab show: `display:none` → visible, forced layout (headless Chromium, shipped CSS) | 706–809 ms; ~1.2 s to the second frame | 27–30 ms |
| Width change (window resize, sidebar transition) | up to 118 ms | ≤4 ms |
| First mount commit (production React) | 1,081 ms | 40 ms |
| Re-render with unchanged items (what each `App` re-render costs a hidden tab) | 7.1 ms | 0.2 ms |
| One `text_delta` commit, visible / hidden | 12.1 / 5.3 ms | 0.3 / 0.2 ms |

`historyToItems` itself is linear and cheap (31 ms for 4,002 items): the DOM
is the cost, not the store array.

## Decision

`TranscriptView` renders `items.slice(start)`, where `start` derives from one
piece of state, `frozenStart: number | null`, through the pure module
`lib/transcript-window.ts`:

- Following (`frozenStart === null`): `start = max(0, length − 150)`
  (`TRANSCRIPT_WINDOW_ROWS`). Appends drop the oldest rendered items, so the
  DOM stays bounded however long a live tab runs; dropped rows sit above the
  pinned viewport, so nothing moves on screen.
- Reading (`frozenStart !== null`): `start = min(frozenStart, max(0, length −
  150))`. The window stops sliding, so content never shifts under a reader; a
  wholesale shorter list (reload after rewind, reboot) clamps to the new tail.
- Leaving follow freezes the current start; returning to follow (bottom
  reached, or "jump to latest") clears it and trims back to 150.
- "Load older" (`TRANSCRIPT_WINDOW_STEP = 150`) moves the frozen start back
  one step — triggered by scrolling within `LOAD_OLDER_TRIGGER_PX = 600` of
  the top while reading, or by a "show N earlier" button at the head of the
  column. A layout effect restores the captured distance from the bottom, so
  the viewport does not jump.
- Reveal (find jump, Vault notes jump) widens the window to
  `max(0, index − TRANSCRIPT_REVEAL_CONTEXT)` when the target sits above it,
  then centres the row.

`userPositions` (the rewind key, issue #680) and in-session find matching
still span the full `items`; only rendered rows are windowed. Cross-component
scroll requests move onto a module-level listener map
(`lib/transcript-reveal.ts`, the repo's `lib/themes.ts` pattern): outside code
calls `requestTranscriptReveal(tabId, itemId)` instead of querying
`[data-item-id]` in the DOM. `RpcTab` and `TerminalTab` become `memo`
components, and `App` trades its whole-active-runtime subscription for a
number-valued inspector-badge selector.

## Rejected

- **Virtualization library (react-window, react-virtuoso,
  @tanstack/virtual):** rows are variable-height and grow while streaming;
  follow mode depends on a synchronous `scrollTop = scrollHeight` clamp with
  `[overflow-anchor:none]`; find and reveal need real row nodes; the hanging
  speaker labels (issue #392) would have to be re-fitted to absolute
  positioning. A tail window keeps normal flow and every existing contract.
- **`content-visibility: auto` on `.speaker-run`:** measured show cost 14 ms,
  but it implies paint containment, which clips the hanging speaker labels
  positioned outside the run, and its estimated intrinsic sizes make
  `scrollHeight` move while scrolling, fighting the follow pin.
- **Unmounting hidden tabs:** kills the xterm instance and the rpc tab state;
  the session becomes unrecoverable in place (`App.tsx` mount contract).
- **Dropping pre-compaction items from the live tab:** loses scrollback the
  user can see today, and the store array is not the cost.

## Consequences

- While following, the transcript DOM is bounded at one window of rows no
  matter how long a tab runs; while reading, it grows with appended items
  only until follow resumes.
- A marker run cut at the window edge shows a partial collapse count: the
  count reflects the rows inside the window, not the full run.
- Anything that scrolls to a transcript row from outside the component must
  go through `requestTranscriptReveal`, never a `[data-item-id]` DOM query —
  the row may not be rendered.
- Tab bodies are `memo` components: new props on `RpcTab`/`TerminalTab` must
  stay shallow-comparable primitives, and `App` must not subscribe to a whole
  per-tab slice again.
