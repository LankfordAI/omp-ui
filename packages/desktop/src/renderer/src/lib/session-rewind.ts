// Pure correlation between the rendered transcript and omp's session entries
// (issue #680). Neither `message_start` events nor `get_messages` carry omp
// entry ids, so a "rewind here" click maps the k-th visible user row to the
// k-th user entry on the leaf→root path — the same positional rule the
// transcript itself uses to build user rows. The correlated entry is verified
// by re-deriving its rendered content through the identical
// `userContentFromContent()` strip that built the items; any mismatch refuses
// the rewind rather than guessing an id.

import { strField } from "./fields";
import { isObj } from "./fields";
import { userContentFromContent } from "./transcript";
import type { RenderItem, UserItem } from "./transcript";

/** A user-message entry reduced to the same fields a UserItem shows. */
export interface PromptEntry {
  entryId: string;
  /** Rendered-content mirror of UserItem fields, same derivation. */
  text: string;
  images: { data: string; mimeType: string }[];
}

/**
 * User entries on the leaf path since the newest on-path compaction, in
 * visible (root→leaf) order. `entries` is `get_entries` data.entries.
 * Returns null when the shape is malformed (leafId missing from the entry
 * list, an unknown parent, or a cycle) — never a partial walk.
 */
export function visiblePromptEntries(
  entries: unknown[],
  leafId: unknown,
): PromptEntry[] | null {
  if (typeof leafId !== "string") return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of entries) {
    if (!isObj(raw)) continue;
    const id = strField(raw, "id");
    if (id === undefined) continue;
    byId.set(id, raw);
  }
  const leaf = byId.get(leafId);
  if (leaf === undefined) return null;
  // Walk leaf→root with a visited set: omp entries are a tree, so a cycle
  // means the payload is malformed and positions are meaningless.
  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: Record<string, unknown> | undefined = leaf;
  while (cursor !== undefined) {
    const id = strField(cursor, "id");
    if (id === undefined || seen.has(id)) return null;
    seen.add(id);
    path.push(cursor);
    const parentId = cursor.parentId;
    if (parentId === null || parentId === undefined) break;
    if (typeof parentId !== "string") return null;
    cursor = byId.get(parentId);
    if (cursor === undefined) return null;
  }
  path.reverse();

  // Drop everything before `firstKeptEntryId` of the newest type==="compaction"
  // entry on the path — those entries are not in the visible model context
  // (probed: pre-compaction user entries do not surface as messages). An
  // off-path compaction is another branch's business and is ignored; an id
  // that is not itself on the path cannot truncate the path.
  let start = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.type !== "compaction") continue;
    const kept = strField(path[i]!, "firstKeptEntryId");
    if (kept === undefined) break;
    const at = path.findIndex((entry) => strField(entry, "id") === kept);
    if (at !== -1) start = at;
    break;
  }

  const out: PromptEntry[] = [];
  for (const entry of path.slice(start)) {
    if (entry.type !== "message") continue;
    const message = isObj(entry.message) ? entry.message : null;
    if (message === null || message.role !== "user") continue;
    const id = strField(entry, "id");
    if (id === undefined) return null;
    // Deliberately no text filter: an image-only prompt renders an
    // (empty-text) user row too, and the render side has no such filter.
    const content = userContentFromContent(message.content);
    out.push({
      entryId: id,
      text: content.text,
      images: content.images ?? [],
    });
  }
  return out;
}

/**
 * The entry id behind the `position`-th user row of the transcript, or null
 * when the correlation cannot be verified. Length mismatch is tolerated only
 * at the tail (a user message can exist as an entry a beat before its row
 * renders); the pair at `position` must exist on both sides and agree on
 * rendered text and image count.
 */
export function correlatePromptEntry(
  items: RenderItem[],
  entries: unknown[],
  leafId: unknown,
  position: number,
): string | null {
  const prompts = visiblePromptEntries(entries, leafId);
  if (prompts === null) return null;
  const users: UserItem[] = [];
  for (const item of items) if (item.kind === "user") users.push(item);
  if (users.length > prompts.length) return null;
  if (position < 0 || position >= users.length || position >= prompts.length)
    return null;
  const user = users[position]!;
  const entry = prompts[position]!;
  if (user.text !== entry.text) return null;
  if ((user.images ?? []).length !== entry.images.length) return null;
  return entry.entryId;
}

/**
 * The user-message entry behind `entryId`, reduced for a tree-row rewind
 * (issue #680): the navigator already holds the id, so no positional
 * correlation runs — but the entry must exist and be a user message, or the
 * `branch` RPC would throw. `entries` = get_entries data.entries.
 */
export function entryUserPrompt(
  entries: unknown[],
  entryId: string,
): PromptEntry | null {
  for (const raw of entries) {
    if (!isObj(raw) || strField(raw, "id") !== entryId) continue;
    if (raw.type !== "message") return null;
    const message = isObj(raw.message) ? raw.message : null;
    if (message === null || message.role !== "user") return null;
    const content = userContentFromContent(message.content);
    return {
      entryId,
      text: content.text,
      images: content.images ?? [],
    };
  }
  return null;
}

/**
 * How many current-branch entries stop being the leaf when the leaf moves
 * under `targetEntryId` (issue #680): the leaf chain's nodes strictly below
 * the deepest common ancestor of the current leaf and the target. Null when
 * either id is missing from the entries.
 */
export function discardedEntryCount(
  entries: unknown[],
  leafId: unknown,
  targetEntryId: string,
): number | null {
  if (typeof leafId !== "string") return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of entries) {
    if (!isObj(raw)) continue;
    const id = strField(raw, "id");
    if (id !== undefined) byId.set(id, raw);
  }
  const chain = (id: string): string[] | null => {
    const out: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor !== null) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      out.push(cursor);
      const entry = byId.get(cursor);
      if (entry === undefined) return null;
      const parentId = entry.parentId;
      cursor = typeof parentId === "string" ? parentId : null;
    }
    return out;
  };
  const leafChain = chain(leafId);
  const targetChain = chain(targetEntryId);
  if (leafChain === null || targetChain === null) return null;
  const onTarget = new Set(targetChain);
  // The leaf chain runs leaf→root: the first of its ids that the target's
  // chain contains is the common ancestor; everything below it is discarded.
  const kept = leafChain.find((id) => onTarget.has(id));
  if (kept === undefined) return leafChain.length;
  return leafChain.indexOf(kept);
}

