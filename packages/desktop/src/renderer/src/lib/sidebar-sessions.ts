import type { BackendState, SessionSummary } from "@omp-ui/core/types";
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
  /** live and either not in a turn or blocked on the user (pending plan / human answer), not snoozed — newest open first. */
  active: SidebarEntry[];
  /** live with a running turn and not blocked on the user, not snoozed — newest open first. */
  working: SidebarEntry[];
  /** snoozed === true — newest open first. Always empty while the
   *  snoozedSectionEnabled setting is off (issue #935). */
  snoozed: SidebarEntry[];
  /** Not live and not snoozed (dormant, archived, missing) — newest open first. */
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

/**
 * The sidebar's session lists: every local project session and chat plus
 * every non-self remote instance's sessions, filtered by `query`, sorted
 * newest open first by `launchedAt` (ties keep build order), and split into
 * four sections — active (live, no running turn or blocked on the user),
 * working (live with a running turn, not blocked on the user), snoozed (parked via the sidebar, when the
 * snoozedSectionEnabled setting is on), and settled (not live, not
 * snoozed). Handoffs resolve per host over that host's full session set,
 * before any filtering or partitioning, so a live implementation still
 * finds its settled planning session.
 */
export function buildSidebarLists(state: BackendState, query: string): SidebarLists {
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
  const active: SidebarEntry[] = [];
  const working: SidebarEntry[] = [];
  const snoozed: SidebarEntry[] = [];
  const settled: SidebarEntry[] = [];
  for (const entry of kept) {
    const s = entry.session;
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
    const needsUser = s.pendingPlan !== null || s.awaitingHumanAnswer === true;
    if (s.turnRunning === true && !needsUser) working.push(entry);
    else active.push(entry);
  }
  return { active, working, snoozed, settled };
}
