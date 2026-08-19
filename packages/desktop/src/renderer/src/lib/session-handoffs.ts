import type {
  PlanImplementationSource,
  SessionSummary,
} from "@omp-ui/core/types";
import { sessionWindow } from "./session-window";

export interface SessionHandoffEntry {
  session: SessionSummary;
  /** Presentation depth only; deeper lineage remains ordered and linked. */
  depth: number;
  /** The immediate source session when that source can be resolved safely. */
  source: SessionSummary | null;
  /** The saved source snapshot when its session cannot be resolved safely. */
  orphanSource: PlanImplementationSource | null;
  hasDescendants: boolean;
  /** The root tab id shared by every row in a contiguous handoff tree. */
  treeId: string;
}

export interface ArrangedSessionHandoffs {
  entries: SessionHandoffEntry[];
  shown: number;
  remaining: number;
  total: number;
}

interface HandoffNode {
  session: SessionSummary;
  index: number;
  savedSource: PlanImplementationSource | null;
  parent: HandoffNode | null;
  children: HandoffNode[];
  subtreeNewest: number;
}

function savedSourceOf(session: SessionSummary): PlanImplementationSource | null {
  const source = session.planImplementationSource;
  if (
    source === null ||
    source === undefined ||
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

function matchesTree(nodes: HandoffNode[], query: string): boolean {
  for (const node of nodes) {
    if (node.session.title.toLowerCase().includes(query)) return true;
    if (node.savedSource?.planTitle.toLowerCase().includes(query)) return true;
  }
  return false;
}

/**
 * Arrange one project's newest-first session input into handoff trees.
 *
 * Input position is the recency authority. A source always renders before its
 * descendants, while trees and sibling subtrees inherit the newest position
 * of any member. Filtering and pagination operate on whole trees so neither
 * can strand half of a visible handoff.
 */
export function arrangeSessionHandoffs(
  sessions: readonly SessionSummary[],
  query: string,
  projectMatchesQuery: boolean,
  visible: number,
  focusedTabId: string | null | undefined,
): ArrangedSessionHandoffs {
  const nodes: HandoffNode[] = sessions.map((session, index) => ({
    session,
    index,
    savedSource: savedSourceOf(session),
    parent: null,
    children: [],
    subtreeNewest: index,
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

  // Fold each descendant's newest input position into its ancestors. The
  // forest is acyclic now, so processing leaves upward visits every node once.
  const childrenRemaining = new Map<HandoffNode, number>();
  const leaves: HandoffNode[] = [];
  for (const node of nodes) {
    childrenRemaining.set(node, node.children.length);
    if (node.children.length === 0) leaves.push(node);
  }
  for (let i = 0; i < leaves.length; i += 1) {
    const node = leaves[i]!;
    const parent = node.parent;
    if (parent === null) continue;
    parent.subtreeNewest = Math.min(parent.subtreeNewest, node.subtreeNewest);
    const remaining = childrenRemaining.get(parent)! - 1;
    childrenRemaining.set(parent, remaining);
    if (remaining === 0) leaves.push(parent);
  }

  const byNewestMember = (a: HandoffNode, b: HandoffNode): number =>
    a.subtreeNewest - b.subtreeNewest;
  for (const node of nodes) node.children.sort(byNewestMember);
  const roots = nodes.filter((node) => node.parent === null).sort(byNewestMember);

  const normalizedQuery = query.trim().toLowerCase();
  const allEntries: SessionHandoffEntry[] = [];

  for (const root of roots) {
    const treeNodes: HandoffNode[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      treeNodes.push(node);
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        stack.push(node.children[i]!);
      }
    }

    if (
      !projectMatchesQuery &&
      normalizedQuery.length > 0 &&
      !matchesTree(treeNodes, normalizedQuery)
    ) {
      continue;
    }

    const treeId = root.session.tabId;
    const depths = new Map<HandoffNode, number>([[root, 0]]);
    for (const node of treeNodes) {
      const trueDepth = depths.get(node)!;
      for (const child of node.children) depths.set(child, trueDepth + 1);
      allEntries.push({
        session: node.session,
        depth: Math.min(2, trueDepth),
        source: node.parent?.session ?? null,
        orphanSource: node.parent === null ? node.savedSource : null,
        hasDescendants: node.children.length > 0,
        treeId,
      });
    }
  }

  const total = allEntries.length;
  const focusedIndex = focusedTabId
    ? allEntries.findIndex((entry) => entry.session.tabId === focusedTabId)
    : -1;
  let { shown } = sessionWindow(total, visible, focusedIndex);

  // sessionWindow chooses the required row count. If its last row intersects a
  // tree, finish that contiguous tree before paginating.
  if (shown > 0 && shown < total) {
    const finalTreeId = allEntries[shown - 1]!.treeId;
    while (shown < total && allEntries[shown]!.treeId === finalTreeId) shown += 1;
  }

  return {
    entries: allEntries.slice(0, shown),
    shown,
    remaining: total - shown,
    total,
  };
}
