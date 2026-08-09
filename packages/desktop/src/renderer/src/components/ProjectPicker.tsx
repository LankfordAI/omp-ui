import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DirBrowseEntry, DirBrowseResult } from "@omp-ui/core/types";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { useCompactShell } from "../lib/responsive";
import { formatHotkey } from "../lib/hotkeys";
import { useStore } from "../store";
import { PaletteEmpty, PaletteList, PaletteSearchHeader, usePaletteNav } from "./palette";
import { Button, Chip, Modal } from "./ui";

/**
 * In-app, keyboard-driven directory picker for "Add project" (issue #16).
 * Every keystroke asks the main process for one directory listing; a
 * generation counter discards stale responses (no debounce needed — local
 * readdir is cheap). Enter with no row selected registers the resolved path;
 * a selected row descends into it instead.
 */

/** String dirname for display paths — the renderer must not import node:path. */
function parentOf(p: string): string {
  return p.replace(/\/[^/]+\/?$/, "") || "/";
}

/** A list row: the ".." parent link or a real directory entry. */
type PickerRow = { kind: "up" } | { kind: "dir"; entry: DirBrowseEntry };

export function ProjectPicker() {
  const closeProjectPicker = useStore((s) => s.closeProjectPicker);
  const addProject = useStore((s) => s.addProject);
  const newSession = useStore((s) => s.newSession);
  const compact = useCompactShell();

  const [query, setQuery] = useState("~/");
  const [entries, setEntries] = useState<DirBrowseEntry[]>([]);
  const [parentPath, setParentPath] = useState("");
  const [browseError, setBrowseError] = useState<DirBrowseResult["error"]>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const gen = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // One browse per query change, including the initial "~/" seed. The
  // generation guard keeps a slow early response from clobbering a later one.
  useEffect(() => {
    const g = ++gen.current;
    setSubmitError(null);
    void backend.browseDirectories(query).then((r) => {
      if (g !== gen.current) return;
      setEntries(r.entries);
      setParentPath(r.parentPath);
      setBrowseError(r.error);
    });
  }, [query]);

  const trimmed = query.trim();
  const trailingSep = /[/\\]$/.test(trimmed) || trimmed === "~";
  const leaf = trimmed.split(/[/\\]/).pop() ?? "";
  // Case-SENSITIVE: an exact row wins over the raw text, prefix matches don't.
  const exact = entries.find((e) => e.name === leaf);
  const resolvedPath = trailingSep ? parentPath : (exact?.fullPath ?? trimmed);

  const hasParent = parentPath !== "" && parentOf(parentPath) !== parentPath;
  const rows: PickerRow[] = [
    ...(hasParent ? [{ kind: "up" } as const] : []),
    ...entries.map((entry) => ({ kind: "dir", entry }) as const),
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
    // Store closes the picker on success; compact registration continues into
    // a live session because a newly tracked project otherwise leaves a phone
    // at an empty shell. Desktop keeps registration and creation separate.
    void addProject(path)
      .then(() => (compact ? newSession(path) : undefined))
      .catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        setSubmitError(raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
      });
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
    onClose: closeProjectPicker,
    acceptTab: true,
    onEnter: consumeEnter,
  });

  return (
    <Modal onClose={closeProjectPicker} width="w-[34rem]">
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
          placeholder="~/path/to/project"
          aria-label="project directory path"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKey}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {!compact && <Chip mono>{formatHotkey("escape")}</Chip>}
      </PaletteSearchHeader>

      <PaletteList>
        {browseError === "invalid" && (
          <PaletteEmpty title="Type a path" hint="Start with ~/ or an absolute /path." />
        )}
        {browseError === "missing" && <PaletteEmpty title="No such directory" hint={parentPath} />}
        {browseError === "denied" && <PaletteEmpty title="Permission denied" hint={parentPath} />}
        {browseError === null && rows.length === 0 && (
          <PaletteEmpty title="No matching directories" hint="Enter adds the path shown below." />
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
              {row.kind === "up" ? ".." : row.entry.name}
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
            will add: <span className="font-mono text-ink-mid">{resolvedPath || "—"}</span>
          </p>
          <Button variant="solid" disabled={!resolvedPath || browseError !== null} onClick={() => submit(resolvedPath)}>Add project</Button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
          <span className="font-mono">{formatHotkey("arrowup")}{formatHotkey("arrowdown")}</span>
          <span>navigate</span>
          <span className="font-mono">{formatHotkey("enter")}</span>
          <span>open/add</span>
          <span className="font-mono">{formatHotkey("tab")}</span>
          <span>open</span>
          <span className="font-mono">{formatHotkey("mod+enter")}</span>
          <span>add typed path</span>
        </div>
      </div>
    </Modal>
  );
}
