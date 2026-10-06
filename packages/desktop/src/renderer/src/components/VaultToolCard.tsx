import { useState } from "react";
import { cn } from "../lib/cn";
import { strField } from "../lib/fields";
import { useT, type MessageKey } from "../lib/i18n";
import type { ToolItem } from "../lib/transcript";
import { noteTitleFromPath, type VaultWriteAction } from "../lib/vault-notes";
import { DiffViewer } from "./DiffViewer";
import { linkify, Markdown } from "./Markdown";
import { OpenInObsidianButton } from "./OpenInObsidianButton";
import { CheckGlyph, Slab } from "./ToolCard";
import { Chevron, Chip, ICON_STROKE, Panel, ProgressSweep, type Tone } from "./ui";

/** TranscriptRow routes exactly these names (VAULT_WRITE_TOOLS) here. */
const TOOL_ACTION: Record<string, VaultWriteAction> = {
  "omp-ui_vault_create": "create",
  "omp-ui_vault_append": "append",
  "omp-ui_vault_edit": "edit",
  "omp-ui_vault_link": "link",
};

const ACTION_CHIP: Record<VaultWriteAction, { key: MessageKey; tone: Tone }> = {
  create: { key: "transcript.vault.created", tone: "signal" },
  append: { key: "transcript.vault.appended", tone: "neutral" },
  edit: { key: "transcript.vault.edited", tone: "copper" },
  link: { key: "transcript.vault.edited", tone: "copper" },
};

export function VaultActionChip({ action }: { action: VaultWriteAction }) {
  const t = useT();
  const { key, tone } = ACTION_CHIP[action];
  return <Chip tone={tone}>{t(key)}</Chip>;
}

export function NoteGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0", className)} {...ICON_STROKE}>
      <path d="M3.5 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5H5a1.5 1.5 0 0 1-1.5-1.5zM3.5 12a1.5 1.5 0 0 1 1.5-1.5h7.5M6 5.5h4" />
    </svg>
  );
}

/** ToolCard's status vocabulary, so a vault card settles exactly like any other tool. */
function StatusMark({ status }: { status: ToolItem["status"] }) {
  const t = useT();
  switch (status) {
    case "running":
      return <Chip tone="copper">{t("transcript.tool.running")}</Chip>;
    case "error":
      return <Chip tone="rose">{t("transcript.tool.error")}</Chip>;
    case "aborted":
      return <Chip tone="copper">{t("transcript.tool.aborted")}</Chip>;
    case "cancelled":
      return <Chip>{t("transcript.tool.cancelled")}</Chip>;
    case "done":
      return <CheckGlyph />;
  }
}

/**
 * A vault write (issue #767, settled in #753): what the agent wrote, where, and
 * a hand-off to Obsidian. A write into a note omp-ui did not create carries the
 * copper marker; the body is open by default because omp-ui has no note reader.
 */
export function VaultToolCard({ item, tabId }: { item: ToolItem; tabId?: string }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [diffOpen, setDiffOpen] = useState(true);
  const vault = item.vault;
  const action = TOOL_ACTION[item.name]!;
  const done = item.status === "done";
  const foreign = vault?.createdByOmpUi === false;

  const title =
    vault !== undefined
      ? (vault.title ?? (vault.path !== null ? noteTitleFromPath(vault.path) : item.name))
      : (strField(item.args, "title") ?? strField(item.args, "path") ?? item.intent ?? item.name);
  const pathLine = vault !== undefined && vault.path !== null ? `${vault.vaultName} · ${vault.path}` : null;
  const stamp = done && action === "create" && (vault?.stamp?.length ?? 0) > 0 ? vault!.stamp!.join(" · ") : null;
  const preview =
    done && (action === "create" || action === "append") && (vault?.preview?.trim() ?? "") !== ""
      ? vault!.preview!
      : null;
  const diff = done && (action === "edit" || action === "link") && (item.diff?.length ?? 0) > 0 ? item.diff! : null;
  const slab = !done && item.resultText ? item.resultText : null;
  const openable =
    done && vault !== undefined && vault.path !== null ? { vaultName: vault.vaultName, file: vault.path } : null;
  const hasBody = pathLine !== null || stamp !== null || preview !== null || diff !== null || slab !== null;

  return (
    <Panel tone={foreign ? "copper" : "neutral"} className="animate-rise">
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
        <button
          type="button"
          aria-expanded={hasBody ? open : undefined}
          disabled={!hasBody}
          onClick={() => setOpen(!open)}
          className="flex min-w-[8rem] flex-1 items-center gap-2 text-left"
        >
          {hasBody ? <Chevron open={open} className="text-ink-faint" /> : <span className="size-3 shrink-0" />}
          <NoteGlyph className={item.status === "running" ? "text-copper" : "text-ink-dim"} />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink" title={title}>
            {title}
          </span>
        </button>
        {/* Chips and the open button wrap as one group, so the button never drops alone (#753). */}
        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <VaultActionChip action={action} />
          {foreign && <Chip tone="copper">{t("transcript.vault.notCreated")}</Chip>}
          <StatusMark status={item.status} />
          {openable && <OpenInObsidianButton vaultName={openable.vaultName} file={openable.file} tabId={tabId} />}
        </span>
      </div>
      {item.status === "running" && <ProgressSweep tone="copper" activity={item.argsText?.length ?? 0} />}
      {open && hasBody && (
        <div className="space-y-2 border-t border-line-soft px-2.5 py-2 text-ink">
          {pathLine !== null && (
            <p className="min-w-0 truncate font-mono text-[11px] text-ink-mid" title={pathLine}>
              {pathLine}
            </p>
          )}
          {stamp !== null && <p className="break-all font-mono text-[10px] text-ink-faint">{stamp}</p>}
          {preview !== null && (
            <div className="max-h-48 overflow-y-auto overflow-x-hidden rounded-md border border-line-soft bg-sunken px-2.5 py-2">
              <Markdown text={preview} className="text-[13px]" />
            </div>
          )}
          {diff !== null && (
            <DiffViewer rows={diff} path={vault?.path ?? undefined} op="update" open={diffOpen} onOpenChange={setDiffOpen} />
          )}
          {slab !== null && (
            <Slab className="max-h-48" tone={item.status === "error" ? "rose" : "neutral"}>
              {linkify(slab)}
            </Slab>
          )}
        </div>
      )}
    </Panel>
  );
}
