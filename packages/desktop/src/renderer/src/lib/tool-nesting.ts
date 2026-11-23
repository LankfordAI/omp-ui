import type { RenderItem, ToolItem } from "./transcript";

/**
 * Nested tool cards (issue #1274): omp 19.1 marks a tool call made from
 * inside a JS/Python eval cell or a kernel-defined tool with
 * `parentToolCallId` — the id of the invocation that made the nested call —
 * on both its start and end events. The native transcript nests such a call's
 * card under the parent's card. Derivation runs over the full item list at
 * model-build time, never incrementally, so a child whose frames arrive
 * before its parent's resolves as soon as the parent row exists.
 *
 * Robustness rules (all produce a top-level render, never a dropped row):
 * - orphan: the named parent is not among the rendered tool rows (filtered
 *   out, from a prior turn, or never coming);
 * - self-parent: a call cannot nest under itself;
 * - cycle: A→B→A nests nowhere — every member of the cycle is orphaned;
 * - only tool rows can be parents.
 */
export interface ToolNesting {
  /** Nested child render-item id → parent render-item id. A child never
   *  renders in the flat transcript flow while its parent does. */
  readonly parentIdByChildId: ReadonlyMap<string, string>;
  /** Children of one parent render-item id, in transcript order. */
  readonly childrenByParentId: ReadonlyMap<string, ToolItem[]>;
}

/** The shared empty relation: no nesting to apply, zero allocation per call. */
export const EMPTY_TOOL_NESTING: ToolNesting = {
  parentIdByChildId: new Map(),
  childrenByParentId: new Map(),
};

export function buildToolNesting(items: readonly RenderItem[]): ToolNesting {
  // Parent lookup is by toolCallId among tool rows only — no other render
  // kind can host a nested card. First row wins an id collision so two rows
  // claiming one call id never share a parent relation ambiguously.
  const parentByToolCallId = new Map<string, ToolItem>();
  for (const item of items) {
    if (item.kind === "tool" && item.toolCallId !== "" && !parentByToolCallId.has(item.toolCallId)) {
      parentByToolCallId.set(item.toolCallId, item);
    }
  }
  const parentIdByChildId = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const parentCallId = item.parentToolCallId;
    if (parentCallId === undefined || parentCallId === "") continue;
    // A self-parent is the smallest cycle: orphan it directly.
    if (parentCallId === item.toolCallId) continue;
    const parent = parentByToolCallId.get(parentCallId);
    // Orphan: the parent row is not rendered (or is not a tool row).
    if (parent === undefined) continue;
    parentIdByChildId.set(item.id, parent.id);
  }
  breakCycles(parentIdByChildId);
  const childrenByParentId = new Map<string, ToolItem[]>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const parentId = parentIdByChildId.get(item.id);
    if (parentId === undefined) continue;
    const siblings = childrenByParentId.get(parentId);
    if (siblings === undefined) childrenByParentId.set(parentId, [item]);
    else siblings.push(item);
  }
  return parentIdByChildId.size === 0 ? EMPTY_TOOL_NESTING : { parentIdByChildId, childrenByParentId };
}

/**
 * Orphan every member of a parent cycle. Each child has at most one parent,
 * so following the map from any node is a chain that either ends or repeats;
 * deleting the cycle members' own entries breaks every cycle without touching
 * legitimate chains feeding into a former cycle member (which now render as
 * orphans, keeping their children nested under them).
 */
function breakCycles(parentIdByChildId: Map<string, string>): void {
  const settled = new Set<string>();
  for (const start of [...parentIdByChildId.keys()]) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !position.has(current) && !settled.has(current)) {
      position.set(current, path.length);
      path.push(current);
      current = parentIdByChildId.get(current);
    }
    if (current !== undefined && position.has(current)) {
      for (const member of path.slice(position.get(current)!)) parentIdByChildId.delete(member);
    }
    for (const node of path) settled.add(node);
  }
}
