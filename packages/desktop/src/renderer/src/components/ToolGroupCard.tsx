import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { strField } from "../lib/fields";
import {
  pathFromArgs,
  toolGroupCategory,
  toolGroupCounts,
  type ToolGroupCategory,
} from "../lib/tool-groups";
import type { ToolItem } from "../lib/transcript";
import { toolIntentLabel } from "@omp-ui/core/tool-intent-label";
import { useStore } from "../store";
import {
  argSummary,
  CheckGlyph,
  glyphFor,
  PathChip,
  readNoStall,
  RunningChip,
  ToolCard,
  ToolGlyph,
} from "./ToolCard";
import { Chevron, Chip, Panel, ProgressSweep } from "./ui";

interface ToolGroupCardProps {
  /** Members in transcript order; length >= 2; a fresh array on every buildRuns pass. */
  items: readonly ToolItem[];
  tabId?: string;
  /** The find bar's active match when it is one of `items`; else undefined. */
  findActiveId?: string;
  /** The find jump counter, passed only alongside findActiveId; a new value is a new jump. */
  findNonce?: number;
}

const SUMMARY_FORMAT: Record<ToolGroupCategory, { one: string; many: (count: number) => string }> = {
  read: { one: "1 file read", many: (count) => `${count} files read` },
  search: { one: "1 search", many: (count) => `${count} searches` },
  web: { one: "1 web search", many: (count) => `${count} web searches` },
  vault: { one: "1 vault lookup", many: (count) => `${count} vault lookups` },
};

/**
 * `buildRuns` builds a new member array every render while `reduceEvent` keeps
 * unchanged items identical (issue #187): compare members element-wise so a
 * stream tick elsewhere never re-renders a settled group.
 */
const sameMembers = (a: ToolGroupCardProps, b: ToolGroupCardProps): boolean =>
  a.tabId === b.tabId &&
  a.findActiveId === b.findActiveId &&
  a.findNonce === b.findNonce &&
  a.items.length === b.items.length &&
  a.items.every((item, i) => item === b.items[i]);

/**
 * A tool group (issue #1186): back-to-back read-only lookups from one
 * assistant message as one collapsed card titled by per-kind counts. Each
 * expanded line opens that call's full ToolCard in place.
 */
export const ToolGroupCard = memo(function ToolGroupCard({
  items,
  tabId,
  findActiveId,
  findNonce,
}: ToolGroupCardProps) {
  const streamStallMs = useStore(
    tabId === undefined ? readNoStall : (s) => s.rpc[tabId]?.streamStallMs,
  );
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleMember = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Find (issue #270): every jump into a member opens the group and that
  // member's line. Adjusted during render, not in an effect, so the parent's
  // reveal layout effect already sees the opened line.
  const jumpKey = findActiveId === undefined ? undefined : `${findActiveId}#${findNonce ?? 0}`;
  const [forcedKey, setForcedKey] = useState<string | undefined>(undefined);
  if (jumpKey !== forcedKey) {
    setForcedKey(jumpKey);
    if (findActiveId !== undefined) {
      setOpen(true);
      setExpanded((prev) => (prev.has(findActiveId) ? prev : new Set(prev).add(findActiveId)));
    }
  }

  const counts = useMemo(() => toolGroupCounts(items), [items]);
  const summary = counts
    .map(({ category, count }) =>
      count === 1 ? SUMMARY_FORMAT[category].one : SUMMARY_FORMAT[category].many(count),
    )
    .join(" · ");
  const running = items.some((item) => item.status === "running");

  return (
    <Panel tone="neutral">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Chevron open={open} className="text-ink-faint" />
        <span className={cn("shrink-0", running ? "text-copper" : "text-ink-dim")}>
          <ToolGlyph kind={glyphFor(items[0]!.name)} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{summary}</span>
        {running ? <RunningChip streamStallMs={streamStallMs} /> : <CheckGlyph />}
      </button>
      {running && <ProgressSweep tone="copper" paused={streamStallMs !== undefined} />}
      {open && (
        <div
          role="list"
          aria-label="Grouped tool calls"
          className="space-y-1 border-t border-line-soft px-2.5 py-2"
        >
          {items.map((item) => (
            <ToolGroupLine
              key={item.id}
              item={item}
              tabId={tabId}
              open={expanded.has(item.id)}
              active={item.id === findActiveId}
              streamStallMs={streamStallMs}
              onToggle={toggleMember}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}, sameMembers);

/** The chips that identify what one grouped call looked at. */
function lineTarget(item: ToolItem): ReactNode {
  const args = item.args;
  switch (toolGroupCategory(item)) {
    case "read": {
      const path = pathFromArgs(args) ?? item.path;
      return path === undefined ? null : <PathChip value={path} />;
    }
    case "search": {
      const pattern = strField(args, "pattern") ?? strField(args, "query");
      const scope = strField(args, "path") ?? strField(args, "glob");
      if (pattern === undefined && scope === undefined) return null;
      return (
        <>
          {pattern !== undefined && (
            <Chip mono truncate title={pattern}>
              {pattern}
            </Chip>
          )}
          {scope !== undefined && <PathChip value={scope} />}
        </>
      );
    }
    case "web":
    case "vault": {
      const text =
        strField(args, "query") ?? strField(args, "path") ?? strField(args, "folder");
      return text === undefined ? null : (
        <Chip mono truncate title={text}>
          {text}
        </Chip>
      );
    }
    case null:
      return null;
  }
}

/** One grouped call: a compact line that opens the call's full ToolCard. */
const ToolGroupLine = memo(function ToolGroupLine({
  item,
  tabId,
  open,
  active,
  streamStallMs,
  onToggle,
}: {
  item: ToolItem;
  tabId?: string;
  open: boolean;
  active: boolean;
  streamStallMs: number | undefined;
  onToggle: (id: string) => void;
}) {
  // Upstream's brief-label rule (issue #1274): a streaming line shows pi-wire's
  // short intent label, the settled line shows the whole intent; the tooltip
  // always carries the full text.
  const rawIntent = item.intent ?? strField(item.args, "i");
  const fullHeadline = item.intent ?? argSummary(item.args);
  const headlineTitle = rawIntent ?? fullHeadline;
  const headline =
    item.status === "running" && rawIntent !== undefined ? toolIntentLabel(rawIntent) : fullHeadline;
  const target = lineTarget(item);
  return (
    // data-group-member-id, never data-item-id: the reveal loop counts
    // [data-item-id] rows, and a member is not a transcript row.
    <div
      role="listitem"
      data-group-member-id={item.id}
      className={cn("space-y-1", active && "find-hit-active")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(item.id)}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        <Chevron open={open} className="text-ink-faint" />
        <span className={cn("shrink-0", item.status === "running" ? "text-copper" : "text-ink-dim")}>
          <ToolGlyph kind={glyphFor(item.name)} />
        </span>
        {target !== null && (
          <span className="flex min-w-0 max-w-[50%] shrink items-center gap-1.5">{target}</span>
        )}
        {target === null && headline === "" ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-mid">{item.name}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-ink-mid" title={headlineTitle}>
            {headline}
          </span>
        )}
        {item.status === "running" ? <RunningChip streamStallMs={streamStallMs} /> : <CheckGlyph />}
      </button>
      {open && (
        <div className="pl-5">
          <ToolCard item={item} tabId={tabId} />
        </div>
      )}
    </div>
  );
});
