import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/duration";
import { langFromPath, useHighlightTokens } from "../lib/highlight";
import { strField } from "../lib/fields";
import type { AdvisorNote, ToolItem } from "../lib/transcript";
import { isPlanArtifactPath } from "@omp-ui/core/plan";
import { DiffViewer } from "./DiffViewer";
import { linkify, Markdown } from "./Markdown";
import { Chip, Chevron, Disclosure, Label, Panel, ProgressSweep, type Tone } from "./ui";

/** Result blocks longer than this collapse; a done card with one also starts closed. */
const LONG_OUTPUT_LINES = 12;
const ARG_VALUE_MAX = 120;



/* -------------------------------------------------------------- glyphs */

type GlyphKind = "read" | "write" | "bash" | "search" | "agent" | "web" | "todo" | "generic";

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
function glyphFor(name: string): GlyphKind {
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

function ToolGlyph({ kind }: { kind: GlyphKind }) {
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

function CheckGlyph() {
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

function pathFromArgs(args: unknown): string | undefined {
  return strField(args, "path") ?? strField(args, "file_path") ?? strField(args, "file");
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

/** The mono slab used for commands, paths, partial output and results. */
function Slab({
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
        "font-mono text-[12px] leading-[1.55]",
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
function CodeSlab({ code, lang, pin }: { code: string; lang?: string; pin?: boolean }) {
  const tokens = useHighlightTokens(code, lang, code.length < 20_000);
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
      className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-sunken px-2 py-1.5 font-mono text-[12px] leading-[1.55] text-ink"
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

function PathChip({ value }: { value: string }) {
  const cut = value.lastIndexOf("/") + 1;
  return (
    <span
      title={value}
      data-selectable
      className="flex min-w-0 items-baseline rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px]"
    >
      <span className="truncate text-ink-faint">{value.slice(0, cut)}</span>
      <span className="shrink-0 text-ink-mid">{value.slice(cut)}</span>
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
          {pattern && <Chip mono title={pattern}>{pattern}</Chip>}
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
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
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
          <Slab className="mt-1 max-h-48">{jsonText(args)}</Slab>
        </Disclosure>
      )}
    </div>
  );
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
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
function argSummary(args: unknown): string {
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
              className={cn("text-[13px]", tone === "neutral" ? "text-ink-dim" : "text-ink-mid")}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- card */

export function ToolCard({ item }: { item: ToolItem }) {
  const resultLines = useMemo(
    () => (item.resultText ? item.resultText.split("\n").length : 0),
    [item.resultText],
  );
  const resultText = useMemo(
    () => (item.resultText === undefined ? undefined : linkify(item.resultText)),
    [item.resultText],
  );
  const hasDiff = (item.diff?.length ?? 0) > 0;
  const longOutput = resultLines > LONG_OUTPUT_LINES;
  // A finished, quiet card earns its silence; anything unresolved or reviewable
  // stays open so the user never has to hunt for what needs attention.
  const [open, setOpen] = useState(
    item.status !== "done" || hasDiff || (item.notes?.length ?? 0) > 0 || !longOutput,
  );

  const headline = item.intent ?? argSummary(item.args);
  const duration = item.wallTimeMs !== undefined ? formatDuration(item.wallTimeMs) : "";
  const draft = useMemo(() => editDraft(item.name, item.args), [item.name, item.args]);
  const planWrite = isPlanArtifactPath(item.path ?? pathFromArgs(item.args));
  const hasBody =
    item.args !== undefined ||
    item.resultText !== undefined ||
    hasDiff ||
    item.partialText !== undefined ||
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
        <span className="min-w-0 flex-1 truncate text-xs text-ink-mid" title={headline}>
          {headline}
        </span>
        {duration && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
            {duration}
          </span>
        )}
        {planWrite && <Chip tone="iris">plan</Chip>}
        {item.status === "running" && <Chip tone="copper">running</Chip>}
        {item.status === "error" && <Chip tone="rose">error</Chip>}
        {item.status === "cancelled" && <Chip>cancelled</Chip>}
        {item.status === "done" && <CheckGlyph />}
      </button>

      {item.status === "running" && <ProgressSweep tone="copper" />}

      {open && hasBody && (
        <div className="space-y-2 border-t border-line-soft px-2.5 py-2">
          <ToolArgs name={item.name} args={item.args} />

          {(item.path || item.op) && !hasDiff && (
            <div className="flex flex-wrap items-center gap-1.5">
              {item.op && <Chip tone={item.op === "create" ? "signal" : "neutral"}>{item.op}</Chip>}
              {item.path && <PathChip value={item.path} />}
            </div>
          )}

          {item.status === "running" && draft && (
            <div className="space-y-1">
              <Label>writing</Label>
              <CodeSlab code={draft.code} lang={draft.lang} pin={item.argsStreaming === true} />
            </div>
          )}

          {item.status === "running" && item.partialText && (
            <div className="space-y-1">
              <Label>streaming</Label>
              <Slab className="max-h-32" pin>
                {linkify(item.partialText)}
              </Slab>
            </div>
          )}

          {hasDiff && item.diff && <DiffViewer rows={item.diff} path={item.path} op={item.op} />}

          {item.resultText !== undefined &&
            item.resultText !== "" &&
            (longOutput ? (
              <Disclosure
                summary={
                  <span className="text-[11px]">
                    show output · {resultLines} lines
                  </span>
                }
              >
                <Slab
                  className="mt-1 max-h-48"
                  tone={item.status === "error" ? "rose" : "neutral"}
                >
                  {resultText}
                </Slab>
              </Disclosure>
            ) : (
              <Slab className="max-h-48" tone={item.status === "error" ? "rose" : "neutral"}>
                {resultText}
              </Slab>
            ))}

          {item.notes && item.notes.length > 0 && <AdvisoryNotes notes={item.notes} />}
        </div>
      )}
    </Panel>
  );
}
