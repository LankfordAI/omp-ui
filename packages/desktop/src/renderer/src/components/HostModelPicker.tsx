import type { Ref } from "react";
import type { ModelPickerRow } from "@omp-ui/core/host-controls";
import { supportsHostControls } from "@omp-ui/core/host-controls";
import { useStore } from "../store";
import { HOST_CONTROLS_UPDATE_HINT } from "../store/slices/host-controls";
import { Button, Chip, Dot, IconSearch, Label, Modal } from "./ui";
import { usePaletteNav } from "./palette";

/**
 * omp's own session model picker (`get_model_picker`) served to a remote
 * client (issue #1272): the rows arrive in omp's order — the Recent block
 * first on a blank query, `provider/` scopes to one provider, `@` lists the
 * quick roles — and this dialog adds no ranking of its own. Typing re-queries
 * the host, so the server's rank is the list's truth. A row click sends
 * `set_model`; a thinking chip on the row picks that row AT that level in one
 * command (the frame carries `thinkingLevel`, docs/rpc.md v19.1.0).
 */
export function HostModelPicker({ tabId }: { tabId: string }) {
  const view = useStore((s) => s.rpc[tabId]?.modelPicker);
  const queryModelPicker = useStore((s) => s.queryModelPicker);
  const closeHostModelPicker = useStore((s) => s.closeHostModelPicker);
  const pickModelRow = useStore((s) => s.pickModelRow);

  const { active, setActive, activeRef, handleKey } = usePaletteNav({
    items: view?.rows ?? [],
    resetKey: view?.query ?? "",
    onPick: (row) => void pickModelRow(tabId, row),
    onClose: () => closeHostModelPicker(tabId),
  });

  if (view === undefined) return null;
  const rows = view.rows;
  // The Recent split only reads as a block while browsing and when it does
  // not cover every row; `@` role lists never carry one.
  const hasRecentBlock = view.query === "" && view.recent > 0;

  return (
    <Modal onClose={() => closeHostModelPicker(tabId)} width="w-[36rem]" labelledBy="host-model-picker-title">
      <div className="flex max-h-[70vh] flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Label>
            <span id="host-model-picker-title">host model picker</span>
          </Label>
          <IconSearch className="ml-auto size-4 text-ink-faint" />
          <input
            data-modal-initial-focus
            value={view.query}
            placeholder="search the host's models… (provider/ scopes, @ lists quick roles)"
            onChange={(event) => queryModelPicker(tabId, event.target.value)}
            onKeyDown={handleKey}
            className="min-w-0 flex-1 bg-transparent font-sans text-sm outline-none placeholder:text-ink-faint"
          />
          <Label>
            {rows.length < view.total ? `${rows.length}/${view.total} — keep typing` : `${view.total}`}
          </Label>
        </div>
        {view.error !== null && (
          <p className="border-b border-line px-3 py-1.5 text-xs text-rose">{view.error}</p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto py-1" aria-busy={view.loading}>
          {hasRecentBlock && rows.length > 0 && (
            <p className="px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-ink-faint">recent</p>
          )}
          {rows.length === 0 && view.loading && (
            <p className="px-3 py-3 text-xs text-ink-dim">asking the host…</p>
          )}
          {rows.length === 0 && !view.loading && view.error === null && (
            <p className="px-3 py-3 text-xs text-ink-dim">nothing matches that search</p>
          )}
          {rows.map((row, index) => (
            <HostPickerRowView
              key={`${row.role ?? ""}|${row.provider}/${row.id}`}
              row={row}
              active={index === active}
              activeRef={index === active ? activeRef : null}
              onHover={() => setActive(index)}
              onPick={(level) => void pickModelRow(tabId, row, level)}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}

function HostPickerRowView({
  row,
  active,
  activeRef,
  onHover,
  onPick,
}: {
  row: ModelPickerRow;
  active: boolean;
  activeRef: Ref<HTMLButtonElement> | null;
  onHover: () => void;
  /** Undefined level switches the model alone; a chip's step rides set_model's thinkingLevel. */
  onPick: (level?: string) => void;
}) {
  return (
    <div
      onMouseEnter={onHover}
      className={"flex w-full items-center gap-1 pr-2 " + (active ? "bg-hover" : "hover:bg-raised")}
    >
      <button
        type="button"
        ref={activeRef}
        onClick={() => onPick()}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
      >
        <span className="grid w-2 shrink-0 place-items-center">
          {row.current === true && <Dot tone="signal" title="this session runs it" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm text-ink">
              {row.role !== undefined ? `@ ${row.name}` : row.name}
            </span>
            {(row.roles ?? []).map((role) => (
              <Chip key={role.role} tone={role.auto === true ? "iris" : "neutral"} title={`role: ${role.role}${role.auto === true ? " (auto-selected)" : ""}`}>
                {role.label}
              </Chip>
            ))}
            {row.overContext === true && (
              <Chip tone="copper" title="the session's context exceeds this model's window">over context</Chip>
            )}
          </span>
          <span className="block truncate font-mono text-xs text-ink-faint">
            {row.role !== undefined ? `switches the ${row.role} role` : `${row.provider}/${row.id}`}
          </span>
        </span>
      </button>
      {(row.thinking ?? []).map((step) => (
        <button
          key={step}
          type="button"
          title={`run ${row.name} at thinking level ${step}`}
          onClick={() => onPick(step)}
          className="shrink-0 cursor-pointer rounded"
        >
          <Chip mono tone={row.thinkingLevel === step ? "signal" : "neutral"}>
            {step}
          </Chip>
        </button>
      ))}
    </div>
  );
}

/**
 * The composer options' entry point beside `model` (issue #1272): opens omp's
 * own picker for sessions steered through another host — a joined remote
 * instance or a fleet dispatch target, where the host owns the catalog and
 * its alt+p ranking is the truth to copy. Local sessions keep the
 * catalog-backed ModelSelector; this row appears only for `instanceId` tabs.
 * An omp the roster reports older than 19.1 never sees it; once a verb
 * answers "Unknown command" the latch keeps the row mounted but disabled with
 * the upgrade hint, and no further frame goes out.
 */
export function HostModelPickerRow({ tabId, instanceId }: { tabId: string; instanceId: string | null }) {
  const ompVersion = useStore((s) => s.rpc[tabId]?.capabilities?.ompVersion ?? null);
  const latched = useStore((s) => s.rpc[tabId]?.hostControlsUnsupported === true);
  const openHostModelPicker = useStore((s) => s.openHostModelPicker);
  if (instanceId === null) return null;
  if (!supportsHostControls(ompVersion) && !latched) return null;
  return (
    <Button
      variant="outline"
      disabled={latched}
      title={
        latched
          ? HOST_CONTROLS_UPDATE_HINT
          : "omp's own model picker, served by the host — recent and role-held models first, thinking levels included"
      }
      className="min-h-8 w-full justify-between px-2.5 text-xs"
      onClick={() => openHostModelPicker(tabId)}
    >
      host model picker
      <Chip mono tone="iris" title={`served by omp ${ompVersion ?? "?"}`}>alt+p</Chip>
    </Button>
  );
}
