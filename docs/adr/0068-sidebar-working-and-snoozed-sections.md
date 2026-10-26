# Sidebar Working and Snoozed sections

> **Status:** Accepted, 2026-10-26 ([#935](https://github.com/LankfordAI/omp-ui/issues/935)).

ADR-0067 flattened the sidebar to a live list plus **Settled**. Two questions
that flattening could not answer without more chrome are answered here: which
live sessions are *working* right now, and where do sessions the user has
deliberately set aside live while they keep running.

## Decision

**The sidebar partitions into four sections, exactly one per session.** From
the open-order sort (ADR-0067 addendum, #921), `buildSidebarLists` assigns
each session to exactly one list, in this precedence:

1. **Snoozed** — `snoozed === true`, and only while the `snoozedSectionEnabled`
   setting is on.
2. **Working** — live with `SessionSummary.turnRunning === true`.
3. **Main list** (unheaded) — live, no running turn.
4. **Settled** — not live and not snoozed.

The body renders main list, Working, Snoozed, Settled.

**The Snoozed section is gated, default off.** One registry setting,
`snoozedSectionEnabled` (default `false`), toggled from Settings → General.
While off: no Snoozed section, no Snooze/Unsnooze menu item, and
snoozed-flagged sessions distribute by liveness (Working/main/Settled) and
keep their persisted flag. Toggling is instant on the next state broadcast.

**Snooze is not hibernate.** Parking never stops the process. The two compose:
a snoozed live session still idle-hibernates and then appears in Snoozed as a
settled row (setting on). The footer live count still counts every live row,
snoozed or not.

**Snooze rides a tab-routed channel.** `session:setSnoozed` joins
`TAB_ROUTED_REQUESTS`: the renderer calls the local backend and main's
`routeByTab` forwards to the owning instance. The main handler writes through
the existing `registry.updateSession(tabId, { snoozed })`. An older remote
host rejects the unknown channel; the renderer surfaces that as an error
notice. `settings:setSnoozedSectionEnabled` is not proxied — settings stay
app-local.

**Section collapse is view state.** Each section's open choice persists in its
own localStorage key, outside the version-gated `DesktopViewStateV1` snapshot
(the `sidebar-settled.ts` reasoning, generalized). Working defaults open,
Snoozed defaults collapsed, Settled keeps its key and default. While a search
filter is active, all sections render expanded and their toggles are inert.

## Why not the obvious routes

- **Key Working off renderer-local rpc state.** Renderer rpc state cannot see
  a remote-owned or older-host session's turn latch. The host-published
  `turnRunning` on `SessionSummary` works for both; absent reads as "not in a
  turn". Rejected.
- **A terminal session in Working.** A PTY raises no rpc turn latch, so a
  terminal session can never report `turnRunning`. It stays in the main list
  even mid-turn; Working is native-only by construction, not by a special
  case. Documented limitation.
- **Snooze as hibernate.** Stopping the process loses the turn's context and
  changes idle-hibernation policy. Snooze is pure sidebar grouping; the
  process and the hibernation rules are untouched. Rejected.
- **A new Registry method.** The existing `registry.updateSession` partial
  write already covers a one-field flip plus broadcast; `session:setAutoTitled`
  is the precedent. Rejected.

## Consequences

- A glance at the sidebar now separates idle live sessions (main list) from
  in-turn ones (Working), and parked ones (Snoozed, setting on).
- A session with in-flight background jobs but no running turn stays in the
  main list while its dot pulses "working" — the turn latch is the only signal.
- Chats are owned sessions and snooze like any other row.
- Snoozed + `missing` files to Snoozed (the flag outranks liveness); delete and
  resurface still work from there.
- Toggling the setting off with snoozed sessions present redistributes them on
  the next broadcast; flags persist for re-enable.
- localStorage unavailable: in-memory defaults (Working open, Snoozed
  collapsed) still apply.

## Amends / relates

- ADR-0067 (sidebar lists sessions) — extends the flat list's partition; the
  open-order sort and Settled collapse rule carry over.
- ADR-0028 (remote instances) — `session:setSnoozed` joins the tab-routed set.

## Addendum: Working docks above Settled (#937, 2026-10-26)

The body renders main list, Snoozed, Working, Settled — superseding the order
in the Decision. Working always renders once the lists load, reading
Working (0) when no session is in a turn. Open, it sizes to its rows up to 40%
of the sidebar body and scrolls inside; it never takes free height. The main
region (rows, an empty state, or an empty filler) owns the free height, so
Working stays directly on Settled whatever the main list holds. Open Snoozed
and Settled still share free height with the main region.

## Addendum: sessions awaiting the user leave Working (#944, 2026-10-26)

A live session with `pendingPlan !== null` or `awaitingHumanAnswer === true`
files to the main list even while `turnRunning` is true, so a question or a
plan review surfaces at the top instead of inside Working. Precedence is now
Snoozed > Settled > main list (needs the user) > Working > main list. Both
signals are host-published `SessionSummary` levels, so remote rows follow
the same rule; snoozed still outranks it. Renderer-local waits
(`experimentProposal`, `extensionQueue`) are not visible to
`buildSidebarLists` and leave such a row in Working while its badge reads
"answer needed" — documented limitation.
