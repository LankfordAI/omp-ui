import { useEffect, useMemo, useRef, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { cn } from "../lib/cn";
import { HIGHLIGHT_CHAR_CAP, langFromPath, useHighlightTokens } from "../lib/highlight";
import { useT, type MessageKey } from "../lib/i18n";
import { diffCounts, hunkStarts, pairWordRanges, rowSegments, type DiffRow, type DiffSegment } from "../lib/omp-diff";
import { useStore } from "../store";
import { Chevron, Chip, CopyButton, ICON_STROKE, IconButton, type Tone } from "./ui";

const ROW_CLASS: Record<DiffRow["kind"], string> = {
  add: "border-signal-dim bg-signal-wash text-signal",
  del: "border-rose-dim bg-rose-wash text-rose",
  ctx: "border-transparent text-ink-dim",
  meta: "border-transparent bg-sunken italic text-ink-faint",
};

const EMPH_CLASS: Partial<Record<DiffRow["kind"], string>> = {
  add: "rounded-sm bg-signal-dim/20",
  del: "rounded-sm bg-rose-dim/20",
};

const SIGN: Record<DiffRow["kind"], string> = { add: "+", del: "-", ctx: " ", meta: " " };

const OP_KEY: Partial<Record<string, MessageKey>> = {
  create: "diff.op.create",
  update: "diff.op.update",
  modified: "diff.op.modified",
  delete: "diff.op.delete",
  write: "diff.op.write",
};

/** Localized operation chip; an unknown op is data and prints as-is. */
export function OpChip({ op }: { op: string | undefined }) {
  const t = useT();
  if (!op) return null;
  const key = OP_KEY[op];
  // Rose for delete: destructive (ADR-0004).
  const tone: Tone = op === "create" ? "signal" : op === "delete" ? "rose" : "neutral";
  return <Chip tone={tone}>{key ? t(key) : op}</Chip>;
}

/** The gutter / sign / segments strip shared by the unified row and the two
 *  split columns; identical markup keeps both layouts reading the same. */
function Cells({ row, segments }: { row: DiffRow; segments: DiffSegment[] }) {
  const emph = EMPH_CLASS[row.kind];
  return (
    <>
      <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-ink-faint">
        {row.lineNum ?? ""}
      </span>
      {/* `whitespace-pre` over `break-all`: wrapping code at arbitrary columns
          destroys the alignment that makes a diff readable. */}
      <span className="select-none pr-1 opacity-70">{SIGN[row.kind]}</span>
      <span className="whitespace-pre pr-3">
        {segments.map((seg, i) => (
          <span
            key={i}
            className={seg.emph ? emph : undefined}
            style={seg.color ? { color: seg.color } : undefined}
          >
            {seg.text}
          </span>
        ))}
      </span>
    </>
  );
}

function Row({ row, segments }: { row: DiffRow; segments: DiffSegment[] }) {
  return (
    <div className={cn("flex border-l-2", ROW_CLASS[row.kind])}>
      <Cells row={row} segments={segments} />
    </div>
  );
}

/** One half-width column of a split line; the wash class comes from the
 *  caller so a single-sided row can paint its empty filler the same wash. */
function SplitCell({ row, segments, wash }: { row: DiffRow; segments: DiffSegment[]; wash: string }) {
  return (
    <div className={cn("flex min-w-0 flex-1 border-l-2", wash)}>
      <Cells row={row} segments={segments} />
    </div>
  );
}

const BLANK_ROW: DiffRow = { kind: "ctx", text: "" };
const BLANK_SEGMENTS: DiffSegment[] = [{ text: "", emph: false }];

/** The gap rule replacing a hunk header that skips unmodified lines (§C).
 *  A plain block child of the band, so in split layout it spans both
 *  columns; the raw `@@` text rides along as the tooltip. */
function CollapsedRule({ label, header }: { label: string; header: string }) {
  return (
    <div className={cn("flex items-center gap-3 border-l-2 py-0.5", ROW_CLASS.meta)} title={header}>
      <span className="h-px flex-1 bg-line" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Below this measured scroller width (~48rem) the split columns get too
 *  narrow to read, so the viewer silently renders unified regardless of the
 *  global preference. */
const SPLIT_MIN_WIDTH_PX = 768;

/** Layout glyphs: three full-width bars (unified) vs. paired half bars
 *  (split), drawn in the shared stroke idiom. */
function IconUnified() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" {...ICON_STROKE}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

function IconSplit() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" {...ICON_STROKE}>
      <path d="M2.5 4h4.6M8.9 4h4.6M2.5 8h4.6M8.9 8h4.6M2.5 12h4.6M8.9 12h4.6" />
    </svg>
  );
}

/** One rendered line of the split layout; indexes into `rows` (§D2). */
type SplitLine = { kind: "pair"; left: number; right: number } | { kind: "del" | "add" | "ctx" | "meta"; row: number };

/**
 * Rows → split lines. A maximal del run directly followed by a maximal add
 * run pairs index-for-index from the top, mirroring `pairWordRanges`; any
 * leftover emits single-sided lines whose opposite column renders blank.
 */
function toSplitLines(rows: readonly DiffRow[]): SplitLine[] {
  const out: SplitLine[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]?.kind !== "del") {
      out.push({ kind: rows[i]!.kind, row: i });
      i++;
      continue;
    }
    const delStart = i;
    while (rows[i]?.kind === "del") i++;
    const addStart = i;
    while (rows[i]?.kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) out.push({ kind: "pair", left: delStart + k, right: addStart + k });
    for (let k = delStart + pairs; k < addStart; k++) out.push({ kind: "del", row: k });
    for (let k = addStart + pairs; k < i; k++) out.push({ kind: "add", row: k });
  }
  return out;
}

export interface DiffViewerProps {
  rows: DiffRow[];
  path?: string;
  op?: string;
  /** Exact patch text for copy; falls back to rows rebuilt with sign prefixes. */
  patch?: string;
  renamedFrom?: string;
  binary?: boolean;
  /** Controlled open state (branch diff pane expand/collapse all). Uncontrolled when undefined. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Initial state for the uncontrolled path; the closed default stays for
   *  callers without one (branch diff pane's multi-file scroll wall, #34). */
  defaultOpen?: boolean;
}

export function DiffViewer(props: DiffViewerProps) {
  const { rows, path, op, renamedFrom, binary } = props;
  const t = useT();
  const { added, removed } = useMemo(() => diffCounts(rows), [rows]);
  const rebuilt = useMemo(
    () => rows.map((row) => (row.kind === "meta" ? row.text : `${SIGN[row.kind]}${row.text}`)).join("\n"),
    [rows],
  );
  const patch = props.patch ?? rebuilt;

  // Collapsed unless the caller opts into defaultOpen (issue #34): the branch
  // diff pane's multi-file scroll wall keeps the closed start.
  const [ownOpen, setOwnOpen] = useState(props.defaultOpen ?? false);
  const open = props.open ?? ownOpen;
  const setOpen = (v: boolean) => {
    if (props.open === undefined) setOwnOpen(v);
    props.onOpenChange?.(v);
  };

  const expandable = rows.length > 0;

  // Gap collapse (§C): a `@@` hunk header preceded by numbered rows hides the
  // unmodified lines between them — one entry per row, non-null on meta rows
  // that carry a gap. Pure render-pass bookkeeping; the rows themselves are
  // untouched, so copy-patch stays verbatim.
  const collapse = useMemo(() => {
    const gaps: (number | null)[] = rows.map(() => null);
    let lastOld: number | null = null;
    let lastNew: number | null = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.kind === "meta") {
        const starts = hunkStarts(row.text);
        // No prior numbered row: a leading hunk header stays raw.
        if (starts === null || (lastOld === null && lastNew === null)) continue;
        const sides: number[] = [];
        // `+0,0` (deleted file): git's zero start means "no side", skip it.
        if (lastOld !== null && starts.oldStart > 0) sides.push(starts.oldStart - lastOld - 1);
        if (lastNew !== null && starts.newStart > 0) sides.push(starts.newStart - lastNew - 1);
        if (sides.length === 0) continue;
        const gap = Math.min(...sides);
        if (gap > 0) gaps[i] = gap;
        continue;
      }
      // add/ctx carry the new line number, del/ctx the old — but ctx carries
      // both in one `lineNum`, and each parser stores the side this row shows.
      if (row.lineNum !== undefined) {
        if (row.kind === "add") lastNew = row.lineNum;
        else if (row.kind === "del") lastOld = row.lineNum;
        else {
          lastOld = row.lineNum;
          lastNew = row.lineNum;
        }
      }
    }
    return gaps;
  }, [rows]);

  // Global layout preference (§D2): persisted by the store, never here.
  const layout = useStore((s) => s.diffViewLayout);
  const setLayout = useStore((s) => s.setDiffViewLayout);

  // Narrow fallback: measure the scroller; under ~48rem split loses more
  // than it gains, so unified wins regardless of the preference.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!open) return;
    const el = scrollerRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setNarrow(el.clientWidth > 0 && el.clientWidth < SPLIT_MIN_WIDTH_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);
  const split = layout === "split" && !narrow;
  const splitLines = useMemo(() => (open && split ? toSplitLines(rows) : []), [open, split, rows]);

  // Two continuous grammar passes (old side: ctx+del, new side: ctx+add).
  const { oldCode, newCode, oldCount, newCount } = useMemo(() => {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const row of rows) {
      if (row.kind === "del" || row.kind === "ctx") oldLines.push(row.text);
      if (row.kind === "add" || row.kind === "ctx") newLines.push(row.text);
    }
    return {
      oldCode: oldLines.join("\n"),
      newCode: newLines.join("\n"),
      oldCount: oldLines.length,
      newCount: newLines.length,
    };
  }, [rows]);
  const lang = langFromPath(path);
  const enabled = open && oldCode.length + newCode.length < HIGHLIGHT_CHAR_CAP;
  const oldTokens = useHighlightTokens(oldCode, lang, enabled);
  const newTokens = useHighlightTokens(newCode, lang, enabled);
  const ranges = useMemo(() => pairWordRanges(rows), [rows]);

  const segments = useMemo(() => {
    if (!open) return [];
    const oldSide = oldTokens && oldTokens.length === oldCount ? oldTokens : null;
    const newSide = newTokens && newTokens.length === newCount ? newTokens : null;
    let o = 0;
    let n = 0;
    return rows.map((row, i) => {
      let tokens: ThemedToken[] | undefined;
      if (row.kind === "del") tokens = oldSide?.[o++];
      else if (row.kind === "add") tokens = newSide?.[n++];
      else if (row.kind === "ctx") {
        tokens = newSide?.[n++];
        o++;
      }
      return rowSegments(row.text, tokens, ranges[i] ?? null);
    });
  }, [open, rows, oldTokens, newTokens, oldCount, newCount, ranges]);

  const shown = path ?? t("diff.viewer.fallbackName");
  const cut = shown.lastIndexOf("/") + 1;
  const dir = shown.slice(0, cut);
  const base = shown.slice(cut);
  const headerClass = "flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left transition-colors hover:text-ink";
  const header = (
    <>
          {/* Top row: the name gets the full width; counts pin right. */}
          <span className="flex w-full min-w-0 items-baseline gap-2 font-mono text-[11px]" title={path}>
            {/* Dirname yields under pressure; the basename is what identifies
                the file at a glance. Only a basename wider than the whole row
                clips (max-w-full + truncate), never into its siblings. */}
            <span className="flex min-w-0 flex-1 items-baseline">
              <span className="truncate text-ink-faint">{dir}</span>
              <span className="max-w-full shrink-0 truncate text-ink-mid">{base}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              <span className="text-signal">+{added}</span>{" "}
              <span className="text-rose">−{removed}</span>
            </span>
          </span>
          {/* Bottom row: expand affordance and status chip. */}
          <span className="flex w-full min-w-0 items-center gap-2">
            {expandable && <Chevron open={open} />}
            <OpChip op={op} />
            {renamedFrom !== undefined && (
              <>
                <Chip>{t("diff.op.rename")}</Chip>
                <span className="min-w-0 truncate font-mono text-[10px] text-ink-faint" title={renamedFrom}>
                  {t("diff.viewer.renamedFrom", { path: renamedFrom })}
                </span>
              </>
            )}
            {binary && <Chip>{t("diff.viewer.binary")}</Chip>}
          </span>
    </>
  );

  // Unified/split preference; two icon-buttons, the pressed one raised.
  const layoutControl = open && expandable && (
    <span className="flex shrink-0 items-center gap-0.5" role="group">
      <IconButton label={t("diff.viewer.viewUnified")} pressed={layout === "unified"} onClick={() => setLayout("unified")}>
        <IconUnified />
      </IconButton>
      <IconButton label={t("diff.viewer.viewSplit")} pressed={layout === "split"} onClick={() => setLayout("split")}>
        <IconSplit />
      </IconButton>
    </span>
  );

  return (
    <div className="overflow-hidden rounded-md border border-line bg-sunken">
      <div className={cn("flex items-end gap-2 px-2 py-1", open && expandable && "border-b border-line-soft")}>
        {expandable ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={headerClass}>
            {header}
          </button>
        ) : (
          <div className={headerClass}>{header}</div>
        )}
        {/* A button inside the header button is invalid HTML — the layout
            control and copy affordance stay siblings (bottom-aligned onto
            the second row by items-end). The copy button works while
            collapsed because the patch memoizes off `rows`, not the open
            state. */}
        {layoutControl}
        {(props.patch !== undefined || expandable) && (
          <CopyButton text={patch} label={t("diff.viewer.patchLabel")} />
        )}
      </div>

      {open && expandable && (
        // The toggle sits outside the horizontal scroller so a wide diff cannot
        // push it off-screen; only the rows themselves pan sideways.
        <div ref={scrollerRef} className="overflow-x-auto font-mono text-[12px] leading-[1.5]">
          {split ? (
            // Split: two half-width columns per line, no `w-max` — the
            // columns share the scrollport 50/50 instead of sizing to the
            // widest row; each side pans its own half.
            <div className="min-w-full" data-selectable>
              {splitLines.map((line, i) => {
                const seg = (index: number): DiffSegment[] =>
                  segments[index] ?? [{ text: rows[index]?.text ?? "", emph: false }];
                if (line.kind === "meta") {
                  const row = rows[line.row]!;
                  const gap = collapse[line.row];
                  // The rule and raw headers span the full band, not half a
                  // column each — the hunk boundary is file-wide context.
                  return gap !== null ? (
                    <CollapsedRule key={i} label={t("diff.viewer.unmodified", { count: gap })} header={row.text} />
                  ) : (
                    <Row key={i} row={row} segments={seg(line.row)} />
                  );
                }
                if (line.kind === "ctx") {
                  const row = rows[line.row]!;
                  // Context mirrors both sides: same text, same digit.
                  return (
                    <div key={i} className="flex">
                      <SplitCell row={row} segments={seg(line.row)} wash={ROW_CLASS.ctx} />
                      <SplitCell row={row} segments={seg(line.row)} wash={ROW_CLASS.ctx} />
                    </div>
                  );
                }
                if (line.kind === "pair") {
                  return (
                    <div key={i} className="flex">
                      <SplitCell row={rows[line.left]!} segments={seg(line.left)} wash={ROW_CLASS.del} />
                      <SplitCell row={rows[line.right]!} segments={seg(line.right)} wash={ROW_CLASS.add} />
                    </div>
                  );
                }
                // Single-sided leftover: the empty opposite column gets the
                // same wash so the band stays one continuous stripe.
                const fill = <SplitCell row={BLANK_ROW} segments={BLANK_SEGMENTS} wash={ROW_CLASS[line.kind]} />;
                const real = <SplitCell row={rows[line.row]!} segments={seg(line.row)} wash={ROW_CLASS[line.kind]} />;
                return (
                  <div key={i} className="flex">
                    {line.kind === "del" ? (
                      <>
                        {real}
                        {fill}
                      </>
                    ) : (
                      <>
                        {fill}
                        {real}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            // `min-w-full w-max`: the wash band spans max(scrollport, widest
            // row) so every add/del row shares one continuous edge-to-edge
            // highlight while panning (issue #92). `data-selectable` lifts the
            // body's user-select: none so code can be copied.
            <div className="min-w-full w-max" data-selectable>
              {rows.map((row, i) => {
                const gap = collapse[i];
                return gap !== null ? (
                  <CollapsedRule key={i} label={t("diff.viewer.unmodified", { count: gap })} header={row.text} />
                ) : (
                  <Row key={i} row={row} segments={segments[i] ?? [{ text: row.text, emph: false }]} />
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
