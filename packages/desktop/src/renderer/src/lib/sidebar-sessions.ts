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
  /** live === "live", newest open first. */
  active: SidebarEntry[];
  /** Every other owned session (dormant, archived, missing), newest open first. */
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
 * The sidebar's flat session list: every local project session and chat plus
 * every non-self remote instance's sessions, filtered by `query`, sorted newest
 * open first by `launchedAt` (ties keep build order), and split into live and
 * settled. Handoffs resolve per host over that host's full session set, before
 * any filtering or partitioning, so a live implementation still finds its
 * settled planning session.
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

  const active: SidebarEntry[] = [];
  const settled: SidebarEntry[] = [];
  for (const entry of kept) (entry.session.live === "live" ? active : settled).push(entry);
  return { active, settled };
}
