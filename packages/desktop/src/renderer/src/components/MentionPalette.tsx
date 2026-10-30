import { Fragment, useImperativeHandle, useMemo, type KeyboardEvent, type Ref } from "react";
import { MAX_PROJECT_FILES } from "@omp-ui/core/project-files-limit";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { fuzzyMatch, highlightRuns } from "../lib/fuzzy";
import { deriveDirs } from "../lib/mentions";
import { Chip, Label } from "./ui";
import { PaletteList, usePaletteNav } from "./palette";

/**
 * Inline file picker above the composer, opened by an `@`-word at the caret —
 * SlashPalette's machinery pointed at the project file listing instead of the
 * command set. Same split: the palette owns filtering and the selection
 * cursor, and the composer's textarea forwards its keydown through
 * `handleKey`, so focus never leaves the input. Sessions this one may
 * reference (issue #984) lead the list under their own label.
 */

export interface MentionPaletteHandle {
  /** Consumes navigation keys. Returns true when the palette handled the key. */
  handleKey(e: KeyboardEvent): boolean;
}

/** Rows shown at most, ranked or not — a picker, not a file manager. */
const MAX_ROWS = 50;
/** The cap as the footer displays it: "10 000". */
const CAP_LABEL = String(MAX_PROJECT_FILES).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** A referenceable session row: its tab and display title. */
export interface MentionSession {
  tabId: string;
  title: string;
}

const NO_SESSIONS: readonly MentionSession[] = [];
/** Session rows shown at most above the files. */
const MAX_SESSION_ROWS = 8;

type Row =
  | {
      kind: "file";
      /** Project-relative path; dirs carry a trailing "/". */
      path: string;
      isDir: boolean;
      /** Indices of `path` the query consumed, for emphasis. */
      hits: number[];
      score?: number;
    }
  | {
      kind: "session";
      tabId: string;
      /** The session title, displayed and matched like a path. */
      path: string;
      isDir: false;
      hits: number[];
      score?: number;
    };

export function MentionPalette({
  query,
  files,
  truncated,
  sessions = NO_SESSIONS,
  onPick,
  onPickSession,
  onClose,
  ref,
}: {
  /** The @-word after the `@`, as typed so far. */
  query: string;
  /** Project-relative file listing (backend.listProjectFiles). */
  files: readonly string[];
  /** The listing hit MAX_PROJECT_FILES — narrowing the query still helps. */
  truncated: boolean;
  /** Sessions this one may reference (issue #984), newest first; listed above the files. */
  sessions?: readonly MentionSession[];
  onPick(relPath: string): void;
  /** A session row was picked: the composer swaps the @-word for a reference chip. */
  onPickSession?(tabId: string): void;
  onClose(): void;
  ref?: Ref<MentionPaletteHandle>;
}) {
  const t = useT();

  const rows = useMemo(() => {
    const sessionRows: Row[] = [];
    for (const session of sessions) {
      if (query === "") {
        sessionRows.push({ kind: "session", tabId: session.tabId, path: session.title, isDir: false, hits: [] });
        continue;
      }
      const hit = fuzzyMatch(session.title, query);
      if (hit !== null)
        sessionRows.push({ kind: "session", tabId: session.tabId, path: session.title, isDir: false, hits: hit.hits, score: hit.score });
    }
    if (query !== "") sessionRows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const all: Row[] = [
      ...files.map((path) => ({ kind: "file" as const, path, isDir: false, hits: [] as number[] })),
      ...deriveDirs(files).map((path) => ({ kind: "file" as const, path, isDir: true, hits: [] as number[] })),
    ];
    const leading = sessionRows.slice(0, MAX_SESSION_ROWS);
    // An empty query lists in listed order — ranking zeroes would only shuffle.
    if (query === "") return [...leading, ...all.slice(0, MAX_ROWS)];
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
    return [...leading, ...scored.slice(0, MAX_ROWS).map((s) => s.row)];
  }, [files, sessions, query]);

  const pickRow = (row: Row): void => {
    if (row.kind === "session") onPickSession?.(row.tabId);
    else onPick(pickPath(row));
  };

  const { active, setActive, activeRef, handleKey } = usePaletteNav({
    items: rows,
    resetKey: query,
    acceptTab: true,
    onPick: pickRow,
    onClose,
  });

  useImperativeHandle(ref, () => ({ handleKey }), [handleKey]);

  const shell =
    "animate-rise edge-lit absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg border border-line-strong bg-overlay";

  if (rows.length === 0) {
    return (
      <div className={cn(shell, "px-3 py-2.5")}>
        <p className="text-xs text-ink-dim">
          {t("composer.mention.noMatch")} <span className="font-mono text-ink-mid">@{query}</span>
        </p>
      </div>
    );
  }

  const sessionCount = rows.findIndex((row) => row.kind !== "session");
  const firstFile = sessionCount === -1 ? rows.length : sessionCount;
  return (
    <PaletteList className={cn(shell, "max-h-[min(18rem,calc(var(--app-viewport-height,100dvh)*0.45))] py-1")}>
      {rows.map((row, i) => (
        <Fragment key={row.kind === "session" ? `session:${row.tabId}` : row.path}>
          {i === 0 && firstFile > 0 && (
            <div className="px-3 pb-0.5 pt-1">
              <Label>{t("composer.mention.sessions")}</Label>
            </div>
          )}
          {i === firstFile && firstFile > 0 && <div className="my-1 border-t border-line" />}
          <button
            type="button"
            data-mention-session={row.kind === "session" ? row.tabId : undefined}
            ref={i === active ? activeRef : null}
            // Keep the caret in the textarea: a blur would tear the palette down.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pickRow(row)}
            className={cn(
              "flex w-full items-baseline gap-2 px-3 py-1 text-left",
              i === active ? "bg-hover" : "hover:bg-raised",
            )}
          >
            <span className={cn("min-w-0 flex-1 truncate text-xs text-ink", row.kind === "file" && "font-mono")}>
              {highlightRuns(row.path, row.hits).map((part, j) => (
                <span key={j} className={part.hit ? "text-signal" : undefined}>
                  {part.text}
                </span>
              ))}
            </span>
            {row.isDir && <Chip>{t("composer.mention.dir")}</Chip>}
          </button>
        </Fragment>
      ))}
      {truncated && (
        <div className="border-t border-line px-3 pb-1 pt-1.5">
          <Label>{t("composer.mention.capped", { n: CAP_LABEL })}</Label>
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
