import { useImperativeHandle, useMemo, type KeyboardEvent, type Ref } from "react";
import { cn } from "../lib/cn";
import { fuzzyMatch, highlightRuns } from "../lib/fuzzy";
import { deriveDirs } from "../lib/mentions";
import { Chip, Label } from "./ui";
import { PaletteList, usePaletteNav } from "./palette";

/**
 * Inline file picker above the composer, opened by an `@`-word at the caret —
 * SlashPalette's machinery pointed at the project file listing instead of the
 * command set. Same split: the palette owns filtering and the selection
 * cursor, and the composer's textarea forwards its keydown through
 * `handleKey`, so focus never leaves the input.
 */

export interface MentionPaletteHandle {
  /** Consumes navigation keys. Returns true when the palette handled the key. */
  handleKey(e: KeyboardEvent): boolean;
}

/** Rows shown at most, ranked or not — a picker, not a file manager. */
const MAX_ROWS = 50;

interface Row {
  /** Project-relative path; dirs carry a trailing "/". */
  path: string;
  isDir: boolean;
  /** Indices of `path` the query consumed, for emphasis. */
  hits: number[];
}

export function MentionPalette({
  query,
  files,
  truncated,
  onPick,
  onClose,
  ref,
}: {
  /** The @-word after the `@`, as typed so far. */
  query: string;
  /** Project-relative file listing (backend.listProjectFiles). */
  files: readonly string[];
  /** The listing hit MAX_PROJECT_FILES — narrowing the query still helps. */
  truncated: boolean;
  onPick(relPath: string): void;
  onClose(): void;
  ref?: Ref<MentionPaletteHandle>;
}) {

  const rows = useMemo(() => {
    const all: Row[] = [
      ...files.map((path) => ({ path, isDir: false, hits: [] as number[] })),
      ...deriveDirs(files).map((path) => ({ path, isDir: true, hits: [] as number[] })),
    ];
    // An empty query lists in listed order — ranking zeroes would only shuffle.
    if (query === "") return all.slice(0, MAX_ROWS);
    const scored: { row: Row; score: number }[] = [];
    for (const row of all) {
      const full = fuzzyMatch(row.path, query);
      if (full === null) continue;
      // A basename hit outranks the same characters spread across the path;
      // painting always uses the full-path hits, which index the displayed row.
      const base = fuzzyMatch(row.path.slice(row.path.lastIndexOf("/") + 1), query);
      const score = Math.max(full.score, (base?.score ?? -Infinity) * 2);
      scored.push({ row: { ...row, hits: full.hits }, score });
    }
    scored.sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path));
    return scored.slice(0, MAX_ROWS).map((s) => s.row);
  }, [files, query]);

  const { active, setActive, activeRef, handleKey } = usePaletteNav({
    items: rows,
    resetKey: query,
    acceptTab: true,
    onPick: (row) => onPick(pickPath(row)),
    onClose,
  });

  useImperativeHandle(ref, () => ({ handleKey }), [handleKey]);

  const shell =
    "animate-rise edge-lit absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg border border-line-strong bg-overlay";

  if (rows.length === 0) {
    return (
      <div className={cn(shell, "px-3 py-2.5")}>
        <p className="text-xs text-ink-dim">
          no file matches <span className="font-mono text-ink-mid">@{query}</span>
        </p>
      </div>
    );
  }

  return (
    <PaletteList className={cn(shell, "max-h-[min(18rem,calc(var(--app-viewport-height,100dvh)*0.45))] py-1")}>
      {rows.map((row, i) => (
        <button
          key={row.path}
          type="button"
          ref={i === active ? activeRef : null}
          // Keep the caret in the textarea: a blur would tear the palette down.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick(pickPath(row))}
          className={cn(
            "flex w-full items-baseline gap-2 px-3 py-1 text-left",
            i === active ? "bg-hover" : "hover:bg-raised",
          )}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
            {highlightRuns(row.path, row.hits).map((part, j) => (
              <span key={j} className={part.hit ? "text-signal" : undefined}>
                {part.text}
              </span>
            ))}
          </span>
          {row.isDir && <Chip>dir</Chip>}
        </button>
      ))}
      {truncated && (
        <div className="border-t border-line px-3 pb-1 pt-1.5">
          <Label>listing capped at 10 000 files — keep typing to narrow</Label>
        </div>
      )}
    </PaletteList>
  );
}

/**
 * Dir rows insert without the trailing slash: omp's mention token ends at
 * whitespace and the picker adds the trailing space itself, and a bare `@dir`
 * still resolves to the directory at send time.
 */
function pickPath(row: Row): string {
  return row.isDir ? row.path.slice(0, -1) : row.path;
}
