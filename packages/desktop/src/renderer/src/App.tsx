import { useEffect } from "react";
import { AppUpdateCard } from "./components/AppUpdateCard";
import { CommandPalette, openPalette } from "./components/CommandPalette";
import { DeleteSessionDialog } from "./components/DeleteSessionDialog";
import { McpManager } from "./components/McpManager";
import { OmpUpdateCard } from "./components/OmpUpdateCard";
import { ProjectPicker } from "./components/ProjectPicker";
import { RpcTab } from "./components/RpcTab";
import { Sidebar } from "./components/Sidebar";
import { TerminalTab } from "./components/TerminalTab";
import { Button } from "./components/ui";
import { formatHotkey, useHotkeys } from "./lib/hotkeys";
import { resetTranscriptScale, stepTranscriptScale } from "./lib/text-scale";
import { findRecord, useStore } from "./store";

/** The shortcuts the chrome actually registers, spelled out for newcomers. */
const HINTS: [combo: string, what: string][] = [
  ["mod+k", "command palette"],
  ["mod+shift+n", "new session in the current project"],
  ["mod+j", "toggle console"],
  ["mod+=", "larger transcript text"],
];

/**
 * The native frame is hidden (titleBarStyle: "hidden" + overlay controls in
 * main/index.ts), so this strip IS the window title bar: it carries the drag
 * region and echoes the active session title the way an OS frame would.
 * Height matches the 36px titleBarOverlay so the native controls sit flush.
 * The hairline under this strip must NOT be a border-b here: the overlay
 * rect is composited over web content and would cover its right end (the
 * segment under the min/max/close buttons). It lives as a border-t on the
 * content wrapper below, the first row the overlay doesn't reach.
 */
function TitleBar() {
  const title = useStore((s) =>
    s.activeTabId ? (findRecord(s.state, s.activeTabId)?.title ?? null) : null,
  );

  return (
    <header className="relative flex h-9 shrink-0 select-none items-center justify-center bg-void [app-region:drag]">
      {title ? (
        <span className="max-w-[50%] truncate text-xs text-ink-dim">{title}</span>
      ) : (
        <span className="font-display text-xs font-semibold tracking-tight text-ink-mid">
          omp<span className="text-ink-faint">-ui</span>
        </span>
      )}
    </header>
  );
}

function Welcome() {
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const hasProjects = useStore((s) => (s.state?.projects.length ?? 0) > 0);

  return (
    <div className="grain flex h-full flex-col items-center justify-center bg-void">
      <div className="animate-rise flex w-[26rem] flex-col items-center gap-5 text-center">
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

        <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-left">
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
  const activeTabId = useStore((s) => s.activeTabId);
  const deleteConfirmation = useStore((s) => s.deleteConfirmation);
  const projectPickerOpen = useStore((s) => s.projectPickerOpen);
  const mcpManager = useStore((s) => s.mcpManager);
  const newSession = useStore((s) => s.newSession);
  const toggleConsole = useStore((s) => s.toggleConsole);

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
  });

  useEffect(() => {
    void init();
  }, [init]);

  const visibleTabs = tabs.filter((t) => !t.hidden);

  return (
    // `relative` anchors the CommandPalette's `absolute inset-0` scrim.
    <div className="relative flex h-screen flex-col overflow-hidden bg-void font-sans text-ink">
      <TitleBar />
      {/* border-t = the title-bar hairline; see TitleBar for why it isn't border-b there. */}
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
            {visibleTabs.length === 0 && <Welcome />}
          </div>
        </div>
      </div>
      <CommandPalette />
      {/* Both update cards share one corner stack (issue #19): cards that
          render null leave no gap; when both show, the app card sits on top. */}
      <div className="fixed right-4 bottom-4 z-40 flex w-80 flex-col gap-2">
        <AppUpdateCard />
        <OmpUpdateCard />
      </div>
      {deleteConfirmation && (
        <DeleteSessionDialog key={deleteConfirmation.tabId} confirmation={deleteConfirmation} />
      )}
      {projectPickerOpen && <ProjectPicker />}
      {mcpManager && <McpManager tabId={mcpManager.tabId} projectCwd={mcpManager.projectCwd} />}
    </div>
  );
}
