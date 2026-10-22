import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { formatHotkey } from "../lib/hotkeys";
import { useDismissal } from "../lib/use-dismissal";
import { useCompactShell, useViewportWidth } from "../lib/responsive";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  resolveDesktopPanelWidths,
} from "../lib/panel-layout";
import { buildSidebarLists, type SidebarEntry } from "../lib/sidebar-sessions";
import { setSettledOpen, useSettledOpen } from "../lib/sidebar-settled";
import { supportsSessionMigrate } from "../lib/session-migrate";
import { useStore } from "../store";
import { SessionRow } from "./SessionRow";
import { useBrowserPaneSplitOpen } from "./browser-pane/BrowserPaneSplit";
import { Button, Chevron, Dot, Empty, IconButton, IconClose, IconFleet, IconPlus, IconSearch, Panel, ResizeHandle, Sheet } from "./ui";

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

/** Folder-plus — add project, distinct from the adjacent new-session glyph. */
function IconFolderPlus() {
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
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
      <path d="M8 7.5v3.4M6.3 9.2h3.4" />
    </svg>
  );
}

/* ---------------------------------------------------------------- helpers */

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

/** Opens a session row's context menu with the items it can accept (#888 Migrate, #895 Ask). */
type OpenSessionMenu = (
  tabId: string,
  event: ReactMouseEvent<HTMLElement>,
  items: { migrate: boolean; ask: boolean },
) => void;

interface SessionMenuRequest {
  tabId: string;
  migrate: boolean;
  ask: boolean;
  x: number;
  y: number;
  trigger: HTMLElement;
}

const MENU_ROW =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";

/** One sidebar row: a session from this app or a joined instance, any project or a chat. */
function Row({
  entry,
  onActivate,
  openSessionMenu,
}: {
  entry: SidebarEntry;
  onActivate: () => void;
  openSessionMenu: OpenSessionMenu;
}) {
  const t = useT();
  // Issue #888: gate the row context menu on the local binary's floor.
  const ompInstalledVersion = useStore((st) => st.ompUpdate.installedVersion);
  return (
    <div className={cn(!entry.reachable && "opacity-60")}>
      <SessionRow
        s={entry.session}
        onActivate={onActivate}
        handoff={entry.handoff}
        projectLabel={entry.projectName ?? t("sidebar.session.chat")}
        instanceNickname={entry.nickname}
        onContextMenu={(event) => {
          // A row opens the menu only with an item it can accept; it never
          // opens an empty one (issue #888). Migrate: omp refuses to pack a
          // transcript another process writes, and a row with no transcript
          // yet has nothing to carry. The version floor is knowable only for
          // this host's binary; a remote source answers version skew verbatim
          // at pack time (ADR-0028). Chats never migrate. Ask (#895): only
          // local rows with a saved transcript.
          if (!entry.reachable) return;
          const s = entry.session;
          const chat = entry.projectName === null;
          const migrate =
            !chat &&
            s.sessionId !== null &&
            s.live !== "live" &&
            (entry.instanceId !== null || supportsSessionMigrate(ompInstalledVersion));
          const ask = entry.instanceId === null && s.sessionId !== null && s.live !== "missing";
          if (!migrate && !ask) return;
          openSessionMenu(s.tabId, event, { migrate, ask });
        }}
      />
    </div>
  );
}

const rowKey = (entry: SidebarEntry): string => `${entry.instanceId ?? "local"}:${entry.session.tabId}`;

/* ------------------------------------------------------------------ sidebar */

export function Sidebar() {
  const t = useT();
  const state = useStore((st) => st.state);
  const openProjectPicker = useStore((st) => st.openProjectPicker);
  const openProjectQuickOpen = useStore((st) => st.openProjectQuickOpen);
  const openSettings = useStore((st) => st.openSettings);
  const openMigrateDialog = useStore((st) => st.openMigrateDialog);
  const askAboutSession = useStore((st) => st.askAboutSession);
  const compact = useCompactShell();
  const surface = useStore((st) => st.compactSurface);
  const closeCompactSurface = useStore((st) => st.closeCompactSurface);
  const openFleet = useStore((st) => st.openFleet);
  const fleetOpen = useStore((st) => st.fleet !== null);
  const settledOpen = useSettledOpen();

  // Desktop collapse memory lives in the store: the toggle lives in App's
  // title bar (issue #60), and the compact sheet ignores it.
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
  // The session row's context menu (issue #888); Sidebar-local, never in the store.
  const [sessionMenu, setSessionMenu] = useState<SessionMenuRequest | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuItemRef = useRef<HTMLButtonElement>(null);

  // Issue #888/#895: the per-row Migrate/Ask menu.
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

  const filtering = query.trim().length > 0;
  const lists = useMemo(() => (state === null ? null : buildSidebarLists(state, query)), [state, query]);

  // The footer counts every live row this app can see, ignoring the search.
  const instances = state?.remoteInstances ?? [];
  const totalLive = useMemo(() => {
    if (state === null) return 0;
    let n = 0;
    const count = (sessions: readonly { live: string }[]) => {
      for (const s of sessions) if (s.live === "live") n += 1;
    };
    for (const group of state.projects) count(group.sessions);
    count(state.chats);
    for (const instance of state.remoteInstances) {
      if (instance.status === "self") continue;
      for (const group of instance.projects) count(group.sessions);
    }
    return n;
  }, [state]);
  const hasInstances = instances.some((i) => i.status !== "self");
  const unreachable = instances.filter(
    (i) => i.status !== "self" && i.status !== "joined" && i.status !== "connecting",
  ).length;

  // Collapse hides the desktop sidebar entirely; the title bar keeps the
  // toggle and New session. The compact sheet ignores the desktop collapse.
  if (!compact && collapsed) return null;

  const resolvedWidths = resolveDesktopPanelWidths({
    viewportWidth,
    sidebarWidth,
    inspectorWidth,
    sidebarCollapsed: false,
    inspectorOpen,
    browserPaneWidth,
    browserPaneOpen,
  });
  const displayedSidebarWidth = previewWidth ?? resolvedWidths.sidebarWidth;
  const headerButton = compact ? "size-9 rounded-md border border-line" : "size-7";
  const settledShown = settledOpen || filtering;

  const sidebar = (
    <aside
      className={cn(
        "ambient relative flex shrink-0 flex-col border-r border-line chrome-sunken",
        !resizing && "transition-[width] duration-200 ease-out-quint",
        compact && "h-full w-full border-r-0",
      )}
      style={compact ? undefined : { width: displayedSidebarWidth }}
    >
      {/* -------- header -------- */}
      <div className="shrink-0 border-b border-line px-3 py-2.5">
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
                  {lists === null ? 0 : lists.active.length + lists.settled.length}
                </span>
                <IconButton label={t("sidebar.filter.clear")} onClick={() => setQuery("")} className="size-5">
                  <IconClose className="size-3.5" />
                </IconButton>
              </>
            )}
          </div>
          <IconButton
            label={t("sidebar.project.add")}
            onClick={() => { openProjectPicker(); closeCompactSurface(); }}
            className={headerButton}
          >
            <IconFolderPlus />
          </IconButton>
          <IconButton
            label={t("sidebar.newSession")}
            onClick={() => { openProjectQuickOpen(); closeCompactSurface(); }}
            className={headerButton}
          >
            <IconPlus />
          </IconButton>
        </div>
      </div>

      {/* -------- body -------- */}
      <div className="flex min-h-0 flex-1 flex-col">
        {lists === null ? (
          <SkeletonRows />
        ) : (
          <>
            {lists.active.length > 0 ? (
              <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 py-1">
                {lists.active.map((entry) => (
                  <Row key={rowKey(entry)} entry={entry} onActivate={closeCompactSurface} openSessionMenu={openSessionMenu} />
                ))}
              </div>
            ) : !filtering ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Empty
                  title={t("sidebar.empty.noLive")}
                  hint={t("sidebar.empty.noLiveHint", { hotkey: formatHotkey("mod+shift+n") })}
                  action={
                    <Button variant="solid" onClick={() => { openProjectQuickOpen(); closeCompactSurface(); }}>
                      {t("sidebar.empty.newSession")}
                    </Button>
                  }
                />
              </div>
            ) : lists.settled.length === 0 ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Empty
                  title={t("sidebar.empty.noMatches", { query: query.trim() })}
                  hint={t("sidebar.empty.noMatchesHint")}
                  action={
                    <Button variant="ghost" onClick={() => setQuery("")}>
                      {t("sidebar.filter.clear")}
                    </Button>
                  }
                />
              </div>
            ) : null}
            {lists.settled.length > 0 && (
              <div className={cn("border-t border-line", settledShown ? "flex min-h-0 flex-1 flex-col" : "shrink-0")}>
                {/* The search forces the block open, so the toggle is inert
                    while filtering and the stored choice stays untouched. */}
                <button
                  type="button"
                  aria-expanded={settledShown}
                  disabled={filtering}
                  onClick={() => setSettledOpen(!settledOpen)}
                  className="flex w-full shrink-0 items-center gap-1.5 px-3 pt-2 pb-1 text-left font-mono text-[10px] uppercase text-ink-faint transition-colors duration-150 hover:text-ink-mid focus-visible:text-ink focus-visible:outline-none disabled:hover:text-ink-faint"
                >
                  <Chevron open={settledShown} />
                  {t("sidebar.settled.heading", { n: lists.settled.length })}
                </button>
                {settledShown && (
                  <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 py-1">
                    {lists.settled.map((entry) => (
                      <Row key={rowKey(entry)} entry={entry} onActivate={closeCompactSurface} openSessionMenu={openSessionMenu} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
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
                  className={MENU_ROW}
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
                  className={MENU_ROW}
                >
                  {t("sidebar.session.migrate")}
                </button>
              )}
            </Panel>
          </div>,
          document.body,
        )}

      {/* -------- footer -------- */}
      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2 text-[10px] text-ink-faint">
        <IconButton label={t("sidebar.footer.settings")} onClick={() => { openSettings(); closeCompactSurface(); }}>
          <IconGear />
        </IconButton>
        {hasInstances && (
          <IconButton
            label={t("fleet.sidebar.open")}
            pressed={fleetOpen}
            onClick={() => { openFleet(); closeCompactSurface(); }}
          >
            <IconFleet />
          </IconButton>
        )}
        {unreachable > 0 && (
          <Button
            size="xs"
            variant="ghost"
            tone="rose"
            title={t("sidebar.footer.hostsAttentionTitle")}
            onClick={() => { openSettings("remote-instances"); closeCompactSurface(); }}
          >
            {t("sidebar.footer.hostsAttention", { n: unreachable })}
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Dot tone={totalLive > 0 ? "signal" : "neutral"} />
          <span className="font-mono tabular-nums">{totalLive}</span>
          <span>{t("sidebar.footer.live")}</span>
        </span>
      </footer>
      {!compact && (
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
    <Sheet open={surface === "sessions"} placement="left" label={t("app.compact.sessions")} onClose={closeCompactSurface}>
      {sidebar}
    </Sheet>
  ) : sidebar;
}
