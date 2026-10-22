import type {
  PlanImplementationSource,
  SessionSummary,
} from "@omp-ui/core/types";

/** Plan-handoff view of one row (issue #238). At most one of source/orphanSource is set. */
export interface SessionHandoff {
  /** The planning session this row implements, when it still resolves. */
  source: SessionSummary | null;
  /** Saved dispatch metadata when the planning session cannot be resolved. */
  orphanSource: PlanImplementationSource | null;
  /** This row dispatched at least one implementation in the same input. */
  hasDescendants: boolean;
}

export const NO_HANDOFF: SessionHandoff = Object.freeze({
  source: null,
  orphanSource: null,
  hasDescendants: false,
});

interface HandoffNode {
  session: SessionSummary;
  savedSource: PlanImplementationSource | null;
  parent: HandoffNode | null;
  children: HandoffNode[];
}

function savedSourceOf(session: SessionSummary): PlanImplementationSource | null {
  const source = session.planImplementationSource;
  if (
    source === null ||
    typeof source !== "object" ||
    typeof source.sourceTabId !== "string" ||
    typeof source.planTitle !== "string" ||
    typeof source.planFilePath !== "string"
  ) {
    return null;
  }
  return source;
}

/**
 * Detect nodes whose parent links form a cycle without recursively following
 * malformed lineage. Parent links on every cycle member are later discarded.
 */
function cycleMembers(nodes: HandoffNode[]): Set<HandoffNode> {
  const done = new Set<HandoffNode>();
  const cycles = new Set<HandoffNode>();

  for (const start of nodes) {
    if (done.has(start)) continue;

    const path: HandoffNode[] = [];
    const visiting = new Set<HandoffNode>();
    let cursor: HandoffNode | null = start;

    while (cursor !== null && !done.has(cursor)) {
      if (visiting.has(cursor)) {
        let member = cursor;
        do {
          cycles.add(member);
          member = member.parent!;
        } while (member !== cursor);
        break;
      }
      visiting.add(cursor);
      path.push(cursor);
      cursor = cursor.parent;
    }

    for (const node of path) done.add(node);
  }

  return cycles;
}

/**
 * Resolves every row's handoff against ONE host's full session set (all of a
 * host's projects plus, locally, its chats), never a filtered or partitioned
 * subset: a live implementation must still resolve its settled source.
 * Rules are unchanged from the tree arrangement: a parent resolves only when
 * the source tabId is unique, not self, not `missing`, in the same
 * projectCwd, and not on a cycle. First occurrence of a duplicate tabId wins.
 */
export function resolveSessionHandoffs(
  sessions: readonly SessionSummary[],
): Map<string, SessionHandoff> {
  const nodes: HandoffNode[] = sessions.map((session) => ({
    session,
    savedSource: savedSourceOf(session),
    parent: null,
    children: [],
  }));

  // Duplicate ids make a source ambiguous. Treat them like any other
  // unresolvable metadata rather than choosing an input-order-dependent row.
  const byTabId = new Map<string, HandoffNode>();
  const duplicateTabIds = new Set<string>();
  for (const node of nodes) {
    if (byTabId.has(node.session.tabId)) duplicateTabIds.add(node.session.tabId);
    else byTabId.set(node.session.tabId, node);
  }

  for (const node of nodes) {
    const sourceTabId = node.savedSource?.sourceTabId;
    if (
      sourceTabId === undefined ||
      sourceTabId === node.session.tabId ||
      duplicateTabIds.has(sourceTabId)
    ) {
      continue;
    }
    const parent = byTabId.get(sourceTabId);
    if (
      parent !== undefined &&
      parent.session.live !== "missing" &&
      parent.session.projectCwd === node.session.projectCwd
    ) {
      node.parent = parent;
    }
  }

  for (const node of cycleMembers(nodes)) node.parent = null;
  for (const node of nodes) node.parent?.children.push(node);

  const out = new Map<string, SessionHandoff>();
  for (const node of nodes) {
    if (out.has(node.session.tabId)) continue;
    out.set(node.session.tabId, {
      source: node.parent?.session ?? null,
      orphanSource: node.parent === null ? node.savedSource : null,
      hasDescendants: node.children.length > 0,
    });
  }
  return out;
}
