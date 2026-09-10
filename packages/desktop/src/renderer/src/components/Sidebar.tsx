import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ProjectGroup, ProjectOpenAvailability, RemoteInstanceSummary, SessionSummary } from "@omp-ui/core/types";
import { defaultNickname } from "@omp-ui/core/remote-instances";
import { desktop } from "../desktop";
import { projectKey } from "../lib/project-key";
import { remoteInstanceStatusKey, remoteInstanceStatusTone } from "../lib/remote-instance-status";
import { useDismissal } from "../lib/use-dismissal";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { useCompactShell, useViewportWidth } from "../lib/responsive";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  resolveDesktopPanelWidths,
} from "../lib/panel-layout";
import { PAGE } from "../lib/session-window";
import { arrangeSessionHandoffs } from "../lib/session-handoffs";
import { useListReorder, type ListReorderRow } from "../lib/use-list-reorder";
import { useStore } from "../store";
import { SessionRow } from "./SessionRow";
import { ProjectOpenControl } from "./ProjectOpenControl";
import { ProjectActionsSheet } from "./ProjectActionsSheet";
import { Button, Chevron, Chip, Dot, Empty, IconButton, IconClose, IconGrip, IconPlus, IconRefresh, IconTune, MiddleTruncate, Panel, ResizeHandle, Sheet } from "./ui";

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
  instanceId: string | null,
) => void;

interface TerminalMenuRequest {
  projectCwd: string;
  instanceId: string | null;
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

interface ProjectSectionProps {
  group: ProjectGroup;
  /** The joined remote instance this project lives on; null for this app's own registry (issue #416). */
  instanceId: string | null;
  /** Whether host-local opens (VS Code / Files / Terminal) make sense: only for this app's own projects. */
  hostLocalActions: boolean;
  /** The owning instance is not joined: the group dims and every action is inert. */
  disabled?: boolean;
  /** The project name matched the filter, so no tree is trimmed (issue #238). */
  projectHit: boolean;
  query: string;
  openTerminalMenu: OpenTerminalMenu;
  compact: boolean;
  onActivate: () => void;
  openAvailability: ProjectOpenAvailability | null;
  refreshAvailability: () => Promise<void>;
  onOpenActions?: () => void;
  /** The project row's drag/keyboard reorder wiring (issues #115/#120). */
  reorder: ListReorderRow;
  /** Live-region sink shared with the project reorder (issue #120). */
  onAnnounce?: (text: string) => void;
}

/* --------------------------------------------------------- project section */

function ProjectSection({
  group,
  instanceId,
  hostLocalActions,
  disabled = false,
  projectHit,
  query,
  openTerminalMenu,
  compact,
  openAvailability,
  refreshAvailability,
  onActivate,
  onOpenActions,
  reorder,
  onAnnounce,
}: ProjectSectionProps) {
  const t = useT();
  const newSession = useStore((st) => st.newSession);
  const removeProject = useStore((st) => st.removeProject);
  const moveSession = useStore((st) => st.moveSession);
  const focusedTabId = useStore((st) => st.focusedTabByProject[projectKey(instanceId, group.project.path)]);
  const openProjectSettings = useStore((st) => st.openProjectSettings);
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


  // Issues #115/#120 machinery applied to session rows (#274). Trees reorder
  // as units: grips render on depth-0 rows only, and drops resolve against
  // tree roots.
  const canReorderSessions = !compact && !disabled && query.trim() === "" && group.sessions.length > 1;

  // Roots in visible order — the units a session reorder moves between.
  const roots = useMemo(() => entries.filter((e) => e.depth === 0), [entries]);
  const rootTabIds = useMemo(() => roots.map((r) => r.session.tabId), [roots]);

  const sessionReorder = useListReorder({
    rows: entries,
    rootOf: (entry) => entry.treeId,
    keys: rootTabIds,
    nameOf: (tabId) => roots.find((r) => r.session.tabId === tabId)?.session.title,
    move: moveSession,
    enabled: canReorderSessions,
    announce: (text) => onAnnounce?.(text),
  });

  const { project } = group;
  // Chips describe the project itself, so they count raw sessions — filtering
  // and tree retention only change which rows render below.
  const live = liveCount(group.sessions);

  return (
    <section
      className={cn(
        "pb-1",
        disabled && "opacity-60",
        reorder.dragging && "opacity-60",
        // The insertion line uses neutral emphasis — ADR-0004 reserves the
        // signal accent for liveness/success.
        reorder.dropIndicator === "before" && "border-t-2 border-line-strong",
        reorder.dropIndicator === "after" && "border-b-2 border-line-strong",
      )}
      data-drop-indicator={reorder.dropIndicator ?? undefined}
      onDragOver={reorder.onDragOver}
      onDrop={reorder.onDrop}
    >
      <div className="sticky top-0 z-10 bg-sunken/95 px-2 pt-2 pb-1 backdrop-blur">
        <div
          // No gap in the non-compact layout: the reveals bring their own margin,
          // so the name owns the full row width at rest.
          className={cn("group/proj flex items-start", compact && "gap-1.5", reorder.draggable && "cursor-grab active:cursor-grabbing")}
          draggable={reorder.draggable}
          onDragStart={reorder.onDragStart}
          onDragEnd={reorder.onDragEnd}
        >
          {reorder.draggable && (
            <span className="proj-reveal proj-reveal-r mt-px shrink-0 self-center overflow-hidden max-w-0 transition-all duration-200 group-hover/proj:mr-1.5 group-hover/proj:max-w-11 focus-within:mr-1.5 focus-within:max-w-11">
              <button
                type="button"
                ref={reorder.registerGrip}
                aria-label={t("sidebar.project.reorder", { name: project.name })}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title={t("sidebar.project.reorderTitle", { name: project.name })}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  // Ours: neither scroll the list nor wake Electron's
                  // auto-hidden menu bar (main/index.ts: autoHideMenuBar).
                  e.preventDefault();
                  reorder.onReorder(e.key === "ArrowUp" ? -1 : 1);
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
                <Chip mono title={t("sidebar.project.sessions", { n: group.sessions.length })}>
                  {group.sessions.length}
                </Chip>
                {live > 0 && (
                  <Chip mono tone="signal" title={t("sidebar.project.live", { n: live })}>
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
                  <Chip mono title={t("sidebar.project.sessions", { n: group.sessions.length })}>
                    {group.sessions.length}
                  </Chip>
                  {live > 0 && (
                    <Chip mono tone="signal" title={t("sidebar.project.live", { n: live })}>
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
              label={t("sidebar.project.actions", { name: project.name })}
              disabled={disabled}
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
              {hostLocalActions && (
                <ProjectOpenControl
                  project={project}
                  availability={openAvailability}
                  refreshAvailability={refreshAvailability}
                />
              )}
              <IconButton label={t("sidebar.project.settings", { name: project.name })} disabled={disabled} onClick={() => openProjectSettings(project.path, instanceId)}>
                <IconTune />
              </IconButton>
              <span onContextMenu={(event) => { if (!disabled) openTerminalMenu(project.path, event, instanceId); }}>
                <IconButton label={t("sidebar.project.newSession")} disabled={disabled} onClick={() => { void newSession(project.path, undefined, instanceId); onActivate(); }}>
                  <IconPlus />
                </IconButton>
              </span>
              <IconButton
                label={t("sidebar.project.newSessionOptions", { name: project.name })}
                disabled={disabled}
                onClick={(event) => openTerminalMenu(project.path, event, instanceId)}
              >
                <Chevron open className="size-2.5" />
              </IconButton>
              <IconButton label={t("sidebar.project.remove")} tone="rose" disabled={disabled} onClick={() => void removeProject(project.path, instanceId)}>
                <IconClose className="size-3.5" />
              </IconButton>
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="space-y-px px-1.5">
          {entries.map((entry, index) => {
            const isRoot = entry.depth === 0;
            const reorderable = canReorderSessions && isRoot;
            const row = sessionReorder.bindRow(entry.treeId, index);
            return (
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
                // the signal accent (ADR-0004, issue #238). The stroke is a
                // 2px border-line — one step above line-soft — so the
                // handoff reads on the sunken sidebar (issue #310).
                <span
                  aria-hidden
                  data-handoff-connector
                  className={cn(
                    "pointer-events-none absolute top-0 h-1/2 w-2 rounded-bl border-b-2 border-l-2 border-line",
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
                canReorder={reorderable}
                dragging={row.dragging}
                dropIndicator={row.dropIndicator}
                registerGrip={reorderable ? row.registerGrip : undefined}
                onReorder={reorderable ? row.onReorder : undefined}
                onDragStart={row.onDragStart}
                onDragOver={(e) => {
                  if (sessionReorder.dragKey === null) return; // project drag: bubble to the section
                  // Session drags only; never let a row drop bubble to the
                  // section's project-drop handlers.
                  e.stopPropagation();
                  row.onDragOver(e);
                }}
                onDrop={(e) => {
                  if (sessionReorder.dragKey === null) return; // project drag: bubble to the section
                  e.stopPropagation();
                  row.onDrop(e);
                }}
                onDragEnd={row.onDragEnd}
              />
            </div>
            );
          })}
          {total === 0 && (
            <p className="px-3 py-1 text-[11px] text-ink-faint italic">{t("sidebar.project.noSessions")}</p>
          )}
          {total > PAGE && (
            <div className="flex items-center gap-2 px-3 pt-1 pb-0.5">
              <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                {t("sidebar.project.showing", { shown, total })}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {visible > PAGE && shown > PAGE && (
                  <Button size="xs" variant="ghost" onClick={() => setVisible(PAGE)}>
                    {t("sidebar.project.showLess")}
                  </Button>
                )}
                {remaining > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setVisible(shown + PAGE)}
                    title={t(remaining === 1 ? "sidebar.project.moreSession" : "sidebar.project.moreSessions", { remaining, name: project.name })}
                  >
                    {t("sidebar.project.showMore", { n: Math.min(PAGE, remaining) })}
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

/* ------------------------------------------------------- remote instance */

/**
 * One joined omp-ui app's registry as a sidebar group (issue #416): a header
 * naming the instance and its connection status, then that host's projects as
 * ordinary ProjectSections addressed to it. Every action inside runs on that
 * host; host-local opens are never offered. While the instance is not joined
 * the last-known projects stay visible but dimmed and inert — the sessions are
 * still running over there, this app just cannot reach them right now.
 */
function RemoteInstanceSection({
  instance,
  query,
  compact,
  openTerminalMenu,
  onActivate,
  onOpenActions,
  refreshAvailability,
  onAnnounce,
}: {
  instance: RemoteInstanceSummary;
  query: string;
  compact: boolean;
  openTerminalMenu: OpenTerminalMenu;
  onActivate: () => void;
  onOpenActions: (path: string) => void;
  refreshAvailability: () => Promise<void>;
  onAnnounce: (text: string) => void;
}) {
  const t = useT();
  const openProjectPicker = useStore((st) => st.openProjectPicker);
  const openSettings = useStore((st) => st.openSettings);
  const reconnectRemoteInstance = useStore((st) => st.reconnectRemoteInstance);
  const moveProject = useStore((st) => st.moveProject);
  const [open, setOpen] = useState(true);
  const joined = instance.status === "joined";

  const filtered = useMemo(() => applyFilter(instance.projects, query), [instance.projects, query]);
  const filteredPaths = useMemo(() => filtered.map((f) => f.group.project.path), [filtered]);
  const canReorder = joined && !compact && query.trim() === "" && instance.projects.length > 1;
  const reorder = useListReorder({
    rows: filtered,
    rootOf: (f) => f.group.project.path,
    keys: filteredPaths,
    nameOf: (path) => filtered.find((f) => f.group.project.path === path)?.group.project.name,
    move: (path, before) => moveProject(path, before, instance.id),
    enabled: canReorder,
    announce: onAnnounce,
  });

  // A filter that matches nothing on this host hides the whole group: the
  // local list's own "no matches" state already says the query missed.
  if (query.trim() !== "" && filtered.length === 0) return null;

  return (
    <section data-remote-instance={instance.id} className="border-t border-line pb-1">
      <div className="sticky top-0 z-10 bg-sunken/95 px-2 pt-2 pb-1 backdrop-blur">
        <div className="group/inst flex items-start gap-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={t("remoteinstances.action.toggle", { nickname: instance.nickname })}
            onClick={() => setOpen(!open)}
            title={instance.url}
            className="mt-px flex min-w-0 flex-1 items-start gap-1.5 text-left"
          >
            <span className="mt-1 shrink-0">
              <Chevron open={open} className="text-ink-dim" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <Dot
                  tone={remoteInstanceStatusTone(instance.status)}
                  pulse={instance.status === "connecting"}
                  title={t(remoteInstanceStatusKey(instance.status))}
                />
                <MiddleTruncate
                  text={instance.nickname}
                  className="min-w-0 flex-1 font-display text-xs font-semibold text-ink"
                />
              </span>
              {(!joined || defaultNickname(instance.url) !== instance.nickname) && (
                <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-faint">
                  {joined
                    ? instance.url
                    : `${t(remoteInstanceStatusKey(instance.status))}${instance.error !== null ? ` — ${instance.error}` : ""}`}
                </span>
              )}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {joined && (
              <IconButton
                label={t("remoteinstances.action.registerProject", { nickname: instance.nickname })}
                onClick={() => { openProjectPicker(instance.id); onActivate(); }}
              >
                <IconPlus />
              </IconButton>
            )}
            {!joined && instance.status !== "connecting" && (
              <IconButton
                label={t("remoteinstances.action.reconnect")}
                onClick={() => void reconnectRemoteInstance(instance.id)}
              >
                <IconRefresh />
              </IconButton>
            )}
            <IconButton
              label={t("remoteinstances.action.settings")}
              onClick={() => { openSettings("remote-instances"); onActivate(); }}
            >
              <IconTune />
            </IconButton>
          </div>
        </div>
      </div>
      {open && instance.projects.length === 0 && joined && (
        <Empty
          title={t("remoteinstances.empty.projects", { nickname: instance.nickname })}
          action={
            <Button variant="ghost" onClick={() => { openProjectPicker(instance.id); onActivate(); }}>
              {t("remoteinstances.action.registerProject", { nickname: instance.nickname })}
            </Button>
          }
        />
      )}
      {open &&
        filtered.map((f, index) => {
          const path = f.group.project.path;
          return (
            <ProjectSection
              key={path}
              group={f.group}
              instanceId={instance.id}
              hostLocalActions={false}
              disabled={!joined}
              projectHit={f.projectHit}
              query={query}
              openTerminalMenu={openTerminalMenu}
              compact={compact}
              openAvailability={null}
              refreshAvailability={refreshAvailability}
              onActivate={onActivate}
              onOpenActions={() => onOpenActions(path)}
              reorder={reorder.bindRow(path, index)}
              onAnnounce={onAnnounce}
            />
          );
        })}
    </section>
  );
}

/* -------------------------------------------------------------- rail (thin) */

interface RailEntry {
  group: ProjectGroup;
  instanceId: string | null;
  /** The owning instance's nickname; null for this app's own projects. */
  nickname: string | null;
  disabled: boolean;
}

function CollapsedRail({
  entries,
  openTerminalMenu,
}: {
  entries: RailEntry[];
  openTerminalMenu: OpenTerminalMenu;
}) {
  const t = useT();
  const newSession = useStore((st) => st.newSession);
  return (
    <div className="flex flex-col items-center gap-2 py-3">
      {entries.map(({ group: g, instanceId, nickname, disabled }) => {
        const live = liveCount(g.sessions);
        const name = nickname === null ? g.project.name : `${nickname} · ${g.project.name}`;
        return (
          <button
            key={projectKey(instanceId, g.project.path)}
            type="button"
            disabled={disabled}
            title={t("sidebar.project.railSummary", { name, sessions: g.sessions.length, live })}
            onClick={() => void newSession(g.project.path, undefined, instanceId)}
            onContextMenu={(event) => { if (!disabled) openTerminalMenu(g.project.path, event, instanceId); }}
            className={cn(
              "animate-slide-in relative grid size-9 place-items-center rounded-md border",
              "border-line bg-raised font-display text-[11px] font-semibold text-ink-mid",
              "transition-colors duration-150 hover:border-line-strong hover:text-ink",
              disabled && "opacity-60",
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
  const t = useT();
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
  // The project whose compact actions sheet is open (issue #205), by
  // projectKey so a same-path project on a remote instance is distinct (#416).
  // Sidebar-local UI state, like `terminalMenu` — never in the store.
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [openAvailability, setOpenAvailability] = useState<ProjectOpenAvailability | null>(null);
  const availabilityMounted = useRef(false);
  const availabilityGeneration = useRef(0);
  const refreshAvailability = useCallback(async (): Promise<void> => {
    if (desktop === null) return;
    const generation = ++availabilityGeneration.current;
    let available: ProjectOpenAvailability = { vsCode: false, terminal: false };
    try {
      available = await desktop.getProjectOpenAvailability();
    } catch {
      // A failed discovery channel is equivalent to unavailable optional
      // integrations; Files remains a usable project-open destination.
    }
    if (availabilityMounted.current && generation === availabilityGeneration.current) {
      setOpenAvailability(available);
    }
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
  /** Live-region text: the *result* of a reorder, never the request. */
  const [reorderNote, setReorderNote] = useState("");

  const openTerminalMenu: OpenTerminalMenu = (projectCwd, event, instanceId) => {
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
      instanceId,
      x: keyboardPosition ? rect.left : event.clientX,
      y: keyboardPosition ? rect.bottom : event.clientY,
      trigger,
    });
  };

  useEffect(() => {
    if (terminalMenu === null) return;
    terminalMenuItemRef.current?.focus();
  }, [terminalMenu]);

  useDismissal({
    open: terminalMenu !== null,
    refs: terminalMenuRef,
    onClose: () => setTerminalMenu(null),
    onEscape: () => setTerminalMenu(null),
    restoreFocus: () => {
      const m = terminalMenu;
      if (m !== null) m.trigger.focus();
    },
  });

  const groups = state?.projects ?? null;
  const remoteInstances = state?.remoteInstances ?? null;
  const filtered = useMemo(() => applyFilter(groups ?? [], query), [groups, query]);
  // Paths in render order, used to resolve where a drop lands. Everything
  // recomputes from the live list, so a stale pointer resolves against the
  // current rows even when the filter changed mid-drag.
  const filteredPaths = useMemo(() => filtered.map((f) => f.group.project.path), [filtered]);

  // A lone project can't be reordered; the compact sheet's touch surface gets
  // no drag affordances (issue #115 scoping). Filtering also disables the
  // reorder: positions resolve against the *visible* rows, so with neighbours
  // hidden the insertion line — or an Alt+Arrow step — would promise a place
  // the reorder cannot honour. One gate covers both input paths: the pointer
  // drag (issue #115) and the keyboard move (issue #120).
  const canReorder = !compact && query.trim() === "" && (groups?.length ?? 0) > 1;

  const reorder = useListReorder({
    rows: filtered,
    rootOf: (f) => f.group.project.path,
    keys: filteredPaths,
    nameOf: (path) => filtered.find((f) => f.group.project.path === path)?.group.project.name,
    move: moveProject,
    enabled: canReorder,
    announce: setReorderNote,
  });

  // Derived from the live broadcast so a removed project can never leave a
  // stale sheet: a lookup miss renders a closed Sheet (issue #205). The key
  // resolves across the local list and every remote instance's list (#416).
  const actions = useMemo(() => {
    if (!compact || actionsFor === null) return null;
    const local = groups?.find((g) => projectKey(null, g.project.path) === actionsFor);
    if (local !== undefined) return { project: local.project, instanceId: null };
    for (const instance of remoteInstances ?? []) {
      const hit = instance.projects.find((g) => projectKey(instance.id, g.project.path) === actionsFor);
      if (hit !== undefined) return { project: hit.project, instanceId: instance.id };
    }
    return null;
  }, [compact, actionsFor, groups, remoteInstances]);

  // Counts and the rail cover every project this app can see, local or joined.
  const railEntries = useMemo<RailEntry[]>(() => {
    const out: RailEntry[] = (groups ?? []).map((group) => ({ group, instanceId: null, nickname: null, disabled: false }));
    for (const instance of remoteInstances ?? []) {
      for (const group of instance.projects) {
        out.push({ group, instanceId: instance.id, nickname: instance.nickname, disabled: instance.status !== "joined" });
      }
    }
    return out;
  }, [groups, remoteInstances]);
  const matchCount = filtered.reduce((n, f) => n + f.sessions.length, 0);
  const totalSessions = railEntries.reduce((n, e) => n + e.group.sessions.length, 0);
  const totalLive = railEntries.reduce((n, e) => n + liveCount(e.group.sessions), 0);
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
        "ambient relative flex shrink-0 flex-col border-r border-line glass-sunken",
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
          {groups && <CollapsedRail entries={railEntries} openTerminalMenu={openTerminalMenu} />}
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
                  placeholder={t("sidebar.filter.placeholder")}
                  aria-label={t("sidebar.filter.label")}
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
                    <IconButton label={t("sidebar.filter.clear")} onClick={() => setQuery("")} className="size-5">
                      <IconClose className="size-3.5" />
                    </IconButton>
                  </>
                )}
              </div>
              {compact && (
                <IconButton label={t("sidebar.project.add")} onClick={() => { openProjectPicker(); closeCompactSurface(); }} className="size-9 rounded-md border border-line">
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
                title={t("sidebar.empty.noProjects")}
                hint={t("sidebar.empty.noProjectsHint")}
                action={
                  <Button variant="solid" onClick={() => { openProjectPicker(); closeCompactSurface(); }}>
                    {t("sidebar.project.addButton")}
                  </Button>
                }
              />
            )}
            {groups !== null && groups.length > 0 && filtered.length === 0 && (
              <Empty
                title={t("sidebar.empty.noMatches", { query: query.trim() })}
                hint={t("sidebar.empty.noMatchesHint")}
                action={
                  <Button variant="ghost" onClick={() => setQuery("")}>
                    {t("sidebar.filter.clear")}
                  </Button>
                }
              />
            )}
            {filtered.map((f, index) => {
              const path = f.group.project.path;
              return (
                <ProjectSection
                  key={path}
                  group={f.group}
                  instanceId={null}
                  hostLocalActions={desktop !== null}
                  projectHit={f.projectHit}
                  query={query}
                  openTerminalMenu={openTerminalMenu}
                  compact={compact}
                  openAvailability={openAvailability}
                  refreshAvailability={refreshAvailability}
                  onActivate={closeCompactSurface}
                  onOpenActions={() => setActionsFor(projectKey(null, path))}
                  reorder={reorder.bindRow(path, index)}
                  onAnnounce={setReorderNote}
                />
              );
            })}
            {/* Joined remote instances (issue #416), after this app's own
                projects. `self` is this app seen through its own URL — no
                group, nothing to show twice. */}
            {(remoteInstances ?? [])
              .filter((instance) => instance.status !== "self")
              .map((instance) => (
                <RemoteInstanceSection
                  key={instance.id}
                  instance={instance}
                  query={query}
                  compact={compact}
                  openTerminalMenu={openTerminalMenu}
                  onActivate={closeCompactSurface}
                  onOpenActions={(path) => setActionsFor(projectKey(instance.id, path))}
                  refreshAvailability={refreshAvailability}
                  onAnnounce={setReorderNote}
                />
              ))}
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
                  const { projectCwd, instanceId } = terminalMenu;
                  setTerminalMenu(null);
                  void newSession(projectCwd, "pty", instanceId);
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                {t("project.actions.newTerminal")}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const { projectCwd, instanceId } = terminalMenu;
                  setTerminalMenu(null);
                  openWorktreeDialog(projectCwd, instanceId);
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                {t("project.actions.newWorktree")}
              </button>
            </Panel>
          </div>,
          document.body,
        )}
      {/* Unmounted the moment compact flips false mid-open: useOverlay's
          cleanup releases the scroll lock and restores focus (issue #205). */}
      {compact && (
        <ProjectActionsSheet
          project={actions?.project ?? null}
          instanceId={actions?.instanceId ?? null}
          onClose={() => setActionsFor(null)}
          onActivate={closeCompactSurface}
        />
      )}

      {/* -------- footer -------- */}
      <footer
        className={cn(
          "flex shrink-0 items-center border-t border-line text-[10px] text-ink-faint",
          displayedCollapsed ? "flex-col gap-1 px-2 py-2" : "gap-2 px-3 py-2",
        )}
      >
        {/* One gear in both layouts: settings must stay reachable collapsed. */}
        <IconButton label={t("sidebar.footer.settings")} onClick={() => { openSettings(); closeCompactSurface(); }}>
          <IconGear />
        </IconButton>
        <span className="flex items-center gap-1.5">
          <Dot tone={totalLive > 0 ? "signal" : "neutral"} />
          <span className="font-mono tabular-nums">{totalLive}</span>
          {!displayedCollapsed && <span>{t("sidebar.footer.live")}</span>}
        </span>
        {!displayedCollapsed && (
          <span className="ml-auto font-mono tabular-nums" title={t("sidebar.footer.sessionsOnRecord")}>
            {t(totalSessions === 1 ? "sidebar.footer.session" : "sidebar.footer.sessions", { n: totalSessions })}
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
          label={t("sidebar.footer.resize")}
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
    <Sheet open={surface === "sessions"} placement="left" label={t("app.compact.projectsAndSessions")} onClose={closeCompactSurface}>
      {sidebar}
    </Sheet>
  ) : sidebar;
}
