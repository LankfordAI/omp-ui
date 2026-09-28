// The session-tree wire contract (issue #680, Phase 2). Pure — zero imports —
// because the renderer imports it directly via the @omp-ui/core/session-tree
// subpath, exactly like goal.ts and capabilities.ts. The generating half
// (which writes the extension file) lives in tree-extension.ts and consumes
// these same constants, so the two sides of the channel can never drift.
//
// omp's rpc surface reads the tree (`get_tree`) but has no verb that JUMPS to
// an arbitrary entry: `AgentSession.navigateTree(entryId, { summarize })` is
// in-process only (verified against the managed 18.4.2 binary: no dispatch
// case). Per ADR-0007/0024 that makes this one more per-lineage generated
// bridge: the extension publishes the tree snapshot over `ui.setStatus` and
// executes navigation against the live session.

/** Hidden command family the renderer dispatches (`show`, `navigate …`). */
export const TREE_COMMAND = "omp-ui-tree";

/** `setStatus` key carrying the JSON tree snapshot. Routed, never rendered raw. */
export const TREE_STATUS_KEY = "omp-ui:tree";

/** Per-node preview cap on the wire; the full text stays in the session file. */
export const TREE_PREVIEW_CHAR_LIMIT = 160;

/**
 * Hard cap on the serialized snapshot (UTF-8 bytes). The publisher replaces an
 * over-budget tree with a `payload-too-large` snapshot rather than emitting
 * half a tree; the parser rejects anything over it, leaving the last good
 * snapshot standing (capabilities.ts discipline).
 */
export const TREE_STATUS_BYTE_LIMIT = 256 * 1024;

/** Why the bridge could not read the tree. Never confused with an empty one. */
export type TreeReason = "missing-api" | "read-failed" | "payload-too-large";

/** One entry, flattened for display: depth derives from parentId. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  /** omp's entry type (`message`, `compaction`, `model_change`, …). */
  type: string;
  /** Present only for `message` entries. */
  role?: string;
  /** Joined-text preview, capped at TREE_PREVIEW_CHAR_LIMIT. */
  text: string;
  timestamp: string;
}

/** The outcome of the most recent navigate this process executed. */
export interface TreeNavigationResult {
  entryId: string;
  ok: boolean;
  error?: string;
  aborted?: boolean;
}

/** What the root bridge publishes on {@link TREE_STATUS_KEY}. */
export interface TreeSnapshot {
  available: boolean;
  reason?: TreeReason;
  /** Strictly increasing per published replacement, per process. */
  revision: number;
  leafId: string | null;
  /** Root→leaf ids of the current branch. */
  activePath: string[];
  nodes: TreeNode[];
  navigation?: TreeNavigationResult;
}

/** The hidden navigate dispatch. */
export function treeNavigateMessage(
  entryId: string,
  summarize: boolean,
): string {
  return `/${TREE_COMMAND} navigate ${entryId}${summarize ? " summarize" : ""}`;
}

/**
 * Parses the JSON published on {@link TREE_STATUS_KEY}. A malformed or
 * over-budget publish returns null — the caller keeps the last good snapshot;
 * nothing is ever half-applied.
 */
export function parseTreeSnapshot(text: string): TreeSnapshot | null {
  if (utf8Length(text) > TREE_STATUS_BYTE_LIMIT) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return readSnapshot(raw);
}

const INVALID = Symbol("invalid");

function readSnapshot(value: unknown): TreeSnapshot | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.available !== "boolean") return null;
  const revision = record.revision;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return null;
  if (record.leafId !== null && typeof record.leafId !== "string") return null;
  const reason = record.reason;
  if (
    reason !== undefined &&
    reason !== "missing-api" &&
    reason !== "read-failed" &&
    reason !== "payload-too-large"
  )
    return null;
  const activePath = readStringArray(record.activePath);
  const nodes = readNodes(record.nodes);
  if (activePath === INVALID || nodes === INVALID) return null;
  const out: TreeSnapshot = {
    available: record.available,
    ...(reason !== undefined ? { reason } : {}),
    revision,
    leafId: (record.leafId as string | null) ?? null,
    activePath: activePath as string[],
    nodes: nodes as TreeNode[],
  };
  if (record.navigation !== undefined) {
    const navigation = readNavigation(record.navigation);
    if (navigation === null) return null;
    out.navigation = navigation;
  }
  // An available snapshot must describe a tree; an unavailable one is a
  // reason plus an empty shape, which is legal.
  if (record.available === true && typeof record.leafId !== "string")
    return null;
  return out;
}

function readNodes(value: unknown): TreeNode[] | typeof INVALID {
  if (!Array.isArray(value)) return INVALID;
  const nodes: TreeNode[] = [];
  for (const raw of value) {
    const node = asRecord(raw);
    if (node === null) return INVALID;
    const id = nonEmptyString(node.id);
    const type = nonEmptyString(node.type);
    const text = typeof node.text === "string" ? node.text : null;
    const timestamp = typeof node.timestamp === "string" ? node.timestamp : null;
    if (id === null || type === null || text === null || timestamp === null)
      return INVALID;
    if (node.parentId !== null && typeof node.parentId !== "string")
      return INVALID;
    if (node.role !== undefined && typeof node.role !== "string")
      return INVALID;
    nodes.push({
      id,
      parentId: (node.parentId as string | null) ?? null,
      type,
      ...(node.role !== undefined ? { role: node.role as string } : {}),
      text,
      timestamp,
    });
  }
  return nodes;
}

function readNavigation(value: unknown): TreeNavigationResult | null {
  const record = asRecord(value);
  if (record === null) return null;
  const entryId = nonEmptyString(record.entryId);
  if (entryId === null || typeof record.ok !== "boolean") return null;
  if (record.error !== undefined && typeof record.error !== "string")
    return null;
  if (record.aborted !== undefined && typeof record.aborted !== "boolean")
    return null;
  return {
    entryId,
    ok: record.ok,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(record.aborted === true ? { aborted: true } : {}),
  };
}

function readStringArray(value: unknown): string[] | typeof INVALID {
  if (!Array.isArray(value)) return INVALID;
  for (const item of value)
    if (typeof item !== "string") return INVALID;
  return value as string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** UTF-8 byte length without runtime imports (pure scan, no allocation). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
