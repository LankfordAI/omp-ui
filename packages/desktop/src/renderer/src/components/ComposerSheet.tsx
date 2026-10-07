import { modelFastTier, type PromptRoute } from "../lib/rpc-types";
import { useT } from "../lib/i18n";
import { queueChipCount, queueChipView } from "../lib/queue-chip";
import { findOwner, useStore } from "../store";
import { AdvisorControl } from "./AdvisorControl";
import { BranchChip } from "./BranchChip";
import { ComposerActions } from "./ComposerActions";
import { ModelSelector } from "./ModelSelector";
import { BuildPlanControl } from "./BuildPlanControl";
import { QueuedMessageList } from "./QueuedMessageList";
import { FastModeControl } from "./FastModeControl";
import { LiveVoiceControl } from "./LiveVoiceControl";
import { supportsNativeLive } from "../lib/live-voice";
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
  const t = useT();
  const status = useStore((s) => s.rpc[tabId]?.status);
  const queued = useStore((s) => {
    const session = s.rpc[tabId]?.session;
    return session ? queueChipCount(session) : 0;
  });
  const queueListed = useStore((s) => s.rpc[tabId]?.session.queuedMessages != null);
  const efforts = useStore((s) => s.rpc[tabId]?.model?.thinking?.efforts ?? NO_EFFORTS);
  const thinkingLevel = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const thinkingConfigured = useStore(
    (s) => s.rpc[tabId]?.session.thinkingConfigured ?? null,
  );
  const model = useStore((s) => s.rpc[tabId]?.model ?? null);
  const fastEnabled = useStore((s) => s.rpc[tabId]?.session.fastModeEnabled ?? false);
  const fastActive = useStore((s) => s.rpc[tabId]?.session.fastModeActive ?? false);
  // Live voice gates on the omp version, like the inline rows (issue #778).
  const liveSupported = useStore(
    (s) => supportsNativeLive(s.rpc[tabId]?.capabilities?.ompVersion ?? null),
  );
  // One fast control per sheet: the gate's yes puts it in the model/effort
  // section beside the pills it belongs to (issue #689); its no keeps #677's
  // always-available row in the session section, so the affordance is never
  // hidden — and the sheet never carries two switches with one label.
  const fastVisible = modelFastTier(model) !== null || fastEnabled || fastActive;
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const abortAgent = useStore((s) => s.abortAgent);
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const running = status === "running";
  const queueChip = queueChipView(running, queued);

  return (
    <Sheet open={open} placement="bottom" label={t("composer.options.title")} onClose={onClose}>
      <div className="prompt-options space-y-5 px-[max(1rem,var(--safe-left))] py-4 pr-[max(1rem,var(--safe-right))]">
        <section className="rounded-xl border border-line bg-raised/60 p-3">
          <Label>{t("composer.sheet.modelEffort")}</Label>
          <div className="mt-2 flex min-h-11 items-center rounded-lg border border-line bg-void/35 px-2">
            <ModelSelector tabId={tabId} disabled={unavailable} />
          </div>
          {efforts.length > 0 && (
            <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-2">
              {/* omp's automatic selector rides above the ladder — same row
                  styling, and the effort rows un-highlight while it is on:
                  under auto the resolved level is not the user's choice. */}
              <Button disabled={unavailable} selected={thinkingConfigured === "auto"} tone="iris" onClick={() => void setThinkingLevel(tabId, "auto")} className="min-h-11 min-w-0 justify-center px-2 font-mono" title={t("composer.thinking.autoTitle", { level: thinkingLevel ?? "—" })}>{t("composer.thinking.auto")}</Button>
              {efforts.map((effort) => <Button key={effort} disabled={unavailable} selected={thinkingConfigured !== "auto" && effort === thinkingLevel} tone="iris" onClick={() => void setThinkingLevel(tabId, effort)} className="min-h-11 min-w-0 justify-center px-2 font-mono">{effort}</Button>)}
            </div>
          )}
          {fastVisible && (
            <div className="mt-2 flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-void/35 px-3">
              <FastModeControl tabId={tabId} layout="sheet" disabled={unavailable} className="w-full" />
            </div>
          )}
          {liveSupported && (
            <div className="mt-2 flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-void/35 px-3">
              <LiveVoiceControl tabId={tabId} layout="sheet" disabled={unavailable} className="w-full" />
            </div>
          )}
        </section>
        <section className="rounded-xl border border-line bg-raised/60 p-3">
          <Label>{t("composer.sheet.session")}</Label>
          <div className="mt-2 space-y-2">
            <AdvisorControl tabId={tabId} disabled={unavailable} layout="sheet" />
            <BuildPlanControl tabId={tabId} layout="sheet" disabled={unavailable} className="min-h-11" />
            {!fastVisible && (
              <div className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-void/35 px-3">
                <FastModeControl tabId={tabId} layout="sheet" disabled={unavailable} className="w-full" />
              </div>
            )}
            <div className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-void/35 px-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">{t("composer.sheet.branch")}</span>
              <span className="flex min-w-0 items-center gap-2"><BranchChip projectCwd={projectCwd} instanceId={instanceId} />{queueChip && <Chip mono tone="copper" title={running ? t("composer.queue.queuedTitle") : t("composer.queue.parkedTitle")}>{running ? t("composer.queue.queued", { n: queued }) : t("composer.queue.parked", { n: queued })}</Chip>}</span>
            </div>
            {queueChip && queueListed && (
              <div className="rounded-lg border border-line bg-void/35 p-3">
                <QueuedMessageList tabId={tabId} disabled={unavailable} />
              </div>
            )}
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
