import { useEffect, useRef, useState } from "react";
import type { RoutineRecord, RoutineRunRow } from "@omp-ui/core/routine";
import { backend } from "../../backend";
import { useDismissal } from "../../lib/use-dismissal";
import { useStore } from "../../store";
import { Button, Chip, IconButton, IconClose, Switch } from "../ui";
import { RunHistoryList } from "./RunHistoryList";
import {
  describeSchedule,
  formatTimeout,
  formatUsd,
  formatWhen,
  runsOf,
} from "./routine-format";

/**
 * The routines gallery's slide-over inspector (ports the Artifacts page's
 * detail surface): everything a row can answer without leaving the list —
 * schedule, resolved config, artifact binding, recent runs — plus the enable
 * switch and Run now. Full editing stays in `RoutineEditor`, reached via
 * "Edit full routine →".
 */
export interface RoutineInspectorProps {
  routine: RoutineRecord;
  /** The host's whole run log; the drawer slices to this routine itself. */
  runs: readonly RoutineRunRow[];
  hostLabel: string;
  /** Host defaults the drawer shows when this routine overrides neither cap. */
  spendDefaults: { warnUsd: number; maxUsd: number };
  readOnly: boolean;
  instanceId: string | null;
  onClose(): void;
  /** Drill into the full-pane editor for this routine. */
  onEdit(): void;
  /** Open a run's session tab (and let the owner close Routines). */
  onOpenSession(): void;
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 truncate text-right text-ink-mid">{children}</dd>
    </div>
  );
}

export function RoutineInspector({
  routine,
  runs,
  hostLabel,
  spendDefaults,
  readOnly,
  instanceId,
  onClose,
  onEdit,
  onOpenSession,
}: RoutineInspectorProps): React.ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const updateRoutine = useStore((s) => s.updateRoutine);
  const runRoutineNow = useStore((s) => s.runRoutineNow);
  const reportError = useStore((s) => s.reportError);
  const openSession = useStore((s) => s.openSession);
  const backendState = useStore((s) => s.state);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [artifactTitle, setArtifactTitle] = useState<string | null>(null);

  useDismissal({
    open: true,
    refs: panelRef,
    onClose,
    onEscape: onClose,
  });

  useEffect(() => {
    panelRef.current?.focus();
  }, [routine.id]);

  // The artifact library lives on this computer only; remote bindings show the
  // raw id rather than a cross-host describe attempt.
  const artifactId = routine.artifact?.artifactId ?? null;
  useEffect(() => {
    setArtifactTitle(null);
    if (artifactId === null || instanceId !== null || backendState?.artifactLibraryEnabled !== true) return;
    let cancelled = false;
    backend
      .artifactDescribe({ artifactId })
      .then((desc) => {
        if (!cancelled) setArtifactTitle(desc.artifact.title);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artifactId, instanceId, backendState?.artifactLibraryEnabled]);

  const recent = runsOf(runs, routine.id).slice(0, 5);
  const latest = recent[0];
  const waiting = latest !== undefined && latest.outcome === "waiting-approval";
  const reviewRun =
    waiting && latest.tabId !== null && !latest.pruned ? latest : null;

  const toggleEnabled = (): void => {
    updateRoutine(routine.id, { enabled: !routine.enabled }, instanceId).catch((err: unknown) =>
      reportError(err),
    );
  };

  const runNow = (): void => {
    if (readOnly || busy) return;
    setBusy(true);
    setActionError(null);
    runRoutineNow(routine.id, instanceId)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Routine ${routine.name}`}
      data-routine-inspector={routine.id}
      tabIndex={-1}
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-line bg-surface/95 shadow-2xl backdrop-blur-md outline-none"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">
            {routine.name}
            {routine.artifact !== null && (
              <span
                data-routine-artifact-badge
                title="Scheduled artifact refresh"
                className="ml-1.5 align-middle text-[10px] uppercase tracking-wide text-copper"
              >
                refresh
              </span>
            )}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
            <Chip tone="neutral">{hostLabel}</Chip>
            <span className="truncate" title={routine.destination.projectCwd}>
              {routine.destination.projectCwd.split("/").filter(Boolean).pop() ?? routine.destination.projectCwd}
            </span>
          </p>
        </div>
        <IconButton label="Close inspector" onClick={onClose}>
          <IconClose />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs">
        {waiting && (
          <div data-routine-inspector-waiting className="rounded-lg border border-copper/40 bg-copper-wash/30 px-3 py-2">
            <p className="font-medium text-copper">Run waiting on an Approval card.</p>
            {reviewRun !== null && (
              <Button
                size="xs"
                variant="solid"
                tone="copper"
                className="mt-1.5"
                onClick={() => {
                  void openSession(reviewRun.tabId!);
                  onOpenSession();
                }}
              >
                Review approval
              </Button>
            )}
          </div>
        )}

        <section aria-label="Schedule" className="space-y-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Schedule</h3>
          <dl className="divide-y divide-line-soft rounded-lg border border-line-soft bg-raised/60 px-3">
            <ConfigRow label="Repeats">{describeSchedule(routine.schedule) || routine.timeZone}</ConfigRow>
            <ConfigRow label="Next">
              {routine.enabled && routine.nextRunAtMs !== null ? (
                <span className="font-mono" title={new Date(routine.nextRunAtMs).toLocaleString()}>
                  {formatWhen(routine.nextRunAtMs)}
                </span>
              ) : (
                <span className="text-ink-faint">{routine.enabled ? "Never" : "Paused"}</span>
              )}
            </ConfigRow>
          </dl>
        </section>

        <section aria-label="Configuration" className="space-y-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Configuration</h3>
          <dl className="divide-y divide-line-soft rounded-lg border border-line-soft bg-raised/60 px-3">
            <ConfigRow label="Model">{routine.model ?? "Project default"}</ConfigRow>
            {routine.model !== null && <ConfigRow label="Thinking">{routine.thinkingLevel ?? "auto"}</ConfigRow>}
            <ConfigRow label="Spend">
              {`${formatUsd(routine.spend.warnUsd ?? spendDefaults.warnUsd)} warn / ${formatUsd(routine.spend.maxUsd ?? spendDefaults.maxUsd)} max`}
            </ConfigRow>
            <ConfigRow label="Workspace">{routine.destination.workspace}</ConfigRow>
            <ConfigRow label="Mode">{routine.mode}</ConfigRow>
            <ConfigRow label="Timeout">{formatTimeout(routine.timeoutMinutes ?? 30)}</ConfigRow>
            <ConfigRow label="Tool policy">
              {`${routine.toolPolicy.allow.length} allowed · ${routine.toolPolicy.deny.length} denied`}
            </ConfigRow>
          </dl>
          <p className="text-ink-faint">bash / eval always bypass the policy on a shell host.</p>
        </section>

        {routine.artifact !== null && (
          <section aria-label="Artifact refresh" className="space-y-1" data-routine-inspector-artifact>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Artifact refresh</h3>
            <dl className="divide-y divide-line-soft rounded-lg border border-line-soft bg-raised/60 px-3">
              <ConfigRow label="Artifact">
                {artifactTitle ?? (
                  <span className="font-mono text-ink-faint">{routine.artifact.artifactId.slice(0, 8)}</span>
                )}
              </ConfigRow>
              <ConfigRow label="Datasets">{`${routine.artifact.datasetIds.length} selected`}</ConfigRow>
              <ConfigRow label="Auto apply">{routine.artifact.autoApply ? "On" : "Off"}</ConfigRow>
            </dl>
          </section>
        )}

        {actionError !== null && (
          <p role="alert" className="rounded-md border border-rose/30 bg-rose/5 px-2.5 py-1.5 text-rose">
            {actionError}
          </p>
        )}

        <section aria-label="Recent runs" className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Recent runs</h3>
          <RunHistoryList runs={recent} onOpen={onOpenSession} />
        </section>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5">
        <Switch
          on={routine.enabled}
          disabled={readOnly}
          label={`Enable ${routine.name}`}
          onChange={toggleEnabled}
        />
        <span className="text-xs text-ink-faint">{routine.enabled ? "Enabled" : "Paused"}</span>
        <span className="flex-1" />
        {!readOnly && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={runNow}>
            ▶ Run now
          </Button>
        )}
        <Button size="xs" variant="solid" onClick={onEdit}>
          Edit full routine →
        </Button>
      </footer>
    </div>
  );
}
