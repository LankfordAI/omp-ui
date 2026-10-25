import { diffCounts, type DiffRow } from "./omp-diff";
import type { RenderItem } from "./transcript";

/** One diff-bearing tool card folded into an exchange's change rollup. */
export interface ExchangeChangeEntry {
  itemId: string;
  path?: string;
  op?: string;
  /** Shared by reference with the tool item — never cloned. */
  rows: DiffRow[];
}

/** The receipt payload for one exchange: every diff card between two user prompts. */
export interface ExchangeChanges {
  /** The last content item before the next user prompt (or the tail), the key's twin. */
  anchorId: string;
  entries: ExchangeChangeEntry[];
  files: number;
  added: number;
  removed: number;
}

/**
 * Fold every diff-bearing tool card into the exchange it belongs to (issue #933).
 * A `user` item opens a new exchange; a `tool` item carrying `diff` (vault write
 * cards included — same rule) joins the running rollup; the exchange is keyed by
 * its anchor, the last content item before the next user prompt or the tail.
 * Ambient rows (marker/notice/irc) never close an exchange and never become the
 * anchor — the same rule as opensExchange. An exchange with no diff-bearing card
 * gets no map entry at all. A card without a path counts once as a single
 * pseudo-file ("diff"); zero-row entries still count as a file. Rows are
 * aliased, never copied — callers must treat them as read-only.
 */
export function summarizeExchanges(items: readonly RenderItem[]): Map<string, ExchangeChanges> {
  const map = new Map<string, ExchangeChanges>();
  let entries: ExchangeChangeEntry[] = [];
  let anchorId: string | null = null;

  const flush = (): void => {
    if (entries.length === 0 || anchorId === null) return;
    const paths = new Set<string>();
    let anonymous = false;
    let added = 0;
    let removed = 0;
    for (const entry of entries) {
      if (entry.path === undefined) anonymous = true;
      else paths.add(entry.path);
      const counts = diffCounts(entry.rows);
      added += counts.added;
      removed += counts.removed;
    }
    map.set(anchorId, {
      anchorId,
      entries,
      files: paths.size + (anonymous ? 1 : 0),
      added,
      removed,
    });
  };

  for (const item of items) {
    if (item.kind === "user") {
      flush();
      entries = [];
      anchorId = null;
      continue;
    }
    if (item.kind !== "marker" && item.kind !== "notice" && item.kind !== "irc") {
      anchorId = item.id;
    }
    if (item.kind === "tool" && item.diff !== undefined) {
      entries.push({ itemId: item.id, path: item.path, op: item.op, rows: item.diff });
    }
  }
  flush();
  return map;
}
