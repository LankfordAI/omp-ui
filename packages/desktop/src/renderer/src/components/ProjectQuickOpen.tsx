import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../lib/cn";
import { fuzzyBest, highlightRuns } from "../lib/fuzzy";
import { currentLocaleId, useT } from "../lib/i18n";
import { formatHotkey, useHotkeys, type HotkeyMap } from "../lib/hotkeys";
import { initials } from "../lib/initials";
import { useCompactShell } from "../lib/responsive";
import { useStore } from "../store";
import { Chip, IconSearch, Label, Modal } from "./ui";
import { PaletteEmpty, PaletteList, PaletteSearchHeader, usePaletteNav } from "./palette";

/**
 * The project quick-open (issue #915): a command-palette-sized spotlight for
 * "start work somewhere". One row per repository — the #903 merge, mirrored
 * from NewSessionDialog's here face — plus the no-project Chat and the
 * add-project affordance, so every spawn choice is reachable without leaving
 * the keyboard. Backspace on an empty box walks back out, which is why the
 * input's onKeyDown filters that chord before delegating to the palette nav.
 */

/** One launch target: a project path as owned by one instance (null = here). */
interface Pair {
  projectCwd: string;
  instanceId: string | null;
}

/** One registered project on one host, before the repository merge. */
interface Entry extends Pair {
  name: string;
  /** Full path tooltip; set for remote rows only (mirrors hereOptions). */
  title?: string;
  repositoryKey: string | null;
}

interface QuickRow {
  id: string;
  /** Section header; null rows (Chat/Add) render without one. */
  group: string | null;
  label: string;
  sub?: string;
  title?: string;
  hits: number[];
  kind: "chat" | "project" | "add";
  pair?: Pair;
  score?: number;
  /** Position in the empty-query order; the tie-breaker when scoring. */
  index: number;
  /** Every checkout merged into this row (#903); drives focused-row matching. */
  members?: Pair[];
}

export function ProjectQuickOpen() {
  const seed = useStore((s) => s.projectQuickOpen);
  const closeProjectQuickOpen = useStore((s) => s.closeProjectQuickOpen);
  const state = useStore((s) => s.state);
  const focused = useStore((s) => s.tabs.find((tab) => tab.tabId === s.activeTabId) ?? null);
  const newSession = useStore((s) => s.newSession);
  const newChat = useStore((s) => s.newChat);
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const openNewSessionDialog = useStore((s) => s.openNewSessionDialog);
  const t = useT();
  const localeId = currentLocaleId();
  const compact = useCompactShell();

  // The seed query is consumed at mount: App mounts this overlay only while
  // `projectQuickOpen !== null`, so a re-open always remounts with its seed.
  const [query, setQuery] = useState(seed?.query ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Registry projects exactly as NewSessionDialog's hereOptions (118-142):
  // the local registry first, then every joined instance's projects.
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const group of state?.projects ?? []) {
      out.push({
        instanceId: null,
        projectCwd: group.project.path,
        name: group.project.name,
        repositoryKey: group.project.repositoryKey,
      });
    }
    const joined = (state?.remoteInstances ?? []).filter((instance) => instance.status !== "self");
    for (const instance of joined) {
      for (const group of instance.projects) {
        out.push({
          instanceId: instance.id,
          projectCwd: group.project.path,
          name: group.project.name,
          title: group.project.path,
          repositoryKey: group.project.repositoryKey,
        });
      }
    }
    return out;
  }, [state]);

  const close = useCallback(() => closeProjectQuickOpen(), [closeProjectQuickOpen]);

  const baseRows = useMemo<QuickRow[]>(() => {
    // The repository merge (issue #903 rule, mirrored from hereGroups): one
    // row per repositoryKey. A null key NEVER merges across machines except
    // by identical path, so keyless entries dedupe by path alone.
    const byKey = new Map<string | null, Entry[]>();
    for (const entry of entries) {
      const list = byKey.get(entry.repositoryKey);
      if (list === undefined) byKey.set(entry.repositoryKey, [entry]);
      else list.push(entry);
    }
    const groups: { key: string | null; members: Entry[] }[] = [];
    for (const [key, members] of byKey) {
      if (key !== null) {
        groups.push({ key, members });
        continue;
      }
      const byPath = new Map<string, Entry[]>();
      for (const entry of members) {
        const list = byPath.get(entry.projectCwd);
        if (list === undefined) byPath.set(entry.projectCwd, [entry]);
        else list.push(entry);
      }
      for (const list of byPath.values()) groups.push({ key: null, members: list });
    }

    const nicknames = new Map((state?.remoteInstances ?? []).map((instance) => [instance.id, instance.nickname]));
    const focusedInstanceId = focused?.instanceId ?? null;

    const out: QuickRow[] = [
      { id: "chat", group: null, label: t("quickopen.noproject"), sub: t("quickopen.noproject.desc"), hits: [], kind: "chat", index: 0 },
    ];

    for (const group of groups) {
      // Target pair (the Q3 rule): the local checkout wins, else the instance
      // holding the focused tab, else registry order. The target names the row
      // and decides which host the subline shows.
      const target =
        group.members.find((m) => m.instanceId === null) ??
        (focusedInstanceId !== null ? group.members.find((m) => m.instanceId === focusedInstanceId) : undefined) ??
        group.members[0]!;
      out.push({
        id: group.key !== null ? `repo:${group.key}` : `${target.instanceId ?? "local"}\u0000${target.projectCwd}`,
        group: t("quickopen.group.projects"),
        label: target.name,
        sub:
          target.instanceId === null
            ? t("quickopen.host.local")
            : `${nicknames.get(target.instanceId) ?? target.instanceId} · ${target.projectCwd}`,
        title: target.title,
        hits: [],
        kind: "project",
        pair: { projectCwd: target.projectCwd, instanceId: target.instanceId },
        index: 0,
        members: group.members.map((m) => ({ projectCwd: m.projectCwd, instanceId: m.instanceId })),
      });
    }

    // The focused tab's repository leads the list (issue #915). Keyed groups
    // match by membership, so a remote twin of the focused checkout still
    // promotes the merged row; keyless rows match on path.
    if (focused !== null) {
      const at = out.findIndex(
        (row) => row.kind === "project" && row.members?.some((m) => m.projectCwd === focused.projectCwd) === true,
      );
      if (at > 1) out.splice(1, 0, out.splice(at, 1)[0]!);
    }

    out.push({ id: "add", group: null, label: t("quickopen.add"), hits: [], kind: "add", index: 0 });
    return out.map((row, i) => ({ ...row, index: i }));
  }, [entries, focused, state, t, localeId]);

  // Flat, already-ordered result list; group headers derive from it so the
  // arrow-key index and the rendered rows can never disagree.
  const results = useMemo<QuickRow[]>(() => {
    const needle = query.trim();
    if (needle.length === 0) return baseRows;
    const scored: { row: QuickRow; score: number }[] = [];
    for (const row of baseRows) {
      // Every merged checkout's path is a search field (issue #915): typing
      // any host's directory fragment must find the group row, even when the
      // row itself shows the local pair. Only the label reports hit indices —
      // emphasising a truncated subline is noise.
      const fields: { text: string; weight: number; report?: boolean }[] = [
        { text: row.label, weight: 1 },
      ];
      if (row.members !== undefined) {
        for (const path of new Set(row.members.map((m) => m.projectCwd))) {
          fields.push({ text: path, weight: 0.5, report: false });
        }
      } else {
        fields.push({ text: row.label, weight: 0.5, report: false });
      }
      const hit = fuzzyBest(needle, fields);
      if (hit !== null) scored.push({ row: { ...row, hits: hit.hits, score: hit.score }, score: hit.score });
    }
    // Ties keep the empty-query order, chat-first and focused-row included.
    scored.sort((a, b) => b.score - a.score || a.row.index - b.row.index);
    return scored.map((s) => s.row);
  }, [baseRows, query]);

  const pick = useCallback(
    (row: QuickRow): void => {
      // Close first, spawn after: the overlay must never outlive the pick it
      // just committed, even while the spawn timeout burns inside newSession.
      close();
      if (row.kind === "chat") void newChat();
      else if (row.kind === "add") openProjectPicker();
      else if (row.pair !== undefined) void newSession(row.pair.projectCwd, undefined, row.pair.instanceId);
    },
    [close, newChat, openProjectPicker, newSession],
  );

  const { active, setActive, activeRef, handleKey } = usePaletteNav({
    items: results,
    resetKey: query,
    onPick: pick,
    onClose: close,
    // Shift+Enter on a project opens the New session dialog for that pair
    // instead of spawning — the quick-open is also the dialog's shortcut (issue #915).
    onEnter: (e: ReactKeyboardEvent): boolean => {
      if (!e.shiftKey) return false;
      const row = results[active];
      if (row === undefined || row.kind !== "project" || row.pair === undefined) return false;
      close();
      openNewSessionDialog({ projectCwd: row.pair.projectCwd, instanceId: row.pair.instanceId });
      return true;
    },
  });

  function handleInputKey(event: ReactKeyboardEvent): void {
    // Backspace on an empty box walks back out of the overlay rather than
    // silently deleting nothing (issue #915); any other key belongs to nav.
    if (event.key === "Backspace" && query === "") {
      event.preventDefault();
      close();
      return;
    }
    handleKey(event);
  }

  // mod+1…mod+9 fire the first nine rows while the box is empty. The map is a
  // fresh literal each render — `useHotkeys` keeps a latest-ref either way.
  const positional: HotkeyMap = {};
  for (let i = 0; i < 9; i += 1) {
    positional[`mod+${i + 1}`] = (e: KeyboardEvent): void => {
      const row = baseRows[i];
      // Inert while closed or mid-typing: return without preventDefault so
      // the chord stays available to the rest of the shell.
      if (seed === null || row === undefined || query.trim() !== "") return;
      e.preventDefault();
      pick(row);
    };
  }
  useHotkeys(positional);

  if (seed === null) return null;

  const emptyQuery = query.trim() === "";
  let lastGroup: string | null = null;

  return (
    <Modal onClose={close} width="w-[34rem]">
      <PaletteSearchHeader>
        <IconSearch className="size-4 shrink-0 text-ink-dim" />
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          placeholder={t("quickopen.search.placeholder")}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={handleInputKey}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {!compact && <Chip mono>{formatHotkey("escape")}</Chip>}
      </PaletteSearchHeader>

      <PaletteList>
        {results.length === 0 && (
          <PaletteEmpty title={t("palette.empty.title")} hint={t("palette.empty.hint")} />
        )}
        {results.map((row, i) => {
          const header = row.group !== null && row.group !== lastGroup ? row.group : null;
          lastGroup = row.group;
          return (
            <div key={row.id}>
              {header !== null && (
                <Label className="mt-1.5 block px-3.5 pb-1 pt-1.5 first:mt-0">{header}</Label>
              )}
              <button
                type="button"
                ref={i === active ? activeRef : null}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(row)}
                title={row.title}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors",
                  i === active ? "bg-hover" : "hover:bg-hover/50",
                )}
              >
                {row.kind === "project" ? (
                  // The sidebar rail's monogram box, so the row reads as the
                  // same repository the sidebar already shows.
                  <span className="grid size-6 shrink-0 place-items-center rounded-md border border-line bg-raised font-display text-[10px] font-semibold text-ink-mid">
                    {initials(row.label)}
                  </span>
                ) : (
                  <span
                    className={cn(
                      "h-3.5 w-0.5 shrink-0 rounded-full",
                      i === active ? "bg-signal" : "bg-transparent",
                    )}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-ink">
                  {highlightRuns(row.label, row.hits).map((run, r) =>
                    run.hit ? (
                      <mark key={r} className="bg-transparent font-semibold text-signal">
                        {run.text}
                      </mark>
                    ) : (
                      <span key={r}>{run.text}</span>
                    ),
                  )}
                </span>
                {row.sub !== undefined && (
                  <span className="min-w-0 max-w-[16rem] shrink-0 truncate text-[11px] text-ink-dim">
                    {row.sub}
                  </span>
                )}
                {emptyQuery && i < 9 && <Chip mono>{formatHotkey(`mod+${i + 1}`)}</Chip>}
              </button>
            </div>
          );
        })}
      </PaletteList>

      <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[10px] text-ink-faint">
        <span className="font-mono">{formatHotkey("arrowup")}{formatHotkey("arrowdown")}</span>
        <span>{t("quickopen.footer.navigate")}</span>
        <span className="font-mono">{formatHotkey("enter")}</span>
        <span>{t("quickopen.footer.select")}</span>
        <span className="font-mono">{formatHotkey("backspace")}</span>
        <span>{t("quickopen.footer.back")}</span>
        <span className="font-mono">{formatHotkey("escape")}</span>
        <span>{t("quickopen.footer.close")}</span>
      </div>
    </Modal>
  );
}
