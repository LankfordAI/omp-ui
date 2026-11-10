import { HTML_ARTIFACT_TOOL_NAME } from "@omp-ui/core/html-artifact";
import type { RenderItem, ToolItem } from "./transcript";

/** A mid-run tool hop: omp's bridge spelling plus the provider spellings
 *  (the suppressWithCard keys of STOP_REASON_PARTS in TranscriptView). */
const TOOL_HOP_STOP_REASONS: ReadonlySet<string> = new Set(["toolUse", "tool_use", "tool_calls"]);
const NO_DEFERRED: ReadonlySet<string> = new Set();

export interface ArtifactPresentation {
  /** Display order: every input item exactly once. */
  items: RenderItem[];
  /** Ids of done render_html items held at their call position because their
   *  run has no final reply yet; the card shows a one-line note instead. */
  deferred: ReadonlySet<string>;
}

function isMovableArtifact(item: RenderItem): item is ToolItem {
  return item.kind === "tool" && item.name === HTML_ARTIFACT_TOOL_NAME && item.status === "done";
}

function isFinalReply(item: RenderItem): boolean {
  return item.kind === "assistant" && !item.streaming &&
    item.stopReason !== undefined && !TOOL_HOP_STOP_REASONS.has(item.stopReason);
}

function isAmbient(item: RenderItem): boolean {
  return item.kind === "marker" || item.kind === "notice" || item.kind === "irc";
}

/** Places items[start, end) (no user item inside) onto `out`. */
function placeSegment(
  items: RenderItem[], start: number, end: number, settled: boolean,
  out: RenderItem[], deferred: Set<string>,
): void {
  let lastReply = -1;
  for (let i = end - 1; i >= start; i--) {
    if (isFinalReply(items[i]!)) { lastReply = i; break; }
  }
  // Artifacts after the last final reply: once settled, they land after the
  // segment's last other content item; while the run is live they hold.
  let tailAnchor = -1;
  if (settled) {
    for (let i = end - 1; i > lastReply; i--) {
      const item = items[i]!;
      if (!isAmbient(item) && !isMovableArtifact(item)) { tailAnchor = i; break; }
    }
  }
  let pending: ToolItem[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    if (isMovableArtifact(item)) {
      if (i < lastReply || i < tailAnchor) pending.push(item);
      else {
        if (!settled) deferred.add(item.id);
        out.push(item);
      }
      continue;
    }
    if (isFinalReply(item) && pending.length > 0) { out.push(...pending); pending = []; }
    out.push(item);
    if (i === tailAnchor && pending.length > 0) { out.push(...pending); pending = []; }
  }
}

/**
 * HTML artifacts show with the run's final reply (issue #1141): a done
 * render_html call moves to directly before the first final reply after it in
 * its segment (the span between user items). With no such reply it holds in
 * place while the tab runs, else lands after the segment's last content item.
 * Display-only: the session file and the store's items keep call order.
 */
export function presentArtifacts(items: RenderItem[], running: boolean): ArtifactPresentation {
  if (!items.some(isMovableArtifact)) return { items, deferred: NO_DEFERRED };
  const out: RenderItem[] = [];
  const deferred = new Set<string>();
  let start = 0;
  while (start <= items.length) {
    let end = start;
    while (end < items.length && items[end]!.kind !== "user") end++;
    const closed = end < items.length;
    placeSegment(items, start, end, closed || !running, out, deferred);
    if (closed) out.push(items[end]!);
    start = end + 1;
  }
  const unchanged = out.every((item, i) => item === items[i]);
  return {
    items: unchanged ? items : out,
    deferred: deferred.size === 0 ? NO_DEFERRED : deferred,
  };
}
