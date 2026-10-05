// PROTOTYPE (#753): throwaway.
// "Add vault" folder picker: a trimmed copy of ProjectPicker.tsx (not a
// refactor). Same per-keystroke browse with a generation guard, same rows and
// empties; Tab completion is dropped. The footer shows the resolved path and
// one live chip saying whether it already holds a .obsidian/ folder.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DirBrowseEntry, DirBrowseResult } from "@omp-ui/core/types";
import { backendFor } from "../../backend";
import { cn } from "../../lib/cn";
import { fuzzyMatch, highlightRuns } from "../../lib/fuzzy";
import { formatHotkey } from "../../lib/hotkeys";
import { useCompactShell } from "../../lib/responsive";
import { PaletteEmpty, PaletteList, PaletteSearchHeader, usePaletteNav } from "../palette";
import { Button, Chip, Modal } from "../ui";
import { DETECTION, listEntryFor } from "./fixtures";
import { addVault, usePrototype753 } from "./state";

function parentOf(p: string): string {
  return p.replace(/\/[^/]+\/?$/, "") || "/";
}

type PickerRow = { kind: "up" } | { kind: "dir"; entry: DirBrowseEntry; hits: number[] };

export function VaultPathPicker({ onClose }: { onClose: () => void }) {
  const proto = usePrototype753();
  const compact = useCompactShell();

  const [query, setQuery] = useState("~/Documents/");
  const [entries, setEntries] = useState<DirBrowseEntry[]>([]);
  const [parentPath, setParentPath] = useState("");
  const [browseError, setBrowseError] = useState<DirBrowseResult["error"]>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** The .obsidian/ check, pinned to the path it answered. */
  const [check, setCheck] = useState<{ path: string; found: boolean } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const gen = useRef(0);
  const checkGen = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const g = ++gen.current;
    setSubmitError(null);
    void backendFor(null).browseDirectories(query).then((r) => {
      if (g !== gen.current) return;
      setEntries(r.entries);
      setParentPath(r.parentPath);
      setBrowseError(r.error);
    });
  }, [query]);

  const trimmed = query.trim();
  const trailingSep = /[/\\]$/.test(trimmed) || trimmed === "~";
  const leaf = trimmed.split(/[/\\]/).pop() ?? "";
  const exact = entries.find((e) => e.name === leaf);
  const resolvedPath = trailingSep ? parentPath : (exact?.fullPath ?? trimmed);
  const canAdd = resolvedPath !== "" && browseError === null;

  // One extra browse per resolved-path change: a non-trailing ".obsidian" leaf
  // lists the folder itself filtered to hidden entries named like it.
  useEffect(() => {
    const g = ++checkGen.current;
    if (!canAdd) return;
    const base = resolvedPath.replace(/[/\\]+$/, "");
    void backendFor(null).browseDirectories(`${base}/.obsidian`).then((r) => {
      if (g !== checkGen.current) return;
      setCheck({ path: resolvedPath, found: r.error === null && r.entries.some((e) => e.name === ".obsidian") });
    });
  }, [resolvedPath, canAdd]);

  const hasParent = parentPath !== "" && parentOf(parentPath) !== parentPath;
  const dirs = trailingSep || leaf === ""
    ? entries.map((entry) => ({ entry, hits: [] as number[], score: 0 }))
    : entries
        .flatMap((entry) => {
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

  const submit = (path: string): void => {
    if (path === "" || browseError !== null) return;
    const error = addVault(path, listEntryFor(DETECTION[proto.det], path)?.id ?? null);
    if (error !== null) setSubmitError(error);
    else onClose();
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

  // Tab descends a selected row; otherwise it is swallowed so focus never
  // walks to the modal's close button.
  function handleInputKey(event: ReactKeyboardEvent): void {
    if (handleKey(event)) return;
    if (event.key === "Tab") event.preventDefault();
  }

  const liveCheck = canAdd && check !== null && check.path === resolvedPath ? check : null;

  return (
    <Modal onClose={onClose} width="w-[34rem]">
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
          placeholder="~/path/to/vault"
          aria-label="Vault folder path"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKey}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {!compact && <Chip mono>{formatHotkey("escape")}</Chip>}
      </PaletteSearchHeader>

      <PaletteList>
        {browseError === "invalid" && <PaletteEmpty title="Type a path" hint="Start with ~/ or /" />}
        {browseError === "missing" && <PaletteEmpty title="Folder not found" hint={parentPath} />}
        {browseError === "denied" && <PaletteEmpty title="Permission denied" hint={parentPath} />}
        {browseError === null && rows.length === 0 && (
          <PaletteEmpty title="No matching folders" hint="Press Enter to add the typed path." />
        )}
        {rows.map((row, i) => (
          <button
            key={row.kind === "up" ? ".." : row.entry.fullPath}
            type="button"
            ref={i === active ? activeRef : null}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => descend(row)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors",
              i === active ? "bg-hover" : "hover:bg-hover/50",
            )}
          >
            <span className={cn("h-3.5 w-0.5 shrink-0 rounded-full", i === active ? "bg-signal" : "bg-transparent")} />
            <span
              className={cn("min-w-0 flex-1 truncate font-mono text-xs", row.kind === "up" ? "text-ink-dim" : "text-ink")}
            >
              {row.kind === "up"
                ? ".."
                : highlightRuns(row.entry.name, row.hits).map((part, j) => (
                    <span key={j} className={part.hit ? "text-signal" : undefined}>
                      {part.text}
                    </span>
                  ))}
            </span>
          </button>
        ))}
      </PaletteList>

      {submitError !== null && <p className="border-t border-line px-3.5 py-2 text-xs text-rose">{submitError}</p>}

      <div className="border-t border-line px-3.5 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-ink-dim">
            <span className="min-w-0 truncate">
              Will add:{" "}
              <span className="font-mono text-ink-mid" title={resolvedPath}>
                {resolvedPath || "none"}
              </span>
            </span>
            {liveCheck !== null &&
              (liveCheck.found ? (
                <Chip tone="signal" mono>
                  .obsidian/ found
                </Chip>
              ) : (
                <Chip tone="copper">not a vault yet</Chip>
              ))}
          </p>
          <Button variant="solid" disabled={!canAdd} onClick={() => submit(resolvedPath)}>
            Add vault
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
          <span className="font-mono">
            {formatHotkey("arrowup")}
            {formatHotkey("arrowdown")}
          </span>
          <span>navigate</span>
          <span className="font-mono">{formatHotkey("enter")}</span>
          <span>open or add</span>
          <span className="font-mono">{formatHotkey("mod+enter")}</span>
          <span>add typed path</span>
        </div>
      </div>
    </Modal>
  );
}
