import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ProjectGroup, SessionSummary } from "@omp-ui/core/types";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { useCompactShell, useViewportWidth } from "../lib/responsive";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  resolveDesktopPanelWidths,
} from "../lib/panel-layout";
import { PAGE } from "../lib/session-window";
import { arrangeSessionHandoffs } from "../lib/session-handoffs";
import { useStore } from "../store";
import { SessionRow } from "./SessionRow";
import { ProjectOpenControl } from "./ProjectOpenControl";
import { ProjectActionsSheet } from "./ProjectActionsSheet";
import { ProjectDefaultsSheet } from "./ProjectDefaultsSheet";
import { Button, Chevron, Chip, Dot, Empty, IconButton, IconClose, MiddleTruncate, Panel, ResizeHandle, Sheet } from "./ui";

/* ------------------------------------------------------------------- icons */

function IconSearch() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7" cy="7" r="4" />
      <path d="M10.2 10.2 13 13" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function IconMcp() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="currentColor">
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <rect x="4.5" y="4.25" width="1" height="1" />
      <rect x="4.5" y="10.75" width="1" height="1" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M6.89 1.7A6.4 6.4 0 0 1 9.11 1.7L8.93 3.8A4.3 4.3 0 0 1 10.31 4.37L11.67 2.76A6.4 6.4 0 0 1 13.24 4.33L11.63 5.69A4.3 4.3 0 0 1 12.2 7.07L14.3 6.89A6.4 6.4 0 0 1 14.3 9.11L12.2 8.93A4.3 4.3 0 0 1 11.63 10.31L13.24 11.67A6.4 6.4 0 0 1 11.67 13.24L10.31 11.63A4.3 4.3 0 0 1 8.93 12.2L9.11 14.3A6.4 6.4 0 0 1 6.89 14.3L7.07 12.2A4.3 4.3 0 0 1 5.69 11.63L4.33 13.24A6.4 6.4 0 0 1 2.76 11.67L4.37 10.31A4.3 4.3 0 0 1 3.8 8.93L1.7 9.11A6.4 6.4 0 0 1 1.7 6.89L3.8 7.07A4.3 4.3 0 0 1 4.37 5.69L2.76 4.33A6.4 6.4 0 0 1 4.33 2.76L5.69 4.37A4.3 4.3 0 0 1 7.07 3.8L6.89 1.7Z" />
    </svg>
  );
}

/** Drag handle and keyboard reorder control for a project (issues #115, #120). */
function IconGrip() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="currentColor"
    >
      <circle cx="5.5" cy="4" r="0.9" />
      <circle cx="10.5" cy="4" r="0.9" />
      <circle cx="5.5" cy="8" r="0.9" />
      <circle cx="10.5" cy="8" r="0.9" />
      <circle cx="5.5" cy="12" r="0.9" />
      <circle cx="10.5" cy="12" r="0.9" />
    </svg>
  );
}

/** Trigger for the compact project actions sheet (issue #205). */
function IconEllipsis() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="12.5" cy="8" r="1.1" />
    </svg>
  );
}

/** Slider mark for the project default-models sheet (issue #257), matching the composer's options icon. */
function IconTune() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
      <path d="M2 4.5h4.6M10.4 4.5H14M2 11.5h2.6M8.4 11.5H14" />
      <circle cx="9" cy="4.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="6" cy="11.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* -------------------------------------------------------------- primitives */

/** Three pulsing bars — the honest "we have not heard from the backend yet". */
function SkeletonRows() {
  return (
    <div className="space-y-2 px-3 py-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse space-y-1.5" style={{ animationDelay: `${i * 120}ms` }}>
          <div className="h-2.5 rounded bg-line-soft" style={{ width: `${72 - i * 14}%` }} />
          <div className="h-2 w-1/3 rounded bg-line-soft" />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

function liveCount(sessions: SessionSummary[]): number {
  let n = 0;
  for (const s of sessions) if (s.live === "live") n += 1;
  return n;
}

/** Two-letter monogram for the collapsed rail. */
function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

interface FilteredGroup {
  group: ProjectGroup;
  /** Sessions matching the query themselves — the filter chip's count. */
  sessions: SessionSummary[];
  /** The project name matched, so every handoff tree survives untrimmed. */
  projectHit: boolean;
}
type OpenTerminalMenu = (
  projectCwd: string,
  event: ReactMouseEvent<HTMLElement>,
) => void;

interface TerminalMenuRequest {
  projectCwd: string;
  x: number;
  y: number;
  trigger: HTMLElement;
}

/**
 * A session survives the filter when its own title (or its saved plan title)
 * matches; a matching project name reveals that project's whole list. Group
 * survival mirrors the arrangement's whole-tree filter: a tree is retained by
 * any member match, and members live in the same group as their source.
 */
function applyFilter(groups: ProjectGroup[], query: string): FilteredGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.map((group) => ({ group, sessions: group.sessions, projectHit: true }));
  const out: FilteredGroup[] = [];
  for (const group of groups) {
    const projectHit = group.project.name.toLowerCase().includes(q);
    const sessions = projectHit
      ? group.sessions
      : group.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            (s.planImplementationSource?.planTitle.toLowerCase().includes(q) ?? false),
        );
    if (projectHit || sessions.length > 0) out.push({ group, sessions, projectHit });
  }
  return out;
}

/**
 * Which registered path a dragged project should land *before*, given the
 * pointer over the section at `index`. Bottom half of any section means "after
 * this one", i.e. before its successor — or the end of the list when there is
 * none (null). Top half means before this section's project.
 */
function beforePathOf(
  paths: string[],
  index: number,
  clientY: number,
  rectTop: number,
  rectBottom: number,
): string | null {
  const mid = (rectTop + rectBottom) / 2;
  const after = clientY >= mid;
  return after ? (paths[index + 1] ?? null) : paths[index];
}

interface ProjectSectionProps {
  group: ProjectGroup;
  /** The project name matched the filter, so no tree is trimmed (issue #238). */
  projectHit: boolean;
  query: string;
  openTerminalMenu: OpenTerminalMenu;
  compact: boolean;
  onActivate: () => void;
  vsCodeAvailable: boolean | null;
  refreshAvailability: () => Promise<boolean>;
  onOpenActions?: () => void;
  onOpenDefaults?: () => void;
  // issue #115 pointer reorder, issue #120 keyboard reorder — one gate for both
  canReorder?: boolean;
  registerGrip?: (path: string, el: HTMLButtonElement | null) => void;
  onReorder?: (delta: -1 | 1) => void;
  dragging?: boolean;
  dropIndicator?: "before" | "after" | null;
  onDragStart?: (e: ReactDragEvent<HTMLElement>) => void;
  onDragOver?: (e: ReactDragEvent<HTMLElement>) => void;
  onDrop?: (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}

/* --------------------------------------------------------- project section */

function ProjectSection({
  group,
  projectHit,
  query,
  openTerminalMenu,
  compact,
  vsCodeAvailable,
  refreshAvailability,
  onActivate,
  onOpenActions,
  onOpenDefaults,
  canReorder = false,
  registerGrip,
  onReorder,
  dragging = false,
  dropIndicator = null,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ProjectSectionProps) {
  const newSession = useStore((st) => st.newSession);
  const removeProject = useStore((st) => st.removeProject);
  const focusedTabId = useStore((st) => st.focusedTabByProject[group.project.path]);
  const openMcpManager = useStore((st) => st.openMcpManager);
  const [open, setOpen] = useState(true);
  const [visible, setVisible] = useState(PAGE);

  // ProjectSection is keyed by project path, so state survives filter edits: a
  // page opened before typing would otherwise describe a list that no longer
  // exists. Adjusting during render (rather than in an effect) means the stale
  // count is never painted.
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setVisible(PAGE);
  }

  // Pagination follows this project's remembered focus, not the global active
  // tab: after another project takes global focus (or after an update restore)
  // each project's list still shows the session last focused in it. The
  // arrangement also widens the page so a handoff tree is never split, and
  // resolves each row's plan source (issue #238).
  const { entries, shown, remaining, total } = arrangeSessionHandoffs(
    group.sessions,
    query,
    projectHit,
    visible,
    focusedTabId,
  );

  const { project } = group;
  // Chips describe the project itself, so they count raw sessions — filtering
  // and tree retention only change which rows render below.
  const live = liveCount(group.sessions);

  return (
    <section
      className={cn(
        "pb-1",
        dragging && "opacity-60",
        // The insertion line uses neutral emphasis — ADR-0004 reserves the
        // signal accent for liveness/success.
        dropIndicator === "before" && "border-t-2 border-line-strong",
        dropIndicator === "after" && "border-b-2 border-line-strong",
      )}
      data-drop-indicator={dropIndicator ?? undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="sticky top-0 z-10 bg-sunken/95 px-2 pt-2 pb-1 backdrop-blur">
        <div
          // No gap in the non-compact layout: the reveals bring their own margin,
          // so the name owns the full row width at rest.
          className={cn("group/proj flex items-start", compact && "gap-1.5", canReorder && "cursor-grab active:cursor-grabbing")}
          draggable={canReorder}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          {canReorder && (
            <span className="proj-reveal proj-reveal-r mt-px shrink-0 self-center overflow-hidden max-w-0 transition-all duration-200 group-hover/proj:mr-1.5 group-hover/proj:max-w-11 focus-within:mr-1.5 focus-within:max-w-11">
              <button
                type="button"
                ref={(el) => {
                  registerGrip?.(project.path, el);
                }}
                aria-label={`reorder ${project.name}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title={`reorder ${project.name} — drag, or Alt+↑ / Alt+↓`}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  // Ours: neither scroll the list nor wake Electron's
                  // auto-hidden menu bar (main/index.ts: autoHideMenuBar).
                  e.preventDefault();
                  onReorder?.(e.key === "ArrowUp" ? -1 : 1);
                }}
                className="shrink-0 rounded text-ink-faint opacity-0 transition-opacity duration-200 group-hover/proj:opacity-100 focus-visible:opacity-100 focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                <IconGrip />
              </button>
            </span>
          )}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            title={project.path}
            className={cn("mt-px flex min-w-0 flex-1 items-start text-left", compact && "gap-1.5")}
          >
            {/* Joins the hover-reveal family: zero width at rest so the name runs
                edge to edge. In the compact shell it is permanently visible —
                a phone has no hover, and the name tap alone is a weak affordance. */}
            <span
              className={cn(
                "mt-1 shrink-0",
                !compact && "proj-reveal proj-reveal-r overflow-hidden opacity-0 max-w-0 transition-all duration-200 group-hover/proj:mr-1.5 group-hover/proj:max-w-3 group-hover/proj:opacity-100 group-focus-within/proj:mr-1.5 group-focus-within/proj:max-w-3 group-focus-within/proj:opacity-100",
              )}
            >
              <Chevron open={open} className="text-ink-dim" />
            </span>
            {compact ? (
              // Compact keeps one line: name + chips + the ⋯ trigger. The
              // full path lives in the actions sheet (issue #205); the
              // collapse button's title still carries it for long-press.
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <MiddleTruncate
                  text={project.name}
                  className="min-w-0 flex-1 font-display text-xs font-semibold text-ink"
                />
                <Chip mono title={`${group.sessions.length} sessions`}>
                  {group.sessions.length}
                </Chip>
                {live > 0 && (
                  <Chip mono tone="signal" title={`${live} live`}>
                    <Dot tone="signal" />
                    {live}
                  </Chip>
                )}
              </span>
            ) : (
              <span className="min-w-0 flex-1">
                <MiddleTruncate
                  text={project.name}
                  className="font-display text-xs font-semibold text-ink"
                />
                <span className="mt-0.5 flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
                    {project.path}
                  </span>
                  <Chip mono title={`${group.sessions.length} sessions`}>
                    {group.sessions.length}
                  </Chip>
                  {live > 0 && (
                    <Chip mono tone="signal" title={`${live} live`}>
                      <Dot tone="signal" />
                      {live}
                    </Chip>
                  )}
                </span>
              </span>
            )}
          </button>

          {compact ? (
            // One 44px trigger replaces the whole cluster below 900px
            // (issue #205); every action moves into the bottom sheet.
            <IconButton
              label={`actions for ${project.name}`}
              onClick={() => onOpenActions?.()}
              className="shrink-0 self-center"
            >
              <IconEllipsis />
            </IconButton>
          ) : (
            // max-w-0 (not w-0): children carry min-widths under coarse pointers,
            // and the ProjectOpenControl error line can grow; the revealed cap is
            // the row itself, so nothing ever clips.
            <div className="proj-reveal proj-reveal-l compact-lifecycle-visible flex shrink-0 items-center gap-1 overflow-hidden opacity-0 max-w-0 transition-all duration-200 group-hover/proj:ml-1.5 group-hover/proj:max-w-full group-hover/proj:opacity-100 focus-within:ml-1.5 focus-within:max-w-full focus-within:opacity-100">
              <ProjectOpenControl
                project={project}
                vsCodeAvailable={vsCodeAvailable}
                refreshAvailability={refreshAvailability}
              />
              <IconButton label={`MCP servers for ${project.name}`} onClick={() => openMcpManager(project.path)}>
                <IconMcp />
              </IconButton>
              <IconButton label={`default models for ${project.name}`} onClick={() => onOpenDefaults?.()}>
                <IconTune />
              </IconButton>
              <span onContextMenu={(event) => openTerminalMenu(project.path, event)}>
                <IconButton label="new session" onClick={() => { void newSession(project.path); onActivate(); }}>
                  <IconPlus />
                </IconButton>
              </span>
              <IconButton
                label={`new session options for ${project.name}`}
                onClick={(event) => openTerminalMenu(project.path, event)}
              >
                <Chevron open className="size-2.5" />
              </IconButton>
              <IconButton label="remove project" tone="rose" onClick={() => void removeProject(project.path)}>
                <IconClose className="size-3.5" />
              </IconButton>
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="space-y-px px-1.5">
          {entries.map((entry) => (
            <div
              key={entry.session.tabId}
              className={cn(
                "relative",
                entry.depth === 1 && "pl-4",
                entry.depth >= 2 && "pl-8",
              )}
            >
              {entry.depth > 0 && (
                // Handoff connector — a stem and elbow from the plan source
                // above into this implementation row. Neutral chrome, never
                // the signal accent (ADR-0004, issue #238).
                <span
                  aria-hidden
                  data-handoff-connector
                  className={cn(
                    "pointer-events-none absolute top-0 h-1/2 w-2 rounded-bl border-b border-l border-line-soft",
                    entry.depth === 1 ? "left-1.5" : "left-5.5",
                  )}
                />
              )}
              <SessionRow
                s={entry.session}
                onActivate={onActivate}
                handoff={{
                  source: entry.source,
                  orphanSource: entry.orphanSource,
                  hasDescendants: entry.hasDescendants,
                }}
              />
            </div>
          ))}
          {total === 0 && (
            <p className="px-3 py-1 text-[11px] text-ink-faint italic">no sessions yet</p>
          )}
          {total > PAGE && (
            <div className="flex items-center gap-2 px-3 pt-1 pb-0.5">
              <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                showing {shown} of {total}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {visible > PAGE && shown > PAGE && (
                  <Button size="xs" variant="ghost" onClick={() => setVisible(PAGE)}>
                    show less
                  </Button>
                )}
                {remaining > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setVisible(shown + PAGE)}
                    title={`${remaining} more session${remaining === 1 ? "" : "s"} in ${project.name}`}
                  >
                    show {Math.min(PAGE, remaining)} more
                  </Button>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- rail (thin) */

function CollapsedRail({
  groups,
  openTerminalMenu,
}: {
  groups: ProjectGroup[];
  openTerminalMenu: OpenTerminalMenu;
}) {
  const newSession = useStore((st) => st.newSession);
  return (
    <div className="flex flex-col items-center gap-2 py-3">
      {groups.map((g) => {
        const live = liveCount(g.sessions);
        return (
          <button
            key={g.project.path}
            type="button"
            title={`${g.project.name} — ${g.sessions.length} sessions, ${live} live`}
            onClick={() => void newSession(g.project.path)}
            onContextMenu={(event) => openTerminalMenu(g.project.path, event)}
            className={cn(
              "animate-slide-in relative grid size-9 place-items-center rounded-md border",
              "border-line bg-raised font-display text-[11px] font-semibold text-ink-mid",
              "transition-colors duration-150 hover:border-line-strong hover:text-ink",
            )}
          >
            {initials(g.project.name)}
            {live > 0 && (
              <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full border border-signal-dim bg-signal-wash font-mono text-[9px] text-signal tabular-nums">
                {live}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ sidebar */

export function Sidebar() {
  const state = useStore((st) => st.state);
  const openProjectPicker = useStore((st) => st.openProjectPicker);
  const openSettings = useStore((st) => st.openSettings);
  const newSession = useStore((st) => st.newSession);
  const openWorktreeDialog = useStore((st) => st.openWorktreeDialog);
  const moveProject = useStore((st) => st.moveProject);
  const compact = useCompactShell();
  const surface = useStore((st) => st.compactSurface);
  const closeCompactSurface = useStore((st) => st.closeCompactSurface);

  // Desktop collapse memory lives in the store: the toggle moved to App's
  // title bar (issue #60), and the compact sheet ignores it as before.
  const collapsed = useStore((st) => st.sidebarCollapsed);
  const sidebarWidth = useStore((st) => st.sidebarWidth);
  const inspectorWidth = useStore((st) => st.inspectorWidth);
  const inspectorOpen = useStore((st) => st.inspectorOpen);
  const setSidebarWidth = useStore((st) => st.setSidebarWidth);
  const viewportWidth = useViewportWidth();
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const [query, setQuery] = useState("");
  const [terminalMenu, setTerminalMenu] = useState<TerminalMenuRequest | null>(null);
  // The project whose compact actions sheet is open (issue #205), by path.
  // Sidebar-local UI state, like `terminalMenu` — never in the store.
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  // The project whose default-models sheet is open (issue #257), by path.
  const [defaultsFor, setDefaultsFor] = useState<string | null>(null);
  const [vsCodeAvailable, setVsCodeAvailable] = useState<boolean | null>(null);
  const availabilityMounted = useRef(false);
  const availabilityGeneration = useRef(0);
  const refreshAvailability = useCallback(async (): Promise<boolean> => {
    const generation = ++availabilityGeneration.current;
    let available = false;
    try {
      available = (await backend.getProjectOpenAvailability()).vsCode;
    } catch {
      // A failed discovery channel is equivalent to an unavailable optional
      // integration; Files remains a usable project-open destination.
    }
    if (availabilityMounted.current && generation === availabilityGeneration.current) {
      setVsCodeAvailable(available);
    }
    return available;
  }, []);

  useEffect(() => {
    availabilityMounted.current = true;
    void refreshAvailability();
    return () => {
      availabilityMounted.current = false;
      availabilityGeneration.current += 1;
    };
  }, [refreshAvailability]);
  const terminalMenuRef = useRef<HTMLDivElement>(null);
  const terminalMenuItemRef = useRef<HTMLButtonElement>(null);
  // issue #115 drag-and-drop reorder. `dragPath` is the project being dragged;
  // `dropIndicator`/`dropIndex` describe where the insertion line is drawn.
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<"before" | "after" | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // issue #120 keyboard reorder. Grips are registered by path so focus can be
  // restored to the moved project after the registry's broadcast re-renders the
  // list (React reorders by moving the DOM subtree, which blurs it).
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerGrip = useCallback((path: string, el: HTMLButtonElement | null) => {
    if (el === null) gripRefs.current.delete(path);
    else gripRefs.current.set(path, el);
  }, []);
  /** The keyboard move in flight, and the slot it must land in. */
  const pendingMove = useRef<{ path: string; name: string; index: number } | null>(null);
  /** Live-region text: the *result* of a reorder, never the request. */
  const [reorderNote, setReorderNote] = useState("");

  const openTerminalMenu: OpenTerminalMenu = (projectCwd, event) => {
    event.preventDefault();
    const currentTarget = event.currentTarget;
    const trigger =
      currentTarget instanceof HTMLButtonElement
        ? currentTarget
        : currentTarget.querySelector<HTMLButtonElement>("button");
    if (trigger === null) return;
    const keyboardPosition = event.clientX === 0 && event.clientY === 0;
    const rect = trigger.getBoundingClientRect();
    setTerminalMenu({
      projectCwd,
      x: keyboardPosition ? rect.left : event.clientX,
      y: keyboardPosition ? rect.bottom : event.clientY,
      trigger,
    });
  };

  useEffect(() => {
    if (terminalMenu === null) return;
    terminalMenuItemRef.current?.focus();
  }, [terminalMenu]);

  useEffect(() => {
    if (terminalMenu === null) return;
    const dismissOutside = (event: PointerEvent) => {
      const menu = terminalMenuRef.current;
      if (menu !== null && event.target instanceof Node && menu.contains(event.target)) return;
      setTerminalMenu(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTerminalMenu(null);
      terminalMenu.trigger.focus();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [terminalMenu]);

  const groups = state?.projects ?? null;
  const filtered = useMemo(() => applyFilter(groups ?? [], query), [groups, query]);
  // Paths in render order, used to resolve where a drop lands. Everything
  // recomputes from the live list, so a stale pointer resolves against the
  // current rows even when the filter changed mid-drag.
  const filteredPaths = useMemo(() => filtered.map((f) => f.group.project.path), [filtered]);
  // The move is only real once the broadcast has replaced `state`. Waiting for
  // the expected slot means a refused or coalesced move announces nothing, and
  // focus is restored on the render that actually moved the row.
  useEffect(() => {
    const pending = pendingMove.current;
    if (pending === null || filteredPaths[pending.index] !== pending.path) return;
    pendingMove.current = null;
    gripRefs.current.get(pending.path)?.focus();
    setReorderNote(
      `${pending.name} moved to position ${pending.index + 1} of ${filteredPaths.length}`,
    );
  }, [filteredPaths]);
  // A lone project can't be reordered; the compact sheet's touch surface gets
  // no drag affordances (issue #115 scoping). Filtering also disables the
  // reorder: positions resolve against the *visible* rows, so with neighbours
  // hidden the insertion line — or an Alt+Arrow step — would promise a place
  // the reorder cannot honour. One gate covers both input paths: the pointer
  // drag (issue #115) and the keyboard move (issue #120).
  const canReorder = !compact && query.trim() === "" && (groups?.length ?? 0) > 1;

  const reorderProject = (index: number, delta: -1 | 1): void => {
    const path = filteredPaths[index];
    const name = filtered[index]?.group.project.name;
    if (path === undefined || name === undefined) return;
    const target = index + delta;
    if (target < 0 || target >= filteredPaths.length) {
      setReorderNote(`${name} is already ${delta < 0 ? "first" : "last"}`);
      return;
    }
    // moveProject inserts *before* a sibling: one step up is "before the
    // predecessor"; one step down is "before the successor's successor", and
    // null past the end of the list.
    const beforePath = delta < 0 ? filteredPaths[index - 1]! : (filteredPaths[index + 2] ?? null);
    pendingMove.current = { path, name, index: target };
    void moveProject(path, beforePath);
  };

  // Derived from the live broadcast so a removed project can never leave a
  // stale sheet: a lookup miss renders a closed Sheet (issue #205).
  const actionsProject =
    (compact && actionsFor !== null
      ? groups?.find((g) => g.project.path === actionsFor)?.project
      : undefined) ?? null;

  const matchCount = filtered.reduce((n, f) => n + f.sessions.length, 0);
  const totalSessions = (groups ?? []).reduce((n, g) => n + g.sessions.length, 0);
  const totalLive = (groups ?? []).reduce((n, g) => n + liveCount(g.sessions), 0);
  const filtering = query.trim().length > 0;
  const displayedCollapsed = compact ? false : collapsed;
  const resolvedWidths = resolveDesktopPanelWidths({
    viewportWidth,
    sidebarWidth,
    inspectorWidth,
    sidebarCollapsed: displayedCollapsed,
    inspectorOpen,
  });
  const displayedSidebarWidth = previewWidth ?? resolvedWidths.sidebarWidth;

  const sidebar = (
    <aside
      className={cn(
        "ambient relative flex shrink-0 flex-col border-r border-line bg-sunken",
        !resizing && "transition-[width] duration-200 ease-out-quint",
        displayedCollapsed ? "w-14" : compact ? "h-full w-full border-r-0" : undefined,
      )}
      style={!compact && !displayedCollapsed ? { width: displayedSidebarWidth } : undefined}
    >
      {/* No compact header: the Sheet chrome already names the surface and
          carries the close control; add-project rides the filter row below.
          On desktop the controls live in the title bar (issue #60). */}

      {displayedCollapsed ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups && <CollapsedRail groups={groups} openTerminalMenu={openTerminalMenu} />}
        </div>
      ) : (
        <>
          {/* -------- filter -------- */}
          <div className="shrink-0 border-b border-line px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-raised px-2 focus-within:border-line-strong">
                <span className="shrink-0 text-ink-faint">
                  <IconSearch />
                </span>
                <input
                  type="text"
                  value={query}
                  spellCheck={false}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter sessions…"
                  aria-label="filter sessions"
                  className={cn(
                    "min-w-0 flex-1 bg-transparent py-1.5 text-xs text-ink",
                    "placeholder:font-mono placeholder:text-ink-faint focus:outline-none",
                  )}
                />
                {filtering && (
                  <>
                    <span className="shrink-0 font-mono text-[10px] text-ink-dim tabular-nums">
                      {matchCount}
                    </span>
                    <IconButton label="clear filter" onClick={() => setQuery("")} className="size-5">
                      <IconClose className="size-3.5" />
                    </IconButton>
                  </>
                )}
              </div>
              {compact && (
                <IconButton label="add project" onClick={() => { openProjectPicker(); closeCompactSurface(); }} className="size-9 rounded-md border border-line">
                  <IconPlus />
                </IconButton>
              )}
            </div>
          </div>

          {/* -------- project list -------- */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups === null && <SkeletonRows />}
            {groups !== null && groups.length === 0 && (
              <Empty
                title="No projects yet"
                hint="Point omp-ui at a repository and every session you start there shows up here."
                action={
                  <Button variant="solid" onClick={() => { openProjectPicker(); closeCompactSurface(); }}>
                    Add project
                  </Button>
                }
              />
            )}
            {groups !== null && groups.length > 0 && filtered.length === 0 && (
              <Empty
                title={`Nothing matches “${query.trim()}”`}
                hint="No session title or project name contains that."
                action={
                  <Button variant="ghost" onClick={() => setQuery("")}>
                    clear filter
                  </Button>
                }
              />
            )}
            {filtered.map((f, index) => {
              const path = f.group.project.path;

              const handleDragStart = (e: ReactDragEvent<HTMLElement>) => {
                e.dataTransfer?.setData("text/plain", path); // required for Firefox
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                setDragPath(path);
              };

              const handleDragOver = (e: ReactDragEvent<HTMLElement>) => {
                if (dragPath === null || dragPath === path) return; // own row: no indicator
                e.preventDefault(); // allow the drop
                const rect = e.currentTarget.getBoundingClientRect();
                const beforePath = beforePathOf(filteredPaths, index, e.clientY, rect.top, rect.bottom);
                // "before" → insertion above this project (top half); "after" →
                // below it (bottom half: before the next project, or the end of
                // the list). Recomputed fresh on drop, so this is display only.
                setDropIndicator(beforePath === path ? "before" : "after");
                setDropIndex(index);
              };

              const handleDrop = (e: ReactDragEvent<HTMLElement>) => {
                e.preventDefault();
                if (dragPath !== null && dragPath !== path) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const beforePath = beforePathOf(filteredPaths, index, e.clientY, rect.top, rect.bottom);
                  // Dropping just above itself resolves to "before itself" —
                  // the "leave it put" gesture. The registry treats it as a
                  // no-op regardless; skipping the call here also spares a
                  // pointless save and state broadcast.
                  if (beforePath !== dragPath) void moveProject(dragPath, beforePath);
                }
                setDragPath(null);
                setDropIndicator(null);
                setDropIndex(null);
              };

              const handleDragEnd = () => {
                setDragPath(null);
                setDropIndicator(null);
                setDropIndex(null);
              };

              return (
                <ProjectSection
                  key={path}
                  group={f.group}
                  projectHit={f.projectHit}
                  query={query}
                  openTerminalMenu={openTerminalMenu}
                  compact={compact}
                  vsCodeAvailable={vsCodeAvailable}
                  refreshAvailability={refreshAvailability}
                  onActivate={closeCompactSurface}
                  onOpenActions={() => setActionsFor(path)}
                  onOpenDefaults={() => setDefaultsFor(path)}
                  canReorder={canReorder}
                  registerGrip={registerGrip}
                  onReorder={(delta) => reorderProject(index, delta)}
                  dragging={dragPath === path}
                  dropIndicator={dropIndex === index ? dropIndicator : null}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onDragEnd={handleDragEnd}
                />
              );
            })}
          </div>
        </>
      )}
      {terminalMenu !== null &&
        createPortal(
          <div
            ref={terminalMenuRef}
            role="menu"
            className="fixed z-50"
            style={{ left: terminalMenu.x, top: terminalMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <Panel
              className={cn(
                "edge-lit animate-rise p-1",
                terminalMenu.x > window.innerWidth / 2 && "-translate-x-full",
                terminalMenu.y > window.innerHeight / 2 && "-translate-y-full",
              )}
            >
              <button
                ref={terminalMenuItemRef}
                type="button"
                role="menuitem"
                onClick={() => {
                  const projectCwd = terminalMenu.projectCwd;
                  setTerminalMenu(null);
                  void newSession(projectCwd, "pty");
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                New terminal session
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const projectCwd = terminalMenu.projectCwd;
                  setTerminalMenu(null);
                  openWorktreeDialog(projectCwd);
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                New worktree session…
              </button>
            </Panel>
          </div>,
          document.body,
        )}
      {/* Unmounted the moment compact flips false mid-open: useOverlay's
          cleanup releases the scroll lock and restores focus (issue #205). */}
      {compact && (
        <ProjectActionsSheet
          project={actionsProject}
          onClose={() => setActionsFor(null)}
          onActivate={closeCompactSurface}
          onOpenDefaults={actionsProject !== null ? () => setDefaultsFor(actionsProject.path) : undefined}
        />
      )}

      <ProjectDefaultsSheet
        project={defaultsFor === null ? null : state?.projects.find((g) => g.project.path === defaultsFor)?.project ?? null}
        onClose={() => setDefaultsFor(null)}
      />

      {/* -------- footer -------- */}
      <footer
        className={cn(
          "flex shrink-0 items-center border-t border-line text-[10px] text-ink-faint",
          displayedCollapsed ? "flex-col gap-1 px-2 py-2" : "gap-2 px-3 py-2",
        )}
      >
        {/* One gear in both layouts: settings must stay reachable collapsed. */}
        <IconButton label="settings" onClick={() => { openSettings(); closeCompactSurface(); }}>
          <IconGear />
        </IconButton>
        <span className="flex items-center gap-1.5">
          <Dot tone={totalLive > 0 ? "signal" : "neutral"} />
          <span className="font-mono tabular-nums">{totalLive}</span>
          {!displayedCollapsed && <span>live</span>}
        </span>
        {!displayedCollapsed && (
          <span className="ml-auto font-mono tabular-nums" title="sessions on record">
            {totalSessions} session{totalSessions === 1 ? "" : "s"}
          </span>
        )}
      </footer>
      {/* The reorder result, announced for keyboard and assistive-tech users
          (issue #120). Text only changes when a move lands, so a repeated
          boundary press is silent — correct: nothing changed. */}
      <p role="status" aria-live="polite" className="sr-only">
        {reorderNote}
      </p>
      {!compact && !displayedCollapsed && (
        <ResizeHandle
          label="resize project sidebar"
          edge="right"
          value={displayedSidebarWidth}
          min={SIDEBAR_MIN_WIDTH}
          max={resolvedWidths.sidebarAllowedMax}
          defaultValue={SIDEBAR_DEFAULT_WIDTH}
          onPreview={setPreviewWidth}
          onCommit={(width) => {
            setSidebarWidth(width);
            setPreviewWidth(null);
          }}
          onDraggingChange={setResizing}
        />
      )}
    </aside>
  );
  return compact ? (
    <Sheet open={surface === "sessions"} placement="left" label="projects and sessions" onClose={closeCompactSurface}>
      {sidebar}
    </Sheet>
  ) : sidebar;
}
