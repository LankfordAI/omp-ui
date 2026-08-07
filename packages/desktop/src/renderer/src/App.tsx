import { useEffect } from "react";
import { AppUpdateCard } from "./components/AppUpdateCard";
import { CommandPalette, openPalette } from "./components/CommandPalette";
import { DeleteSessionDialog } from "./components/DeleteSessionDialog";
import { inspectorBadges } from "./components/InspectorRail";
import { McpManager } from "./components/McpManager";
import { OmpUpdateCard } from "./components/OmpUpdateCard";
import { ProjectPicker } from "./components/ProjectPicker";
import { RpcTab } from "./components/RpcTab";
import { SessionHud } from "./components/SessionHud";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { TerminalTab } from "./components/TerminalTab";
import { Button, Chevron, Chip, IconButton } from "./components/ui";
import { cn } from "./lib/cn";
import { formatHotkey, useHotkeys } from "./lib/hotkeys";
import { IS_MAC, IS_WINDOWS } from "./lib/platform";
import { resetTranscriptScale, stepTranscriptScale } from "./lib/text-scale";
import { useAppViewport, useCompactShell } from "./lib/responsive";
import { findRecord, useStore } from "./store";

/** The shortcuts the chrome actually registers, spelled out for newcomers. */
const HINTS: [combo: string, what: string][] = [
  ["mod+k", "command palette"],
  ["mod+shift+n", "new session in the current project"],
  ["mod+j", "toggle console"],
  ["mod+=", "larger transcript text"],
];

// The native overlay rect is composited over the strip's right end; reserve
// its width so bar content never slides under the min/max/close buttons.
// 138 = 3×46px Windows caption buttons. On Linux the GTK theme paints them
// (~44px each under adwaita) and no API reports the width, so 132 is a
// visual-fit value — if a theme draws wider buttons, adjust this one line.
// macOS paints no overlay; its traffic lights sit top-left, so the inset
// moves to the left edge instead.
const OVERLAY_INSET = IS_MAC ? 0 : IS_WINDOWS ? 138 : 132;
const TRAFFIC_LIGHT_INSET = IS_MAC ? 78 : 0;

/** Plus — new session, matching the sidebar's per-project `+` affordances. */
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

/**
 * The native frame is hidden (titleBarStyle: "hidden" + overlay controls in
 * main/index.ts), so this strip IS the window title bar — and the app's only
 * chrome row (issue #60): app identity and sidebar controls on the left, the
 * active session's HUD (rpc-ui) or bare title (terminal) in the middle, and
 * room reserved for the native min/max/close overlay on the right. The strip
 * is flat bg-void with no ambient texture because the overlay can only
 * composite a flat colour — a textured strip read as a shade mismatch under
 * the buttons (issue #59). Height matches the 36px titleBarOverlay so the
 * native controls sit flush.
 * The hairline under this strip must NOT be a border-b here: the overlay
 * rect is composited over web content and would cover its right end (the
 * segment under the min/max/close buttons). It lives as a border-t on the
 * content wrapper below, the first row the overlay doesn't reach.
 */
function TitleBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const title = useStore((s) =>
    s.activeTabId ? (findRecord(s.state, s.activeTabId)?.title ?? null) : null,
  );
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useStore((s) => s.toggleSidebarCollapsed);
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const newSession = useStore((s) => s.newSession);
  const activeTab = tabs.find((t) => t.tabId === activeTabId);
  // Same rule as the mod+shift+n hotkey below: the active tab's project only —
  // with nowhere to spawn, the button disables rather than choose implicitly.
  const newSessionProject = activeTab?.projectCwd;

  return (
    <header
      className="relative flex h-9 shrink-0 select-none items-center gap-1 bg-void [app-region:drag]"
      style={TRAFFIC_LIGHT_INSET > 0 ? { paddingLeft: TRAFFIC_LIGHT_INSET } : undefined}
    >
      <div className="flex shrink-0 items-center gap-1 pl-3 [app-region:no-drag]">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-signal" />
        <span className="pr-1 font-display text-sm font-semibold tracking-tight text-ink">
          omp<span className="text-ink-faint">-ui</span>
        </span>
        <IconButton
          label="new session in current project"
          disabled={newSessionProject === undefined}
          onClick={() => {
            if (newSessionProject !== undefined) void newSession(newSessionProject);
          }}
        >
          <IconPlus />
        </IconButton>
        <IconButton label="add project" onClick={openProjectPicker}>
          <IconFolderPlus />
        </IconButton>
        <IconButton
          label={sidebarCollapsed ? "expand sidebar" : "collapse sidebar"}
          onClick={toggleSidebarCollapsed}
        >
          <Chevron open={false} className={cn("size-3.5", !sidebarCollapsed && "rotate-180")} />
        </IconButton>
      </div>

      {activeTab?.mode === "rpc-ui" ? (
        <SessionHud tabId={activeTab.tabId} />
      ) : (
        <>
          {title && (
            <span className="min-w-0 truncate px-2 text-xs text-ink-dim [app-region:no-drag]">
              {title}
            </span>
          )}
          <span className="min-w-0 flex-1" />
        </>
      )}

      {OVERLAY_INSET > 0 && <div className="h-full shrink-0" style={{ width: OVERLAY_INSET }} />}
    </header>
  );
}

/**
 * Quiet boot surface shown while init's tier-3 restore resumes the previous
 * run's tabs (issue #99). Renders in place of the Welcome screen so the app
 * is clearly doing something, without flashing the empty landing page mid
 * restore.
 */
function RestoringSessions() {
  return (
    <div className="ambient flex h-full flex-col items-center justify-center bg-void px-5">
      <p className="font-display text-sm text-ink-dim">Restoring sessions…</p>
    </div>
  );
}

function Welcome() {
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const hasProjects = useStore((s) => (s.state?.projects.length ?? 0) > 0);

  return (
    <div className="ambient flex h-full flex-col items-center justify-center bg-void px-5">
      <div className="animate-rise flex w-full max-w-[26rem] flex-col items-center gap-5 text-center">
        <div className="flex flex-col items-center gap-1.5">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">omp-ui</h1>
          <p className="text-balance-tight text-sm leading-relaxed text-ink-dim">
            {hasProjects
              ? "Pick a session from the sidebar, or start a new one in any tracked project."
              : "Track a project directory, then run omp agents against it — as a terminal or as a native session."}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="solid" onClick={openProjectPicker}>
            Add project
          </Button>
          {hasProjects && (
            <Button variant="ghost" onClick={() => openPalette()}>
              Open session…
            </Button>
          )}
        </div>

        <dl className="compact-welcome-hints mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-left">
          {HINTS.map(([combo, what]) => (
            <div key={combo} className="col-span-2 grid grid-cols-subgrid items-center">
              <dt className="justify-self-end rounded border border-line bg-raised px-1.5 py-px font-mono text-[10px] leading-4 text-ink-mid">
                {formatHotkey(combo)}
              </dt>
              <dd className="text-[11px] text-ink-faint">{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export default function App() {
  const init = useStore((s) => s.init);
  const tabs = useStore((s) => s.tabs);
  const restoringTabs = useStore((s) => s.restoringTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const deleteConfirmation = useStore((s) => s.deleteConfirmation);
  const projectPickerOpen = useStore((s) => s.projectPickerOpen);
  const mcpManager = useStore((s) => s.mcpManager);
  const newSession = useStore((s) => s.newSession);
  const settingsPage = useStore((s) => s.settingsPage);
  const openSettings = useStore((s) => s.openSettings);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const activeRecord = useStore((s) => (s.activeTabId ? findRecord(s.state, s.activeTabId) : undefined));
  const activeRuntime = useStore((s) => (s.activeTabId ? s.rpc[s.activeTabId] : undefined));
  const showCompactSurface = useStore((s) => s.showCompactSurface);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  const compact = useCompactShell();
  useAppViewport();

  // The keyboard twin of the composer's /new: a new live session in the current
  // tab's project. No current project (nothing focused yet, or every tab hidden)
  // means nowhere to spawn — the key deliberately does nothing rather than
  // choose a project implicitly.
  useHotkeys({
    "mod+shift+n": (e) => {
      e.preventDefault();
      const projectCwd = tabs.find((t) => t.tabId === activeTabId)?.projectCwd;
      if (projectCwd !== undefined) void newSession(projectCwd);
    },
    // Console drawer (issue #33): rpc-ui tabs only — terminal tabs have no console.
    "mod+j": (e) => {
      e.preventDefault();
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (tab?.mode === "rpc-ui") toggleConsole(tab.tabId);
    },
    // Transcript text scale (issue #30). Registered app-wide: the combos are
    // free because Electron zoom is disabled, and a scale keystroke with no
    // transcript visible is harmless.
    "mod+=": (e) => {
      e.preventDefault();
      stepTranscriptScale(1);
    },
    // Ctrl+Shift+= is how many keyboards actually type "+"; UNSHIFT maps the
    // key back to "=" but keeps the shift modifier, so it needs its own entry.
    "mod+shift+=": (e) => {
      e.preventDefault();
      stepTranscriptScale(1);
    },
    "mod+-": (e) => {
      e.preventDefault();
      stepTranscriptScale(-1);
    },
    "mod+0": (e) => {
      e.preventDefault();
      resetTranscriptScale();
    },
    // Settings modal (issue #36). The combo is free — Electron menus don't
    // claim it — and matches the platform convention for preferences.
    "mod+,": (e) => {
      e.preventDefault();
      openSettings();
    },
  });

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    closeCompactSurface();
  }, [activeTabId, compact, closeCompactSurface]);

  const visibleTabs = tabs.filter((t) => !t.hidden);
  const activeTab = tabs.find((tab) => tab.tabId === activeTabId);
  const activeTitle = activeRecord?.title ?? "projects and sessions";
  const badges = activeTab?.mode === "rpc-ui" ? inspectorBadges(activeRuntime) : null;
  const inspectorCount = badges ? badges.todos + badges.agents + badges.plans : 0;

  return (
    <div className="relative flex h-[var(--app-viewport-height,100dvh)] flex-col overflow-hidden bg-void font-sans text-ink">
      {!compact && <TitleBar />}
      {compact && (
        <nav className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line bg-void px-[max(0.5rem,var(--safe-left))] pt-[var(--safe-top)] pr-[max(0.5rem,var(--safe-right))]">
          <Button variant="ghost" className="min-w-11 px-2" onClick={() => showCompactSurface("sessions")}>
            <span aria-hidden>☰</span><span className="sr-only">projects and sessions</span>
          </Button>
          <button type="button" className="min-w-0 flex-1 truncate px-2 text-center font-display text-sm font-semibold" onClick={() => showCompactSurface("sessions")}>{activeTitle}</button>
          {activeTab?.mode === "rpc-ui" ? (
            <Button variant="ghost" className="min-w-11 justify-center px-2" onClick={() => showCompactSurface("inspector")}>
              <span aria-hidden>◎</span><span className="sr-only">inspector</span>
              {inspectorCount > 0 && <Chip tone="copper" mono>{inspectorCount}</Chip>}
            </Button>
          ) : <span className="w-11" />}
        </nav>
      )}
      <div className="flex min-h-0 flex-1 border-t border-line">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            {/*
             * Every tab stays mounted and is toggled with `display` only: hiding
             * a tab must not unmount it, or its xterm instance and rpc state die
             * with it and the session becomes unrecoverable in place.
             */}
            {tabs.map((t) => {
              const shown = t.tabId === activeTabId && !t.hidden;
              return (
                <div
                  key={t.tabId}
                  className="absolute inset-0"
                  style={{ display: shown ? "block" : "none" }}
                >
                  {t.mode === "rpc-ui" ? (
                    <RpcTab tabId={t.tabId} active={shown} />
                  ) : (
                    <TerminalTab tabId={t.tabId} active={shown} />
                  )}
                </div>
              );
            })}
            {visibleTabs.length === 0 && (restoringTabs ? <RestoringSessions /> : <Welcome />)}
          </div>
        </div>
      </div>
      <CommandPalette />
      {/* Both update cards share one corner stack (issue #19): cards that
          render null leave no gap; when both show, the app card sits on top. */}
      <div className="fixed right-[max(1rem,var(--safe-right))] bottom-[max(1rem,var(--safe-bottom))] z-40 flex w-80 max-w-[calc(100vw-var(--safe-left)-var(--safe-right)-2rem)] flex-col gap-2">
        <AppUpdateCard />
        <OmpUpdateCard />
      </div>
      {deleteConfirmation && (
        <DeleteSessionDialog key={deleteConfirmation.tabId} confirmation={deleteConfirmation} />
      )}
      {projectPickerOpen && <ProjectPicker />}
      {mcpManager && <McpManager tabId={mcpManager.tabId} projectCwd={mcpManager.projectCwd} />}
      {settingsPage && <Settings />}
    </div>
  );
}
