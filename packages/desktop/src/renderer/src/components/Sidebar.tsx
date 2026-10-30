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
import { setSidebarSectionOpen, useSidebarSectionOpen } from "../lib/sidebar-section-open";
import { supportsSessionMigrate } from "../lib/session-migrate";
import { fromDateTimeLocal, snoozePresets, toDateTimeLocal, type SnoozePreset } from "../lib/snooze-until";
import { useStore } from "../store";
import { SessionRow } from "./SessionRow";
import { useBrowserPaneSplitOpen } from "./browser-pane/BrowserPaneSplit";
import { Button, Chevron, ConfirmDialog, Dot, Empty, IconButton, IconClose, IconFleet, IconPlus, IconSearch, Panel, ResizeHandle, Sheet } from "./ui";
import { FIELD } from "./settings/rows";

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

/** Opens a session row's context menu with the items it can accept (#888 Migrate, #895 Ask, #935 Snooze, #981 Pin). */
type OpenSessionMenu = (
  tabId: string,
  event: ReactMouseEvent<HTMLElement>,
  items: { migrate: boolean; ask: boolean; snooze: boolean; snoozed: boolean; pin: boolean; pinned: boolean },
) => void;

interface SessionMenuRequest {
  tabId: string;
  migrate: boolean;
  ask: boolean;
  snooze: boolean;
  snoozed: boolean;
  pin: boolean;
  pinned: boolean;
  x: number;
  y: number;
  trigger: HTMLElement;
}

const MENU_ROW =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";

/** Menu label per timed-snooze preset (issue #979). */
const SNOOZE_PRESET_LABEL = {
  hour: "sidebar.session.snoozeHour",
  evening: "sidebar.session.snoozeEvening",
  morning: "sidebar.session.snoozeMorning",
  nextWeek: "sidebar.session.snoozeNextWeek",
} as const satisfies Record<SnoozePreset, string>;

/** The custom "Snooze until…" picker (issue #979): a local date-time, future only. */
function SnoozeUntilDialog({
  onSnooze,
  onClose,
}: {
  onSnooze: (untilMs: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  // Opens on tomorrow 09:00, the "Tomorrow morning" preset's deadline.
  const [value, setValue] = useState(() => toDateTimeLocal(snoozePresets(new Date()).find((p) => p.preset === "morning")!.untilMs));
  const picked = fromDateTimeLocal(value);
  const untilMs = picked !== null && picked > Date.now() ? picked : null;
  return (
    <ConfirmDialog
      kicker={t("dialog.snoozeUntil.kicker")}
      title={t("dialog.snoozeUntil.title")}
      tone="iris"
      onClose={onClose}
      width="w-[22rem]"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.dialog.cancel")}
          </Button>
          <Button variant="solid" tone="iris" disabled={untilMs === null} onClick={() => untilMs !== null && onSnooze(untilMs)}>
            {t("sidebar.session.snooze")}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-xs text-ink-mid">
        {t("dialog.snoozeUntil.label")}
        <input
          type="datetime-local"
          autoFocus
          value={value}
          min={toDateTimeLocal(Date.now())}
          onChange={(event) => setValue(event.target.value)}
          className={FIELD}
        />
      </label>
      {untilMs === null && <p className="mt-2 text-[11px] text-rose">{t("dialog.snoozeUntil.past")}</p>}
    </ConfirmDialog>
  );
}

/** One sidebar row: a session from this app or a joined instance, any project or a chat. */
function Row({
  entry,
  onActivate,
  openSessionMenu,
  slim,
}: {
  entry: SidebarEntry;
  onActivate: () => void;
  openSessionMenu: OpenSessionMenu;
  slim: boolean;
}) {
  const t = useT();
  // Issue #888: gate the row context menu on the local binary's floor.
  const ompInstalledVersion = useStore((st) => st.ompUpdate.installedVersion);
  const snoozedEnabled = useStore((st) => st.state?.snoozedSectionEnabled === true);
  return (
    <div className={cn(!entry.reachable && "opacity-60")}>
      <SessionRow
        s={entry.session}
        onActivate={onActivate}
        handoff={entry.handoff}
        projectLabel={entry.projectName ?? t("sidebar.session.chat")}
        instanceNickname={entry.nickname}
        density={slim ? "slim" : "tile"}
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
          // Snooze (#935): every reachable row offers it while the setting
          // is on — parking a `missing` record is legitimate.
          const snooze = snoozedEnabled;
          const snoozed = s.snoozed === true;
          // Pin (#981): a live row can pin; any pinned row can unpin, even a
          // settled one that keeps its pin until resume.
          const pinned = typeof s.pinnedAtMs === "number";
          const pin = pinned || s.live === "live";
          if (!migrate && !ask && !snooze && !pin) return;
          openSessionMenu(s.tabId, event, { migrate, ask, snooze, snoozed, pin, pinned });
        }}
      />
    </div>
  );
}

const rowKey = (entry: SidebarEntry): string => `${entry.instanceId ?? "local"}:${entry.session.tabId}`;

/** One collapsible sidebar section: a heading toggle and its row list. The
 *  search forces the block open, so the toggle is inert while filtering and
 *  the stored choice stays untouched (issue #935). An open `grow` section
 *  takes the free height (Snoozed, Settled); a non-growing one sizes to its
 *  rows up to 40% of the body and scrolls inside, so Working stays docked on
 *  the section below it (issue #937). */
function SidebarSection({
  heading,
  entries,
  shown,
  grow,
  disabled,
  onToggle,
  onActivate,
  openSessionMenu,
  slim,
}: {
  heading: string;
  entries: SidebarEntry[];
  shown: boolean;
  grow: boolean;
  disabled: boolean;
  onToggle: () => void;
  onActivate: () => void;
  openSessionMenu: OpenSessionMenu;
  /** Settled rows render slim; every other section renders tiles (issue #938). */
  slim: boolean;
}) {
  return (
    <div
      className={cn(
        "border-t border-line",
        !shown
          ? "shrink-0"
          : grow
            ? "flex min-h-0 flex-1 flex-col"
            : "flex max-h-[40%] min-h-0 shrink-0 flex-col",
      )}
    >
      <button
        type="button"
        aria-expanded={shown}
        disabled={disabled}
        onClick={onToggle}
        className="flex w-full shrink-0 items-center gap-1.5 px-3 pt-2 pb-1 text-left font-mono text-[10px] uppercase text-ink-faint transition-colors duration-150 hover:text-ink-mid focus-visible:text-ink focus-visible:outline-none disabled:hover:text-ink-faint"
      >
        <Chevron open={shown} />
        {heading}
      </button>
      {shown && entries.length > 0 && (
        <div className={cn("min-h-0 overflow-y-auto px-1.5 py-1", slim ? "space-y-px" : "space-y-1", grow && "flex-1")}>
          {entries.map((entry) => (
            <Row key={rowKey(entry)} entry={entry} onActivate={onActivate} openSessionMenu={openSessionMenu} slim={slim} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ sidebar */

export function Sidebar() {
  const t = useT();
  const state = useStore((st) => st.state);
  const openProjectQuickOpen = useStore((st) => st.openProjectQuickOpen);
  const openSettings = useStore((st) => st.openSettings);
  const openMigrateDialog = useStore((st) => st.openMigrateDialog);
  const askAboutSession = useStore((st) => st.askAboutSession);
  const setSessionSnoozed = useStore((st) => st.setSessionSnoozed);
  const setSessionPinned = useStore((st) => st.setSessionPinned);
  const compact = useCompactShell();
  const surface = useStore((st) => st.compactSurface);
  const closeCompactSurface = useStore((st) => st.closeCompactSurface);
  const openFleet = useStore((st) => st.openFleet);
  const fleetOpen = useStore((st) => st.fleet !== null);
  const settledOpen = useSettledOpen();
  const workingOpen = useSidebarSectionOpen("omp-ui.sidebarWorkingOpen", true);
  const snoozedOpen = useSidebarSectionOpen("omp-ui.sidebarSnoozedOpen", false);

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
  // Timed snooze's custom picker (issue #979): the tab it will snooze, or closed.
  const [snoozeCustomTabId, setSnoozeCustomTabId] = useState<string | null>(null);

  // Issue #888/#895: the per-row Migrate/Ask menu.
  const openSessionMenu: OpenSessionMenu = (tabId, event, { migrate, ask, snooze, snoozed, pin, pinned }) => {
    event.preventDefault();
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) return;
    const keyboardPosition = event.clientX === 0 && event.clientY === 0;
    const rect = currentTarget.getBoundingClientRect();
    setSessionMenu({
      tabId,
      migrate,
      ask,
      snooze,
      snoozed,
      pin,
      pinned,
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
  // "No running sessions" fires only with no live row anywhere (pinned,
  // active, working, or a live snoozed row); "Nothing matches" only when no
  // row at all survives the filter. A dormant snoozed row is a row, so it
  // counts toward anyRow even though it is not live (issue #935).
  const liveAnywhere =
    lists !== null &&
    (lists.pinned.length > 0 ||
      lists.active.length > 0 ||
      lists.working.length > 0 ||
      lists.snoozed.some((e) => e.session.live === "live"));
  const anyRow =
    lists !== null &&
    (lists.pinned.length > 0 ||
      lists.active.length > 0 ||
      lists.working.length > 0 ||
      lists.snoozed.length > 0 ||
      lists.settled.length > 0);

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
  const workingShown = workingOpen || filtering;
  const snoozedShown = snoozedOpen || filtering;

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
                  {lists === null
                    ? 0
                    : lists.pinned.length + lists.active.length + lists.working.length + lists.snoozed.length + lists.settled.length}
                </span>
                <IconButton label={t("sidebar.filter.clear")} onClick={() => setQuery("")} className="size-5">
                  <IconClose className="size-3.5" />
                </IconButton>
              </>
            )}
          </div>
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
            {lists.pinned.length > 0 || lists.active.length > 0 ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
                {/* Pinned (#981) heads the main list in pin order; it never
                    collapses, since a pin means "keep this in view". */}
                {lists.pinned.length > 0 && (
                  <div role="group" aria-label={t("sidebar.pinned.heading", { n: lists.pinned.length })} className="space-y-1">
                    <div className="px-1.5 pt-1 pb-0.5 font-mono text-[10px] uppercase text-ink-faint">
                      {t("sidebar.pinned.heading", { n: lists.pinned.length })}
                    </div>
                    {lists.pinned.map((entry) => (
                      <Row key={rowKey(entry)} entry={entry} onActivate={closeCompactSurface} openSessionMenu={openSessionMenu} slim={false} />
                    ))}
                  </div>
                )}
                {lists.active.length > 0 && (
                  <div className={cn("space-y-1", lists.pinned.length > 0 && "mt-1.5 border-t border-line-soft pt-1.5")}>
                    {lists.active.map((entry) => (
                      <Row key={rowKey(entry)} entry={entry} onActivate={closeCompactSurface} openSessionMenu={openSessionMenu} slim={false} />
                    ))}
                  </div>
                )}
              </div>
            ) : !filtering && !liveAnywhere ? (
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
            ) : filtering && !anyRow ? (
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
            ) : (
              // An empty main list still owns the free height, so the headed
              // sections below stay docked at the bottom of the sidebar (issue #937).
              <div aria-hidden className="min-h-0 flex-1" />
            )}
            {lists.snoozed.length > 0 && (
              <SidebarSection
                heading={t("sidebar.snoozed.heading", { n: lists.snoozed.length })}
                entries={lists.snoozed}
                shown={snoozedShown}
                grow
                disabled={filtering}
                onToggle={() => setSidebarSectionOpen("omp-ui.sidebarSnoozedOpen", !snoozedOpen)}
                onActivate={closeCompactSurface}
                openSessionMenu={openSessionMenu}
                slim={false}
              />
            )}
            <SidebarSection
              heading={t("sidebar.working.heading", { n: lists.working.length })}
              entries={lists.working}
              shown={workingShown}
              grow={false}
              disabled={filtering}
              onToggle={() => setSidebarSectionOpen("omp-ui.sidebarWorkingOpen", !workingOpen)}
              onActivate={closeCompactSurface}
              openSessionMenu={openSessionMenu}
              slim={false}
            />
            {lists.settled.length > 0 && (
              <SidebarSection
                heading={t("sidebar.settled.heading", { n: lists.settled.length })}
                entries={lists.settled}
                shown={settledShown}
                grow
                disabled={filtering}
                onToggle={() => setSettledOpen(!settledOpen)}
                onActivate={closeCompactSurface}
                openSessionMenu={openSessionMenu}
                slim
              />
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
              {sessionMenu.pin && (
                <button
                  ref={sessionMenu.ask || sessionMenu.migrate ? undefined : sessionMenuItemRef}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const { tabId, pinned } = sessionMenu;
                    setSessionMenu(null);
                    void setSessionPinned(tabId, !pinned);
                  }}
                  className={MENU_ROW}
                >
                  {t(sessionMenu.pinned ? "sidebar.session.unpin" : "sidebar.session.pin")}
                </button>
              )}
              {sessionMenu.snooze && (
                <button
                  ref={sessionMenu.ask || sessionMenu.migrate || sessionMenu.pin ? undefined : sessionMenuItemRef}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const { tabId, snoozed } = sessionMenu;
                    setSessionMenu(null);
                    void setSessionSnoozed(tabId, !snoozed);
                  }}
                  className={MENU_ROW}
                >
                  {t(sessionMenu.snoozed ? "sidebar.session.unsnooze" : "sidebar.session.snooze")}
                </button>
              )}
              {/* Timed snooze (#979): presets resolve against the clock at open. */}
              {sessionMenu.snooze && !sessionMenu.snoozed && (
                <>
                  {snoozePresets(new Date()).map(({ preset, untilMs }) => (
                    <button
                      key={preset}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const { tabId } = sessionMenu;
                        setSessionMenu(null);
                        void setSessionSnoozed(tabId, true, untilMs);
                      }}
                      className={MENU_ROW}
                    >
                      {t(SNOOZE_PRESET_LABEL[preset])}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const { tabId } = sessionMenu;
                      setSessionMenu(null);
                      setSnoozeCustomTabId(tabId);
                    }}
                    className={MENU_ROW}
                  >
                    {t("sidebar.session.snoozeCustom")}
                  </button>
                </>
              )}
            </Panel>
          </div>,
          document.body,
        )}
      {snoozeCustomTabId !== null && (
        <SnoozeUntilDialog
          onClose={() => setSnoozeCustomTabId(null)}
          onSnooze={(untilMs) => {
            const tabId = snoozeCustomTabId;
            setSnoozeCustomTabId(null);
            void setSessionSnoozed(tabId, true, untilMs);
          }}
        />
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
