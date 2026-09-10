import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { fuzzyBest, highlightRuns } from "../lib/fuzzy";
import { useCompactShell } from "../lib/responsive";
import { formatHotkey, useHotkeys } from "../lib/hotkeys";
import { currentLocaleId, useT } from "../lib/i18n";
import { HAS_DESKTOP } from "../desktop";
import { findRecord, sessionCwd, useStore } from "../store";
import { Chip, Dot, Label, Modal, type Tone } from "./ui";
import { PaletteEmpty, PaletteList, PaletteSearchHeader, usePaletteNav } from "./palette";

/**
 * The one keyboard surface for "go somewhere / do something". Anything the
 * chrome exposes as a button should also be reachable from here.
 */

/** Any chrome affordance can open the palette by dispatching this on `window`. */
export const PALETTE_EVENT = "omp-ui:palette";

export interface PaletteOpenDetail {
  query?: string;
}

declare global {
  interface WindowEventMap {
    "omp-ui:palette": CustomEvent<PaletteOpenDetail | undefined>;
  }
}

/** Opens the palette from anywhere, optionally pre-seeding the query. */
export function openPalette(query?: string): void {
  window.dispatchEvent(
    new CustomEvent(PALETTE_EVENT, { detail: query ? { query } : undefined }),
  );
}

interface Action {
  id: string;
  group: string;
  name: string;
  desc?: string;
  /** A `useHotkeys` combo string, rendered through `formatHotkey`. */
  hint?: string;
  dot?: Tone;
  run: () => void;
}

/** An action plus the name-character indices the current query consumed. */
interface Row {
  action: Action;
  hits: number[];
}

const LIVE_TONE: Record<SessionSummary["live"], Tone> = {
  live: "signal",
  dormant: "neutral",
  archived: "copper",
  missing: "rose",
};

/* ------------------------------------------------------------------ scoring */

/**
 * Name matches outrank description matches, so the secondary text stays a
 * fallback rather than a competitor. Only the name reports hit indices —
 * emphasising a description the row truncates would be noise.
 */
function rank(query: string, action: Action): { score: number; hits: number[] } | null {
  return fuzzyBest(query, [
    { text: action.name, weight: 1 },
    { text: action.desc ?? "", weight: 0.5, report: false },
  ]);
}

/* ---------------------------------------------------------------- component */

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const compact = useCompactShell();

  const state = useStore((s) => s.state);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openSession = useStore((s) => s.openSession);
  const newSession = useStore((s) => s.newSession);
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const openCapabilitiesViewer = useStore((s) => s.openCapabilitiesViewer);
  const terminate = useStore((s) => s.terminate);
  const switchMode = useStore((s) => s.switchMode);
  const regenerateSessionTitle = useStore((s) => s.regenerateSessionTitle);
  const checkAppUpdate = useStore((s) => s.checkAppUpdate);
  const checkOmpUpdate = useStore((s) => s.checkOmpUpdate);
  const openSettings = useStore((s) => s.openSettings);
  const openDiagnosticsDialog = useStore((s) => s.openDiagnosticsDialog);
  const t = useT();
  const localeId = currentLocaleId();

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const actions = useMemo<Action[]>(() => {
    const out: Action[] = [];

    for (const group of state?.projects ?? []) {
      for (const s of group.sessions) {
        if (s.live === "missing") continue;
        out.push({
          id: `session:${s.tabId}`,
          group: t("palette.group.sessions"),
          name: s.title,
          desc: group.project.name,
          dot: LIVE_TONE[s.live],
          run: () => void openSession(s.tabId),
        });
      }
    }

    for (const group of state?.projects ?? []) {
      out.push({
        id: `new:${group.project.path}`,
        group: t("palette.group.projects"),
        name: t("palette.action.newSession", { name: group.project.name }),
        desc: group.project.path,
        run: () => void newSession(group.project.path),
      });
    }
    out.push({
      id: "add-project",
      group: t("palette.group.projects"),
      name: t("palette.action.addProject"),
      desc: t("palette.action.addProjectDesc"),
      run: () => openProjectPicker(),
    });
    // The catalog viewer is scope-global: same content from any context, no
    // session required (issue #383) — the HUD button and this action always
    // open it unpinned.
    out.push({
      id: "app:capabilities",
      group: t("palette.group.app"),
      name: t("palette.action.capabilities"),
      desc: t("palette.action.capabilitiesDesc"),
      run: () => openCapabilitiesViewer(null, undefined, "mcp"),
    });

    const tab = activeTabId === null ? undefined : tabs.find((t) => t.tabId === activeTabId);
    if (tab) {
      const title = findRecord(state, tab.tabId)?.title ?? t("palette.action.sessionFallback");
      const other = tab.mode === "pty" ? "rpc-ui" : "pty";
      out.push(
        {
          id: "session:terminate",
          group: t("palette.group.session"),
          name: t("palette.action.terminate"),
          desc: t("palette.action.terminateDesc", { title }),
          run: () => void terminate(tab.tabId),
        },
        {
          id: "session:mode",
          group: t("palette.group.session"),
          name: t("palette.action.switchMode", { mode: other === "pty" ? "terminal" : "native" }),
          desc: t("palette.action.switchModeDesc", { title }),
          run: () => void switchMode(tab.tabId, other),
        },
      );
      // Re-titling is native-only (issue #433): terminal tabs are titled by
      // omp's own TUI generator and have no prompt channel to write through.
      if (tab.mode === "rpc-ui") {
        out.push({
          id: "session:retitle",
          group: t("palette.group.session"),
          name: t("palette.action.retitle"),
          desc: t("palette.action.retitleDesc", { title }),
          run: () => void regenerateSessionTitle(tab.tabId),
        });
      }
      // The session-pinned viewer (#379's door): live roster, session-local
      // switches, MCP runtime status, resolved at the session's own working
      // tree — a worktree session's checkout (#325). Gated to native tabs
      // with a cwd: a terminal tab shows the same facts in its own TUI.
      const scopeCwd = sessionCwd(findRecord(state, tab.tabId));
      if (scopeCwd !== undefined && tab.mode === "rpc-ui") {
        out.push({
          id: "session:capabilities",
          group: t("palette.group.session"),
          name: t("palette.action.capabilitiesSession"),
          desc: t("palette.action.capabilitiesSessionDesc"),
          run: () => openCapabilitiesViewer(scopeCwd, tab.tabId, "mcp"),
        });
      }
    }

    // The omp-ui check is the desktop client's own artifact (#454): a browser client runs no
    // artifact the check could describe, so the action is absent rather than a silent no-op.
    if (HAS_DESKTOP) {
      out.push({
        id: "app:check-updates",
        group: t("palette.group.app"),
        name: t("palette.action.checkApp"),
        desc: t("palette.action.checkAppDesc"),
        run: () => void checkAppUpdate(),
      });
    }
    out.push({
      id: "app:settings",
      group: t("palette.group.app"),
      name: t("palette.action.settings"),
      desc: t("palette.action.settingsDesc"),
      hint: "mod+,",
      run: () => openSettings(),
    });
    out.push({
      id: "app:export-diagnostics",
      group: t("palette.group.app"),
      name: t("palette.action.exportDiagnostics"),
      desc: t("palette.action.exportDiagnosticsDesc"),
      run: () => openDiagnosticsDialog(),
    });
    out.push({
      id: "omp:check-updates",
      group: t("palette.group.app"),
      name: t("palette.action.checkOmp"),
      desc: t("palette.action.checkOmpDesc"),
      run: () => void checkOmpUpdate(),
    });

    return out;
  }, [state, tabs, activeTabId, openSession, newSession, openProjectPicker, openCapabilitiesViewer, terminate, switchMode, regenerateSessionTitle, checkAppUpdate, checkOmpUpdate, openSettings, openDiagnosticsDialog, t, localeId]);

  // Flat, already-ordered result list; group headers are derived from it so the
  // arrow-key index and the rendered rows can never disagree.
  const results = useMemo<Row[]>(() => {
    const needle = query.trim();
    if (needle.length === 0) return actions.map((action) => ({ action, hits: [] }));
    const scored: { row: Row; score: number; index: number }[] = [];
    actions.forEach((action, index) => {
      const hit = rank(needle, action);
      if (hit) scored.push({ row: { action, hits: hit.hits }, score: hit.score, index });
    });
    // Ties keep source order, which keeps the grouping stable.
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map((s) => s.row);
  }, [actions, query]);

  const close = useCallback(() => setOpen(false), []);
  const pick = useCallback((row: Row): void => {
    close();
    row.action.run();
  }, [close]);
  const { active: clamped, setActive, activeRef, handleKey } = usePaletteNav({
    items: results,
    resetKey: query,
    onPick: pick,
    onClose: close,
  });

  const show = useCallback((seed?: string) => {
    setQuery(seed ?? "");
    setActive(0);
    setOpen(true);
  }, [setActive]);

  useHotkeys({ "mod+k": (e) => { e.preventDefault(); show(); } });

  useEffect(() => {
    const onOpen = (e: CustomEvent<PaletteOpenDetail | undefined>): void => show(e.detail?.query);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(PALETTE_EVENT, onOpen);
  }, [show]);

  if (!open) return null;

  let lastGroup = "";

  return (
    <Modal onClose={close} width="w-[34rem]">
      <PaletteSearchHeader>
        <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 text-ink-dim">
          <circle
            cx="7"
            cy="7"
            r="4.25"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
          <path
            d="M10.2 10.2L13.5 13.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        </svg>
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          placeholder={t("palette.search.placeholder")}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={handleKey}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {!compact && <Chip mono>{formatHotkey("escape")}</Chip>}
      </PaletteSearchHeader>

      <PaletteList>
        {results.length === 0 && (
          <PaletteEmpty title={t("palette.empty.title")} hint={t("palette.empty.hint")} />
        )}
        {results.map(({ action, hits }, i) => {
          const header = action.group === lastGroup ? null : action.group;
          lastGroup = action.group;
          return (
            <div key={action.id}>
              {header && (
                <Label className="mt-1.5 block px-3.5 pb-1 pt-1.5 first:mt-0">{header}</Label>
              )}
              <button
                type="button"
                ref={i === clamped ? activeRef : null}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(results[i])}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors",
                  i === clamped ? "bg-hover" : "hover:bg-hover/50",
                )}
              >
                {action.dot ? (
                  <Dot tone={action.dot} pulse={action.dot === "signal"} />
                ) : (
                  <span
                    className={cn(
                      "h-3.5 w-0.5 shrink-0 rounded-full",
                      i === clamped ? "bg-signal" : "bg-transparent",
                    )}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-ink">
                  {highlightRuns(action.name, hits).map((run, r) =>
                    run.hit ? (
                      <mark key={r} className="bg-transparent font-semibold text-signal">
                        {run.text}
                      </mark>
                    ) : (
                      <span key={r}>{run.text}</span>
                    ),
                  )}
                </span>
                {action.desc && (
                  <span className="min-w-0 max-w-[14rem] shrink-0 truncate text-[11px] text-ink-dim">
                    {action.desc}
                  </span>
                )}
                {action.hint && <Chip mono>{formatHotkey(action.hint)}</Chip>}
              </button>
            </div>
          );
        })}
      </PaletteList>

      <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[10px] text-ink-faint">
        <span className="font-mono">{formatHotkey("arrowup")}{formatHotkey("arrowdown")}</span>
        <span>{t("palette.footer.navigate")}</span>
        <span className="font-mono">{formatHotkey("enter")}</span>
        <span>{t("palette.footer.run")}</span>
        <span className="font-mono">Ctrl+N</span>
        <span>/</span>
        <span className="font-mono">Ctrl+P</span>
        <span>{t("palette.footer.alsoMove")}</span>
      </div>
    </Modal>
  );
}
