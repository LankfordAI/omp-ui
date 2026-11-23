import { useEffect, useSyncExternalStore } from "react";
import { cn } from "../lib/cn";
import type { DispatchLink } from "../lib/dispatched-sessions";
import { releaseDispatchHover, setDispatchHover, useDispatchHover } from "../lib/dispatch-hover";
import { isSessionSettled } from "../lib/sidebar-sessions";
import { deriveSidebarSessionState, useStore } from "../store";
import { Chevron, Dot } from "./ui";
import { ProjectMonogram } from "./ProjectMonogram";
import { ChatMark } from "./SessionProjectLine";
import { SESSION_FACE } from "./SessionRow";
import { withTitleCard } from "./TitleCardChip";

/** Unsettled lines shown before "+N more" (ADR-0098). */
const VISIBLE_LINES = 4;

/**
 * Per dispatching tab, in memory only (ADR-0098 rejects persisting it):
 * collapsed (default open), expanded past VISIBLE_LINES, and settled revealed.
 */
interface TetherSets {
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  showSettled: ReadonlySet<string>;
}
let sets: TetherSets = { collapsed: new Set(), expanded: new Set(), showSettled: new Set() };
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function toggle(key: keyof TetherSets, tabId: string): void {
  const next = new Set(sets[key]);
  if (next.has(tabId)) next.delete(tabId);
  else next.add(tabId);
  sets = { ...sets, [key]: next };
  for (const cb of listeners) cb();
}

/** Test helper: clears collapsed / expanded / showSettled. */
export function resetDispatchTetherState(): void {
  sets = { collapsed: new Set(), expanded: new Set(), showSettled: new Set() };
  for (const cb of listeners) cb();
}

function useTetherFlag(key: keyof TetherSets, tabId: string): boolean {
  return useSyncExternalStore(subscribe, () => sets[key].has(tabId));
}

/**
 * The dispatch tether (#1226, ADR-0098): the sessions a dispatching session's
 * agent dispatched, listed under its sidebar tile or attention card. It
 * repeats those sessions; their own rows keep their section and open order
 * (ADR-0067). Rendered as a sibling of the row's draggable, context-menu
 * container and of an attention card's button, never nested in a button.
 */
export function DispatchTether({
  parentTabId,
  parentTitle,
  children,
  onActivate,
}: {
  parentTabId: string;
  parentTitle: string;
  children: DispatchLink[];
  /** Sidebar's onActivate (closes the compact surface). */
  onActivate?: () => void;
}) {
  const collapsed = useTetherFlag("collapsed", parentTabId);
  const expanded = useTetherFlag("expanded", parentTabId);
  const showSettled = useTetherFlag("showSettled", parentTabId);
  // One primitive snapshot: "<awaiting-answer>,<working>".
  const counts = useStore((st) => {
    let waiting = 0;
    let working = 0;
    for (const link of children) {
      const state = deriveSidebarSessionState(link.session, st.rpc[link.session.tabId]);
      if (state === "awaiting-answer") waiting++;
      else if (state === "working" || state === "awaiting-work") working++;
    }
    return `${waiting},${working}`;
  });
  if (children.length === 0) return null;
  const [waiting, working] = counts.split(",").map(Number) as [number, number];
  const unsettled = children.filter((link) => !isSessionSettled(link.session));
  const settled = children.filter((link) => isSessionSettled(link.session));
  const visible = expanded ? unsettled : unsettled.slice(0, VISIBLE_LINES);
  const hidden = unsettled.length - visible.length;

  return (
    <div
      role="group"
      aria-label={`Sessions dispatched by “${parentTitle}”`}
      className="mx-3 mb-2 border-l border-line-strong pl-2"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        title={collapsed ? "Show dispatched sessions" : "Hide dispatched sessions"}
        onClick={() => toggle("collapsed", parentTabId)}
        className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-hover"
      >
        <Chevron open={!collapsed} />
        <span className="min-w-0 truncate text-xs text-ink-faint">
          {`${children.length} dispatched`}
          {waiting > 0 && (
            <>
              {" · "}
              <span className="text-iris">{`${waiting} waiting on you`}</span>
            </>
          )}
          {working > 0 && (
            <>
              {" · "}
              <span className="text-copper">{`${working} working`}</span>
            </>
          )}
        </span>
      </button>
      {!collapsed && (
        <div className="flex min-w-0 flex-col">
          {visible.map((link) => (
            <TetherLine key={link.session.tabId} link={link} onActivate={onActivate} />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => toggle("expanded", parentTabId)}
              className="rounded px-1.5 py-0.5 text-left text-xs text-ink-faint hover:bg-hover hover:text-ink"
            >
              {`+${hidden} more`}
            </button>
          )}
          {settled.length > 0 && (
            <>
              {showSettled &&
                settled.map((link) => (
                  <TetherLine key={link.session.tabId} link={link} settled onActivate={onActivate} />
                ))}
              <button
                type="button"
                onClick={() => toggle("showSettled", parentTabId)}
                className="rounded px-1.5 py-0.5 text-left text-xs text-ink-faint hover:bg-hover hover:text-ink"
              >
                {showSettled ? "hide settled" : `+${settled.length} settled`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TetherLine({
  link,
  settled = false,
  onActivate,
}: {
  link: DispatchLink;
  settled?: boolean;
  onActivate?: () => void;
}) {
  const tabId = link.session.tabId;
  const openSession = useStore((st) => st.openSession);
  const state = useStore((st) => deriveSidebarSessionState(link.session, st.rpc[tabId]));
  // SessionRow's rule: a missing row opens only when it is a stranded mounted tab (#926).
  const stranded = useStore((st) => st.exited[tabId] !== undefined && st.tabs.some((x) => x.tabId === tabId));
  const rowHovered = useDispatchHover(tabId, "row");
  useEffect(() => () => releaseDispatchHover({ tabId, source: "tether" }), [tabId]);

  const face = SESSION_FACE[state];
  const where =
    (link.project?.name ?? "chat") + (link.nickname !== null ? ` · ${link.nickname}` : "");
  const title = `${link.session.title} — ${where} · ${face.label}`;
  const inert = link.session.live === "missing" && !stranded;
  const className = cn(
    "flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs text-ink-mid hover:bg-hover hover:text-ink",
    rowHovered && "bg-hover text-ink",
    !link.reachable && "opacity-60",
    settled && "opacity-50",
    inert && "cursor-default",
  );
  const body = (
    <>
      <Dot tone={face.tone} pulse={face.pulse} />
      {link.project !== null ? (
        <ProjectMonogram
          seed={link.project.seed}
          name={link.project.name}
          icon={link.project.icon}
          className="size-3.5 rounded-sm text-[0.45rem]"
        />
      ) : (
        <ChatMark />
      )}
      <span className="min-w-0 flex-1 truncate">{withTitleCard(link.session.title)}</span>
      {state === "awaiting-answer" && <span className="shrink-0 text-iris">{face.label}</span>}
    </>
  );
  const hover = { tabId, source: "tether" } as const;
  if (inert) {
    return (
      <span data-dispatch-line={tabId} title={title} className={className}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-dispatch-line={tabId}
      title={title}
      onClick={() => {
        void openSession(tabId);
        onActivate?.();
      }}
      onMouseEnter={() => setDispatchHover(hover)}
      onFocus={() => setDispatchHover(hover)}
      onMouseLeave={() => releaseDispatchHover(hover)}
      onBlur={() => releaseDispatchHover(hover)}
      className={className}
    >
      {body}
    </button>
  );
}
