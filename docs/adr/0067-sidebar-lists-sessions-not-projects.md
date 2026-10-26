# The sidebar lists sessions, not projects; projects live in the quick-open

> **Status:** Accepted, 2026-10-22 ([#919](https://github.com/LankfordAI/omp-ui/issues/919)).

The sidebar was a project tree: one header per project with its owned sessions
beneath it, user-named **Sidebar groups** above that (#745), a stack per joined
**Remote instance** or one **Unified project view** node per repository
(ADR-0063), a host-scope picker choosing between the two, a Work/Chat toggle
(#894), a collapsed rail of project monograms, and an explicit, user-reordered
session order (#274). Each pass added a control to reach the same thing — the
session the user wants to look at — and a registry with a few hundred dormant
sessions buried the handful of running ones under project headers and **show
more** pagination. #915 had already put a project quick-open behind New
session; this ADR finishes that move.

Facts that shape the design:

- The question the sidebar answers most often is "what is running, and which
  one needs me?" Only live sessions can need an answer; dormant ones wait.
- The recency key `cachedModified ?? launchedAt` already exists: idle
  hibernation's last-active exemption sorts by it (issues #246, #266, #304).
  Ordering the list by it needs no new field.
- Every project action — new session, terminal, private, the **New session
  dialog**, open targets, Experiments, Project settings, remove — takes a
  project and an optional instance and nothing else. None needs a sidebar node
  to hang from.
- `resolveRepositoryKey` (ADR-0061, ADR-0063) keys the per-repository merge,
  and the quick-open already performs it for its rows.
- A joined instance's sessions already reach the renderer with their owner
  (ADR-0028), and `SessionRow` already renders an instance nickname; each row
  can name its machine without a per-host section.
- Process and worktree state stay host-local (ADR-0063 (c)): the machine is a
  property of the session, so a label is enough to say where it runs.

## Why not the obvious routes

- **Keep the project tree, collapsed by default.** Smallest change, but the
  running sessions still hide one click behind whichever project they belong
  to, and every collapsed header is chrome between the user and the sessions.
  The tree's only job — reaching a project's actions — moves to the
  quick-open. Rejected.
- **A Settings → Projects page.** A home for project actions outside the
  sidebar, but starting work is the most frequent project action, and Settings
  is a modal the user has to leave again to see the session. Rejected: the
  quick-open is already where New session lands.
- **Fixed launch order.** Stable rows that never move under the pointer — the
  property #274 bought with its explicit order. But launch order puts a session
  that just asked a question below ten idle ones, and keeping it meaningful
  needed drag and keyboard reordering plus a frozen-order migration. Rejected:
  rows are keyed by host and tab, so a re-sort moves the node instead of
  remounting it, and hover and focus survive. _Partly superseded by the
  addendum: launch-stamp order was adopted; manual reordering remains
  rejected._

## Decision

**(a) The sidebar is a flat list of live sessions plus Settled.** Every live
session — this app's project sessions, chats, and every joined instance's
sessions — shares one list. Every other owned session (dormant, hibernated,
archived, missing) sits in one collapsible **Settled** section at the bottom,
collapsed by default; a non-empty search shows it expanded.

**(b) Rows sort by recency.** _Superseded by the open-order addendum (#921)._
The key is `cachedModified ?? launchedAt`, newest first. This supersedes #274's
explicit order: there is no manual reorder, no move channel, and no
frozen-order setting. Registry arrays stay insertion-ordered; only the
hibernation tie-break reads that order.

**(c) Projects are reached only through the Project quick-open.** New session
opens it; its root lists the projects, *No project* (a chat — this replaces the
Work/Chat toggle), and *Add project…*. A project row's page holds every project
action the header cluster and the compact actions sheet used to carry. The
per-repository merge ADR-0063 put on a sidebar node lives in the quick-open
row, and its page offers New session on each other checkout.

**Amended 2026-10-26 (#936):** the per-checkout launch moved from the
quick-open project page to the composer's machine chip. The page no longer
lists New session on each other checkout; a merged row's subline names every
machine holding the repository, and an unprompted native session is moved to
another member from the chip.

**(d) Sidebar groups and the host-scope picker are removed.** Groups, their
registry field and channels go; with no per-host sections there is nothing for
a scope picker to choose.

**(e) The machine stays a row label.** A remote session shows its instance's
nickname on its row, exactly ADR-0063 (c)'s rule; opening, steering, and
terminating still run on the owner.

**(f) Unreachable instances dim, and recovery lives in Settings.** Sessions of
an instance that is not joined render dimmed with no context menu, and the
footer shows an "N unreachable" chip that opens Settings → Remote instances,
where Reconnect and Refresh state live.

## Consequences

- A glance at the sidebar answers "what is running, and which one needs me?"
  without expanding anything; the session that changed last is on top.
- Rows move as sessions work. Keys carry the host and tab, so a re-sort never
  remounts a row under the pointer.
- Starting work is always New session → pick a row → Enter. The quick-open
  orders the focused tab's project first (or *No project* when a chat is
  focused), so one Enter repeats "another one of these".
- Plan handoffs keep their row labels and the "open planning session" button,
  but lose tree indentation: a recency-sorted list cannot keep a planning
  session and its implementations contiguous.
- Registries written by older builds load unchanged: stale `sidebarGroups` and
  `sessionOrderFrozen` keys are dropped on parse and left out of the next
  write. An older client calling a removed channel on a newer host gets an
  "unknown channel" error, and the instance stays joined.

## Amends / relates

- ADR-0063 (unified project view) — decision (a)'s sidebar node and the
  HostScopePicker sentence of (c) are superseded here; (b), the direct-spawn
  single-member launch, stands, and (c)'s machine-as-label rule carries over.
- ADR-0059 (chats in app-data scratch dirs) — chats join the one list,
  labelled *chat*, instead of a separate Chat mode.
- ADR-0004 (design tokens) — the New session button, Settled header, and
  footer use neutral ink and line tokens; signal stays reserved for liveness.

## Addendum: rows sort by open order (#921, 2026-10-22)

Decision (b) is superseded: the sidebar sorts by `launchedAt` (newest open
first), not by `cachedModified ?? launchedAt`. A row's position is fixed when
the session opens — work churn no longer moves rows under the pointer, and
resuming a settled session does not float it. `launchedAt` is set once at
creation, so this buys the stability the "Fixed launch order" option above was
rejected for *without* its cost: no drag reordering, no keyboard moves, no
frozen-order setting — #274's explicit order stays deleted. The hibernation
last-active exemption keeps the activity key; only the sidebar order changed.
The consequences "the session that changed last is on top" and "rows move as
sessions work" are withdrawn.
