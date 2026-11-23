import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { formatDuration } from "../lib/duration";
import {
  HIGHLIGHT_CHAR_CAP,
  langFromPath,
  useHighlightTokens,
  useIncrementalHighlightTokens,
} from "../lib/highlight";
import { arrField, strArrayField, strField } from "../lib/fields";
import { editErrorKindLabel } from "../lib/edit-rejections";
import type { ThemedToken } from "shiki/core";
import type { AdvisorNote, AskFacts, RecordedTaskFile, ToolItem } from "../lib/transcript";
import { cwdText } from "../lib/transcript";
import { pathFromArgs } from "../lib/tool-groups";
import { isPlanArtifactPath } from "@omp-ui/core/plan";
import { supportsSpillRead } from "@omp-ui/core/spill";
import { toolIntentLabel } from "@omp-ui/core/tool-intent-label";
import { useStore } from "../store";
import { RawOutputViewer } from "./RawOutputViewer";
import { DiffViewer, OpChip } from "./DiffViewer";
import { openImageViewer } from "./ImageViewer";
import { linkify, Markdown } from "./Markdown";
import { Chip, Chevron, Disclosure, Label, Panel, ProgressSweep, type Tone } from "./ui";

/** Result blocks longer than this collapse; a done card with one also starts closed. */
const LONG_OUTPUT_LINES = 12;
const ARG_VALUE_MAX = 120;



/* -------------------------------------------------------------- glyphs */

export type GlyphKind = "read" | "write" | "bash" | "search" | "agent" | "web" | "todo" | "generic";

const GLYPH_PATHS: Record<GlyphKind, string> = {
  read: "M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4M6 11h3",
  write: "M10.5 2.5l3 3-7 7-3.5.5.5-3.5zM9 4l3 3",
  bash: "M3 4l3 4-3 4M8.5 12h4.5",
  search: "M7.2 2.7a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.6 10.6l2.7 2.7",
  agent: "M4 3.5h8M4 8h8M4 12.5h5M2 3.5h.01M2 8h.01M2 12.5h.01",
  web: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2.4 6.4h11.2M2.4 9.6h11.2M8 2c1.8 2 2.6 4 2.6 6S9.8 12 8 14c-1.8-2-2.6-4-2.6-6S6.2 4 8 2z",
  todo: "M2.5 4.5l1.5 1.5L6.5 3.5M2.5 11l1.5 1.5L6.5 10M8.5 5h5M8.5 11.5h5",
  generic: "M8 2.2l5 2.9v5.8L8 13.8 3 10.9V5.1zM3 5.1l5 2.9 5-2.9M8 8v5.8",
};

/**
 * Tool names arrive from the agent, not from us — match on substrings so a
 * renamed or namespaced tool still lands on a sensible glyph.
 */
export function glyphFor(name: string): GlyphKind {
  const n = name.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "bash";
  if (n.includes("grep") || n.includes("glob") || n.includes("search") || n.includes("find"))
    return "search";
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) return "write";
  if (n.includes("read") || n.includes("cat") || n.includes("view")) return "read";
  if (n.includes("task") || n.includes("agent") || n.includes("hub")) return "agent";
  if (n.includes("web") || n.includes("fetch") || n.includes("http") || n.includes("browser"))
    return "web";
  if (n.includes("todo") || n.includes("plan")) return "todo";
  return "generic";
}

export function ToolGlyph({ kind }: { kind: GlyphKind }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={GLYPH_PATHS[kind]} />
    </svg>
  );
}

export function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5 shrink-0 text-signal"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8.4l3.2 3.2L13 4.8" />
    </svg>
  );
}

/* ---------------------------------------------------------------- args */

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return null;
}

/** The content an edit/write tool is about to apply, straight from its args. */
function editDraft(name: string, args: unknown): { code: string; lang?: string } | null {
  if (glyphFor(name) !== "write") return null;
  const content = strField(args, "content");
  if (content) return { code: content, lang: langFromPath(pathFromArgs(args)) };
  const input = strField(args, "input"); // hashline/patch DSL — highlight as diff
  if (input) return { code: input, lang: "diff" };
  const newText = strField(args, "newText");
  if (newText) return { code: newText, lang: langFromPath(pathFromArgs(args)) };
  return null;
}

/** One parsed line of a read result: gutter digits plus content, or a gutterless line. */
export interface ReadResultRow {
  num: string | null;
  text: string;
}

/** An omp `read` result split into its `[path#tag]` header and body rows. */
export interface ReadResultParts {
  header: string | null;
  rows: ReadResultRow[];
}

const READ_HEADER_RE = /^\[[^[\]\n]+\]$/;
const READ_GUTTER_RE = /^(\d+):(.*)$/;

/**
 * Splits an omp `read` result into its `[path#tag]` header line and body rows.
 * A guttered line becomes { num, text }; any line without an `N:` prefix
 * (elision markers, oddity) keeps its full text with num === null, so it
 * degrades to an ordinary line instead of corrupting the parse.
 */
export function splitReadResult(text: string): ReadResultParts {
  const lines = text.split("\n");
  let header: string | null = null;
  const first = lines[0];
  if (first !== undefined && READ_HEADER_RE.test(first)) {
    header = first;
    lines.splice(0, 1);
  }
  const rows = lines.map((line) => {
    const match = READ_GUTTER_RE.exec(line);
    return match ? { num: match[1] ?? null, text: match[2] ?? "" } : { num: null, text: line };
  });
  return { header, rows };
}

/**
 * A read-type result: the `[path#tag]` header plus `N:`-guttered file content.
 * Gutters are stripped before tokenizing and rendered as their own uncolored
 * select-none column, so shiki only ever sees file content. Above the cap (or
 * before the grammar loads) the body degrades to plain text beside the gutters.
 */
function ReadResultSlab({
  parts,
  lang,
  pin,
  className,
}: {
  parts: ReadResultParts;
  lang?: string;
  pin?: boolean;
  className?: string;
}) {
  const code = useMemo(() => parts.rows.map((row) => row.text).join("\n"), [parts]);
  const tokens = useHighlightTokens(code, lang, code.length < HIGHLIGHT_CHAR_CAP);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!pin) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pin, code, tokens]);
  return (
    <pre
      ref={ref}
      data-selectable
      className={cn(
        "overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-sunken px-2 py-1.5 font-mono text-xs leading-[1.55] text-ink",
        className,
      )}
    >
      {parts.header !== null && (
        <span className="select-none text-ink-faint">
          {parts.header}
          {"\n"}
        </span>
      )}
      {parts.rows.map((row, i) => (
        <span key={i}>
          {row.num !== null && (
            <span className="select-none tabular-nums text-ink-faint">{row.num}:</span>
          )}
          {tokens
            ? tokens[i]?.map((token, k) => (
                <span key={k} style={{ color: token.color }}>
                  {token.content}
                </span>
              ))
            : row.text}
          {i < parts.rows.length - 1 ? "\n" : null}
        </span>
      ))}
    </pre>
  );
}

/** The mono slab used for commands, paths, partial output and results. */
export function Slab({
  children,
  className,
  tone = "neutral",
  pin,
}: {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "rose";
  /** Follow the tail as content grows — live output is only useful at its newest end. */
  pin?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!pin) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pin, children]);
  return (
    <pre
      ref={ref}
      data-selectable
      className={cn(
        "overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-sunken px-2 py-1.5",
        "font-mono text-xs leading-[1.55]",
        tone === "rose" ? "text-rose" : "text-ink",
        className,
      )}
    >
      {children}
    </pre>
  );
}

/**
 * Slab with shiki tokens. Highlighting stays on while args stream in — the
 * hook drops stale runs, so each delta just lags one tokenize behind; very
 * large payloads stay plain. `pin` follows the tail while the model writes.
 */
function CodeSlab({ code, lang, pin, className }: { code: string; lang?: string; pin?: boolean; className?: string }) {
  const tokens = useHighlightTokens(code, lang, code.length < HIGHLIGHT_CHAR_CAP);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!pin) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pin, code, tokens]);
  return (
    <pre
      ref={ref}
      data-selectable
      className={cn(
        "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-sunken px-2 py-1.5 font-mono text-xs leading-[1.55] text-ink",
        className,
      )}
    >
      {tokens
        ? tokens.map((line, i) => (
            <span key={i}>
              {line.map((token, k) => (
                <span key={k} style={{ color: token.color }}>
                  {token.content}
                </span>
              ))}
              {i < tokens.length - 1 ? "\n" : null}
            </span>
          ))
        : code}
    </pre>
  );
}

/**
 * One tokenized line as a memoized span. Stable lines from the incremental
 * hook keep their array identity across appends, so a tail update re-renders
 * only the tail row — the settled rows' token spans are never revisited.
 */
const TokenLine = memo(function TokenLine({
  line,
  newline,
}: {
  line: readonly ThemedToken[];
  newline: boolean;
}) {
  return (
    <span>
      {line.map((token, index) => (
        <span key={index} style={{ color: token.color }}>
          {token.content}
        </span>
      ))}
      {newline ? "\n" : null}
    </span>
  );
});

/**
 * Slab for live append-only drafts (issue #369). Same surface as `CodeSlab`
 * — selectable, wrapping, scrollable, pinned to the tail while streaming —
 * but each delta tokenizes only newly completed lines plus the current tail
 * through shiki's grammar-state continuation, and settled rows are memoized.
 * Over the incremental budget, or on any tokenizer failure, the hook returns
 * null and the raw source renders unchanged.
 */
function IncrementalCodeSlab({
  code,
  lang,
  pin,
  className,
}: {
  code: string;
  lang?: string;
  pin?: boolean;
  className?: string;
}) {
  const tokens = useIncrementalHighlightTokens(code, lang, true);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!pin) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pin, code, tokens]);
  return (
    <pre
      ref={ref}
      data-selectable
      className={cn(
        "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-sunken px-2 py-1.5 font-mono text-xs leading-[1.55] text-ink",
        className,
      )}
    >
      {tokens
        ? tokens.map((line, i) => (
            <TokenLine key={i} line={line} newline={i < tokens.length - 1} />
          ))
        : code}
    </pre>
  );
}

export function PathChip({ value }: { value: string }) {
  const cut = value.lastIndexOf("/") + 1;
  return (
    <span
      title={value}
      data-selectable
      className="flex min-w-0 items-baseline rounded bg-sunken px-1.5 py-0.5 font-mono text-xs"
    >
      {/* Dirname yields first; the basename identifies the target. A basename
          wider than the whole chip (a jq selector suffix, a long URL query)
          clips too (max-w-full + truncate), so the transcript never scrolls
          sideways; `title` keeps the full value on hover (issue #934). */}
      <span className="truncate text-ink-faint">{value.slice(0, cut)}</span>
      <span className="max-w-full shrink-0 truncate text-ink-mid">{value.slice(cut)}</span>
    </span>
  );
}

/**
 * Per-tool argument views. A raw JSON dump is never the primary reading —
 * it stays available behind a disclosure for the shapes we do not know.
 */
function ToolArgs({ name, args }: { name: string; args: unknown }) {
  const kind = glyphFor(name);
  const entries: [string, unknown][] =
    args !== null && typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [];
  const argsJson = useMemo(() => jsonText(args), [args]);

  // `ask` args are a whole HTML form (18.18.3+) or a question list (before):
  // neither reads as a key/value row, so the raw payload lives only behind the
  // all-arguments disclosure and the answered card body carries the substance
  // (issue #1203).
  if (name === "ask" && entries.length > 0) {
    return (
      <Disclosure summary={<Label>all arguments</Label>}>
        <CodeSlab code={argsJson} lang="json" className="mt-1 max-h-48" />
      </Disclosure>
    );
  }

  if (kind === "bash") {
    const command = strField(args, "command") ?? strField(args, "cmd");
    if (command) return <Slab className="max-h-32 text-ink">{linkify(command)}</Slab>;
  }

  if (kind === "search") {
    const pattern = strField(args, "pattern") ?? strField(args, "query");
    const where = strField(args, "path") ?? strField(args, "glob");
    if (pattern || where) {
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          {pattern && <Chip mono truncate title={pattern}>{pattern}</Chip>}
          {where && <PathChip value={where} />}
        </div>
      );
    }
  }

  if (kind === "read" || kind === "write") {
    const path = pathFromArgs(args);
    if (path) return <PathChip value={path} />;
  }

  if (kind === "agent") {
    const subagent =
      strField(args, "agent") ?? strField(args, "name") ?? strField(args, "subagent_type");
    const prompt = strField(args, "task") ?? strField(args, "prompt") ?? strField(args, "message");
    if (subagent || prompt) {
      return (
        <div className="space-y-1.5">
          {subagent && <Chip tone="iris" mono>{subagent}</Chip>}
          {prompt && (
            <Slab className="max-h-32">
              {linkify(prompt.length > 400 ? `${prompt.slice(0, 400)}…` : prompt)}
            </Slab>
          )}
        </div>
      );
    }
  }

  if (kind === "web") {
    const url = strField(args, "url") ?? strField(args, "query");
    if (url) return <PathChip value={url} />;
  }

  if (entries.length === 0) return null;

  const scalars = entries
    .map(([key, value]) => [key, scalarText(value)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== null);
  const hasComplex = scalars.length < entries.length;

  return (
    <div className="space-y-1">
      {scalars.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
          {scalars.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-ink-faint">{key}</dt>
              <dd className="min-w-0 truncate font-mono text-ink-mid" title={value}>
                {value.length > ARG_VALUE_MAX ? `${value.slice(0, ARG_VALUE_MAX)}…` : value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {(hasComplex || scalars.some(([, v]) => v.length > ARG_VALUE_MAX)) && (
        <Disclosure summary={<Label>all arguments</Label>}>
          <CodeSlab code={argsJson} lang="json" className="mt-1 max-h-48" />
        </Disclosure>
      )}
    </div>
  );
}

interface TaskFileRow {
  key: number;
  /** Batch item name (or `#N`); undefined for the flat single-spawn shape. */
  label?: string;
  path: string;
  sha256?: string;
}

/**
 * omp 18.14 `task.file`: a task item may name its assignment by `taskFile`
 * instead of inline `task` text (exactly one of the two per item). Rows come
 * from the call's own args, flat or `tasks[]`, so a file-only spawn shows its
 * file while it runs; the SHA-256 omp recorded joins by item index once
 * progress or results report it.
 */
function taskFileRows(args: unknown, recorded: RecordedTaskFile[] | undefined): TaskFileRow[] {
  const shaByIndex = new Map((recorded ?? []).map((r) => [r.index, r.sha256]));
  const rows: TaskFileRow[] = [];
  // The flat shape and `tasks[]` are exclusive (omp rejects a top-level
  // taskFile in batch calls); a flat spawn records its file at index 0.
  const flat = strField(args, "taskFile");
  if (flat !== undefined) rows.push({ key: -1, path: flat, sha256: shaByIndex.get(0) });
  arrField(args, "tasks").forEach((entry, index) => {
    const path = strField(entry, "taskFile");
    if (path === undefined) return;
    const name = strField(entry, "name")?.trim();
    rows.push({ key: index, label: name || `#${index + 1}`, path, sha256: shaByIndex.get(index) });
  });
  return rows;
}

function TaskFiles({ rows }: { rows: TaskFileRow[] }) {
  return (
    <div className="space-y-1">
      <Label>task file</Label>
      {rows.map((row) => (
        <div key={row.key} className="flex min-w-0 flex-wrap items-center gap-1.5">
          {row.label !== undefined && <Chip tone="iris" mono>{row.label}</Chip>}
          <PathChip value={row.path} />
          {row.sha256 !== undefined && (
            <Chip mono title={`SHA-256 omp recorded for this file's bytes at spawn: ${row.sha256}`}>
              {`sha256 ${row.sha256.slice(0, 12)}`}
            </Chip>
          )}
        </div>
      ))}
    </div>
  );
}

interface TaskStageRow {
  key: number;
  /** Batch item name (or `#N`); undefined for the flat single-spawn shape. */
  label?: string;
  steps: string[];
}

/**
 * omp 18.19 `task.steps`: with the `task.steps` setting on, a spawn carries
 * ordered stages (`steps: string[]`) instead of one inline `task`, each sent
 * once the child delivered the previous. Rows come from the call's own args,
 * flat or `tasks[]`; entries still streaming in as non-strings drop.
 */
function taskStepRows(args: unknown): TaskStageRow[] {
  const rows: TaskStageRow[] = [];
  // The flat shape and `tasks[]` are exclusive (omp refuses top-level steps
  // alongside a batch); a flat spawn's stages live at the top level.
  const flat = strArrayField(args, "steps");
  if (flat.length > 0) rows.push({ key: -1, steps: flat });
  arrField(args, "tasks").forEach((entry, index) => {
    const steps = strArrayField(entry, "steps");
    if (steps.length === 0) return;
    const name = strField(entry, "name")?.trim();
    rows.push({ key: index, label: name || `#${index + 1}`, steps });
  });
  return rows;
}

function TaskStages({ rows }: { rows: TaskStageRow[] }) {
  return (
    <div className="space-y-1.5">
      <Label>stages</Label>
      {rows.map((row) => (
        <div key={row.key} className="min-w-0 space-y-1">
          {row.label !== undefined && <Chip tone="iris" mono>{row.label}</Chip>}
          <ol className="space-y-1">
            {row.steps.map((step, i) => (
              <li key={i} className="flex min-w-0 items-start gap-1.5">
                <span className="mt-1.5 shrink-0 font-mono text-xs tabular-nums text-ink-faint">
                  {i + 1}
                </span>
                <Slab className="max-h-32 min-w-0 flex-1">{linkify(step)}</Slab>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

/**
 * `ask` answered body (issue #1203): each named field's question over its
 * submitted answer — picks as a list, multi-select arrays one row per pick,
 * an empty or skipped field dimmed — then the notes attached to chosen options
 * and the timeout note, mirroring omp's own renderer.
 */
function AskAnswers({ facts }: { facts: AskFacts }) {
  return (
    <div className="space-y-2">
      {facts.answers.map((answer, i) => {
        const picks = Array.isArray(answer.answer) ? answer.answer : null;
        const text = typeof answer.answer === "string" && answer.answer !== "" ? answer.answer : null;
        return (
          <div key={i} className="min-w-0 space-y-1">
            <div className="text-sm text-ink">{linkify(answer.question)}</div>
            {picks !== null && picks.length > 0 ? (
              <ul className="space-y-0.5">
                {picks.map((pick, n) => (
                  <li key={n} className="flex min-w-0 items-baseline gap-1.5">
                    <CheckGlyph />
                    <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{linkify(pick)}</span>
                  </li>
                ))}
              </ul>
            ) : text !== null ? (
              <div className="flex min-w-0 items-baseline gap-1.5">
                <CheckGlyph />
                <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{linkify(text)}</span>
              </div>
            ) : (
              <div className="text-xs text-ink-faint">(no answer)</div>
            )}
            {(facts.notes ?? [])
              .filter((note) => note.name === answer.name)
              .map((note, n) => (
                <div key={n} className="min-w-0 text-xs text-ink-dim [overflow-wrap:anywhere]">
                  <span className="text-ink-faint">{"\u270E "}</span>
                  {note.option.length > 0 ? `${note.option}: ` : ""}
                  {linkify(note.text)}
                </div>
              ))}
          </div>
        );
      })}
      {facts.timedOut && (
        <div className="text-xs text-ink-faint">auto-selected after timeout — not a user choice</div>
      )}
    </div>
  );
}

function jsonText(value: unknown, pretty = true): string {
  try {
    return (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) ?? String(value);
  } catch {
    // Cyclic or exotic args must not take the transcript down with them.
    return String(value);
  }
}

/**
 * Falls back to a short arg summary when the event carried no `intent`.
 * Replayed history is the common case: `tool_execution_start.intent` only
 * exists on the live stream, but omp puts the same text in the tool's own `i`
 * argument, which survives in the session file.
 *
 * Returns "" rather than the tool name when nothing descriptive exists — the
 * header already renders the name, and echoing it read as "edit edit".
 */
export function argSummary(args: unknown): string {
  const first =
    strField(args, "i") ??
    strField(args, "command") ??
    strField(args, "path") ??
    strField(args, "file_path") ??
    strField(args, "pattern") ??
    strField(args, "query") ??
    strField(args, "url") ??
    strField(args, "agent");
  if (!first) return "";
  return first.length > 90 ? `${first.slice(0, 90)}…` : first;
}

/** generate_image provenance for one thumbnail (issue #672); null when nothing is known. */
function imageCaption(
  model: string | undefined,
  image: { size?: string; quality?: string },
): string | null {
  const parts: string[] = [];
  if (model) parts.push(model);
  const dims = /(\d+)\s*[xX×]\s*(\d+)/.exec(image.size ?? "");
  if (dims) parts.push(`${dims[1]} × ${dims[2]} px`);
  else if (image.size) parts.push(image.size);
  if (image.quality) parts.push(image.quality);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/* ------------------------------------------------------------- notes */

const SEVERITY_TONE: Record<string, Tone> = {
  blocker: "rose",
  concern: "copper",
  nit: "neutral",
};

/**
 * Advisor notes render identically whether they arrive on a tool result or as
 * a standalone advisory message, so both call sites share this.
 */
export function AdvisoryNotes({ notes }: { notes: AdvisorNote[] }) {
  return (
    <div className="space-y-1.5">
      {notes.map((note, i) => {
        const severity = note.severity ?? "nit";
        const tone = SEVERITY_TONE[severity] ?? "neutral";
        return (
          <div
            key={i}
            className={cn(
              "animate-rise rounded-md py-1.5 pl-2.5 pr-2",
              tone === "rose" && "edge-lit border-l-[3px] border-rose-dim bg-rose-wash",
              tone === "copper" && "border-l-[3px] border-copper-dim bg-copper-wash",
              tone === "neutral" && "border-l-2 border-line-strong bg-sunken",
            )}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <Chip mono className="uppercase">
                {note.advisor ?? "advisor"}
              </Chip>
              <Chip tone={tone}>{severity}</Chip>
            </div>
            <Markdown
              text={note.note}
              className={cn("text-sm", tone === "neutral" ? "text-ink-dim" : "text-ink-mid")}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The tool commands that ran inside this bash call (issue #1274). From omp
 * 19.1 a mounted tool invoked as a command ships no separate
 * `tool_execution_*` frames — the run's `details.toolCommands` record is the
 * transcript's only view of them, and upstream renders exactly that nesting:
 * one row per dispatch under the bash card, in invocation order, each with
 * its own exit status (independent of the outer shell's).
 */
function ToolCommandRows({ item }: { item: ToolItem }) {
  if (item.name !== "bash") return null;
  const dispatches = item.toolCommands ?? [];
  if (dispatches.length === 0) return null;
  return (
    <div className="space-y-1">
      <Label>tool commands</Label>
      <ul className="space-y-0.5">
        {dispatches.map((dispatch, index) => (
          <li key={`${dispatch.tool}:${index}`} data-tool-command={dispatch.tool} className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-ink-dim">
              <ToolGlyph kind={glyphFor(dispatch.tool)} />
            </span>
            <span
              className="min-w-0 truncate font-mono text-xs text-ink-mid"
              title={dispatch.args === undefined ? dispatch.tool : `${dispatch.tool} ${jsonText(dispatch.args, false)}`}
            >
              {dispatch.tool}
            </span>
            {dispatch.mode === "help" && <Chip mono>help</Chip>}
            {dispatch.exitCode !== 0 && <Chip tone="rose">exit {dispatch.exitCode}</Chip>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tool-result metadata is distinct from RPC shell-row provenance. Keep the output notice intact. */
function ToolTruncationFacts({ item }: { item: ToolItem }) {
  const metadata = item.toolTruncation;
  if (!metadata) return null;
  const facts: string[] = [];
  const elision = metadata.truncation;
  if (elision) {
    const lines = elision.elidedLines === undefined ? undefined : `${elision.elidedLines.toLocaleString("en")} lines`;
    const bytes = elision.elidedBytes === undefined ? undefined : formatBytes(elision.elidedBytes);
    const magnitude = lines && bytes ? `${lines} (${bytes})` : lines ?? bytes;
    const directionLabel = {
      // Upstream direction names the retained window, not the elided side.
      head: "Tail elided",
      tail: "Head elided",
      middle: "Middle elided",
    } as const;
    facts.push(`${directionLabel[elision.direction]}: ${magnitude ?? "output truncated"}`);
  }
  const columns = metadata.columnTruncated;
  if (columns) {
    const limit = columns.maxColumn.toLocaleString("en");
    facts.push(`Column cut: maxColumn ${limit}`);
    if (columns.unit) facts.push(columns.unit === "bytes" ? "UTF-8 bytes per line" : "UTF-16 characters per line");
  }
  return <div className="font-mono text-xs tabular-nums text-ink-faint">{facts.join(" · ")}</div>;
}

/* ---------------------------------------------------------------- card */

/** Stable no-op selector for mounts without a tab (SubagentView): the hook
 *  must stay unconditional. */
export const readNoStall = (): undefined => undefined;

/** The running chip, or the stalled readout while the model stream is silent (issue #228). */
export function RunningChip({ streamStallMs }: { streamStallMs: number | undefined }) {
  return streamStallMs === undefined ? (
    <Chip tone="copper">running</Chip>
  ) : (
    <Chip tone="copper" mono title="No model-stream frame (text, thinking, or tool-call arguments) has arrived while the assistant response is open. Local tool execution does not reset this clock.">
      {`stalled ${formatDuration(streamStallMs)}`}
    </Chip>
  );
}

/**
 * The header headline rule (issue #1274): while a call streams, the surface
 * shows the brief intent — an explicit `toolIntentLabel` on the wire outranks
 * the derived colon split of `intent`; a settled card shows the whole text
 * again, since ranking and history keep it. `fallback` covers the no-intent
 * case (an args summary).
 */
export function toolHeadline(item: ToolItem, fallback: string): string {
  if (item.status !== "running") return fallback;
  const rawIntent = item.intent ?? strField(item.args, "i");
  if (item.toolIntentLabel !== undefined && item.toolIntentLabel !== "") {
    return item.toolIntentLabel;
  }
  return rawIntent !== undefined ? toolIntentLabel(rawIntent) : fallback;
}

export function ToolCard({
  item,
  tabId,
  nestedBody,
}: {
  item: ToolItem;
  tabId?: string;
  /** Child tool cards this call spawned (issue #1274), built by the transcript
   *  view; rendered inside this card's body so collapsing the parent collapses
   *  its children with it. */
  nestedBody?: ReactNode;
}) {
  const streamStallMs = useStore(
    tabId === undefined ? readNoStall : (s) => s.rpc[tabId]?.streamStallMs,
  );
  // Only omp 19+ spills raw output to `local://N.log` files that a card can
  // read back; below the gate (or before the version is known) the card keeps
  // today's shape: the recovery notice in the text, no action (issue #1236).
  const canReadSpill = useStore(
    tabId === undefined ? readNoStall : (s) => supportsSpillRead(s.rpc[tabId]?.capabilities?.ompVersion ?? null),
  );
  const [rawOutputOpen, setRawOutputOpen] = useState(false);
  const resultLines = useMemo(
    () => (item.resultText ? item.resultText.split("\n").length : 0),
    [item.resultText],
  );
  const resultText = useMemo(
    () => (item.resultText === undefined ? undefined : linkify(item.resultText)),
    [item.resultText],
  );
  const toolViewerImages = useMemo(
    () =>
      (item.images ?? []).map((im, n) => ({
        src: `data:${im.mimeType};base64,${im.data}`,
        mimeType: im.mimeType,
        label: `tool result image ${n + 1}`,
        ...(item.imageModel !== undefined ? { model: item.imageModel } : {}),
        ...(im.quality !== undefined ? { quality: im.quality } : {}),
      })),
    [item.images, item.imageModel],
  );
  const hasDiff = (item.diff?.length ?? 0) > 0;
  const longOutput = resultLines > LONG_OUTPUT_LINES;
  // A finished, quiet card earns its silence; anything unresolved or reviewable
  // stays open so the user never has to hunt for what needs attention.
  const [open, setOpen] = useState(
    item.status !== "done" || hasDiff || (item.notes?.length ?? 0) > 0 || !longOutput,
  );

  // Upstream's brief-label rule (issue #1274) via the shared headline helper.
  const rawIntent = item.intent ?? strField(item.args, "i");
  const fullHeadline = rawIntent ?? argSummary(item.args);
  const headline = toolHeadline(item, fullHeadline);
  const duration = item.wallTimeMs !== undefined ? formatDuration(item.wallTimeMs) : "";
  const draft = useMemo(() => editDraft(item.name, item.args), [item.name, item.args]);
  const taskFiles = useMemo(
    () => (glyphFor(item.name) === "agent" ? taskFileRows(item.args, item.taskFiles) : []),
    [item.name, item.args, item.taskFiles],
  );
  const taskStages = useMemo(
    () => (glyphFor(item.name) === "agent" ? taskStepRows(item.args) : []),
    [item.name, item.args],
  );
  const kind = glyphFor(item.name);
  // Where the command ran (issue #1093): prefer the directory omp resolved —
  // an explicit `cwd` arg or a `cd` it hoisted — over the bare request, and
  // label an args-only fallback as requested so the card never claims omp
  // confirmed it. The command slab stays exactly the model's text: no
  // reconstructed `cd` prefix, so an original `cd dir && …` is never doubled.
  const execDir = useMemo(() => {
    if (kind !== "bash") return null;
    if (item.cwd !== undefined) return { cwd: item.cwd, resolved: true } as const;
    const requested = cwdText(item.args);
    return requested !== undefined ? { cwd: requested, resolved: false } as const : null;
  }, [kind, item.cwd, item.args]);
  const resultLang = kind === "read" ? langFromPath(item.path ?? pathFromArgs(item.args)) : undefined;
  // Read bodies stream with the same header+gutter shape as the settled result;
  // until the header line arrives we cannot tell read output from prose.
  const resultParts = useMemo(
    () => (kind === "read" && typeof item.resultText === "string" ? splitReadResult(item.resultText) : null),
    [kind, item.resultText],
  );
  const partialParts = useMemo(
    () => (kind === "read" && typeof item.partialText === "string" ? splitReadResult(item.partialText) : null),
    [kind, item.partialText],
  );
  const partialLang = useMemo(
    () =>
      kind === "read"
        ? langFromPath(item.path ?? pathFromArgs(item.args))
        : editDraft(item.name, item.args)?.lang,
    [kind, item.name, item.args, item.path],
  );
  const planWrite = isPlanArtifactPath(item.path ?? pathFromArgs(item.args));
  const hasBody =
    item.args !== undefined ||
    item.resultText !== undefined ||
    item.toolTruncation !== undefined ||
    (item.images?.length ?? 0) > 0 ||
    hasDiff ||
    item.partialText !== undefined ||
    execDir !== null ||
    (item.name === "bash" && (item.toolCommands?.length ?? 0) > 0) ||
    nestedBody !== undefined ||
    draft !== null ||
    (item.notes?.length ?? 0) > 0;

  return (
    <Panel tone={item.status === "error" ? "rose" : "neutral"} className="animate-rise">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {hasBody ? (
          <Chevron open={open} className="text-ink-faint" />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        <span
          className={cn(
            "shrink-0",
            item.status === "running" ? "text-copper" : "text-ink-dim",
          )}
        >
          <ToolGlyph kind={glyphFor(item.name)} />
        </span>
        <span className="shrink-0 font-mono text-xs font-semibold text-ink">{item.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-mid" title={fullHeadline}>
          {headline}
        </span>
        {duration && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-ink-faint">
            {duration}
          </span>
        )}
        {planWrite && <Chip tone="iris">plan</Chip>}
        {item.askFacts?.timedOut === true && (
          <Chip tone="copper" title="auto-selected after timeout — not a user choice">
            timed out
          </Chip>
        )}
        {item.status === "running" && <RunningChip streamStallMs={streamStallMs} />}
        {item.status === "error" && item.errorKind !== undefined && (
          <Chip tone="rose" title={`Why omp refused this edit: ${item.errorKind}`}>
            {editErrorKindLabel(item.errorKind)}
          </Chip>
        )}
        {item.status === "error" && <Chip tone="rose">error</Chip>}
        {item.status === "aborted" && <Chip tone="copper">aborted</Chip>}
        {item.status === "cancelled" && <Chip>cancelled</Chip>}
        {item.status === "done" && <CheckGlyph />}
      </button>

      {item.status === "running" && (
        <ProgressSweep tone="copper" paused={streamStallMs !== undefined} />
      )}
      {item.name === "web_search" && (item.providerFailures?.length ?? 0) > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1.5 px-2.5 pb-2">
          {item.providerFailures!.map((failure, index) => (
            <Chip key={`${failure.provider}-${index}`} tone="rose" className="min-w-0 max-w-full whitespace-normal">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {failure.status === undefined ? `${failure.label} — ${failure.reason}` : `${failure.label} — ${failure.reason} (status ${failure.status ?? ""})`}
              </span>
            </Chip>
          ))}
        </div>
      )}
      {open && hasBody && (
        <div className="space-y-2 border-t border-line-soft px-2.5 py-2">
          <ToolArgs name={item.name} args={item.args} />

          {/* `ask` still open: the dialog owns the interaction; say what the
              card is waiting for instead of the form source (issue #1203). */}
          {item.name === "ask" && item.askFacts === undefined && item.status === "running" && (
            <div className="text-xs text-ink-faint">Waiting for your answer…</div>
          )}

          {item.askFacts !== undefined && <AskAnswers facts={item.askFacts} />}

          {execDir && (
            <div className="flex min-w-0 items-baseline gap-1.5 font-mono text-xs">
              <Label>{execDir.resolved ? "cwd" : "cwd (requested)"}</Label>
              {/* Wraps instead of clipping: the directory must stay readable,
                  and `[overflow-wrap:anywhere]` inside the card's min-w-0 body
                  keeps even a single long segment from growing the page. */}
              <span
                data-selectable
                title={execDir.cwd}
                className="min-w-0 text-ink-mid [overflow-wrap:anywhere]"
              >
                {execDir.cwd}
              </span>
            </div>
          )}

          {taskFiles.length > 0 && <TaskFiles rows={taskFiles} />}

          {taskStages.length > 0 && <TaskStages rows={taskStages} />}

          {(item.path || item.op) && !hasDiff && (
            <div className="flex flex-wrap items-center gap-1.5">
              <OpChip op={item.op} />
              {item.path && <PathChip value={item.path} />}
            </div>
          )}

          {item.status === "running" && draft && (
            <div className="space-y-1">
              <Label>writing</Label>
              <IncrementalCodeSlab
                code={draft.code}
                lang={draft.lang}
                pin={item.argsStreaming === true}
              />
            </div>
          )}

          {item.status === "running" && item.partialText && (
            <div className="space-y-1">
              <Label>streaming</Label>
              {partialParts?.header !== null && partialParts ? (
                <ReadResultSlab parts={partialParts} lang={partialLang} pin className="max-h-32" />
              ) : partialLang !== undefined ? (
                <IncrementalCodeSlab code={item.partialText} lang={partialLang} pin className="max-h-32" />
              ) : (
                <Slab className="max-h-32" pin>
                  {linkify(item.partialText)}
                </Slab>
              )}
            </div>
          )}

          {hasDiff && item.diff && <DiffViewer rows={item.diff} path={item.path} op={item.op} defaultOpen />}

          {item.minimized && (
            <div className="font-mono text-xs tabular-nums text-ink-faint">
              {`Minimized: ${item.minimized.filter} ${formatBytes(item.minimized.inputBytes)} → ${formatBytes(item.minimized.outputBytes)}`}
            </div>
          )}

          <ToolCommandRows item={item} />

          {/* Session tools this call invoked (issue #1274): the transcript view
              builds the indented child-card section; it lives inside this body,
              so collapsing the parent collapses its children with it. */}
          {nestedBody}

          <ToolTruncationFacts item={item} />

          {item.spillRef !== undefined && canReadSpill && tabId !== undefined && (
            <>
              <button
                type="button"
                onClick={() => setRawOutputOpen(true)}
                className="block self-start border-0 bg-transparent p-0 font-mono text-xs text-iris hover:underline"
              >
                view raw output
              </button>
              {rawOutputOpen && (
                <RawOutputViewer tabId={tabId} spill={item.spillRef} onClose={() => setRawOutputOpen(false)} />
              )}
            </>
          )}

          {/* An answered ask's result text is omp's model-facing restatement of the
              same answers the card body already renders; drop it, as omp's own
              renderer does. (issue #1203) */}
          {item.askFacts === undefined &&
            item.resultText !== undefined &&
            item.resultText !== "" &&
            (longOutput ? (
              <Disclosure
                summary={
                  <span className="text-xs">
                    {`show output · ${resultLines} lines`}
                  </span>
                }
              >
                {resultParts?.header !== null && resultParts ? (
                  <ReadResultSlab parts={resultParts} lang={resultLang} className="mt-1 max-h-48" />
                ) : (
                  <Slab className="mt-1 max-h-48" tone={item.status === "error" ? "rose" : "neutral"}>
                    {resultText}
                  </Slab>
                )}
              </Disclosure>
            ) : resultParts?.header !== null && resultParts ? (
              <ReadResultSlab parts={resultParts} lang={resultLang} className="max-h-48" />
            ) : (
              <Slab className="max-h-48" tone={item.status === "error" ? "rose" : "neutral"}>
                {resultText}
              </Slab>
            ))}

          {(item.images?.length ?? 0) > 0 && (
            <div
              role="group"
              aria-label="result images"
              className="flex flex-wrap gap-1.5"
            >
              {(item.images ?? []).map((image, i) => {
                const caption = imageCaption(item.imageModel, image);
                return (
                  <div key={i} className="flex flex-col items-start gap-1">
                    {/* Index-keyed deliberately, as in UserBubble: the list is fixed
                        once rendered and the base64 payload is far too long a key. */}
                    <button
                      type="button"
                      className="block cursor-zoom-in rounded border-0 p-0"
                      title={`${image.mimeType} — image ${i + 1} of ${item.images!.length}`}
                      aria-label={`enlarge image ${i + 1}`}
                      onClick={() => openImageViewer(toolViewerImages, i)}
                    >
                      <img
                        src={`data:${image.mimeType};base64,${image.data}`}
                        alt={`tool result image ${i + 1}`}
                        className="max-h-40 rounded border border-line-strong bg-sunken object-contain"
                      />
                    </button>
                    {caption && (
                      <span className="font-mono text-xs text-ink-faint">{caption}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {item.notes && item.notes.length > 0 && <AdvisoryNotes notes={item.notes} />}
        </div>
      )}
    </Panel>
  );
}
