import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { ProjectGroup, ProjectOpenAvailability, RemoteInstanceSummary, SessionSummary, SidebarGroup } from "@omp-ui/core/types";
import { defaultNickname } from "@omp-ui/core/remote-instances";
import { backend } from "../backend";
import { initials } from "../lib/initials";
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
import { supportsSessionMigrate } from "../lib/session-migrate";
import { useListReorder, type ListReorderRow } from "../lib/use-list-reorder";
import { useStore } from "../store";
import { SessionRow } from "./SessionRow";
import { useBrowserPaneSplitOpen } from "./browser-pane/BrowserPaneSplit";
import { ProjectOpenControl } from "./ProjectOpenControl";
import { ProjectActionsSheet } from "./ProjectActionsSheet";
import { ChatList, SkeletonRows, filterChats, type OpenSessionMenu } from "./ChatList";
import { setSidebarMode, useSidebarMode } from "../lib/sidebar-mode";
import { Button, Chevron, ChoiceCapsule, Chip, Dot, Empty, IconButton, IconClose, IconFlask, IconFleet, IconGrip, IconGroup, IconPencil, IconPlus, IconRefresh, IconSearch, IconTune, MiddleTruncate, Panel, ResizeHandle, Sheet } from "./ui";

/* ------------------------------------------------------------------- icons */

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

/* ---------------------------------------------------------------- helpers */

function liveCount(sessions: SessionSummary[]): number {
  let n = 0;
  for (const s of sessions) if (s.live === "live") n += 1;
  return n;
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
interface SessionMenuRequest {
  tabId: string;
  migrate: boolean;
  ask: boolean;
  x: number;
  y: number;
  trigger: HTMLElement;
}

/** A row survives the filter when its own title (or its saved plan title) matches. */
function sessionMatches(s: SessionSummary, q: string): boolean {
  return (
    s.title.toLowerCase().includes(q) ||
    (s.planImplementationSource?.planTitle.toLowerCase().includes(q) ?? false)
  );
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
    const sessions = projectHit ? group.sessions : group.sessions.filter((s) => sessionMatches(s, q));
    if (projectHit || sessions.length > 0) out.push({ group, sessions, projectHit });
  }
  return out;
}

/**
 * The dataTransfer type a local project drag carries besides text/plain, so a
 * group header can tell a project drag from text or a remote project's drag
 * (issue #745).
 */
const PROJECT_DRAG_TYPE = "application/x-omp-ui-project";

/** Stable stand-in while the state has not arrived, so memos keep identity. */
const EMPTY_GROUPS: readonly SidebarGroup[] = Object.freeze([]);

interface Segments<T> {
  ungrouped: T[];
  grouped: Array<{ group: SidebarGroup; rows: T[] }>;
}

/** Partitions rows (already in registry order) by group membership; group order = sidebarGroups order. */
function segmentByGroup<T>(
  rows: readonly T[],
  pathOf: (row: T) => string,
  groups: readonly SidebarGroup[],
): Segments<T> {
  const grouped = groups.map((group) => ({ group, rows: [] as T[] }));
  const slotByPath = new Map<string, T[]>();
  for (const segment of grouped) {
    for (const path of segment.group.projectPaths) slotByPath.set(path, segment.rows);
  }
  const ungrouped: T[] = [];
  for (const row of rows) (slotByPath.get(pathOf(row)) ?? ungrouped).push(row);
  return { ungrouped, grouped };
}

/**
 * A group header (or the Ungrouped header) as a drop target for a local
 * project drag (issue #745): dropping files the project into `groupId`
 * (null = ungrouped), landing last. Only drags carrying PROJECT_DRAG_TYPE are
 * accepted; a drop of the segment's own member is a no-op. `onDrop` returns
 * false when the drag is not a project so the caller can hand the event to the
 * group reorder.
 */
function useProjectDropTarget(groupId: string | null, memberPaths: readonly string[], enabled: boolean) {
  const setProjectSidebarGroup = useStore((st) => st.setProjectSidebarGroup);
  const [hover, setHover] = useState(false);
  const carriesProject = (e: ReactDragEvent<HTMLElement>): boolean =>
    enabled && e.dataTransfer?.types?.includes(PROJECT_DRAG_TYPE) === true;
  return {
    hover,
    onDragOver: (e: ReactDragEvent<HTMLElement>): void => {
      if (!carriesProject(e)) return;
      e.preventDefault(); // allow the drop
      setHover(true);
    },
    onDragLeave: (): void => setHover(false),
    onDrop: (e: ReactDragEvent<HTMLElement>): boolean => {
      if (!carriesProject(e)) return false;
      const path = e.dataTransfer.getData(PROJECT_DRAG_TYPE);
      if (path !== "" && !memberPaths.includes(path)) void setProjectSidebarGroup(path, groupId);
      setHover(false);
      e.preventDefault();
      return true;
    },
  };
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
  /** Unified project view (issue #903): other machines' checkouts of this
   *  repository, folded into this node's tree. Non-empty only under All hosts
   *  scope with no active filter; remote rows then carry a machine chip. */
  extra?: CheckoutBlock[];
  query: string;
  openTerminalMenu: OpenTerminalMenu;
  compact: boolean;
  onActivate: () => void;
  openAvailability: ProjectOpenAvailability | null;
  openSessionMenu: OpenSessionMenu;
  refreshAvailability: () => Promise<void>;
  onOpenActions?: () => void;
  /** The project row's drag/keyboard reorder wiring (issues #115/#120). */
  reorder: ListReorderRow;
  /** Live-region sink shared with the project reorder (issue #120). */
  onAnnounce?: (text: string) => void;
}

/* ---------------------------------------------------- unified project view */

/**
 * One machine's checkout inside a unified node (issue #903, ADR-0063): the
 * checkout's own group, the owning instance (null = this app), the owner's
 * nickname for session-row chips, and whether its actions are inert because
 * the instance is not joined.
 */
interface CheckoutBlock {
  group: ProjectGroup;
  instanceId: string | null;
  /** The owning instance's nickname; null for this app's own registry. */
  nickname: string | null;
  disabled: boolean;
}

/**
 * Groups joined instances' keyed projects by repository key — ADR-0061's
 * `host/owner/repo` from the web remote — for the all-hosts lens (issue #903).
 * A null key never merges: a checkout without a web remote stays in its own
 * per-instance section, and path is never a match key (ADR-0063). Only
 * repositories this app also has registered fold into the local node; every
 * other project renders exactly as the per-host lens does today.
 */
function indexRemoteCheckouts(instances: RemoteInstanceSummary[] | null): Map<string, CheckoutBlock[]> {
  const byKey = new Map<string, CheckoutBlock[]>();
  for (const instance of instances ?? []) {
    if (instance.status === "self") continue;
    for (const group of instance.projects) {
      const key = group.project.repositoryKey;
      // A null key never merges across machines: unkeyed remote checkouts
      // index under their own composite id and simply never fold.
      if (key === null) continue;
      const block: CheckoutBlock = {
        group,
        instanceId: instance.id,
        nickname: instance.nickname,
        disabled: instance.status !== "joined",
      };
      const list = byKey.get(key);
      if (list === undefined) byKey.set(key, [block]);
      else list.push(block);
    }
  }
  return byKey;
}
/* --------------------------------------------------------- project section */

function ProjectSection({
  group,
  instanceId,
  hostLocalActions,
  disabled = false,
  projectHit,
  extra,
  query,
  openTerminalMenu,
  openSessionMenu,
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
  const openLab = useStore((st) => st.openLab);
  // Issue #888: gate the row context menu on the local binary's floor.
  const ompInstalledVersion = useStore((st) => st.ompUpdate.installedVersion);
  const openSidebarGroupDialog = useStore((st) => st.openSidebarGroupDialog);
  const experimentsEnabled = useStore((st) => st.state?.experimentsEnabled === true);
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
  // Unified project view (issue #903, ADR-0063): the local checkout anchors
  // this node; other machines' checkouts of the same repository (matched by
  // the web-remote key, never by path) fold into the same list. Without
  // `extra` every value below equals today's single-machine rendering.
  const blocks: CheckoutBlock[] | null =
    extra !== undefined && extra.length > 0
      ? [{ group, instanceId, nickname: null, disabled }, ...extra]
      : null;
  const merged = blocks !== null;
  const allSessions = blocks === null ? group.sessions : blocks.flatMap((b) => b.group.sessions);

  // Pagination follows this project's remembered focus, not the global active
  // tab: after another project takes global focus (or after an update restore)
  // each project's list still shows the session last focused in it. The
  // arrangement also widens the page so a handoff tree is never split, and
  // resolves each row's plan source (issue #238).
  const { entries, shown, remaining, total } = arrangeSessionHandoffs(
    allSessions,
    query,
    projectHit,
    visible,
    focusedTabId,
  );


  // Issues #115/#120 machinery applied to session rows (#274). Trees reorder
  // as units: grips render on depth-0 rows only, and drops resolve against
  // tree roots.
  const canReorderSessions = !compact && !disabled && query.trim() === "" && allSessions.length > 1;

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
  const live = liveCount(allSessions);
  // A folded checkout's display name: its nickname, or this app's own machine.
  const machineOf = (b: CheckoutBlock): string => b.nickname ?? t("dialog.newsession.machineLocal");
  // Unified node (issue #903): one node spans machines, so the header names
  // the repository instead of this machine's directory — the last two
  // segments of the `host/owner/repo` web-remote key. A key too short to
  // split keeps the project name (defensive; the key is free-form).
  const repoName = (() => {
    if (!merged || project.repositoryKey === null) return null;
    const parts = project.repositoryKey.split("/");
    return parts.length >= 2 ? parts.slice(-2).join("/") : null;
  })();
  const headerName = repoName ?? project.name;

  // Unified view (issue #903): which checkout each row came from, so
  // chips and machine labels follow the session's owner; a divider
  // introduces every folded checkout in the rendered page.
  const checkouts = (() => {
    if (!merged || blocks === null) return null;
    const rowToBlock = new Map<string, CheckoutBlock>();
    for (const b of blocks) for (const s of b.group.sessions) rowToBlock.set(s.tabId, b);
    const dividerBefore: boolean[] = [];
    let prev: CheckoutBlock | null = null;
    for (const e of entries) {
      const b = rowToBlock.get(e.session.tabId) ?? null;
      dividerBefore.push(prev !== null && b !== null && b !== prev);
      prev = b;
    }
    return { rowToBlock, dividerBefore };
  })();

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
      <div className="sticky top-0 z-10 bg-sunken/95 px-2 pt-2 pb-1 backdrop-glass">
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
            title={merged ? (project.repositoryKey ?? project.path) : project.path}
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
                  text={headerName}
                  className="min-w-0 flex-1 font-display text-xs font-semibold text-ink"
                />
                <Chip mono title={t("sidebar.project.sessions", { n: allSessions.length })}>
                  {allSessions.length}
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
                  text={headerName}
                  className="font-display text-xs font-semibold text-ink"
                />
                <span className="mt-0.5 flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
                    {project.path}
                  </span>
                  <Chip mono title={t("sidebar.project.sessions", { n: allSessions.length })}>
                    {allSessions.length}
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
              {experimentsEnabled && (
                <IconButton label={t("sidebar.project.lab", { name: project.name })} disabled={disabled} onClick={() => openLab(project.path, instanceId)}>
                  <IconFlask />
                </IconButton>
              )}
              {instanceId === null && (
                <IconButton
                  label={t("sidebar.project.moveToGroup", { name: project.name })}
                  onClick={() => openSidebarGroupDialog({ kind: "move", projectPath: project.path })}
                >
                  <IconGroup />
                </IconButton>
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
            // The checkout this row came from; null for the anchor's machine.
            const block = checkouts?.rowToBlock.get(entry.session.tabId) ?? null;
            return (
              <Fragment key={entry.session.tabId}>
                {checkouts !== null && checkouts.dividerBefore[index] === true && block !== null && (
                  <div
                    title={t("sidebar.hosts.machineLabel", {
                      machine: machineOf(block),
                      path: block.group.project.path,
                    })}
                    className="flex items-center gap-1.5 px-3 pb-0.5 pt-1 text-[10px] text-ink-faint"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {t("sidebar.unified.checkout", { machine: machineOf(block) })}
                    </span>
                    <IconButton
                      label={t("sidebar.unified.newSessionOn", { machine: machineOf(block) })}
                      disabled={block.disabled}
                      onClick={() => {
                        void newSession(block.group.project.path, undefined, block.instanceId);
                        onActivate();
                      }}
                    >
                      <IconPlus className="size-3.5" />
                    </IconButton>
                  </div>
                )}
                <div
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
                    instanceNickname={block?.nickname ?? null}
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
                    onContextMenu={(event) => {
                      // A row opens the menu only with an item it can accept; it
                      // never opens an empty one (issue #888). Migrate: omp
                      // refuses to pack a transcript another process writes, and
                      // a row with no transcript yet has nothing to carry. The
                      // version floor is knowable only for this host's binary; a
                      // remote source answers version skew verbatim at pack time
                      // (ADR-0028). Ask (#895): chats are host-local, so only
                      // local rows with a saved transcript.
                      const s = entry.session;
                      // Unified view (issue #903): a folded row obeys its owning
                      // block, not the anchor — a remote source answers version skew
                      // at pack time (ADR-0028); Ask (#895) stays host-local.
                      if (block !== null ? block.disabled : disabled) return;
                      const rowInstanceId = block === null ? instanceId : block.instanceId;
                      const migrate =
                        s.sessionId !== null &&
                        s.live !== "live" &&
                        (rowInstanceId !== null || supportsSessionMigrate(ompInstalledVersion));
                      const ask =
                        rowInstanceId === null && s.sessionId !== null && s.live !== "missing";
                      if (!migrate && !ask) return;
                      openSessionMenu(s.tabId, event, { migrate, ask });
                    }}
                  />
                </div>
              </Fragment>
            );
          })}
          {/* Unified view (issue #903): every folded checkout owns an
              always-present sub-row, even with zero sessions — the fold must
              be visible without waiting for a session divider to interleave.
              blocks[0] is this machine's anchor; today's header is its row. */}
          {merged &&
            blocks !== null &&
            blocks.slice(1).map((b) => (
              <div
                key={`${String(b.instanceId)}:${b.group.project.path}`}
                title={t("sidebar.hosts.machineLabel", {
                  machine: machineOf(b),
                  path: b.group.project.path,
                })}
                className={cn(
                  "flex items-center gap-1.5 px-3 pb-0.5 pt-1 text-[10px] text-ink-faint",
                  b.disabled && "opacity-60",
                )}
              >
                <span className="shrink-0 font-mono">{machineOf(b)}</span>
                <MiddleTruncate text={b.group.project.path} className="min-w-0 flex-1 font-mono" />
                <IconButton
                  label={t("sidebar.unified.newSessionOn", { machine: machineOf(b) })}
                  disabled={b.disabled}
                  onClick={() => {
                    void newSession(b.group.project.path, undefined, b.instanceId);
                    onActivate();
                  }}
                >
                  <IconPlus className="size-3.5" />
                </IconButton>
              </div>
            ))}
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
  openSessionMenu,
  onActivate,
  onOpenActions,
  refreshAvailability,
  onAnnounce,
  foldedKeys,
}: {
  instance: RemoteInstanceSummary;
  query: string;
  compact: boolean;
  openTerminalMenu: OpenTerminalMenu;
  openSessionMenu: OpenSessionMenu;
  onActivate: () => void;
  onOpenActions: (path: string) => void;
  refreshAvailability: () => Promise<void>;
  onAnnounce: (text: string) => void;
  /** Repository keys (ADR-0061) whose checkouts render on the unified local
   *  node instead of this section under All-hosts scope (issue #903). */
  foldedKeys?: ReadonlySet<string>;
}) {
  const t = useT();
  const openProjectPicker = useStore((st) => st.openProjectPicker);
  const openSettings = useStore((st) => st.openSettings);
  const reconnectRemoteInstance = useStore((st) => st.reconnectRemoteInstance);
  const refreshRemoteInstanceState = useStore((st) => st.refreshRemoteInstanceState);
  const moveProject = useStore((st) => st.moveProject);
  const [open, setOpen] = useState(true);
  const joined = instance.status === "joined";

  // Unified view (issue #903): keyed checkouts render on their local node's
  // tree under All-hosts scope; only keyless checkouts stay listed here.
  const visibleProjects = useMemo(
    () =>
      foldedKeys === undefined || foldedKeys.size === 0
        ? instance.projects
        : instance.projects.filter(
            (g) => g.project.repositoryKey === null || !foldedKeys.has(g.project.repositoryKey),
          ),
    [instance.projects, foldedKeys],
  );
  const filtered = useMemo(() => applyFilter(visibleProjects, query), [visibleProjects, query]);
  const filteredPaths = useMemo(() => filtered.map((f) => f.group.project.path), [filtered]);
  const canReorder = joined && !compact && query.trim() === "" && visibleProjects.length > 1;
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
      <div className="sticky top-0 z-10 bg-sunken/95 px-2 pt-2 pb-1 backdrop-glass">
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
            {joined && (
              <IconButton
                label={t("remoteinstances.action.refreshState")}
                onClick={() => void refreshRemoteInstanceState(instance.id)}
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
              openSessionMenu={openSessionMenu}
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

/* ------------------------------------------------------------ sidebar group */

/**
 * One user-named sidebar group of this app's own projects (issue #745): a
 * header carrying the group's name, counts, collapse toggle, and its
 * rename/remove actions, then its member projects as ordinary ProjectSections.
 * The header is a drop target for project drags from other segments and the
 * drag source for reordering groups; members reorder among themselves only.
 * A non-empty filter expands every group with a match (without writing the
 * persisted `collapsed`) and hides groups without one.
 */
function SidebarGroupSection({
  group,
  rows,
  members,
  query,
  compact,
  openTerminalMenu,
  openSessionMenu,
  openAvailability,
  refreshAvailability,
  onActivate,
  onOpenActions,
  onAnnounce,
  extraFor,
  groupReorder,
}: {
  group: SidebarGroup;
  /** Member projects surviving the filter, in registry order. */
  rows: FilteredGroup[];
  /** Every member project, unfiltered — the header chips describe the group itself. */
  members: ProjectGroup[];
  query: string;
  compact: boolean;
  openTerminalMenu: OpenTerminalMenu;
  openSessionMenu: OpenSessionMenu;
  openAvailability: ProjectOpenAvailability | null;
  refreshAvailability: () => Promise<void>;
  onActivate: () => void;
  onOpenActions: (path: string) => void;
  onAnnounce: (text: string) => void;
  /** The header's drag/keyboard wiring for reordering groups. */
  groupReorder: ListReorderRow;
  /** Unified project view (issue #903): folded remote checkouts for a member. */
  extraFor: (f: FilteredGroup) => CheckoutBlock[] | undefined;
}) {
  const t = useT();
  const moveProject = useStore((st) => st.moveProject);
  const setSidebarGroupCollapsed = useStore((st) => st.setSidebarGroupCollapsed);
  const removeSidebarGroup = useStore((st) => st.removeSidebarGroup);
  const openSidebarGroupDialog = useStore((st) => st.openSidebarGroupDialog);
  const filtering = query.trim() !== "";
  const open = filtering || !group.collapsed;

  const rowPaths = useMemo(() => rows.map((f) => f.group.project.path), [rows]);
  const reorder = useListReorder({
    rows,
    rootOf: (f) => f.group.project.path,
    keys: rowPaths,
    nameOf: (path) => rows.find((f) => f.group.project.path === path)?.group.project.name,
    move: moveProject,
    // A lone member stays draggable: other groups' headers (and Ungrouped)
    // are drop targets even when there is nothing to reorder within.
    enabled: !compact && !filtering,
    announce: onAnnounce,
    dragType: PROJECT_DRAG_TYPE,
  });
  const drop = useProjectDropTarget(group.id, group.projectPaths, !compact && !filtering);

  if (filtering && rows.length === 0) return null;

  const live = members.reduce((n, g) => n + liveCount(g.sessions), 0);

  return (
    <section
      data-sidebar-group={group.id}
      className={cn(
        "border-t border-line pb-1",
        groupReorder.dragging && "opacity-60",
        groupReorder.dropIndicator === "before" && "border-t-2 border-line-strong",
        groupReorder.dropIndicator === "after" && "border-b-2 border-line-strong",
      )}
      data-drop-indicator={groupReorder.dropIndicator ?? undefined}
    >
      <div
        data-sidebar-group-header
        data-project-drop={drop.hover ? "true" : undefined}
        className={cn(
          "sticky top-0 z-10 bg-sunken/95 px-2 pt-2 pb-1 backdrop-glass",
          drop.hover && "bg-hover",
        )}
        draggable={groupReorder.draggable}
        onDragStart={groupReorder.onDragStart}
        onDragEnd={groupReorder.onDragEnd}
        onDragOver={(e) => {
          groupReorder.onDragOver(e);
          drop.onDragOver(e);
        }}
        onDragLeave={drop.onDragLeave}
        onDrop={(e) => {
          if (!drop.onDrop(e)) groupReorder.onDrop(e);
        }}
      >
        {/* No gap: like the project header, the reveals bring their own margin
            so the name owns the full row width at rest. */}
        <div className={cn("group/grp flex items-start", groupReorder.draggable && "cursor-grab active:cursor-grabbing")}>
          {groupReorder.draggable && (
            <span className="proj-reveal proj-reveal-r mt-px shrink-0 self-center overflow-hidden max-w-0 transition-all duration-200 group-hover/grp:mr-1.5 group-hover/grp:max-w-11 focus-within:mr-1.5 focus-within:max-w-11">
              <button
                type="button"
                ref={groupReorder.registerGrip}
                aria-label={t("sidebar.group.reorder", { name: group.name })}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title={t("sidebar.group.reorderTitle", { name: group.name })}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  // Same reasoning as the project grip: no scroll, no menu bar.
                  e.preventDefault();
                  groupReorder.onReorder(e.key === "ArrowUp" ? -1 : 1);
                }}
                className="shrink-0 rounded text-ink-faint opacity-0 transition-opacity duration-200 group-hover/grp:opacity-100 focus-visible:opacity-100 focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                <IconGrip />
              </button>
            </span>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-label={t("sidebar.group.toggle", { name: group.name })}
            disabled={filtering}
            onClick={() => void setSidebarGroupCollapsed(group.id, !group.collapsed)}
            className="mt-px flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <span className="shrink-0">
              <Chevron open={open} className="text-ink-dim" />
            </span>
            <MiddleTruncate
              text={group.name}
              className="min-w-0 flex-1 font-display text-xs font-semibold text-ink"
            />
            <Chip mono title={t("sidebar.group.projects", { n: members.length })}>
              {members.length}
            </Chip>
            {live > 0 && (
              <Chip mono tone="signal" title={t("sidebar.project.live", { n: live })}>
                <Dot tone="signal" />
                {live}
              </Chip>
            )}
          </button>
          <div className="proj-reveal proj-reveal-l flex shrink-0 items-center gap-1 overflow-hidden opacity-0 max-w-0 transition-all duration-200 group-hover/grp:ml-1.5 group-hover/grp:max-w-full group-hover/grp:opacity-100 focus-within:ml-1.5 focus-within:max-w-full focus-within:opacity-100">
            <IconButton
              label={t("sidebar.group.rename", { name: group.name })}
              onClick={() => openSidebarGroupDialog({ kind: "rename", groupId: group.id })}
            >
              <IconPencil />
            </IconButton>
            <IconButton
              label={t("sidebar.group.remove", { name: group.name })}
              tone="rose"
              onClick={() => void removeSidebarGroup(group.id)}
            >
              <IconClose className="size-3.5" />
            </IconButton>
          </div>
        </div>
      </div>
      {open && rows.length === 0 && (
        <p className="px-4 py-2 text-[11px] text-ink-faint">{t("sidebar.group.empty")}</p>
      )}
      {open &&
        rows.map((f, index) => {
          const path = f.group.project.path;
          return (
            <ProjectSection
              key={path}
              group={f.group}
              extra={extraFor(f)}
              instanceId={null}
              hostLocalActions
              projectHit={f.projectHit}
              query={query}
              openTerminalMenu={openTerminalMenu}
              openSessionMenu={openSessionMenu}
              compact={compact}
              openAvailability={openAvailability}
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
  /** The sidebar group holding this local project (issue #745); null when ungrouped or remote. */
  groupName: string | null;
  /** First entry of its group: the rail draws a divider above it. */
  groupStart: boolean;
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
      {entries.map(({ group: g, instanceId, nickname, groupName, groupStart, disabled }) => {
        const live = liveCount(g.sessions);
        const name = [nickname, groupName, g.project.name].filter((part) => part !== null).join(" · ");
        return (
          <Fragment key={projectKey(instanceId, g.project.path)}>
            {groupStart && <div aria-hidden className="h-px w-6 bg-line" />}
            <button
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
          </Fragment>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------- host scope picker */

/** Menu-row chrome shared with the sidebar's other menus (issue #507). */
const HOST_MENU_ROW =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";

/** Sidebar Work/Chat pill on the recessed track (SessionHud's Segmented idiom). */
const MODE_PILL = {
  selectedClassName: "bg-raised text-ink edge-lit hover:bg-raised",
  unselectedClassName: "text-ink-dim hover:text-ink-mid",
} as const;

/**
 * The sidebar host filter (issue #507): with instances joined, scope the
 * list to one host — or to this computer — as a display choice only. Hidden
 * hosts stay joined, their sessions keep streaming, and their signals keep
 * counting in the footer; a non-empty search query ignores this control
 * entirely (the parent resolves that precedence). A rose dot on the trigger
 * warns that a *hidden* instance needs the user's attention.
 */
function HostScopePicker({
  instances,
  scope,
  onScope,
}: {
  /** Non-`self` joined instances, in state order. */
  instances: RemoteInstanceSummary[];
  scope: string;
  onScope: (next: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [geometry, setGeometry] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissal({
    open,
    refs: [menuRef, triggerRef],
    onClose: () => setOpen(false),
    onEscape: () => setOpen(false),
    restoreFocus: () => triggerRef.current?.focus(),
  });

  const chosen = instances.find((i) => i.id === scope);
  const scopeLabel =
    scope === "local" ? t("sidebar.hosts.local") : (chosen?.nickname ?? t("sidebar.hosts.all"));
  // Scoping must not hide a host that needs attention (issue #507): any
  // instance the scope keeps out of sight in a rose-tone status earns the dot.
  const hiddenProblem =
    scope !== "all" &&
    instances.some(
      (i) => (scope === "local" || i.id !== scope) && remoteInstanceStatusTone(i.status) === "rose",
    );

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    setGeometry(rect === undefined ? null : { left: rect.left, top: rect.bottom + 4 });
    setOpen(true);
  };

  const pick = (value: string): void => {
    onScope(value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // The menu owns its keyboard: focus lands on the current row so the Arrow
  // keys move from there (ProjectOpenControl's pattern, issue #507).
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (menu === null) return;
    (
      menu.querySelector<HTMLElement>("[role='menuitem'][aria-current='true']") ??
      menu.querySelector<HTMLElement>("[role='menuitem']")
    )?.focus();
  }, [open]);

  /** Roving arrow focus with wrap. Enter/Space stay native to the buttons. */
  const moveFocus = (delta: 1 | -1): void => {
    const menu = menuRef.current;
    if (menu === null) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']"));
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      index === -1
        ? delta === 1
          ? items[0]
          : items[items.length - 1]
        : items[(index + delta + items.length) % items.length];
    next?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("sidebar.hosts.filter")}
        title={scopeLabel}
        onClick={toggle}
        className={cn(
          "flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-ink-mid",
          "transition-colors duration-150 hover:bg-hover hover:text-ink",
          "focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none",
          open && "bg-hover text-ink",
        )}
      >
        {chosen !== undefined && (
          <Dot
            tone={remoteInstanceStatusTone(chosen.status)}
            pulse={chosen.status === "connecting"}
            title={t(remoteInstanceStatusKey(chosen.status))}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{scopeLabel}</span>
        {hiddenProblem && <Dot tone="rose" />}
        <Chevron open={false} className={cn("size-2.5 text-ink-dim", open ? "-rotate-90" : "rotate-90")} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t("sidebar.hosts.filter")}
            className="fixed z-50"
            style={{ left: geometry?.left ?? 0, top: geometry?.top ?? 0 }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Handle Escape on the portalled menu before it reaches the
                // Sheet's window listener: dismiss only this popup and return
                // focus to the trigger (issue #507).
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                triggerRef.current?.focus();
                return;
              }
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              moveFocus(event.key === "ArrowDown" ? 1 : -1);
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <Panel
              className={cn(
                "edge-lit animate-rise w-56 p-1",
                (geometry?.left ?? 0) > window.innerWidth / 2 && "-translate-x-full",
                (geometry?.top ?? 0) > window.innerHeight / 2 && "-translate-y-full",
              )}
            >
              <button
                type="button"
                role="menuitem"
                aria-current={scope === "all" ? "true" : undefined}
                onClick={() => pick("all")}
                className={cn(HOST_MENU_ROW, scope === "all" && "font-semibold text-ink")}
              >
                {t("sidebar.hosts.all")}
              </button>
              <button
                type="button"
                role="menuitem"
                aria-current={scope === "local" ? "true" : undefined}
                onClick={() => pick("local")}
                className={cn(HOST_MENU_ROW, scope === "local" && "font-semibold text-ink")}
              >
                {t("sidebar.hosts.local")}
              </button>
              {instances.map((instance) => (
                <button
                  key={instance.id}
                  type="button"
                  role="menuitem"
                  aria-current={instance.id === scope ? "true" : undefined}
                  onClick={() => pick(instance.id)}
                  className={cn(HOST_MENU_ROW, instance.id === scope && "font-semibold text-ink")}
                >
                  <span className="flex items-center gap-1.5">
                    <Dot
                      tone={remoteInstanceStatusTone(instance.status)}
                      pulse={instance.status === "connecting"}
                      title={t(remoteInstanceStatusKey(instance.status))}
                    />
                    <MiddleTruncate text={instance.nickname} className="min-w-0 flex-1" />
                  </span>
                  {instance.status !== "joined" && (
                    <span className="mt-0.5 block font-mono text-[10px] text-ink-faint">
                      {t(remoteInstanceStatusKey(instance.status))}
                    </span>
                  )}
                </button>
              ))}
            </Panel>
          </div>,
          document.body,
        )}
    </>
  );
}

/* ------------------------------------------------------------------ sidebar */

export function Sidebar() {
  const t = useT();
  const state = useStore((st) => st.state);
  const openProjectPicker = useStore((st) => st.openProjectPicker);
  const openSettings = useStore((st) => st.openSettings);
  const newSession = useStore((st) => st.newSession);
  const openNewSessionDialog = useStore((st) => st.openNewSessionDialog);
  const openMigrateDialog = useStore((st) => st.openMigrateDialog);
  const askAboutSession = useStore((st) => st.askAboutSession);
  const moveProject = useStore((st) => st.moveProject);
  const moveSidebarGroup = useStore((st) => st.moveSidebarGroup);
  const openSidebarGroupDialog = useStore((st) => st.openSidebarGroupDialog);
  const compact = useCompactShell();
  const surface = useStore((st) => st.compactSurface);
  const closeCompactSurface = useStore((st) => st.closeCompactSurface);
  const openFleet = useStore((st) => st.openFleet);
  const fleetOpen = useStore((st) => st.fleet !== null);
  const mode = useSidebarMode();

  // Desktop collapse memory lives in the store: the toggle moved to App's
  // title bar (issue #60), and the compact sheet ignores it as before.
  const collapsed = useStore((st) => st.sidebarCollapsed);
  const sidebarWidth = useStore((st) => st.sidebarWidth);
  const inspectorWidth = useStore((st) => st.inspectorWidth);
  const inspectorOpen = useStore((st) => st.inspectorOpen);
  const browserPaneWidth = useStore((st) => st.browserPaneWidth);
  const activeTabId = useStore((st) => st.activeTabId);
  const browserPaneOpen = useBrowserPaneSplitOpen(activeTabId);
  const setSidebarWidth = useStore((st) => st.setSidebarWidth);
  const viewportWidth = useViewportWidth();
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const [query, setQuery] = useState("");
  const [terminalMenu, setTerminalMenu] = useState<TerminalMenuRequest | null>(null);
  // The session row's context menu (issue #888); Sidebar-local like
  // `terminalMenu` — never in the store.
  const [sessionMenu, setSessionMenu] = useState<SessionMenuRequest | null>(null);
  // The project whose compact actions sheet is open (issue #205), by
  // projectKey so a same-path project on a remote instance is distinct (#416).
  // Sidebar-local UI state, like `terminalMenu` — never in the store.
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [openAvailability, setOpenAvailability] = useState<ProjectOpenAvailability | null>(null);
  const availabilityMounted = useRef(false);
  const availabilityGeneration = useRef(0);
  const refreshAvailability = useCallback(async (): Promise<void> => {
    const generation = ++availabilityGeneration.current;
    let available: ProjectOpenAvailability = { vsCode: false, terminal: false };
    try {
      available = await backend.getProjectOpenAvailability();
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
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuItemRef = useRef<HTMLButtonElement>(null);

  // Issue #888/#895: the per-row Migrate/Ask menu, same portal/dismissal
  // shape as the project's new-session options menu.
  const openSessionMenu: OpenSessionMenu = (tabId, event, { migrate, ask }) => {
    event.preventDefault();
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) return;
    const keyboardPosition = event.clientX === 0 && event.clientY === 0;
    const rect = currentTarget.getBoundingClientRect();
    setSessionMenu({
      tabId,
      migrate,
      ask,
      x: keyboardPosition ? rect.left : event.clientX,
      y: keyboardPosition ? rect.bottom : event.clientY,
      trigger: currentTarget,
    });
  };

  useEffect(() => {
    if (sessionMenu === null) return;
    sessionMenuItemRef.current?.focus();
  }, [sessionMenu]);

  useDismissal({
    open: sessionMenu !== null,
    refs: sessionMenuRef,
    onClose: () => setSessionMenu(null),
    onEscape: () => setSessionMenu(null),
    restoreFocus: () => {
      const m = sessionMenu;
      if (m !== null) m.trigger.focus();
    },
  });

  const groups = state?.projects ?? null;
  const remoteInstances = state?.remoteInstances ?? null;
  const sidebarGroups = state?.sidebarGroups ?? EMPTY_GROUPS;
  const filtering = query.trim().length > 0;
  const filtered = useMemo(() => applyFilter(groups ?? [], query), [groups, query]);
  // Sidebar groups (issue #745) partition this app's own projects: the
  // filtered segments render, the unfiltered ones feed the header chips, the
  // drop targets' membership checks, and the rail.
  const segments = useMemo(
    () => segmentByGroup(filtered, (f) => f.group.project.path, sidebarGroups),
    [filtered, sidebarGroups],
  );
  const allSegments = useMemo(
    () => segmentByGroup(groups ?? [], (g) => g.project.path, sidebarGroups),
    [groups, sidebarGroups],
  );
  // Paths in render order, used to resolve where a drop lands. Everything
  // recomputes from the live list, so a stale pointer resolves against the
  // current rows even when the filter changed mid-drag.
  const ungroupedPaths = useMemo(
    () => segments.ungrouped.map((f) => f.group.project.path),
    [segments],
  );

  // A lone project can't be reordered; the compact sheet's touch surface gets
  // no drag affordances (issue #115 scoping). Filtering also disables the
  // reorder: positions resolve against the *visible* rows, so with neighbours
  // hidden the insertion line — or an Alt+Arrow step — would promise a place
  // the reorder cannot honour. One gate covers both input paths: the pointer
  // drag (issue #115) and the keyboard move (issue #120). Each segment —
  // Ungrouped here, every group in its SidebarGroupSection — reorders on its
  // own (issue #745); group headers are the only cross-segment targets, so
  // once groups exist even a lone ungrouped project stays draggable.
  const canReorder = !compact && !filtering && (segments.ungrouped.length > 1 || sidebarGroups.length > 0);
  const dropEnabled = !compact && !filtering;

  const reorder = useListReorder({
    rows: segments.ungrouped,
    rootOf: (f) => f.group.project.path,
    keys: ungroupedPaths,
    nameOf: (path) => segments.ungrouped.find((f) => f.group.project.path === path)?.group.project.name,
    move: moveProject,
    enabled: canReorder,
    announce: setReorderNote,
    dragType: PROJECT_DRAG_TYPE,
  });
  // The header only accepts drops while unfiltered, so the visible ungrouped
  // rows are every ungrouped project.
  const ungroupedDrop = useProjectDropTarget(null, ungroupedPaths, dropEnabled);

  const groupIds = useMemo(() => segments.grouped.map((s) => s.group.id), [segments]);
  const groupReorder = useListReorder({
    rows: segments.grouped,
    rootOf: (s) => s.group.id,
    keys: groupIds,
    nameOf: (id) => sidebarGroups.find((g) => g.id === id)?.name,
    move: moveSidebarGroup,
    enabled: !compact && !filtering && sidebarGroups.length > 1,
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
  // Local entries follow segment order: Ungrouped, then each group.
  const railEntries = useMemo<RailEntry[]>(() => {
    const out: RailEntry[] = allSegments.ungrouped.map((group) => ({
      group,
      instanceId: null,
      nickname: null,
      groupName: null,
      groupStart: false,
      disabled: false,
    }));
    for (const segment of allSegments.grouped) {
      segment.rows.forEach((group, index) => {
        out.push({
          group,
          instanceId: null,
          nickname: null,
          groupName: segment.group.name,
          groupStart: index === 0,
          disabled: false,
        });
      });
    }
    for (const instance of remoteInstances ?? []) {
      for (const group of instance.projects) {
        out.push({
          group,
          instanceId: instance.id,
          nickname: instance.nickname,
          groupName: null,
          groupStart: false,
          disabled: instance.status !== "joined",
        });
      }
    }
    return out;
  }, [allSegments, remoteInstances]);
  const matchCount = filtered.reduce((n, f) => n + f.sessions.length, 0);
  const totalSessions = railEntries.reduce((n, e) => n + e.group.sessions.length, 0);
  const totalLive = railEntries.reduce((n, e) => n + liveCount(e.group.sessions), 0);

  const hostScope = useStore((st) => st.hostScope);
  const setHostScope = useStore((st) => st.setHostScope);
  const hostChoices = useMemo(
    () => (remoteInstances ?? []).filter((i) => i.status !== "self"),
    [remoteInstances],
  );
  // A scope naming a removed instance degrades to "all" without a store write.
  const effectiveScope =
    hostScope === "all" || hostScope === "local" || hostChoices.some((i) => i.id === hostScope)
      ? hostScope
      : "all";
  // Search is global (issue #507): a filtering query overrides the host scope.
  const scoped = !filtering && effectiveScope !== "all";

  // Unified project view (issue #903, ADR-0063): under All-hosts scope with no
  // filter, joined instances' keyed checkouts fold into the local node sharing
  // their repository key; per-host lenses and search keep the split layout.
  const remoteCheckouts = useMemo(
    () => (filtering || effectiveScope !== "all" ? null : indexRemoteCheckouts(remoteInstances)),
    [filtering, effectiveScope, remoteInstances],
  );
  // Repository keys with a local anchor: hidden from the per-instance sections.
  const foldedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (remoteCheckouts === null) return keys;
    for (const g of groups ?? []) {
      const key = g.project.repositoryKey;
      if (key !== null && remoteCheckouts.has(key)) keys.add(key);
    }
    return keys;
  }, [groups, remoteCheckouts]);
  const extraFor = (f: FilteredGroup): CheckoutBlock[] | undefined => {
    if (remoteCheckouts === null) return undefined;
    const key = f.group.project.repositoryKey;
    return key === null ? undefined : remoteCheckouts.get(key);
  };
  const showLocalSections = !scoped || effectiveScope === "local";
  const displayedCollapsed = compact ? false : collapsed;
  const resolvedWidths = resolveDesktopPanelWidths({
    viewportWidth,
    sidebarWidth,
    inspectorWidth,
    sidebarCollapsed: displayedCollapsed,
    inspectorOpen,
    browserPaneWidth,
    browserPaneOpen,
  });
  const displayedSidebarWidth = previewWidth ?? resolvedWidths.sidebarWidth;

  const sidebar = (
    <aside
      className={cn(
        "ambient relative flex shrink-0 flex-col border-r border-line chrome-sunken",
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
            <ChoiceCapsule
              label={t("sidebar.mode.label")}
              value={mode}
              options={[
                { value: "work", label: t("sidebar.mode.work"), ...MODE_PILL },
                { value: "chat", label: t("sidebar.mode.chat"), ...MODE_PILL },
              ]}
              onChange={setSidebarMode}
              className={cn("mb-2 flex w-full gap-0.5 divide-x-0 bg-void p-0.5", compact ? "h-9" : "h-7")}
              optionClassName="flex-1 justify-center rounded-[4px] text-xs font-medium first:rounded-[4px] last:rounded-[4px]"
            />
            <div className="flex items-center gap-1.5">
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-transparent bg-raised px-2",
                  "transition-colors duration-150 focus-within:border-line-strong",
                  compact ? "h-9" : "h-7",
                )}
              >
                <span className="shrink-0 text-ink-dim">
                  <IconSearch />
                </span>
                <input
                  type="text"
                  value={query}
                  spellCheck={false}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("sidebar.filter.placeholder")}
                  aria-label={t("sidebar.filter.label")}
                  className="min-w-0 flex-1 bg-transparent text-xs text-ink placeholder:text-ink-dim focus:outline-none"
                />
                {filtering && (
                  <>
                    <span className="shrink-0 font-mono text-[10px] text-ink-dim tabular-nums">
                      {mode === "chat" ? filterChats(state?.chats ?? [], query).length : matchCount}
                    </span>
                    <IconButton label={t("sidebar.filter.clear")} onClick={() => setQuery("")} className="size-5">
                      <IconClose className="size-3.5" />
                    </IconButton>
                  </>
                )}
              </div>
              {mode === "work" && (
                <IconButton
                  label={t("sidebar.group.create")}
                  onClick={() => openSidebarGroupDialog({ kind: "create" })}
                  className={compact ? "size-9 rounded-md border border-line" : "size-7"}
                >
                  <IconGroup />
                </IconButton>
              )}
              {mode === "work" && compact && (
                <IconButton label={t("sidebar.project.add")} onClick={() => { openProjectPicker(); closeCompactSurface(); }} className="size-9 rounded-md border border-line">
                  <IconPlus />
                </IconButton>
              )}
            </div>
            {mode === "work" && hostChoices.length > 0 && (
              <div className="mt-1 flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <HostScopePicker
                    instances={hostChoices}
                    scope={effectiveScope}
                    onScope={setHostScope}
                  />
                </div>
                <IconButton
                  label={t("fleet.sidebar.open")}
                  pressed={fleetOpen}
                  onClick={() => { openFleet(); closeCompactSurface(); }}
                  className={compact ? "size-9 rounded-md border border-line" : undefined}
                >
                  <IconFleet />
                </IconButton>
              </div>
            )}
          </div>

          {/* -------- project list -------- */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {mode === "chat" ? (
              <ChatList query={query} onActivate={closeCompactSurface} openSessionMenu={openSessionMenu} />
            ) : (
            <>
            {groups === null && <SkeletonRows />}
            {showLocalSections && (
              <>
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
                {sidebarGroups.length > 0 && segments.ungrouped.length > 0 && (
                  <div
                    data-sidebar-ungrouped
                    data-project-drop={ungroupedDrop.hover ? "true" : undefined}
                    className={cn(
                      "px-3 pt-2 pb-1 font-mono text-[10px] uppercase text-ink-faint",
                      ungroupedDrop.hover && "bg-hover",
                    )}
                    onDragOver={ungroupedDrop.onDragOver}
                    onDragLeave={ungroupedDrop.onDragLeave}
                    onDrop={ungroupedDrop.onDrop}
                  >
                    {t("sidebar.group.ungrouped")}
                  </div>
                )}
                {segments.ungrouped.map((f, index) => {
                  const path = f.group.project.path;
                  return (
                    <ProjectSection
                      key={path}
                      group={f.group}
                      instanceId={null}
                      extra={extraFor(f)}
                      hostLocalActions
                      projectHit={f.projectHit}
                      query={query}
                      openTerminalMenu={openTerminalMenu}
                      openSessionMenu={openSessionMenu}
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
                {segments.grouped.map((segment, index) => (
                  <SidebarGroupSection
                    key={segment.group.id}
                    group={segment.group}
                    rows={segment.rows}
                    // Both partitions walk sidebarGroups in order, so indices align.
                    members={allSegments.grouped[index]?.rows ?? []}
                    query={query}
                    compact={compact}
                    openTerminalMenu={openTerminalMenu}
                    openSessionMenu={openSessionMenu}
                    openAvailability={openAvailability}
                    refreshAvailability={refreshAvailability}
                    onActivate={closeCompactSurface}
                    onOpenActions={(path) => setActionsFor(projectKey(null, path))}
                    onAnnounce={setReorderNote}
                    groupReorder={groupReorder.bindRow(segment.group.id, index)}
                    extraFor={extraFor}
                  />
                ))}
              </>
            )}
            {/* Joined remote instances (issue #416), after this app's own
                projects. `self` is this app seen through its own URL — no
                group, nothing to show twice. */}
            {(remoteInstances ?? [])
              .filter(
                (instance) => instance.status !== "self" && (!scoped || instance.id === effectiveScope),
              )
              .map((instance) => (
                <RemoteInstanceSection
                  key={instance.id}
                  instance={instance}
                  query={query}
                  compact={compact}
                  openTerminalMenu={openTerminalMenu}
                  openSessionMenu={openSessionMenu}
                  onActivate={closeCompactSurface}
                  onOpenActions={(path) => setActionsFor(projectKey(instance.id, path))}
                  refreshAvailability={refreshAvailability}
                  onAnnounce={setReorderNote}
                  foldedKeys={foldedKeys}
                />
              ))}
            </>
            )}
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
                  openNewSessionDialog({ projectCwd, instanceId });
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                {t("project.actions.newSessionDialog")}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const { projectCwd, instanceId } = terminalMenu;
                  setTerminalMenu(null);
                  void newSession(projectCwd, undefined, instanceId, { private: true });
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                {t("sidebar.project.newPrivate")}
              </button>
            </Panel>
          </div>,
          document.body,
        )}
      {sessionMenu !== null &&
        createPortal(
          <div
            ref={sessionMenuRef}
            role="menu"
            className="fixed z-50"
            style={{ left: sessionMenu.x, top: sessionMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <Panel
              className={cn(
                "edge-lit animate-rise p-1",
                sessionMenu.x > window.innerWidth / 2 && "-translate-x-full",
                sessionMenu.y > window.innerHeight / 2 && "-translate-y-full",
              )}
            >
              {sessionMenu.ask && (
                <button
                  ref={sessionMenuItemRef}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const { tabId } = sessionMenu;
                    setSessionMenu(null);
                    void askAboutSession(tabId);
                    closeCompactSurface();
                  }}
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
                >
                  {t("sidebar.session.ask")}
                </button>
              )}
              {sessionMenu.migrate && (
                <button
                  ref={sessionMenu.ask ? undefined : sessionMenuItemRef}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const { tabId } = sessionMenu;
                    setSessionMenu(null);
                    openMigrateDialog(tabId);
                  }}
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
                >
                  {t("sidebar.session.migrate")}
                </button>
              )}
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
