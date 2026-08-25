import type { PromptRoute } from "../lib/rpc-types";
import { queueChipView } from "../lib/queue-chip";
import { useStore } from "../store";
import { AdvisorControl } from "./AdvisorControl";
import { BranchChip } from "./BranchChip";
import { ComposerActions } from "./ComposerActions";
import { ModelSelector } from "./ModelSelector";
import { BuildPlanControl } from "./BuildPlanControl";
import { Button, Chip, Label, Sheet } from "./ui";

/** Stable empty so the per-field selector doesn't fire on every store tick. */
const NO_EFFORTS: never[] = [];

/**
 * The compact prompt-options bottom sheet (issue #299): the model/effort,
 * session, and while-running controls that the compact composer row opens.
 * Store-aware on `tabId` — the same idiom as ModelSelector, AdvisorControl,
 * and BuildPlanControl — so the parent passes only draft-dependent and
 * surface state.
 */
export function ComposerSheet({
  open,
  onClose,
  tabId,
  projectCwd,
  unavailable,
  canSend,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  tabId: string;
  projectCwd: string | undefined;
  unavailable: boolean;
  canSend: boolean;
  onSubmit: (route: PromptRoute | "interrupt") => void;
}) {
  const status = useStore((s) => s.rpc[tabId]?.status);
  const queued = useStore((s) => s.rpc[tabId]?.session.queuedMessageCount ?? 0);
  const efforts = useStore((s) => s.rpc[tabId]?.model?.thinking?.efforts ?? NO_EFFORTS);
  const thinkingLevel = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const abortAgent = useStore((s) => s.abortAgent);
  const running = status === "running";
  const queueChip = queueChipView(running, queued);

  return (
    <Sheet open={open} placement="bottom" label="prompt options" onClose={onClose}>
      <div className="prompt-options space-y-5 px-[max(1rem,var(--safe-left))] py-4 pr-[max(1rem,var(--safe-right))]">
        <section className="rounded-xl border border-line bg-raised/60 p-3">
          <Label>model &amp; effort</Label>
          <div className="mt-2 flex min-h-11 items-center rounded-lg border border-line bg-void/35 px-2">
            <ModelSelector tabId={tabId} disabled={unavailable} />
          </div>
          {efforts.length > 0 && (
            <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-2">
              {efforts.map((effort) => <Button key={effort} disabled={unavailable} selected={effort === thinkingLevel} tone="iris" onClick={() => void setThinkingLevel(tabId, effort)} className="min-h-11 min-w-0 justify-center px-2 font-mono">{effort}</Button>)}
            </div>
          )}
        </section>
        <section className="rounded-xl border border-line bg-raised/60 p-3">
          <Label>session</Label>
          <div className="mt-2 space-y-2">
            <AdvisorControl tabId={tabId} disabled={unavailable} layout="sheet" />
            <BuildPlanControl tabId={tabId} layout="sheet" disabled={unavailable} className="min-h-11" />
            <div className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-void/35 px-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">branch</span>
              <span className="flex min-w-0 items-center gap-2"><BranchChip projectCwd={projectCwd} />{queueChip && <Chip mono tone="copper" title={queueChip.title}>{queueChip.label}</Chip>}</span>
            </div>
          </div>
        </section>
        <ComposerActions
          layout="sheet"
          running={running}
          isSlash={false}
          canSend={canSend}
          onSubmit={onSubmit}
          onAbort={() => void abortAgent(tabId)}
        />
      </div>
    </Sheet>
  );
}
