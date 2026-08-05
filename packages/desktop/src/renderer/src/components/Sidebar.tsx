import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ProjectGroup, SessionSummary } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { useCompactShell } from "../lib/responsive";
import { PAGE, sessionWindow } from "../lib/session-window";
import { useStore } from "../store";
import { SessionRow } from "./SessionRow";
import { Button, Chevron, Chip, Dot, Empty, IconButton, Panel, Sheet } from "./ui";

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

function IconClose() {
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
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
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
  sessions: SessionSummary[];
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
 * A session survives the filter when either its own title or its project name
 * matches — typing a project name should reveal that project's whole list.
 */
function applyFilter(groups: ProjectGroup[], query: string): FilteredGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.map((group) => ({ group, sessions: group.sessions }));
  const out: FilteredGroup[] = [];
  for (const group of groups) {
    const projectHit = group.project.name.toLowerCase().includes(q);
    const sessions = projectHit
      ? group.sessions
      : group.sessions.filter((s) => s.title.toLowerCase().includes(q));
    if (projectHit || sessions.length > 0) out.push({ group, sessions });
  }
  return out;
}

/* --------------------------------------------------------- project section */

function ProjectSection({
  group,
  sessions,
  query,
  openTerminalMenu,
  compact,
  onActivate,
}: FilteredGroup & { query: string; openTerminalMenu: OpenTerminalMenu; compact: boolean; onActivate: () => void }) {
  const newSession = useStore((st) => st.newSession);
  const removeProject = useStore((st) => st.removeProject);
  const activeTabId = useStore((st) => st.activeTabId);
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

  const activeIndex = sessions.findIndex((s) => s.tabId === activeTabId);
  const { shown, remaining } = sessionWindow(sessions.length, visible, activeIndex);
  const page = sessions.slice(0, shown);

  const { project } = group;
  const live = liveCount(sessions);

  return (
    <section className="pb-1">
      <div className="sticky top-0 z-10 bg-sunken/95 px-2 pt-2 pb-1 backdrop-blur">
        <div className="group/proj flex items-start gap-1.5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            title={project.path}
            className="mt-px flex min-w-0 flex-1 items-start gap-1.5 text-left"
          >
            <Chevron open={open} className="mt-1 text-ink-dim" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-display text-xs font-semibold text-ink">
                  {project.name}
                </span>
                <Chip mono title={`${sessions.length} sessions`}>
                  {sessions.length}
                </Chip>
                {live > 0 && (
                  <Chip mono tone="signal" title={`${live} live`}>
                    <Dot tone="signal" />
                    {live}
                  </Chip>
                )}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-faint">
                {project.path}
              </span>
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-200 group-hover/proj:opacity-100 focus-within:opacity-100 compact-lifecycle-visible">
            <span onContextMenu={(event) => openTerminalMenu(project.path, event)}>
              <IconButton label="new session" onClick={() => { void newSession(project.path); onActivate(); }}>
                <IconPlus />
              </IconButton>
            </span>
            {compact && (
              <Button size="xs" variant="ghost" onClick={() => { void newSession(project.path, "pty"); onActivate(); }}>
                terminal
              </Button>
            )}
            <IconButton label="remove project" tone="rose" onClick={() => void removeProject(project.path)}>
              <IconClose />
            </IconButton>
          </div>
        </div>
      </div>

      {open && (
        <div className="space-y-px px-1.5">
          {page.map((s) => (
            <SessionRow key={s.tabId} s={s} onActivate={onActivate} />
          ))}
          {sessions.length === 0 && (
            <p className="px-3 py-1 text-[11px] text-ink-faint italic">no sessions yet</p>
          )}
          {sessions.length > PAGE && (
            <div className="flex items-center gap-2 px-3 pt-1 pb-0.5">
              <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                showing {shown} of {sessions.length}
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
  const compact = useCompactShell();
  const surface = useStore((st) => st.compactSurface);
  const closeCompactSurface = useStore((st) => st.closeCompactSurface);

  // Desktop collapse memory is independent from the compact sheet.
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [terminalMenu, setTerminalMenu] = useState<TerminalMenuRequest | null>(null);
  const terminalMenuRef = useRef<HTMLDivElement>(null);
  const terminalMenuItemRef = useRef<HTMLButtonElement>(null);

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

  const matchCount = filtered.reduce((n, f) => n + f.sessions.length, 0);
  const totalSessions = (groups ?? []).reduce((n, g) => n + g.sessions.length, 0);
  const totalLive = (groups ?? []).reduce((n, g) => n + liveCount(g.sessions), 0);
  const filtering = query.trim().length > 0;
  const displayedCollapsed = compact ? false : collapsed;

  const sidebar = (
    <aside
      className={cn(
        "ambient flex shrink-0 flex-col border-r border-line bg-sunken",
        "transition-[width] duration-200 ease-out-quint",
        displayedCollapsed ? "w-14" : compact ? "h-full w-full border-r-0" : "w-[17rem]",
      )}
    >
      {/* -------- header -------- */}
      <header
        className={cn(
          "flex shrink-0 items-center border-b border-line",
          displayedCollapsed ? "flex-col gap-2 px-2 py-2" : "gap-2 px-3 py-2.5",
        )}
      >
        {!displayedCollapsed && (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-signal" />
            <span className="truncate font-display text-sm font-semibold tracking-tight text-ink">
              omp<span className="text-ink-dim">-ui</span>
            </span>
          </span>
        )}
        {displayedCollapsed && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-signal" />}
        {!displayedCollapsed && (
          <IconButton label="add project" onClick={() => { openProjectPicker(); closeCompactSurface(); }}>
            <IconPlus />
          </IconButton>
        )}
        {!compact && <IconButton
          label={displayedCollapsed ? "expand sidebar" : "collapse sidebar"}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Chevron open={false} className={cn("size-3.5", !displayedCollapsed && "rotate-180")} />
        </IconButton>}
      </header>

      {displayedCollapsed ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups && <CollapsedRail groups={groups} openTerminalMenu={openTerminalMenu} />}
        </div>
      ) : (
        <>
          {/* -------- filter -------- */}
          <div className="shrink-0 border-b border-line px-3 py-2.5">
            <div className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2 focus-within:border-line-strong">
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
                    <IconClose />
                  </IconButton>
                </>
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
            {filtered.map((f) => (
              <ProjectSection
                key={f.group.project.path}
                group={f.group}
                sessions={f.sessions}
                query={query}
                openTerminalMenu={openTerminalMenu}
                compact={compact}
                onActivate={closeCompactSurface}
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
                  const projectCwd = terminalMenu.projectCwd;
                  setTerminalMenu(null);
                  void newSession(projectCwd, "pty");
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
              >
                New terminal session
              </button>
            </Panel>
          </div>,
          document.body,
        )}

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
    </aside>
  );
  return compact ? (
    <Sheet open={surface === "sessions"} placement="left" label="projects and sessions" onClose={closeCompactSurface}>
      {sidebar}
    </Sheet>
  ) : sidebar;
}
