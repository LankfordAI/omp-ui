import type { BackendState, SessionSummary } from "@omp-ui/core/types";
import type { UnreadMark } from "../store/slices/unread";
import { NO_HANDOFF, resolveSessionHandoffs, type SessionHandoff } from "./session-handoffs";

export interface SidebarEntry {
  session: SessionSummary;
  /** Owning instance; null = this app. */
  instanceId: string | null;
  /** Owning instance's nickname; null = this app. */
  nickname: string | null;
  /** Registered project name; null for a chat. */
  projectName: string | null;
  /** False while the owning instance's status is not "joined": the row dims and opens no menu. */
  reachable: boolean;
  handoff: SessionHandoff;
}

export interface SidebarLists {
  /** live and pinned (`pinnedAtMs !== null`), whatever its turn or snooze —
   *  earliest pin first, so pinning a row never moves another (issue #981). */
  pinned: SidebarEntry[];
  /** live and either not in a turn or blocked on the user (pending plan / human answer), not pinned or snoozed — newest open first. */
  active: SidebarEntry[];
  /** live with a running turn or a running background job and not blocked on
   *  the user, not pinned or snoozed — newest open first. */
  working: SidebarEntry[];
  /** snoozed === true and not live-pinned — newest open first. Always empty
   *  while the snoozedSectionEnabled setting is off (issue #935). */
  snoozed: SidebarEntry[];
  /** Not live and not snoozed (dormant, archived, missing) — newest open
   *  first. A pinned record that is not live lands here, pin intact. */
  settled: SidebarEntry[];
}

/** Open-order key (#921): when omp-ui opened the session. An unparseable stamp sorts last. */
function openOrderOf(s: SessionSummary): number {
  const t = Date.parse(s.launchedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function matches(entry: SidebarEntry, q: string): boolean {
  // Saved plan metadata is unvalidated on disk; read the title only when it is a string.
  const planTitle = entry.session.planImplementationSource?.planTitle;
  return (
    entry.session.title.toLowerCase().includes(q) ||
    (typeof planTitle === "string" && planTitle.toLowerCase().includes(q)) ||
    (entry.projectName?.toLowerCase().includes(q) ?? false) ||
    (entry.nickname?.toLowerCase().includes(q) ?? false)
  );
}

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set();

/**
 * The sidebar's session lists: every local project session and chat plus
 * every non-self remote instance's sessions, filtered by `query`, sorted
 * newest open first by `launchedAt` (ties keep build order), and split into
 * five sections — pinned (live and pinned, earliest pin first), active (live,
 * no running turn or blocked on the user), working (live with a running turn,
 * not blocked on the user), snoozed (parked via the sidebar, when the
 * snoozedSectionEnabled setting is on), and settled (not live, not
 * snoozed). Handoffs resolve per host over that host's full session set,
 * before any filtering or partitioning, so a live implementation still
 * finds its settled planning session.
 *
 * `backgroundWorkTabIds` carries the tabs whose bridge snapshot reports a running
 * background job (issue #1026): like a running turn, that work needs nothing from
 * the user, so those rows join Working. The caller builds the set from its own
 * renderer state (local rpc-ui tabs only); remote rows never appear in it and keep
 * the host-published `turnRunning` level alone.
 */
export function buildSidebarLists(
  state: BackendState,
  query: string,
  backgroundWorkTabIds: ReadonlySet<string> = EMPTY_TAB_IDS,
  /** Rows surfaced as attention-stack cards (#1038): suppressed from every
   *  list while their card heads the stack, so a flagged session reads once. */
  suppressTabIds: ReadonlySet<string> = EMPTY_TAB_IDS,
): SidebarLists {
  const entries: SidebarEntry[] = [];

  const local: SessionSummary[] = [];
  for (const group of state.projects) local.push(...group.sessions);
  local.push(...state.chats);
  const localHandoffs = resolveSessionHandoffs(local);
  for (const group of state.projects) {
    for (const session of group.sessions) {
      entries.push({
        session,
        instanceId: null,
        nickname: null,
        projectName: group.project.name,
        reachable: true,
        handoff: localHandoffs.get(session.tabId) ?? NO_HANDOFF,
      });
    }
  }
  for (const session of state.chats) {
    entries.push({
      session,
      instanceId: null,
      nickname: null,
      projectName: null,
      reachable: true,
      handoff: localHandoffs.get(session.tabId) ?? NO_HANDOFF,
    });
  }

  for (const instance of state.remoteInstances) {
    if (instance.status === "self") continue;
    const handoffs = resolveSessionHandoffs(instance.projects.flatMap((group) => group.sessions));
    const reachable = instance.status === "joined";
    for (const group of instance.projects) {
      for (const session of group.sessions) {
        entries.push({
          session,
          instanceId: instance.id,
          nickname: instance.nickname,
          projectName: group.project.name,
          reachable,
          handoff: handoffs.get(session.tabId) ?? NO_HANDOFF,
        });
      }
    }
  }

  const q = query.trim().toLowerCase();
  const kept = q.length === 0 ? entries : entries.filter((entry) => matches(entry, q));

  // Never subtract: -Infinity - -Infinity is NaN. Array#sort is stable, so ties
  // keep build order.
  kept.sort((a, b) => {
    const x = openOrderOf(b.session);
    const y = openOrderOf(a.session);
    return x === y ? 0 : x > y ? 1 : -1;
  });

  const snoozedSectionOn = state.snoozedSectionEnabled === true;
  const pinned: SidebarEntry[] = [];
  const active: SidebarEntry[] = [];
  const working: SidebarEntry[] = [];
  const snoozed: SidebarEntry[] = [];
  const settled: SidebarEntry[] = [];
  for (const entry of kept) {
    const s = entry.session;
    // A flagged session reads once (#1038): the caller suppresses exactly the
    // tabIds whose card heads the stack, so the row returns when the mark
    // clears. Marked-but-working sessions are not in the set — no card, row
    // stays where its state puts it.
    if (suppressTabIds.has(s.tabId)) continue;
    // A live pinned session stays in Pinned mid-turn and snoozed: the pin is
    // the user's "keep this in view" (issue #981). Settled still wins — a pin
    // without a process files below with the rest, and returns on resume. An
    // older remote host publishes no pinnedAtMs; absent reads as unpinned.
    if (s.live === "live" && typeof s.pinnedAtMs === "number") {
      pinned.push(entry);
      continue;
    }
    // Snoozed outranks every other placement, and only exists while the
    // setting is on; with it off, flagged sessions fall through to their
    // natural lists and keep their persisted flag (issue #935).
    if (snoozedSectionOn && s.snoozed === true) {
      snoozed.push(entry);
      continue;
    }
    if (s.live !== "live") {
      settled.push(entry);
      continue;
    }
    // A session blocked on the user (plan gate or blocking dialog) belongs in
    // the main list even mid-turn: Working is for sessions that need nothing
    // from the user (issue #944). Both are host-published levels, so remote rows
    // move too. A terminal session never reports turnRunning, so it can never
    // land in Working; an older remote host's absent latch reads the same way.
    // Background work that outlives its dispatching turn counts exactly as the
    // row's chip counts it (issue #851, placement fixed by issue #1026): the
    // caller passes the local tabs whose async-jobs snapshot has a running job.
    const needsUser = s.pendingPlan !== null || s.awaitingHumanAnswer === true;
    const workInFlight = s.turnRunning === true || backgroundWorkTabIds.has(s.tabId);
    if (workInFlight && !needsUser) working.push(entry);
    else active.push(entry);
  }
  // Pin time is a fixed rule, not a hand-kept order (ADR-0067 rejects manual
  // reordering). Stable sort: equal stamps keep open order.
  pinned.sort((a, b) => (a.session.pinnedAtMs as number) - (b.session.pinnedAtMs as number));
  return { pinned, active, working, snoozed, settled };
}

/** One attention-stack card (#1037): a flagged session, its mark, and the
 *  derived state the filter proved it in. */
export interface AttentionEntry {
  entry: SidebarEntry;
  mark: UnreadMark;
  /** Derived sidebar state at build time; the filter guarantees one of ready/awaiting-answer. */
  state: "ready" | "awaiting-answer";
}

/**
 * The attention stack (issue #1037): every flagged local session whose
 * derived state is still `ready` or `awaiting-answer` — a mark on a session
 * that went back to work (or died) waits for the next unseen reply. Entries
 * are built exactly like `buildSidebarLists`' local-instance branch.
 * Remote-instance rows are structurally excluded: no frames flow
 * cross-instance, so a remote row is never marked. The stack is unfiltered by
 * the sidebar search query on purpose — a flagged session surfaces even while
 * the user is filtering or a section is collapsed. `derive` is the caller's
 * `deriveSidebarSessionState`: passed in at the call site so this lib keeps a
 * type-only (never runtime) dependency on the store slice. Newest mark first.
 */
export function buildAttentionEntries(
  state: BackendState,
  unread: Readonly<Record<string, UnreadMark>>,
  derive: (s: SessionSummary) => string,
): AttentionEntry[] {
  const out: AttentionEntry[] = [];
  const visit = (session: SessionSummary, projectName: string | null): void => {
    const mark = unread[session.tabId];
    if (mark === undefined) return;
    // `derive` answers with the wide state union; a plain inequality guard
    // cannot narrow `string`, so map the two kept states explicitly.
    const derived = derive(session);
    const kept = derived === "ready" ? "ready" : derived === "awaiting-answer" ? "awaiting-answer" : null;
    if (kept === null) return;
    out.push({
      entry: {
        session,
        instanceId: null,
        nickname: null,
        projectName,
        reachable: true,
        handoff: NO_HANDOFF,
      },
      mark,
      state: kept,
    });
  };
  for (const group of state.projects) {
    for (const session of group.sessions) visit(session, group.project.name);
  }
  for (const session of state.chats) visit(session, null);
  out.sort((a, b) => b.mark.atMs - a.mark.atMs);
  return out;
}
