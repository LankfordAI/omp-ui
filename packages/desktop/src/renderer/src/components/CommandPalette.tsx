import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SessionSummary } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { fuzzyBest, highlightRuns } from "../lib/fuzzy";
import { formatHotkey, useHotkeys } from "../lib/hotkeys";
import { findRecord, useStore } from "../store";
import { Chip, Dot, Empty, Label, Modal, type Tone } from "./ui";

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
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const state = useStore((s) => s.state);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openSession = useStore((s) => s.openSession);
  const newSession = useStore((s) => s.newSession);
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const openMcpManager = useStore((s) => s.openMcpManager);
  const terminate = useStore((s) => s.terminate);
  const switchMode = useStore((s) => s.switchMode);

  const show = useCallback((seed?: string) => {
    setQuery(seed ?? "");
    setActive(0);
    setOpen(true);
  }, []);

  useHotkeys({ "mod+k": (e) => { e.preventDefault(); show(); } });

  useEffect(() => {
    const onOpen = (e: CustomEvent<PaletteOpenDetail | undefined>): void => show(e.detail?.query);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(PALETTE_EVENT, onOpen);
  }, [show]);

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
          group: "Sessions",
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
        group: "Projects",
        name: `New session in ${group.project.name}`,
        desc: group.project.path,
        run: () => void newSession(group.project.path),
      });
    }
    out.push({
      id: "add-project",
      group: "Projects",
      name: "Add project…",
      desc: "pick a directory to track",
      run: () => openProjectPicker(),
    });

    const tab = activeTabId === null ? undefined : tabs.find((t) => t.tabId === activeTabId);
    if (tab) {
      const title = findRecord(state, tab.tabId)?.title ?? "this session";
      const other = tab.mode === "pty" ? "rpc-ui" : "pty";
      out.push(
        {
          id: "session:terminate",
          group: "Session",
          name: "Terminate agent",
          desc: `${title} — the session stays resumable`,
          run: () => void terminate(tab.tabId),
        },
        {
          id: "session:mode",
          group: "Session",
          name: `Switch to ${other === "pty" ? "terminal" : "native"} mode`,
          desc: `${title} — restarts the process`,
          run: () => void switchMode(tab.tabId, other),
        },
      );
      if (tab.projectCwd) {
        out.push({
          id: "session:mcp",
          group: "Session",
          name: "MCP servers…",
          desc: "inspect and toggle MCP servers for this project",
          run: () => openMcpManager(tab.tabId, tab.projectCwd),
        });
      }
    }

    return out;
  }, [state, tabs, activeTabId, openSession, newSession, openProjectPicker, openMcpManager, terminate, switchMode]);

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

  const clamped = results.length === 0 ? 0 : Math.min(active, results.length - 1);

  useEffect(() => {
    rowsRef.current[clamped]?.scrollIntoView({ block: "nearest" });
  }, [clamped, open]);

  const close = useCallback(() => setOpen(false), []);

  if (!open) return null;

  const move = (delta: number): void => {
    if (results.length === 0) return;
    setActive((i) => {
      const from = Math.min(i, results.length - 1);
      return (from + delta + results.length) % results.length;
    });
  };

  const commit = (): void => {
    const row = results[clamped];
    if (!row) return;
    close();
    row.action.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    // !e.shiftKey: mod+shift+n is the app-level new-session hotkey, not "move down".
    if (key === "arrowdown" || (mod && !e.shiftKey && key === "n")) {
      e.preventDefault();
      move(1);
    } else if (key === "arrowup" || (mod && !e.shiftKey && key === "p")) {
      e.preventDefault();
      move(-1);
    } else if (key === "enter") {
      e.preventDefault();
      commit();
    }
  };

  let lastGroup = "";

  return (
    <Modal onClose={close} width="w-[34rem]">
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
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
          placeholder="Search sessions, projects, actions…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <Chip mono>{formatHotkey("escape")}</Chip>
      </div>

      <div className="max-h-[24rem] overflow-y-auto py-1.5">
        {results.length === 0 && (
          <Empty title="Nothing matches" hint="Try fewer letters — matching is fuzzy, not exact." />
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
                ref={(el) => {
                  rowsRef.current[i] = el;
                }}
                onMouseMove={() => setActive(i)}
                onClick={commit}
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
      </div>

      <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[10px] text-ink-faint">
        <span className="font-mono">{formatHotkey("arrowup")}{formatHotkey("arrowdown")}</span>
        <span>navigate</span>
        <span className="font-mono">{formatHotkey("enter")}</span>
        <span>run</span>
        <span className="font-mono">{formatHotkey("mod+n")}</span>
        <span>/</span>
        <span className="font-mono">{formatHotkey("mod+p")}</span>
        <span>also move</span>
      </div>
    </Modal>
  );
}
