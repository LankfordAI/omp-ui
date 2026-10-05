// PROTOTYPE (#753): throwaway.
// The vault write card: what the agent wrote, where, and a way to open it in
// Obsidian. Three density variants (full, compact, note) and two markers for
// editing a note omp-ui did not create, picked from the switcher.
import { useState } from "react";
import { cn } from "../../lib/cn";
import type { ToolItem } from "../../lib/transcript";
import { DiffViewer } from "../DiffViewer";
import { Markdown } from "../Markdown";
import { Chevron, Chip, Panel, ProgressSweep } from "../ui";
import { splitFrontmatter, vaultArgs, vaultUri, type VaultWriteArgs } from "./fixtures";
import { ActionChip, NoteGlyph, OpenInObsidian } from "./shared";
import { usePrototype753, type ChoiceValue } from "./state";

type CardVariant = ChoiceValue<"p753_card">;

/** Local copy of ToolCard's CheckGlyph. */
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

const BANNER_TEXT = "Edited a note omp-ui did not create. The agent read the whole note first.";

/** Frontmatter split that hides a still-streaming, unclosed frontmatter block. */
function noteParts(text: string): { stamp: [string, string][]; body: string } {
  const parts = splitFrontmatter(text);
  if (parts.stamp.length === 0 && parts.body.startsWith("---")) return { stamp: [], body: "" };
  return parts;
}

function PathLine({ args, className }: { args: VaultWriteArgs; className?: string }) {
  const full = `${args.vault} · ${args.path}`;
  return (
    <p className={cn("min-w-0 truncate font-mono text-[11px] text-ink-mid", className)} title={full}>
      {full}
    </p>
  );
}

function StampStrip({ stamp }: { stamp: [string, string][] }) {
  if (stamp.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-ink-faint">
      {stamp.map(([key, value]) => (
        <span key={key} className="break-all">
          {key}: {value}
        </span>
      ))}
    </div>
  );
}

/** Obsidian-style Properties: muted key column, value column. */
function StampTable({ stamp }: { stamp: [string, string][] }) {
  if (stamp.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-line-soft pb-2 text-[11px]">
      {stamp.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="truncate font-mono text-ink-faint">{key}</dt>
          <dd className="min-w-0 break-words text-ink-mid">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MarkdownBox({ text, tall = false }: { text: string; tall?: boolean }) {
  if (text.trim() === "") return null;
  return (
    <div
      className={cn(
        "overflow-y-auto overflow-x-hidden rounded-md border border-line-soft bg-sunken px-2.5 py-2",
        tall ? "max-h-72" : "max-h-48",
      )}
    >
      <Markdown text={text} className="text-[13px]" />
    </div>
  );
}

/**
 * The card body: a diff for a note omp-ui did not create, the appended text
 * for an append, else the note body with its frontmatter stamp.
 */
function Preview({ args, stamp }: { args: VaultWriteArgs; stamp: "strip" | "table" }) {
  const [diffOpen, setDiffOpen] = useState(true);
  if (!args.createdByOmpUi) {
    // Open by default: with no in-app reader, the diff is the only view of the change.
    return <DiffViewer rows={args.diff ?? []} path={args.path} op="update" open={diffOpen} onOpenChange={setDiffOpen} />;
  }
  if (args.action === "append") {
    return (
      <div className="space-y-1">
        <p className="text-[11px] text-ink-faint">
          Appended to <em className="text-ink-mid">{args.title}</em>
        </p>
        <MarkdownBox text={args.appended ?? ""} />
      </div>
    );
  }
  const parts = noteParts(args.content ?? "");
  return (
    <div className="space-y-1.5">
      {stamp === "strip" ? <StampStrip stamp={parts.stamp} /> : <StampTable stamp={parts.stamp} />}
      <MarkdownBox text={parts.body} tall={stamp === "table"} />
    </div>
  );
}

export function VaultToolCard({ item }: { item: ToolItem; tabId?: string }) {
  const proto = usePrototype753();
  // Open state per variant, so switching variants shows each one's default.
  const [openBy, setOpenBy] = useState<Partial<Record<CardVariant, boolean>>>({});
  const args = vaultArgs(item);
  if (args === null) return null;

  const variant = proto.card;
  const open = openBy[variant] ?? variant === "full";
  const toggle = (): void => setOpenBy((prev) => ({ ...prev, [variant]: !open }));
  const running = item.status === "running";
  const foreign = !args.createdByOmpUi;
  const border = foreign && proto.mark === "border";
  const banner = foreign && proto.mark === "banner";
  const uri = vaultUri(args.vaultId, args.path);

  const glyph = (
    <span className={cn("shrink-0", running ? "text-copper" : "text-ink-dim")}>
      <NoteGlyph />
    </span>
  );
  const markerChip = border && <Chip tone="copper">Not created by omp-ui</Chip>;
  const bannerLine = banner && (
    <p className="border-b border-copper-dim/50 bg-copper-wash px-2.5 py-1.5 text-[11px] text-copper">{BANNER_TEXT}</p>
  );
  const sweep = running && <ProgressSweep tone="copper" activity={args.content?.length ?? 0} />;
  const statusMark = running ? <Chip tone="copper">running</Chip> : <CheckGlyph />;

  if (variant === "note") {
    return (
      <Panel tone={border ? "copper" : "neutral"} className="animate-rise overflow-hidden">
        {bannerLine}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2.5">
          {glyph}
          <h3 className="min-w-0 flex-1 truncate font-display text-base font-semibold text-ink" title={args.title}>
            {args.title}
          </h3>
          <span className="flex shrink-0 items-center gap-1.5">
            <ActionChip action={args.action} />
            {markerChip}
            {statusMark}
          </span>
        </div>
        {sweep}
        <div className="space-y-2 px-3 py-2">
          <Preview args={args} stamp="table" />
        </div>
        <div className="flex min-w-0 items-center gap-2 border-t border-line-soft px-3 py-1.5">
          <PathLine args={args} className="flex-1" />
          <OpenInObsidian uri={uri} />
        </div>
      </Panel>
    );
  }

  if (variant === "compact") {
    return (
      <Panel tone={border ? "copper" : "neutral"} className="animate-rise overflow-hidden">
        {bannerLine}
        <div className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Chevron open={open} className="text-ink-faint" />
            {glyph}
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink" title={args.title}>
              {args.title}
            </span>
          </button>
          <ActionChip action={args.action} />
          {markerChip}
          <Chip mono truncate title={args.vault} className="max-w-24 shrink">
            {args.vault}
          </Chip>
          {running && <Chip tone="copper">running</Chip>}
          <OpenInObsidian uri={uri} iconOnly />
        </div>
        {sweep}
        {open && (
          <div className="space-y-2 border-t border-line-soft px-2.5 py-2">
            <PathLine args={args} />
            <Preview args={args} stamp="strip" />
          </div>
        )}
      </Panel>
    );
  }

  return (
    <Panel tone={border ? "copper" : "neutral"} className="animate-rise overflow-hidden">
      {bannerLine}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex min-w-[8rem] flex-1 items-center gap-2 text-left"
        >
          <Chevron open={open} className="text-ink-faint" />
          {glyph}
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink" title={args.title}>
            {args.title}
          </span>
        </button>
        {/* Chips and the open button wrap as one group, so the button never drops alone. */}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <ActionChip action={args.action} />
          {markerChip}
          {statusMark}
          <OpenInObsidian uri={uri} className="shrink-0" />
        </span>
      </div>
      {sweep}
      {open && (
        <div className="space-y-2 border-t border-line-soft px-2.5 py-2">
          <PathLine args={args} />
          <Preview args={args} stamp="strip" />
        </div>
      )}
    </Panel>
  );
}
