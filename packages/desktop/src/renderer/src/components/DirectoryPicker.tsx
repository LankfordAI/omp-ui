import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DirBrowseEntry, DirBrowseResult } from "@omp-ui/core/types";
import { backendFor, displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { fuzzyMatch, highlightRuns } from "../lib/fuzzy";
import { useT } from "../lib/i18n";
import { useCompactShell } from "../lib/responsive";
import { formatHotkey } from "../lib/hotkeys";
import { PaletteEmpty, PaletteList, PaletteSearchHeader, usePaletteNav } from "./palette";
import { Button, Chip, Modal } from "./ui";

/**
 * In-app, keyboard-driven directory picker for "Add project" (issue #16) and
 * "Add vault" (issue #764). Every keystroke asks the main process for one
 * directory listing whose leaf fuzzy-matches (subsequence) the current
 * directory's names (issue #483); a generation counter discards stale
 * responses (no debounce needed — local readdir is cheap). Rows are ranked
 * here with the shared scorer, and matched characters are highlighted. Enter
 * with no row selected accepts the resolved path; a selected row descends into
 * it instead. Tab on a selected row descends the same way; with the cursor
 * uncommitted it completes the leaf shell-style from the rows on screen
 * (issue #492).
 */

/** String dirname for display paths — the renderer must not import node:path. */
function parentOf(p: string): string {
  return p.replace(/\/[^/]+\/?$/, "") || "/";
}

/** Longest common prefix of the recalled names, compared case-insensitively
 * and spelled as in the first name so Tab inserts real characters. */
function commonPrefix(names: string[]): string {
  const first = names[0] ?? "";
  let len = first.length;
  for (const name of names) {
    let i = 0;
    while (i < len && name[i]?.toLowerCase() === first[i]?.toLowerCase()) i += 1;
    len = i;
  }
  return first.slice(0, len);
}

/** A list row: the ".." parent link or a real directory entry. */
type PickerRow = { kind: "up" } | { kind: "dir"; entry: DirBrowseEntry; hits: number[] };

export interface DirectoryPickerProps {
  mode: "project" | "vault";
  /** Whose filesystem is browsed (issue #416); vault mode always passes null. */
  instanceId: string | null;
  /** Line above the input (the joined instance's "Register project on {nickname}"), or null. */
  banner: string | null;
  onClose: () => void;
  /** Resolves when the path is accepted (the caller closes the picker); a rejection renders inline via displayMessage. */
  onSubmit: (path: string) => Promise<void>;
}

export function DirectoryPicker({ mode, instanceId, banner, onClose, onSubmit }: DirectoryPickerProps) {
  const t = useT();
  const compact = useCompactShell();
  const vault = mode === "vault";

  const [query, setQuery] = useState("~/");
  const [entries, setEntries] = useState<DirBrowseEntry[]>([]);
  const [parentPath, setParentPath] = useState("");
  const [browseError, setBrowseError] = useState<DirBrowseResult["error"]>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Vault mode only: whether the resolved folder holds an `.obsidian/`
  // directory, pinned to the path it answered for.
  const [obsidianCheck, setObsidianCheck] = useState<{ path: string; found: boolean } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const gen = useRef(0);
  const checkGen = useRef(0);
  // Tab-completion cycle (#492): the options Tab walks through, pinned to
  // the exact query and parent dir that produced them — the browse a
  // completion triggers may error (a finished leaf recalls nothing), so the
  // cycle must not read live state. Typing ends it: the query changes.
  const cycle = useRef<{ query: string; base: string; options: string[]; pos: number } | null>(null);
  // The exact query the current entries/parentPath answered. Completion
  // must not use a listing that belongs to an older query while the
  // current browse is still in flight.
  const listedQuery = useRef<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // One browse per query change, including the initial "~/" seed. The
  // generation guard keeps a slow early response from clobbering a later one.
  useEffect(() => {
    const g = ++gen.current;
    setSubmitError(null);
    void backendFor(instanceId).browseDirectories(query).then((r) => {
      if (g !== gen.current) return;
      listedQuery.current = query;
      setEntries(r.entries);
      setParentPath(r.parentPath);
      setBrowseError(r.error);
    });
  }, [query, instanceId]);

  const trimmed = query.trim();
  const trailingSep = /[/\\]$/.test(trimmed) || trimmed === "~";
  const leaf = trimmed.split(/[/\\]/).pop() ?? "";
  // Case-SENSITIVE: an exact row wins over the raw text, prefix matches don't.
  const exact = entries.find((e) => e.name === leaf);
  const resolvedPath = trailingSep ? parentPath : (exact?.fullPath ?? trimmed);

  // Vault mode only: a second browse, with its own generation guard, asks
  // whether the resolved folder already is an Obsidian vault. A leaf that
  // starts with "." lists hidden entries (dir-browse.ts), so `.obsidian`
  // comes back as an exact row when it exists.
  useEffect(() => {
    if (!vault || resolvedPath === "" || browseError !== null) return;
    const g = ++checkGen.current;
    void backendFor(instanceId).browseDirectories(`${resolvedPath}/.obsidian`).then((r) => {
      if (g !== checkGen.current) return;
      setObsidianCheck({
        path: resolvedPath,
        found: r.error === null && r.entries.some((e) => e.name === ".obsidian"),
      });
    });
  }, [vault, resolvedPath, browseError, instanceId]);

  const hasParent = parentPath !== "" && parentOf(parentPath) !== parentPath;
  // Fuzzy recall comes from the backend; ranking reuses the shared scorer so
  // the picker matches exactly like every other palette. Array.prototype.sort
  // is stable, so equal scores keep the backend's alphabetical order.
  // In dirMode the leaf is the descended directory's own name ("~" when the
  // query is bare) — never a filter over that directory's children.
  const dirs = trailingSep || leaf === ""
    ? entries.map((entry) => ({ entry, hits: [] as number[], score: 0 }))
    : entries.flatMap((entry) => {
        const hit = fuzzyMatch(entry.name, leaf);
        return hit === null ? [] : [{ entry, hits: hit.hits, score: hit.score }];
      })
      .sort((a, b) => b.score - a.score);

  const rows: PickerRow[] = [
    ...(hasParent ? [{ kind: "up" } as const] : []),
    ...dirs.map((d) => ({ kind: "dir" as const, entry: d.entry, hits: d.hits })),
  ];

  const descend = (row: PickerRow): void => {
    if (row.kind === "up") {
      const up = parentOf(parentPath);
      setQuery(up.endsWith("/") ? up : `${up}/`);
    } else {
      setQuery(`${row.entry.fullPath}/`);
    }
  };

  // Shell-style Tab completion of the leaf from the rows on screen (#492).
  // One candidate completes to its real fullPath and descends — never query
  // text. Several candidates first insert their longest common prefix (when
  // it extends what was typed), then cycle in place under the resolved
  // parent; Enter accepts a cycled name via `exact`. The cycle list is
  // pinned to the query that produced it — later browses recall fewer rows
  // (a complete name matches only itself), so continuing must not re-derive
  // candidates from them. A fresh completion likewise uses only the listing
  // the current query produced, never one still awaiting its own browse.
  // Shift+Tab cycles backwards; typing ends the cycle because the pinned
  // query stops matching.
  const complete = (back = false): void => {
    const state =
      cycle.current !== null && cycle.current.query === query ? cycle.current : null;
    if (state !== null) {
      const n = state.options.length;
      state.pos = (state.pos + (back ? -1 : 1) + n) % n;
      const next = `${state.base}${state.options[state.pos]}`;
      cycle.current = { query: next, base: state.base, options: state.options, pos: state.pos };
      setQuery(next);
      return;
    }

    if (listedQuery.current !== query || browseError !== null) return;
    const candidates = dirs.map((d) => d.entry);
    if (candidates.length === 0) return;
    if (candidates.length === 1) {
      setQuery(`${candidates[0].fullPath}/`);
      return;
    }
    // dirMode: the rows ARE the listing a shell would print; inserting a child
    // name the user never began typing would complete nothing. Pick a row
    // (ArrowDown+Tab/Enter) instead.
    if (trailingSep || leaf === "") return;
    const names = candidates.map((c) => c.name);
    const cp = commonPrefix(names);
    // The prefix only inserts when it extends what was typed; a fuzzy leaf
    // ("al" vs alpha/axle) shares none, so Tab goes straight to cycling.
    const extendsTyped =
      cp.length > leaf.length && cp.slice(0, leaf.length).toLowerCase() === leaf.toLowerCase();
    const options: string[] = [];
    for (const name of extendsTyped ? [cp, ...names] : names) {
      if (!options.some((o) => o.toLowerCase() === name.toLowerCase())) options.push(name);
    }

    const pos = back ? options.length - 1 : 0;
    const base = parentPath === "/" ? "/" : `${parentPath}/`;
    const next = `${base}${options[pos]}`;
    cycle.current = { query: next, base, options, pos };
    setQuery(next);
  };

  const submit = (path: string): void => {
    void onSubmit(path).catch((err: unknown) => setSubmitError(displayMessage(err)));
  };

  function consumeEnter(event: ReactKeyboardEvent): boolean {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod && active >= 0) return false;
    submit(resolvedPath);
    return true;
  }

  const { active, activeRef, handleKey } = usePaletteNav({
    items: rows,
    resetKey: query,
    initialIndex: -1,
    onPick: descend,
    onClose,
    acceptTab: true,
    onEnter: consumeEnter,
  });

  // The shared engine consumes Tab only when a row is selected (descend);
  // with the cursor uncommitted, Tab belongs to completion. Even when there
  // is nothing to complete the key is swallowed, so focus never walks to the
  // modal's close button (#23).
  function handleInputKey(event: ReactKeyboardEvent): void {
    if (handleKey(event)) return;
    if (event.key === "Tab") {
      event.preventDefault();
      complete(event.shiftKey);
    }
  }

  return (
    <Modal onClose={onClose} width="w-[34rem]">
      {banner !== null && (
        <p className="border-b border-line px-3.5 py-2 text-[11px] text-ink-dim">{banner}</p>
      )}
      <PaletteSearchHeader>
        <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 text-ink-dim">
          <path
            d="M1.5 4.5a1 1 0 0 1 1-1h3.4l1.6 1.7h6a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
        </svg>
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          placeholder={vault ? "~/path/to/vault" : "~/path/to/project"}
          aria-label={vault ? t("settings.vault.pickerPath") : t("project.picker.pathLabel")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKey}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {!compact && <Chip mono>{formatHotkey("escape")}</Chip>}
      </PaletteSearchHeader>

      <PaletteList>
        {browseError === "invalid" && (
          <PaletteEmpty title={t("project.picker.typePath")} hint={t("project.picker.pathHint")} />
        )}
        {browseError === "missing" && <PaletteEmpty title={t("project.picker.missing")} hint={parentPath} />}
        {browseError === "denied" && <PaletteEmpty title={t("project.picker.denied")} hint={parentPath} />}
        {browseError === null && rows.length === 0 && (
          <PaletteEmpty title={t("project.picker.noMatches")} hint={t("project.picker.enterHint")} />
        )}
        {rows.map((row, i) => (
          <button
            key={row.kind === "up" ? ".." : row.entry.fullPath}
            type="button"
            ref={i === active ? activeRef : null}
            // Focus must stay on the path input: all keyboard handling lives
            // there, and a focused row would swallow Enter/mod+Enter (#23).
            // Focus moves on mousedown, so that's where it's blocked.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => descend(row)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors",
              i === active ? "bg-hover" : "hover:bg-hover/50",
            )}
          >
            <span
              className={cn(
                "h-3.5 w-0.5 shrink-0 rounded-full",
                i === active ? "bg-signal" : "bg-transparent",
              )}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-mono text-xs",
                row.kind === "up" ? "text-ink-dim" : "text-ink",
              )}
            >
              {row.kind === "up" ? (
                ".."
              ) : (
                highlightRuns(row.entry.name, row.hits).map((part, j) => (
                  <span key={j} className={part.hit ? "text-signal" : undefined}>
                    {part.text}
                  </span>
                ))
              )}
            </span>
          </button>
        ))}
      </PaletteList>

      {submitError && (
        <p className="border-t border-line px-3.5 py-2 text-xs text-rose">{submitError}</p>
      )}

      <div className="border-t border-line px-3.5 py-2">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-[11px] text-ink-dim">
            {vault ? t("settings.vault.pickerWillAdd") : t("project.picker.willAdd")}{" "}
            <span className="font-mono text-ink-mid">{resolvedPath || "—"}</span>
          </p>
          {vault && obsidianCheck !== null && obsidianCheck.path === resolvedPath && (obsidianCheck.found ? (
            <Chip tone="signal" mono>{t("settings.vault.obsidianFound")}</Chip>
          ) : (
            <Chip tone="copper">{t("settings.vault.notVaultYet")}</Chip>
          ))}
          <Button variant="solid" disabled={!resolvedPath || browseError !== null} onClick={() => submit(resolvedPath)}>
            {vault ? t("settings.vault.pickerAdd") : t("project.picker.addProject")}
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
          <span className="font-mono">{formatHotkey("arrowup")}{formatHotkey("arrowdown")}</span>
          <span>{t("project.picker.navigate")}</span>
          <span className="font-mono">{formatHotkey("enter")}</span>
          <span>{t("project.picker.openAdd")}</span>
          <span className="font-mono">{formatHotkey("tab")}</span>
          <span>{t("project.picker.open")}</span>
          <span className="font-mono">{formatHotkey("mod+enter")}</span>
          <span>{t("project.picker.addTypedPath")}</span>
        </div>
      </div>
    </Modal>
  );
}
