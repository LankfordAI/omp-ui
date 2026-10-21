import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionSummary } from "@omp-ui/core/types";
import {
  fleetAppUpdateAvailable,
  fleetOsLabel,
  LOCAL_MACHINE_KEY,
  PLACEMENT_PREFERENCES,
  type FleetAuditEntry,
  type FleetMachine,
  type FleetMachineStatus,
  type FleetMaintenanceRecord,
  type FleetPackageManager,
  type FleetPendingDispatch,
  type FleetRung,
  type PlacementPreference,
} from "@omp-ui/core/fleet";
import { useT, type MessageKey } from "../../lib/i18n";
import { startVisibleInterval } from "../../lib/visible-interval";
import { deriveSidebarSessionState, useStore, type SidebarSessionState } from "../../store";
import { SESSION_FACE } from "../SessionRow";
import { Button, ChoiceCapsule, Chip, Dot, IconButton, IconClose, IconRefresh, Label, type Tone } from "../ui";
import { FleetUpdateDialog, type FleetUpdateConfirmRequest } from "./FleetUpdateDialog";
import { ProviderKeyRolloutDialog } from "./ProviderKeyRolloutDialog";

/**
 * The Fleet view (CONTEXT.md "Fleet", issue #899): this app and every joined
 * remote instance as places new work can start. It takes the main pane in
 * place of the tabs, exactly like the Stats view, and polls the machine read
 * while open. Placement and the unresolved list are main's; this surface
 * reads them and forwards the user's choices.
 */

const FLEET_POLL_MS = 5_000;

const STATUS_FACE: Record<FleetMachineStatus, { tone: Tone; labelKey: MessageKey }> = {
  ready: { tone: "signal", labelKey: "fleet.status.ready" },
  unsupported: { tone: "copper", labelKey: "fleet.status.unsupported" },
  unreachable: { tone: "rose", labelKey: "fleet.status.unreachable" },
  error: { tone: "rose", labelKey: "fleet.status.error" },
};

const PREFERENCE_LABEL: Record<PlacementPreference, MessageKey> = {
  prefer: "fleet.preference.prefer",
  normal: "fleet.preference.normal",
  less: "fleet.preference.less",
  manual: "fleet.preference.manual",
};

const RUNG_LABEL: Record<FleetRung, MessageKey> = {
  observe: "fleet.rung.observe",
  dispatch: "fleet.rung.dispatch",
  manage: "fleet.rung.manage",
  full: "fleet.rung.full",
};

const AUDIT_ACTION_LABEL: Record<FleetAuditEntry["action"], MessageKey> = {
  exec: "fleet.audit.exec",
  manage: "fleet.audit.manage",
  "grant-raise": "fleet.audit.grantRaise",
  "grant-set": "fleet.audit.grantSet",
  "exec-detached": "fleet.audit.execDetached",
  keys: "fleet.audit.keys",
  update: "fleet.audit.update",
};

/** One dispatched session wherever it lives: this app's registry or a joined instance's. */
interface FleetRow {
  summary: SessionSummary & { fleet: NonNullable<SessionSummary["fleet"]> };
  /** Null for this app. */
  nickname: string | null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <Label className="min-w-0 flex-1 truncate">{title}</Label>
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------- machines */

/** The OS chip's hover text (#905): each manager by name, off-PATH ones with their absolute path. */
function packageManagersTitle(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  managers: FleetPackageManager[] | null,
): string {
  if (managers === null) return t("fleet.machine.packageManagersUnknown");
  if (managers.length === 0) return t("fleet.machine.packageManagersNone");
  return t("fleet.machine.packageManagers", {
    list: managers.map((m) => (m.onPath ? m.name : `${m.name} (${m.path})`)).join(", "),
  });
}

/** The omp chip's hover text (ADR-0066): the managed path, plus how it was chosen. */
function ompChipTitle(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  report: NonNullable<FleetMachine["report"]>,
): string {
  if (report.ompVersion === null && report.ompPath === null) return t("fleet.machine.ompChipNotInstalled");
  const path = report.ompPath ?? "";
  return report.ompPinned ? t("fleet.machine.ompChipPinned", { path }) : t("fleet.machine.ompChip", { path });
}

/**
 * The last Fleet maintenance this controller started on the member (ADR-0066):
 * dispatcher-side bookkeeping over the member's own job record, refreshed by
 * the machines poll while a job runs.
 */
function MaintenanceChip({ record }: { record: FleetMaintenanceRecord }) {
  const t = useT();
  if (record.state === "running") {
    return (
      <span data-maintenance="running">
        <Chip tone="copper">
          {t("fleet.maintenance.running", {
            target: record.target,
            progress: record.progress === null ? "" : ` ${record.progress}%`,
          })}
        </Chip>
      </span>
    );
  }
  if (record.state === "succeeded") {
    // omp details read `omp <from> → <to> at <path>`; the tail is the news.
    const tail = record.detail?.split("\u2192 ").pop() ?? null;
    return (
      <span data-maintenance="succeeded">
        <Chip tone="signal" title={record.detail ?? undefined}>
          {record.target === "omp"
            ? t("fleet.maintenance.succeededOmp", { detail: tail ?? "" })
            : t("fleet.maintenance.succeededApp")}
        </Chip>
      </span>
    );
  }
  if (record.state === "failed") {
    return (
      <span data-maintenance="failed">
        <Chip tone="rose" truncate title={record.detail ?? undefined}>
          {t("fleet.maintenance.failed", { detail: record.detail ?? "" })}
        </Chip>
      </span>
    );
  }
  return (
    <span data-maintenance="revoked">
      <Chip tone="neutral" title={t("fleet.maintenance.revokedTitle")}>
        {t("fleet.maintenance.revoked")}
      </Chip>
    </span>
  );
}

function MachineRow({
  machine,
  onRollout,
  onUpdate,
}: {
  machine: FleetMachine;
  onRollout: (machine: FleetMachine) => void;
  onUpdate: (machine: FleetMachine) => void;
}) {
  const t = useT();
  const setFleetPlacement = useStore((s) => s.setFleetPlacement);
  const name = machine.nickname ?? t("fleet.machine.thisComputer");
  const face = STATUS_FACE[machine.status];
  const report = machine.report;
  // ADR-0066: the maintenance chip reads the last job we started here, if any.
  const maintenance = machine.maintenance;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[11px]" data-machine-key={machine.key}>
      <span className="flex min-w-0 items-center gap-1.5">
        <Dot tone={face.tone} title={t(face.labelKey)} />
        <span className="truncate text-xs text-ink">{name}</span>
        {report !== null && <Chip mono>{t("fleet.machine.version", { version: report.version })}</Chip>}
        {/* ADR-0066: what each member runs, so skew is visible before dispatching to it. */}
        {report !== null && (report.ompVersion !== null || report.ompPath === null) && (
          <Chip mono title={ompChipTitle(t, report)}>
            {report.ompVersion === null
              ? t("fleet.machine.ompNotInstalled")
              : t("fleet.machine.ompVersion", { version: report.ompVersion })}
          </Chip>
        )}
        {report !== null && report.ompBelowMinimum && (
          <Chip tone="rose" title={t("fleet.machine.belowFloorTitle")}>
            {t("fleet.machine.belowFloor")}
          </Chip>
        )}
        {report !== null &&
          (report.appUpdateStaged ? (
            <Chip title={t("fleet.machine.updateStagedTitle", { machine: name })}>
              {t("fleet.machine.updateStaged")}
            </Chip>
          ) : (
            fleetAppUpdateAvailable(report.version, report.appLatestVersion) && (
              <Chip title={t("fleet.machine.updateAvailableTitle", { version: report.appLatestVersion ?? "" })}>
                {t("fleet.machine.updateAvailable")}
              </Chip>
            )
          ))}
        {maintenance !== null && <MaintenanceChip record={maintenance} />}
        {/* #901: what this member will accept from us; null for this computer and older peers. */}
        {machine.grantRung !== null && (
          <Chip tone={machine.grantRung === "full" ? "copper" : "neutral"}>
            {t("fleet.machine.access", { rung: t(RUNG_LABEL[machine.grantRung]) })}
          </Chip>
        )}
        {/* #904: where an agent's own ssh reaches this member, and whether port 22 answered. */}
        {machine.address !== null && (
          <span data-ssh-reachable={String(machine.sshReachable)} className="min-w-0">
            <Chip
              mono
              truncate
              tone={machine.sshReachable === true ? "signal" : machine.sshReachable === false ? "rose" : "neutral"}
              title={t(
                machine.sshReachable === true
                  ? "fleet.machine.sshOpen"
                  : machine.sshReachable === false
                    ? "fleet.machine.sshClosed"
                    : "fleet.machine.sshUnknown",
                { address: machine.address },
              )}
            >
              {t("fleet.machine.ssh", { target: report?.user ? `${report.user}@${machine.address}` : machine.address })}
            </Chip>
          </span>
        )}
        {/* #905: the member's OS; hover names the package managers found on it. */}
        {report !== null && report.os !== null && (
          <span data-machine-os className="min-w-0">
            <Chip truncate title={packageManagersTitle(t, report.packageManagers)}>
              {fleetOsLabel(report.os)}
            </Chip>
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-mid">
        {machine.status === "unsupported" ? (
          t("fleet.machine.unsupported", { nickname: name })
        ) : machine.status !== "ready" || report === null ? (
          <span className="text-rose">{machine.error ?? t(face.labelKey)}</span>
        ) : (
          <>
            <span className="font-mono tabular-nums">
              {report.cpuUtilization === null
                ? t("fleet.machine.cpuUnknown")
                : t("fleet.machine.cpu", { percent: Math.round(report.cpuUtilization * 100) })}
              {report.totalMemoryBytes > 0 &&
                ` · ${t("fleet.machine.memory", {
                  percent: Math.round((report.availableMemoryBytes / report.totalMemoryBytes) * 100),
                })}`}
            </span>
            <span className="ml-3">
              {t("fleet.machine.sessions", { live: report.liveSessions, turns: report.runningTurns })}
            </span>
          </>
        )}
      </span>
      {machine.key !== LOCAL_MACHINE_KEY && machine.status === "ready" && (
        <>
          {/* #905: Provider key rollout; the member refuses anything below Full control. */}
          <Button
            size="xs"
            variant="ghost"
            disabled={machine.grantRung !== "full"}
            title={machine.grantRung !== "full" ? t("fleet.machine.rolloutKeysNeedsFull") : undefined}
            onClick={() => onRollout(machine)}
          >
            {t("fleet.machine.rolloutKeys")}
          </Button>
          {/* ADR-0066: remote version maintenance rides the same Full-control gate. */}
          <Button
            size="xs"
            variant="ghost"
            disabled={machine.grantRung !== "full"}
            title={machine.grantRung !== "full" ? t("fleet.machine.updateVersionsNeedsFull") : undefined}
            onClick={() => onUpdate(machine)}
          >
            {t("fleet.machine.updateVersions")}
          </Button>
        </>
      )}
      <ChoiceCapsule
        label={t("fleet.machine.preference", { machine: name })}
        value={machine.preference}
        options={PLACEMENT_PREFERENCES.map((pref) => ({ value: pref, label: t(PREFERENCE_LABEL[pref]) }))}
        onChange={(pref) => void setFleetPlacement(machine.key, pref)}
        className="text-[11px]"
      />
    </li>
  );
}

function MachinesSection() {
  const t = useT();
  const view = useStore((s) => s.fleet);
  const [rollout, setRollout] = useState<FleetMachine | null>(null);
  const [update, setUpdate] = useState<FleetMachine | null>(null);
  const stageLifecycleConfirmation = useStore((s) => s.stageLifecycleConfirmation);
  // ADR-0066: the dialog only asks; the lifecycle confirmation gate owns the
  // run. The version hop and the live-session count the bodies name ride the
  // machine's own report — the same row that opened the dialog.
  const requestUpdateConfirmation = (req: FleetUpdateConfirmRequest): void => {
    const report = view?.machines?.find((m) => m.key === req.machineKey)?.report ?? null;
    if (req.target === "omp") {
      stageLifecycleConfirmation({
        kind: "fleet-update-omp",
        machineKey: req.machineKey,
        machineNickname: req.machineNickname,
        currentVersion: report?.ompVersion ?? null,
        targetVersion: req.version,
      });
    } else if (req.action === "stage") {
      stageLifecycleConfirmation({
        kind: "fleet-stage-app",
        machineKey: req.machineKey,
        machineNickname: req.machineNickname,
        version: req.version,
      });
    } else {
      // Accepting the gate with live sessions running is the "Install when I
      // quit" choice itself; the count comes from the report, not the picker's
      // checkbox, so the body and the eventual request can never disagree.
      stageLifecycleConfirmation({
        kind: "fleet-apply-app",
        machineKey: req.machineKey,
        machineNickname: req.machineNickname,
        liveSessions: report?.liveSessions ?? 0,
      });
    }
  };
  if (view === null) return null;
  return (
    <Section title={t("fleet.section.machines")}>
      {view.error !== null && (
        <p className="mb-1.5 rounded-md border border-line bg-raised px-3 py-2 text-[11px] text-ink-mid">{view.error}</p>
      )}
      {view.machines === null ? (
        view.loading && <p className="text-[11px] text-ink-faint">{t("fleet.machine.loading")}</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {view.machines.map((machine) => (
            <MachineRow key={machine.key} machine={machine} onRollout={setRollout} onUpdate={setUpdate} />
          ))}
        </ul>
      )}
      {rollout !== null && <ProviderKeyRolloutDialog machine={rollout} onClose={() => setRollout(null)} />}
      {update !== null && (
        <FleetUpdateDialog
          machine={update}
          onClose={() => setUpdate(null)}
          onRequestConfirmation={requestUpdateConfirmation}
        />
      )}
    </Section>
  );
}

/* ----------------------------------------------------------- unresolved */

function PendingRow({ pending }: { pending: FleetPendingDispatch }) {
  const t = useT();
  const retryable = useStore((s) => pending.dispatchId in s.fleetLastRequests);
  const retryFleetDispatch = useStore((s) => s.retryFleetDispatch);
  const dismissFleetDispatch = useStore((s) => s.dismissFleetDispatch);
  const machine = pending.nickname ?? t("fleet.machine.thisComputer");
  return (
    <li className="flex items-center gap-3 py-1.5 text-[11px]" data-dispatch-id={pending.dispatchId}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{pending.title}</span>
        <span className="block truncate text-ink-faint" title={pending.message}>
          {machine} · {t("fleet.pending.outcome", { machine })}
        </span>
      </span>
      {retryable ? (
        <Button variant="ghost" size="xs" onClick={() => void retryFleetDispatch(pending)}>
          {t("fleet.pending.retry")}
        </Button>
      ) : (
        <span className="shrink-0 text-ink-faint">{t("fleet.pending.retryUnavailable")}</span>
      )}
      <Button variant="ghost" size="xs" onClick={() => void dismissFleetDispatch(pending.dispatchId)}>
        {t("fleet.pending.dismiss")}
      </Button>
    </li>
  );
}

function UnresolvedSection() {
  const t = useT();
  const pending = useStore((s) => s.state?.fleetPending ?? null);
  if (pending === null || pending.length === 0) return null;
  return (
    <Section title={t("fleet.section.unresolved")}>
      <ul className="divide-y divide-line-soft">
        {pending.map((p) => (
          <PendingRow key={p.dispatchId} pending={p} />
        ))}
      </ul>
    </Section>
  );
}

/* ----------------------------------------------------------- dispatches */

function DispatchRow({ row, state }: { row: FleetRow; state: SidebarSessionState }) {
  const t = useT();
  const openSession = useStore((s) => s.openSession);
  const terminate = useStore((s) => s.terminate);
  const { summary } = row;
  const face = SESSION_FACE[state];
  const requestedBy = summary.fleet.requestedBy;
  return (
    <li className="flex items-center gap-3 py-1 text-[11px]" data-tab-id={summary.tabId}>
      <Dot tone={face.tone} pulse={face.pulse} title={t(face.titleKey)} />
      <span className="w-28 shrink-0 truncate text-ink-mid">{row.nickname ?? t("fleet.machine.thisComputer")}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{summary.title}</span>
        <span className="block truncate text-ink-faint">
          {t("fleet.dispatches.from", { label: requestedBy.label })}
          {requestedBy.kind === "agent" && ` · ${t("fleet.dispatches.agent")}`}
        </span>
      </span>
      <span className={`shrink-0 ${face.textClass}`}>{t(face.labelKey)}</span>
      <Button variant="ghost" size="xs" onClick={() => void openSession(summary.tabId)}>
        {t("fleet.dispatches.open")}
      </Button>
      {summary.live === "live" && (
        <Button variant="ghost" size="xs" tone="rose" onClick={() => void terminate(summary.tabId)}>
          {t("fleet.dispatches.stop")}
        </Button>
      )}
    </li>
  );
}

/** One dispatch batch (or a lone dispatch): its sessions newest first, with per-state counts. */
function DispatchGroup({ batchId, rows }: { batchId: string | null; rows: FleetRow[] }) {
  const t = useT();
  // A joined string, not an array: the selector must compare stably or every
  // rpc frame re-renders the group.
  const statesKey = useStore((s) =>
    rows.map((row) => deriveSidebarSessionState(row.summary, s.rpc[row.summary.tabId], undefined)).join(","),
  );
  const states = statesKey.split(",") as SidebarSessionState[];
  const counts = new Map<SidebarSessionState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  return (
    <div className="py-1" data-batch-id={batchId ?? undefined}>
      {batchId !== null && (
        <div className="flex items-center gap-2 py-0.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{rows[0]!.summary.title}</span>
          {[...counts].map(([state, count]) => (
            <span key={state} className={SESSION_FACE[state].textClass}>
              {t("fleet.dispatches.stateCount", { count, state: t(SESSION_FACE[state].labelKey) })}
            </span>
          ))}
        </div>
      )}
      <ul className={batchId === null ? undefined : "border-l border-line-soft pl-2"}>
        {rows.map((row, index) => (
          <DispatchRow key={row.summary.tabId} row={row} state={states[index]!} />
        ))}
      </ul>
    </div>
  );
}

function DispatchesSection() {
  const t = useT();
  const state = useStore((s) => s.state);
  const groups = useMemo(() => {
    const rows: FleetRow[] = [];
    const collect = (sessions: SessionSummary[], nickname: string | null): void => {
      for (const summary of sessions) {
        if (summary.fleet !== null) rows.push({ summary: summary as FleetRow["summary"], nickname });
      }
    };
    for (const group of state?.projects ?? []) collect(group.sessions, null);
    for (const instance of state?.remoteInstances ?? []) {
      for (const group of instance.projects) collect(group.sessions, instance.nickname);
    }
    rows.sort((a, b) => b.summary.fleet.dispatchedAt.localeCompare(a.summary.fleet.dispatchedAt));
    // Insertion order follows the newest member, so groups stay newest first.
    const byBatch = new Map<string, { batchId: string | null; rows: FleetRow[] }>();
    for (const row of rows) {
      const { batchId, dispatchId } = row.summary.fleet;
      const key = batchId ?? `dispatch:${dispatchId}`;
      const entry = byBatch.get(key);
      if (entry === undefined) byBatch.set(key, { batchId, rows: [row] });
      else entry.rows.push(row);
    }
    return [...byBatch.entries()];
  }, [state]);
  return (
    <Section title={t("fleet.section.dispatches")}>
      {groups.length === 0 ? (
        <p className="text-[11px] text-ink-faint">{t("fleet.dispatches.empty")}</p>
      ) : (
        groups.map(([key, group]) => <DispatchGroup key={key} batchId={group.batchId} rows={group.rows} />)
      )}
    </Section>
  );
}

/* --------------------------------------------------------------- audit */

/**
 * This machine's own fleet audit ring (#901, ADR-0062): what ran here and
 * who asked, newest first. The node writes the durable lines; this list is
 * the live mirror over `fleet:audit`.
 */
function AuditSection() {
  const t = useT();
  const audit = useStore((s) => s.fleet?.audit ?? null);
  if (audit === null || audit.length === 0) return null;
  const rows = [...audit].reverse();
  return (
    <Section title={t("fleet.section.activity")}>
      <ul className="divide-y divide-line-soft">
        {rows.map((entry, index) => (
          <li
            key={`${entry.at}-${index}`}
            className="flex flex-wrap items-baseline gap-x-2 py-1 text-[11px]"
            data-audit-index={index}
          >
            <span className={`shrink-0 font-medium ${entry.accepted ? "text-ink-mid" : "text-rose"}`}>
              {t(AUDIT_ACTION_LABEL[entry.action])}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-faint" title={entry.detail}>
              {t("fleet.audit.line", { dispatcher: entry.dispatcherLabel, detail: entry.detail })}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-ink-dim">
              {new Date(entry.at).toLocaleTimeString()}
              {entry.exitCode !== null && ` · exit ${entry.exitCode}`}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* --------------------------------------------------------------- surface */

export function Fleet() {
  const t = useT();
  const open = useStore((s) => s.fleet !== null);
  const loading = useStore((s) => s.fleet?.loading === true);
  const refreshFleet = useStore((s) => s.refreshFleet);
  const closeFleet = useStore((s) => s.closeFleet);
  const openNewSessionDialog = useStore((s) => s.openNewSessionDialog);

  useEffect(() => {
    if (!open) return;
    return startVisibleInterval(() => void refreshFleet(), FLEET_POLL_MS);
  }, [open, refreshFleet]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 overflow-auto bg-void text-ink">
      <header className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line chrome-void px-3">
        <Label>{t("fleet.header.title")}</Label>
        <span className="flex-1" />
        <IconButton label={t("fleet.header.refresh")} disabled={loading} onClick={() => void refreshFleet()}>
          <IconRefresh />
        </IconButton>
        <Button tone="signal" variant="solid" size="xs" onClick={() => openNewSessionDialog({ where: "fleet" })}>
          {t("fleet.header.dispatch")}
        </Button>
        <IconButton label={t("fleet.header.close")} onClick={closeFleet}>
          <IconClose />
        </IconButton>
      </header>
      <MachinesSection />
      <UnresolvedSection />
      <DispatchesSection />
      <AuditSection />
    </div>
  );
}
