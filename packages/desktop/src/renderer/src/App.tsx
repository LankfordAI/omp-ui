import { useEffect } from "react";
import { AppFeedback } from "./components/AppFeedback";
import { AppUpdateCard } from "./components/AppUpdateCard";
import { CommandPalette, openPalette } from "./components/CommandPalette";
import { DeleteSessionDialog } from "./components/DeleteSessionDialog";
import { inspectorBadges } from "./components/InspectorRail";
import { CapabilitiesViewer } from "./components/CapabilitiesViewer";
import { NewWorktreeSessionDialog } from "./components/NewWorktreeSessionDialog";
import { ProjectSettings } from "./components/ProjectSettings";
import { OmpUpdateCard } from "./components/OmpUpdateCard";
import { ProjectPicker } from "./components/ProjectPicker";
import { RpcTab } from "./components/RpcTab";
import { SessionHud } from "./components/SessionHud";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { TerminalTab } from "./components/TerminalTab";
import { Button, Chevron, IconButton, IconPlus } from "./components/ui";
import { cn } from "./lib/cn";
import { formatHotkey, useHotkeys } from "./lib/hotkeys";
import { useT, type MessageKey } from "./lib/i18n";
import { IS_ELECTRON, IS_MAC, IS_WINDOWS } from "./lib/platform";
import { resetTranscriptScale, stepTranscriptScale } from "./lib/text-scale";
import { useAppViewport, useCompactShell } from "./lib/responsive";
import { findRecord, useStore } from "./store";

/** The shortcuts the chrome actually registers, spelled out for newcomers. */
const HINTS: [combo: string, what: MessageKey][] = [
  ["mod+k", "app.welcome.hintCommandPalette"],
  ["mod+shift+n", "app.welcome.hintNewSession"],
  ["mod+shift+p", "app.welcome.hintMode"],
  ["mod+j", "app.welcome.hintConsole"],
  ["mod+f", "app.welcome.hintSearch"],
  ["mod+=", "app.welcome.hintTranscriptScale"],
];

// The native overlay rect is composited over the strip's right end; reserve
// its width so bar content never slides under the min/max/close buttons.
// 138 = 3×46px Windows caption buttons. On Linux the GTK theme paints them
// (~44px each under adwaita) and no API reports the width, so 132 is a
// visual-fit value — if a theme draws wider buttons, adjust this one line.
// macOS paints no overlay; its traffic lights sit top-left, so the inset
// moves to the left edge instead.
// Both insets are Electron-only: the remote web client (#37) serves this same
// bundle to a browser tab, where there are no caption buttons to avoid, so
// every use is gated on IS_ELECTRON (#122).
const OVERLAY_INSET = IS_MAC ? 0 : IS_WINDOWS ? 138 : 132;
const TRAFFIC_LIGHT_INSET = IS_MAC ? 78 : 0;


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

/** Hamburger — the compact shell's projects-and-sessions trigger. */
function IconMenu() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
    >
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </svg>
  );
}

/** Side panel — the compact shell's inspector trigger, echoing the rail. */
function IconInspect() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
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
 * Drag polarity: this header is the window's drag region, and every
 * interactive or hover-informative box inside it — here and in SessionHud's
 * wide branch — must carve itself out with [app-region:no-drag]. Draggable
 * regions ignore all pointer events, and a no-drag box wrapped around a
 * flex-1 container removes the whole drag affordance (issue #108). The
 * OVERLAY_INSET spacer below is deliberately left undeclared: it stays
 * draggable, and the native overlay hit test owns it anyway.
 */
function TitleBar() {
  const t = useT();
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
      style={
        IS_ELECTRON && TRAFFIC_LIGHT_INSET > 0 ? { paddingLeft: TRAFFIC_LIGHT_INSET } : undefined
      }
    >
      <div className="flex shrink-0 items-center gap-1 pl-3 [app-region:no-drag]">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-signal" />
        <span className="titlebar-brand pr-1 font-display text-sm font-semibold tracking-tight text-ink">
          omp<span className="text-ink-faint">-ui</span>
        </span>
        <IconButton
          label={t("app.titlebar.newSession")}
          disabled={newSessionProject === undefined}
          onClick={() => {
            if (newSessionProject !== undefined) void newSession(newSessionProject);
          }}
        >
          <IconPlus />
        </IconButton>
        <IconButton label={t("app.titlebar.addProject")} onClick={openProjectPicker}>
          <IconFolderPlus />
        </IconButton>
        <IconButton
          label={sidebarCollapsed ? t("app.titlebar.expandSidebar") : t("app.titlebar.collapseSidebar")}
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

      {IS_ELECTRON && OVERLAY_INSET > 0 && (
        <div className="h-full shrink-0" style={{ width: OVERLAY_INSET }} />
      )}
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
  const t = useT();
  return (
    <div className="ambient flex h-full flex-col items-center justify-center bg-void px-5">
      <p className="font-display text-sm text-ink-dim">{t("app.restoring.label")}</p>
    </div>
  );
}

function Welcome() {
  const t = useT();
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const hasProjects = useStore((s) => (s.state?.projects.length ?? 0) > 0);

  return (
    <div className="ambient flex h-full flex-col items-center justify-center bg-void px-5">
      <div className="animate-rise flex w-full max-w-[26rem] flex-col items-center gap-5 text-center">
        <div className="flex flex-col items-center gap-1.5">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">omp-ui</h1>
          <p className="text-balance-tight text-sm leading-relaxed text-ink-dim">
            {hasProjects
              ? t("app.welcome.hasProjectsHint")
              : t("app.welcome.noProjectsHint")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="solid" onClick={openProjectPicker}>
            {t("app.welcome.addProject")}
          </Button>
          {hasProjects && (
            <Button variant="ghost" onClick={() => openPalette()}>
              {t("app.welcome.openSession")}
            </Button>
          )}
        </div>

        <dl className="compact-welcome-hints mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-left">
          {HINTS.map(([combo, what]) => (
            <div key={combo} className="col-span-2 grid grid-cols-subgrid items-center">
              <dt className="justify-self-end rounded border border-line bg-raised px-1.5 py-px font-mono text-[10px] leading-4 text-ink-mid">
                {formatHotkey(combo)}
              </dt>
              <dd className="text-[11px] text-ink-faint">{t(what)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export default function App() {
  const t = useT();
  const init = useStore((s) => s.init);
  const tabs = useStore((s) => s.tabs);
  const restoringTabs = useStore((s) => s.restoringTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const deleteConfirmation = useStore((s) => s.deleteConfirmation);
  const projectPickerOpen = useStore((s) => s.projectPickerOpen);
  const capabilitiesViewer = useStore((s) => s.capabilitiesViewer);
	const projectSettings = useStore((s) => s.projectSettings);
	const closeProjectSettings = useStore((s) => s.closeProjectSettings);
	const state = useStore((s) => s.state);
  const worktreeDialogProject = useStore((s) => s.worktreeDialogProject);
  const newSession = useStore((s) => s.newSession);
  const settingsPage = useStore((s) => s.settingsPage);
  const openSettings = useStore((s) => s.openSettings);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const setPlanMode = useStore((s) => s.setPlanMode);
  const activeRecord = useStore((s) => (s.activeTabId ? findRecord(s.state, s.activeTabId) : undefined));
  const activeRuntime = useStore((s) => (s.activeTabId ? s.rpc[s.activeTabId] : undefined));
  const showCompactSurface = useStore((s) => s.showCompactSurface);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  const compact = useCompactShell();
  useAppViewport();
	const projectSettingsProject =
		projectSettings === null
			? null
			: state?.projects.find((g) => g.project.path === projectSettings.projectCwd)?.project ?? null;

  // The viewer is pinned to the record it captured: a focus change never
  // retargets it, but deleting the pinned session closes it (the same
  // lookup-enforced auto-close as the project dialog above).
	const capabilitiesModal =
		capabilitiesViewer === null ||
		(capabilitiesViewer.tabId !== undefined &&
			state !== null &&
			findRecord(state, capabilitiesViewer.tabId) === undefined)
			? null
			: capabilitiesViewer;

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
    // The keyboard twin of the composer's Build / Plan selector: the same
    // in-process switch (ADR-0007), never a respawn. rpc-ui tabs only — a pty tab's TUI
    // owns plan mode. A mod combo so it fires mid-draft (hotkeys.ts
    // suppresses bare combos in typing targets); focus never moves, so a
    // partially typed prompt survives.
    "mod+shift+p": (e) => {
      e.preventDefault();
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (tab?.mode !== "rpc-ui") return;
      const plan = activeRuntime?.plan;
      if (plan?.unavailable !== undefined) return;
      void setPlanMode(tab.tabId, !(plan?.enabled ?? false));
    },
    // Console drawer (issue #33): rpc-ui tabs only — terminal tabs have no console.
    "mod+j": (e) => {
      e.preventDefault();
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (tab?.mode === "rpc-ui") toggleConsole(tab.tabId);
    },
    // In-session search (issue #270): one find bar per tab — the
    // transcript items of an rpc-ui tab, the xterm scrollback of a
    // terminal tab. No-op where there is no surface behind the bar
    // (subagent view, plan-review dock, exited session); refocuses
    // its input when the bar is already open. A mod combo, so it
    // fires from the composer or the xterm textarea alike.
    "mod+f": (e) => {
      e.preventDefault();
      if (activeTabId === null) return;
      const tab = tabs.find((t) => t.tabId === activeTabId);
      const s = useStore.getState();
      if (!tab || s.exited[activeTabId] !== undefined) return;
      if (tab.mode === "rpc-ui") {
        const rpc = s.rpc[activeTabId];
        if (rpc?.selectedSubagent) return;
        if (rpc?.planReview != null && rpc.planDeferred !== true) return;
      }
      if (s.searchOpen[activeTabId]) {
        document
          .querySelector<HTMLInputElement>(`[data-tab-id="${CSS.escape(activeTabId)}"] .find-bar-input`)
          ?.focus();
        return;
      }
      s.openSearch(activeTabId);
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
  const activeTitle = activeRecord?.title ?? t("app.compact.projectsAndSessions");
  const badges = activeTab?.mode === "rpc-ui" ? inspectorBadges(activeRuntime) : null;
  const inspectorCount = badges ? badges.todos + badges.agents + badges.plans : 0;

  return (
    <div className="relative flex h-[var(--app-viewport-height,100dvh)] flex-col overflow-hidden bg-void font-sans text-ink">
      {!compact && <TitleBar />}
      {compact && (
        /*
         * The compact shell has no TitleBar, so this row is the window's only
         * web drag surface (issue #121). Same contract as TitleBar above: the
         * nav is the drag region and every control carves itself back out.
         * The title deliberately is NOT the flex-1 box — a no-drag flex-1
         * would eat the whole affordance (#108). It sits inside a draggable
         * flex-1 span and is capped so at least 4rem of grabbable row remains
         * however long the session title is.
         */
        <nav
          className="flex min-h-11 shrink-0 items-center gap-1 border-b border-line bg-void px-[max(0.25rem,var(--safe-left))] pt-[var(--safe-top)] pr-[max(0.25rem,var(--safe-right))] [app-region:drag]"
          style={IS_ELECTRON && TRAFFIC_LIGHT_INSET > 0 ? { paddingLeft: TRAFFIC_LIGHT_INSET } : undefined}
        >
          <Button variant="ghost" className="h-11 min-w-11 justify-center px-2 text-ink-mid [app-region:no-drag]" onClick={() => showCompactSurface("sessions")}>
            <IconMenu />
            <span className="sr-only">{t("app.compact.projectsAndSessions")}</span>
          </Button>
          <span className="min-w-0 flex-1 text-center">
            <button type="button" className="max-w-[calc(100%-4rem)] truncate px-2 py-2 text-center font-display text-sm font-semibold [app-region:no-drag]" onClick={() => showCompactSurface("sessions")}>{activeTitle}</button>
          </span>
          {activeTab?.mode === "rpc-ui" ? (
            <Button variant="ghost" className="relative h-11 min-w-11 justify-center px-2 text-ink-mid [app-region:no-drag]" onClick={() => showCompactSurface("inspector")}>
              <IconInspect />
              <span className="sr-only">{t("app.compact.inspector")}</span>
              {inspectorCount > 0 && (
                <span aria-hidden className="absolute right-1 top-1.5 min-w-3.5 rounded-full bg-copper-wash px-1 text-center font-mono text-[9px] leading-3.5 text-copper">
                  {inspectorCount > 99 ? "99+" : inspectorCount}
                </span>
              )}
            </Button>
          ) : <span className="w-11" />}
          {/* Reserve the caption-button strip so no control slides under it.
              Left undeclared, like TitleBar's: the native overlay owns the hit
              test there anyway. */}
          {IS_ELECTRON && OVERLAY_INSET > 0 && <div className="h-full shrink-0" style={{ width: OVERLAY_INSET }} />}
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
                  data-tab-id={t.tabId}
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
      {capabilitiesModal !== null && (
        <CapabilitiesViewer
          scopeCwd={capabilitiesModal.scopeCwd}
          tabId={capabilitiesModal.tabId}
          section={capabilitiesModal.section}
        />
      )}
			{projectSettingsProject !== null && (
				<ProjectSettings project={projectSettingsProject} onClose={closeProjectSettings} />
			)}
      {worktreeDialogProject !== null && <NewWorktreeSessionDialog projectCwd={worktreeDialogProject} />}
      {settingsPage && <Settings />}
      {/* Feedback last of the root surfaces: its dialogs must outrank every
          other overlay in the stack (issue #373). */}
      <AppFeedback />
    </div>
  );
}
