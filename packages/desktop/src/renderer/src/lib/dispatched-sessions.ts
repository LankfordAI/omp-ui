import type { BackendState, SessionSummary } from "@omp-ui/core/types";
import { projectFaceFor, type ProjectFace } from "./repository-members";

/** One end of a dispatch link (#1226, ADR-0098), shaped like a sidebar entry. */
export interface DispatchLink {
  session: SessionSummary;
  /** Owning instance; null = this app. */
  instanceId: string | null;
  /** Owning instance's nickname; null = this app. */
  nickname: string | null;
  /** Null for a chat. */
  project: ProjectFace | null;
  /** False while the owning instance is not "joined". */
  reachable: boolean;
}

export interface SessionDispatch {
  /** The session whose agent dispatched this one, when it resolves. */
  parent: DispatchLink | null;
  /** Sessions this one's agent dispatched, in dispatch order. */
  children: DispatchLink[];
}

export const NO_DISPATCH: SessionDispatch = Object.freeze({ parent: null, children: [] });

const linksByState = new WeakMap<BackendState, ReadonlyMap<string, SessionDispatch>>();

function dispatchOrderOf(s: SessionSummary): number {
  const at = s.fleet?.dispatchedAt;
  const t = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Parent ↔ child dispatch links across this app and every non-self instance
 * (ADR-0098):
 * - R1: the universe is every local project session and chat plus every
 *   non-self remote instance's project sessions (remote chats are never projected).
 * - R2: a tabId seen more than once takes part neither as parent nor as child.
 * - R3: a child is agent-dispatched (`fleet.requestedBy.kind === "agent"`) with
 *   a non-empty `sourceTabId` that is not its own tabId.
 * - R4: its parent is the unique universe session with that tabId, not `missing`.
 * - R5: children sort by `fleet.dispatchedAt` ascending; unparseable last, ties keep universe order.
 * - R6: only tabIds with a parent or a child get an entry; callers use `?? NO_DISPATCH`.
 * Cached per BackendState object, so selectors get stable references.
 */
export function resolveDispatchLinks(state: BackendState): ReadonlyMap<string, SessionDispatch> {
  const cached = linksByState.get(state);
  if (cached !== undefined) return cached;

  const universe: DispatchLink[] = [];
  for (const group of state.projects) {
    const project = projectFaceFor(state, null, group.project);
    for (const session of group.sessions) {
      universe.push({ session, instanceId: null, nickname: null, project, reachable: true });
    }
  }
  for (const session of state.chats) {
    universe.push({ session, instanceId: null, nickname: null, project: null, reachable: true });
  }
  for (const instance of state.remoteInstances) {
    if (instance.status === "self") continue;
    const reachable = instance.status === "joined";
    for (const group of instance.projects) {
      const project = projectFaceFor(state, instance.id, group.project);
      for (const session of group.sessions) {
        universe.push({ session, instanceId: instance.id, nickname: instance.nickname, project, reachable });
      }
    }
  }

  const byTabId = new Map<string, DispatchLink>();
  const duplicates = new Set<string>();
  for (const link of universe) {
    const id = link.session.tabId;
    if (byTabId.has(id)) duplicates.add(id);
    else byTabId.set(id, link);
  }

  const parents = new Map<string, DispatchLink>();
  const children = new Map<string, DispatchLink[]>();
  for (const link of universe) {
    const own = link.session.tabId;
    if (duplicates.has(own)) continue;
    const requestedBy = link.session.fleet?.requestedBy;
    if (requestedBy?.kind !== "agent") continue;
    const sourceTabId = requestedBy.sourceTabId;
    if (typeof sourceTabId !== "string" || sourceTabId.length === 0 || sourceTabId === own) continue;
    if (duplicates.has(sourceTabId)) continue;
    const parent = byTabId.get(sourceTabId);
    if (parent === undefined || parent.session.live === "missing") continue;
    parents.set(own, parent);
    const list = children.get(sourceTabId);
    if (list === undefined) children.set(sourceTabId, [link]);
    else list.push(link);
  }

  const out = new Map<string, SessionDispatch>();
  for (const [tabId, list] of children) {
    // Never subtract: Infinity - Infinity is NaN. Array#sort is stable.
    list.sort((a, b) => {
      const x = dispatchOrderOf(a.session);
      const y = dispatchOrderOf(b.session);
      return x === y ? 0 : x < y ? -1 : 1;
    });
    out.set(tabId, { parent: parents.get(tabId) ?? null, children: list });
  }
  for (const [tabId, parent] of parents) {
    if (!out.has(tabId)) out.set(tabId, { parent, children: [] });
  }
  linksByState.set(state, out);
  return out;
}
