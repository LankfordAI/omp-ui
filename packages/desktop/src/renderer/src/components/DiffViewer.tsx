import { useMemo, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { cn } from "../lib/cn";
import { HIGHLIGHT_CHAR_CAP, langFromPath, useHighlightTokens } from "../lib/highlight";
import { useT, type MessageKey } from "../lib/i18n";
import { diffCounts, pairWordRanges, rowSegments, type DiffRow, type DiffSegment } from "../lib/omp-diff";
import { Chevron, Chip, CopyButton, type Tone } from "./ui";

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

function Row({ row, segments }: { row: DiffRow; segments: DiffSegment[] }) {
  const emph = EMPH_CLASS[row.kind];
  return (
    <div className={cn("flex border-l-2", ROW_CLASS[row.kind])}>
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
    </div>
  );
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

  // Collapsed by default (issue #34): a multi-file branch is a scroll wall, so
  // every diff starts as its header card and expands on header click.
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = (v: boolean) => {
    if (props.open === undefined) setOwnOpen(v);
    props.onOpenChange?.(v);
  };
  const expandable = rows.length > 0;

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
        {/* A button inside the header button is invalid HTML — the copy
            affordance stays a sibling (bottom-aligned onto the second row by
            items-end). It works while collapsed because the patch memoizes
            off `rows`, not the open state. */}
        {(props.patch !== undefined || expandable) && (
          <CopyButton text={patch} label={t("diff.viewer.patchLabel")} />
        )}
      </div>

      {open && expandable && (
        // The toggle sits outside the horizontal scroller so a wide diff cannot
        // push it off-screen; only the rows themselves pan sideways.
        <div className="overflow-x-auto font-mono text-[12px] leading-[1.5]">
          {/* `min-w-full w-max`: the wash band spans max(scrollport, widest
              row) so every add/del row shares one continuous edge-to-edge
              highlight while panning (issue #92). `data-selectable` lifts the
              body's user-select: none so code can be copied. */}
          <div className="min-w-full w-max" data-selectable>
            {rows.map((row, i) => (
              <Row key={i} row={row} segments={segments[i] ?? [{ text: row.text, emph: false }]} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
