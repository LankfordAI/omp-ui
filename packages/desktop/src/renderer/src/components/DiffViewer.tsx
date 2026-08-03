import { useMemo } from "react";
import { cn } from "../lib/cn";
import type { DiffRow } from "../lib/omp-diff";
import { Chip, CopyButton, Disclosure } from "./ui";

/** Past this many rows the tail hides behind a disclosure. */
const COLLAPSE_OVER = 40;
const HEAD_ROWS = 24;

const ROW_CLASS: Record<DiffRow["kind"], string> = {
  add: "border-signal-dim bg-signal-wash text-signal",
  del: "border-rose-dim bg-rose-wash text-rose",
  ctx: "border-transparent text-ink-dim",
  meta: "border-transparent bg-sunken italic text-ink-faint",
};

const SIGN: Record<DiffRow["kind"], string> = { add: "+", del: "-", ctx: " ", meta: " " };

function Row({ row }: { row: DiffRow }) {
  return (
    <div className={cn("flex border-l-2", ROW_CLASS[row.kind])}>
      <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-ink-faint">
        {row.lineNum ?? ""}
      </span>
      {/* `whitespace-pre` over `break-all`: wrapping code at arbitrary columns
          destroys the alignment that makes a diff readable. */}
      <span className="select-none pr-1 opacity-70">{SIGN[row.kind]}</span>
      <span className="whitespace-pre pr-3">{row.text}</span>
    </div>
  );
}

export function DiffViewer({ rows, path, op }: { rows: DiffRow[]; path?: string; op?: string }) {
  const { added, removed, patch } = useMemo(() => {
    let add = 0;
    let del = 0;
    const lines: string[] = [];
    for (const row of rows) {
      if (row.kind === "add") add++;
      else if (row.kind === "del") del++;
      lines.push(row.kind === "meta" ? row.text : `${SIGN[row.kind]}${row.text}`);
    }
    return { added: add, removed: del, patch: lines.join("\n") };
  }, [rows]);

  if (rows.length === 0) return null;

  const collapsed = rows.length > COLLAPSE_OVER;
  const head = collapsed ? rows.slice(0, HEAD_ROWS) : rows;
  const tail = collapsed ? rows.slice(HEAD_ROWS) : [];

  const shown = path ?? "diff";
  const cut = shown.lastIndexOf("/") + 1;
  const dir = shown.slice(0, cut);
  const base = shown.slice(cut);

  return (
    <div className="overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex items-center gap-2 border-b border-line-soft px-2 py-1">
        {/* Dirname yields under pressure; the basename is what identifies the
            file at a glance. */}
        <span
          className="flex min-w-0 flex-1 items-baseline font-mono text-[11px]"
          title={path}
          data-selectable
        >
          <span className="truncate text-ink-faint">{dir}</span>
          <span className="shrink-0 text-ink-mid">{base}</span>
        </span>
        {op && <Chip tone={op === "create" ? "signal" : "neutral"}>{op}</Chip>}
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-signal">+{added}</span>{" "}
          <span className="text-rose">−{removed}</span>
        </span>
        <CopyButton text={patch} label="patch" />
      </div>

      {/* The toggle sits outside the horizontal scroller so a wide diff cannot
          push it off-screen; only the rows themselves pan sideways. */}
      <div className="overflow-x-auto font-mono text-[12px] leading-[1.5]">
        {head.map((row, i) => (
          <Row key={i} row={row} />
        ))}
      </div>
      {collapsed && (
        <Disclosure
          className="border-t border-line-soft px-2 py-1"
          summary={<span className="text-[11px]">show {tail.length} more lines</span>}
        >
          <div className="overflow-x-auto pt-1 font-mono text-[12px] leading-[1.5]">
            {tail.map((row, i) => (
              <Row key={i} row={row} />
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
