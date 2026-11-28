import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionSummary } from "@omp-ui/core/types";
import {
  fleetAppUpdateAvailable,
  fleetOsLabel,
  fleetRungAtLeast,
  LOCAL_MACHINE_KEY,
  PLACEMENT_PREFERENCES,
  type FleetAuditEntry,
  type FleetMachine,
  type FleetMachineStatus,
  type FleetMaintenanceRecord,
  type FleetPackageManager,
  type FleetPendingDispatch,
  type FleetRung,
  type FleetUpdateAllMember,
  type FleetUpdateAllRun,
  type FleetUpdateAllStep,
  type PlacementPreference,
} from "@omp-ui/core/fleet";
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

const STATUS_FACE: Record<FleetMachineStatus, { tone: Tone; label: string }> = {
  ready: { tone: "signal", label: "Ready" },
  unsupported: { tone: "copper", label: "Needs an omp-ui update" },
  unreachable: { tone: "rose", label: "Not connected" },
  error: { tone: "rose", label: "Did not answer" },
};

const PREFERENCE_LABEL: Record<PlacementPreference, string> = {
  prefer: "Prefer",
  normal: "Normal",
  less: "Less often",
  manual: "Manual only",
};

const RUNG_LABEL: Record<FleetRung, string> = {
  observe: "Observe",
  dispatch: "Dispatch",
  manage: "Manage projects",
  full: "Full control",
  terminal: "Terminal",
};

/** Full control or above: the rung the member-side maintenance verbs need (#905, ADR-0066). */
const holdsFull = (machine: FleetMachine): boolean => machine.grantRung !== null && fleetRungAtLeast(machine.grantRung, "full");

/** Columns and rows a fleet terminal opens at before its view fits itself (issue #991). */
const TERMINAL_OPEN_COLS = 120;
const TERMINAL_OPEN_ROWS = 32;

const AUDIT_ACTION_LABEL: Record<FleetAuditEntry["action"], string> = {
  exec: "exec",
  manage: "manage",
  "grant-raise": "grant raise",
  "grant-set": "grant set",
  "exec-detached": "Detached exec",
  keys: "Provider keys",
  update: "update",
  send: "send",
  finish: "finish",
  stop: "stop",
  settle: "settle",
  terminal: "terminal",
};

/** One dispatched session wherever it lives: this app's registry or a joined instance's. */
interface FleetRow {
  summary: SessionSummary & { fleet: NonNullable<SessionSummary["fleet"]> };
  /** Null for this app. */
  nickname: string | null;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <Label className="min-w-0 flex-1 truncate">{title}</Label>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------- machines */

/** The OS chip's hover text (#905): each manager by name, off-PATH ones with their absolute path. */
function packageManagersTitle(managers: FleetPackageManager[] | null): string {
  if (managers === null) return "Package managers not reported (update omp-ui on this machine)";
  if (managers.length === 0) return "No package manager found";
  return `Package managers: ${managers.map((m) => (m.onPath ? m.name : `${m.name} (${m.path})`)).join(", ")}`;
}

/** The omp chip's hover text (ADR-0066): the managed path, plus how it was chosen. */
function ompChipTitle(report: NonNullable<FleetMachine["report"]>): string {
  if (report.ompVersion === null && report.ompPath === null) return "omp is not installed on this machine";
  const path = report.ompPath ?? "";
  return report.ompPinned ? `${path} · pinned by OMP_UI_OMP_PATH` : `${path}`;
}

/**
 * The last Fleet maintenance this controller started on the member (ADR-0066):
 * dispatcher-side bookkeeping over the member's own job record, refreshed by
 * the machines poll while a job runs.
 */
function MaintenanceChip({ record }: { record: FleetMaintenanceRecord }) {
  if (record.state === "running") {
    return (
      <span data-maintenance="running">
        <Chip tone="copper">
          {`updating ${record.target}…${record.progress === null ? "" : ` ${record.progress}%`}`}
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
            ? `omp → ${tail ?? ""}`
            : "update staged"}
        </Chip>
      </span>
    );
  }
  if (record.state === "failed") {
    return (
      <span data-maintenance="failed">
        <Chip tone="rose" truncate title={record.detail ?? undefined}>
          {`failed: ${record.detail ?? ""}`}
        </Chip>
      </span>
    );
  }
  return (
    <span data-maintenance="revoked">
      <Chip tone="neutral" title="Full control was lost on this machine before the update committed, so nothing was replaced.">
        revoked
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
  const setFleetPlacement = useStore((s) => s.setFleetPlacement);
  const openFleetTerminal = useStore((s) => s.openFleetTerminal);
  const openGrantCeremony = useStore((s) => s.openGrantCeremony);
  const holdsTerminal = machine.grantRung !== null && fleetRungAtLeast(machine.grantRung, "terminal");
  const name = machine.nickname ?? "This computer";
  const face = STATUS_FACE[machine.status];
  const report = machine.report;
  // ADR-0066: the maintenance chip reads the last job we started here, if any.
  const maintenance = machine.maintenance;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs" data-machine-key={machine.key}>
      <span className="flex min-w-0 items-center gap-1.5">
        <Dot tone={face.tone} title={face.label} />
        <span className="truncate text-xs text-ink">{name}</span>
        {report !== null && <Chip mono>{`omp-ui ${report.version}`}</Chip>}
        {report !== null && report.packageFormat === "container" && (
          <Chip title="Running in a container image; update by pulling and redeploying the image.">container</Chip>
        )}
        {/* ADR-0066: what each member runs, so skew is visible before dispatching to it. */}
        {report !== null && (report.ompVersion !== null || report.ompPath === null) && (
          <Chip mono title={ompChipTitle(report)}>
            {report.ompVersion === null
              ? "omp not installed"
              : `omp ${report.ompVersion}`}
          </Chip>
        )}
        {report !== null && report.ompBelowMinimum && (
          <Chip tone="rose" title="This omp is older than the minimum omp-ui requires; update it before sending work here.">
            below the floor
          </Chip>
        )}
        {report !== null &&
          (report.appUpdateStaged ? (
            <Chip title={`An omp-ui update is staged on ${name}; it installs the next time that app quits.`}>
              update staged
            </Chip>
          ) : (
            fleetAppUpdateAvailable(report.version, report.appLatestVersion) && (
              <Chip title={`${report.appLatestVersion ?? ""} is published for this machine; stage it from Update versions…`}>
                omp-ui update available
              </Chip>
            )
          ))}
        {maintenance !== null && <MaintenanceChip record={maintenance} />}
        {/* #901: what this member will accept from us; null for this computer and older peers. */}
        {machine.grantRung !== null && (
          <Chip tone={holdsFull(machine) ? "copper" : "neutral"}>
            {`access ${RUNG_LABEL[machine.grantRung]}`}
          </Chip>
        )}
        {/* #1398: the rung-gated buttons stay disabled, but the chip carries
            its way in — one ghost button opens the shared ceremony for the
            first rung those actions need (Terminal needs terminal, the rest
            full). Shown when the row is ready and falls short. */}
        {machine.key !== LOCAL_MACHINE_KEY && machine.status === "ready" && machine.grantRung !== null && !fleetRungAtLeast(machine.grantRung, "full") && (
          <Button
            size="xs"
            variant="ghost"
            data-request-access={machine.key}
            onClick={() => openGrantCeremony(machine.key, name, "full")}
          >
            Request access
          </Button>
        )}
        {/* #904: where an agent's own ssh reaches this member, and whether port 22 answered. */}
        {machine.address !== null && (
          <span data-ssh-reachable={String(machine.sshReachable)} className="min-w-0">
            <Chip
              mono
              truncate
              tone={machine.sshReachable === true ? "signal" : machine.sshReachable === false ? "rose" : "neutral"}
              title={machine.sshReachable === true ? `SSH port 22 answers on ${machine.address}` : machine.sshReachable === false ? `SSH port 22 did not answer on ${machine.address}` : `SSH not checked: ${machine.address} is not connected`}
            >
              {`ssh ${report?.user ? `${report.user}@${machine.address}` : machine.address}`}
            </Chip>
          </span>
        )}
        {/* #905: the member's OS; hover names the package managers found on it. */}
        {report !== null && report.os !== null && (
          <span data-machine-os className="min-w-0">
            <Chip truncate title={packageManagersTitle(report.packageManagers)}>
              {fleetOsLabel(report.os)}
            </Chip>
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-mid">
        {machine.status === "unsupported" ? (
          `Update omp-ui on ${name} to use Fleet`
        ) : machine.status !== "ready" || report === null ? (
          <span className="text-rose">{machine.error ?? face.label}</span>
        ) : (
          <>
            <span className="font-mono tabular-nums">
              {report.cpuUtilization === null
                ? "CPU unknown"
                : `CPU ${Math.round(report.cpuUtilization * 100)}%`}
              {report.totalMemoryBytes > 0 &&
                ` · ${`${Math.round((report.availableMemoryBytes / report.totalMemoryBytes) * 100)}% memory free`}`}
            </span>
            <span className="ml-3">
              {`${report.liveSessions} live sessions · ${report.runningTurns} running turns`}
            </span>
          </>
        )}
      </span>
      {machine.key !== LOCAL_MACHINE_KEY && machine.status === "ready" && (
        <>
          {/* #991: an interactive login shell on the member; it refuses anything below the Terminal rung. */}
          <Button
            size="xs"
            variant="ghost"
            disabled={!holdsTerminal}
            title={holdsTerminal ? `Open a login shell on ${name}; closing the terminal ends it` : "Needs the Terminal rung on this machine — use Request access"}
            onClick={() => void openFleetTerminal(machine.key, TERMINAL_OPEN_COLS, TERMINAL_OPEN_ROWS)}
          >
            Terminal
          </Button>
          {/* #905: Provider key rollout; the member refuses anything below Full control. */}
          <Button
            size="xs"
            variant="ghost"
            disabled={!holdsFull(machine)}
            title={!holdsFull(machine) ? "Needs Full control on this machine — use Request access" : undefined}
            onClick={() => onRollout(machine)}
          >
            Roll out keys
          </Button>
          {/* ADR-0066: remote version maintenance rides the same Full-control gate. */}
          <Button
            size="xs"
            variant="ghost"
            disabled={!holdsFull(machine) || report?.packageFormat === "container"}
            title={
              report?.packageFormat === "container"
                ? "Containerized member — pull and redeploy the container image to update omp-ui or omp"
                : !holdsFull(machine)
                  ? "Needs Full control on this machine — use Request access"
                  : undefined
            }
            onClick={() => onUpdate(machine)}
          >
            Update versions…
          </Button>
        </>
      )}
      <ChoiceCapsule
        label={`Placement preference for ${name}`}
        value={machine.preference}
        options={PLACEMENT_PREFERENCES.map((pref) => ({ value: pref, label: PREFERENCE_LABEL[pref] }))}
        onChange={(pref) => void setFleetPlacement(machine.key, pref)}
        className="text-xs"
      />
    </li>
  );
}

/* ----------------------------------------------------------- update all */

const UPDATE_ALL_FACE: Record<FleetUpdateAllMember["state"], { tone: Tone; label: string }> = {
  queued: { tone: "neutral", label: "queued" },
  running: { tone: "copper", label: "updating…" },
  done: { tone: "signal", label: "done" },
  skipped: { tone: "neutral", label: "skipped" },
  failed: { tone: "rose", label: "failed" },
};

/** One step's outcome as the row's chip text and tone. */
function UpdateAllStepChip({ product, step }: { product: "omp" | "omp-ui"; step: FleetUpdateAllStep }) {
  const tone: Tone = step.kind === "updated" ? "signal" : step.kind === "failed" ? "rose" : "neutral";
  const text =
    step.kind === "current"
      ? `${product} ${step.version ?? ""} current`
      : step.kind === "updated"
        ? product === "omp" ? `${product} → ${step.version ?? ""}` : `${product} ${step.version ?? ""} at next quit`
        : step.kind === "skipped"
          ? `${product} skipped`
          : `${product} failed`;
  const title = step.kind === "skipped" || step.kind === "failed" ? step.reason : step.kind === "updated" ? (step.detail ?? undefined) : undefined;
  return (
    <span data-update-all-step={product} data-step-kind={step.kind} className="min-w-0">
      <Chip tone={tone} truncate title={title}>
        {text}
      </Chip>
    </span>
  );
}

/** Update all's progress (issue #990): one row per member, from the run main keeps. */
function UpdateAllProgress({ run }: { run: FleetUpdateAllRun }) {
  const settled = run.finishedAt !== null;
  return (
    <div data-update-all-run={settled ? "finished" : "running"} className="mb-2 rounded-md border border-line bg-raised px-3 py-2">
      <p className="mb-1 text-xs text-ink-mid">
        {settled ? "Update all finished" : "Update all is running"}
      </p>
      <ul className="divide-y divide-line-soft">
        {run.members.map((member) => {
          const face = UPDATE_ALL_FACE[member.state];
          return (
            <li
              key={member.machineKey}
              data-update-all-member={member.machineKey}
              data-update-all-state={member.state}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-xs"
            >
              <span className="truncate text-xs text-ink">{member.nickname ?? member.machineKey}</span>
              <Chip tone={face.tone}>
                {member.state === "running" && member.step !== null
                  ? `updating ${member.step === "omp" ? "omp" : "omp-ui"}…${member.progress === null ? "" : ` ${member.progress}%`}`
                  : face.label}
              </Chip>
              {member.omp !== null && <UpdateAllStepChip product="omp" step={member.omp} />}
              {member.app !== null && <UpdateAllStepChip product="omp-ui" step={member.app} />}
              {member.reason !== null && <span className="min-w-0 flex-1 truncate text-ink-faint">{member.reason}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MachinesSection() {
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
  const members = (view.machines ?? []).filter((m) => m.key !== LOCAL_MACHINE_KEY);
  // Who Update all asks: ready members this app holds Full control on (the dispatcher skips the rest).
  const eligible = members.filter((m) => m.status === "ready" && holdsFull(m) && m.report?.packageFormat !== "container").length;
  const runActive = view.updateAll !== null && view.updateAll.finishedAt === null;
  return (
    <Section
      title="Machines"
      action={
        members.length > 0 && (
          // #990: this computer's own update stays on Settings → Updates.
          <Button
            size="xs"
            variant="ghost"
            disabled={eligible === 0 || runActive}
            title={
              runActive
                ? "An Update all run is in progress"
                : eligible === 0
                  ? "No member gives this app Full control"
                  : "Update omp and omp-ui on every member this app holds Full control on; this computer updates from Settings → Updates"
            }
            onClick={() =>
              stageLifecycleConfirmation({ kind: "fleet-update-all", eligible, skipped: members.length - eligible })
            }
          >
            Update all
          </Button>
        )
      }
    >
      {view.updateAll !== null && <UpdateAllProgress run={view.updateAll} />}
      {view.error !== null && (
        <p className="mb-1.5 rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink-mid">{view.error}</p>
      )}
      {view.machines === null ? (
        view.loading && <p className="text-xs text-ink-faint">Reading fleet machines…</p>
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
  const retryable = useStore((s) => pending.dispatchId in s.fleetLastRequests);
  const retryFleetDispatch = useStore((s) => s.retryFleetDispatch);
  const dismissFleetDispatch = useStore((s) => s.dismissFleetDispatch);
  const machine = pending.nickname ?? "This computer";
  return (
    <li className="flex items-center gap-3 py-1.5 text-xs" data-dispatch-id={pending.dispatchId}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{pending.title}</span>
        <span className="block truncate text-ink-faint" title={pending.message}>
          {machine} · {`Outcome unknown — resolves when ${machine} reconnects`}
        </span>
      </span>
      {retryable ? (
        <Button variant="ghost" size="xs" onClick={() => void retryFleetDispatch(pending)}>
          Retry
        </Button>
      ) : (
        <span className="shrink-0 text-ink-faint">Retry unavailable after reload</span>
      )}
      <Button variant="ghost" size="xs" onClick={() => void dismissFleetDispatch(pending.dispatchId)}>
        Dismiss
      </Button>
    </li>
  );
}

function UnresolvedSection() {
  const pending = useStore((s) => s.state?.fleetPending ?? null);
  if (pending === null || pending.length === 0) return null;
  return (
    <Section title="Unresolved">
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
  const openSession = useStore((s) => s.openSession);
  const settleSessions = useStore((s) => s.settleSessions);
  const { summary } = row;
  const face = SESSION_FACE[state];
  const requestedBy = summary.fleet.requestedBy;
  return (
    <li className="flex items-center gap-3 py-1 text-xs" data-tab-id={summary.tabId}>
      <Dot tone={face.tone} pulse={face.pulse} title={face.title} />
      <span className="w-28 shrink-0 truncate text-ink-mid">{row.nickname ?? "This computer"}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{summary.title}</span>
        <span className="block truncate text-ink-faint">
          {`from ${requestedBy.label}`}
          {requestedBy.kind === "agent" && ` · ${"agent"}`}
          {requestedBy.kind === "webhook" && ` · ${"webhook"}`}
          {requestedBy.kind === "mcp" && ` · ${"MCP client"}`}
          {requestedBy.kind === "routine" && ` · ${"routine"}`}
        </span>
      </span>
      <span className={`shrink-0 ${face.textClass}`}>{face.label}</span>
      <Button variant="ghost" size="xs" onClick={() => void openSession(summary.tabId)}>
        Open
      </Button>
      {summary.live === "live" && (
        <Button variant="ghost" size="xs" onClick={() => void settleSessions([summary.tabId])}>
          Settle
        </Button>
      )}
    </li>
  );
}

/** One dispatch batch (or a lone dispatch): its sessions newest first, with per-state counts. */
function DispatchGroup({ batchId, rows }: { batchId: string | null; rows: FleetRow[] }) {
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
        <div className="flex items-center gap-2 py-0.5 text-xs">
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{rows[0]!.summary.title}</span>
          {[...counts].map(([state, count]) => (
            <span key={state} className={SESSION_FACE[state].textClass}>
              {`${count} ${SESSION_FACE[state].label}`}
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
  const state = useStore((s) => s.state);
  const groups = useMemo(() => {
    const rows: FleetRow[] = [];
    const collect = (sessions: SessionSummary[], nickname: string | null): void => {
      for (const summary of sessions) {
        if (summary.fleet != null && summary.live === "live") {
          rows.push({ summary: summary as FleetRow["summary"], nickname });
        }
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
    <Section title="Dispatches">
      {groups.length === 0 ? (
        <p className="text-xs text-ink-faint">No unsettled dispatches.</p>
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
  const audit = useStore((s) => s.fleet?.audit ?? null);
  if (audit === null || audit.length === 0) return null;
  const rows = [...audit].reverse();
  return (
    <Section title="Activity">
      <ul className="divide-y divide-line-soft">
        {rows.map((entry, index) => (
          <li
            key={`${entry.at}-${index}`}
            className="flex flex-wrap items-baseline gap-x-2 py-1 text-xs"
            data-audit-index={index}
          >
            <span className={`shrink-0 font-medium ${entry.accepted ? "text-ink-mid" : "text-rose"}`}>
              {AUDIT_ACTION_LABEL[entry.action]}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-faint" title={entry.detail}>
              {`${entry.dispatcherLabel} · ${entry.detail}`}
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

/* ------------------------------------------------------------ terminals */

/** The fleet terminals this app has open (issue #991): reopen one, or close it to end its shell. */
function TerminalsSection() {
  const terminals = useStore((s) => s.state?.fleetTerminals ?? null);
  const showFleetTerminal = useStore((s) => s.showFleetTerminal);
  const closeFleetTerminal = useStore((s) => s.closeFleetTerminal);
  if (terminals === null || terminals.length === 0) return null;
  return (
    <Section title="Terminals">
      <ul className="divide-y divide-line-soft">
        {terminals.map((ft) => (
          <li key={ft.terminalId} className="flex items-center gap-2 py-1.5 text-xs" data-fleet-terminal-row={ft.terminalId}>
            <Dot tone={ft.exitCode === null ? "signal" : "neutral"} />
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{`Terminal on ${ft.nickname}`}</span>
            <span className="shrink-0 font-mono tabular-nums text-ink-dim">
              {ft.exitCode === null
                ? new Date(ft.openedAt).toLocaleTimeString()
                : ft.exitCode === -1
                  ? "ended on the member"
                  : `exited ${ft.exitCode}`}
            </span>
            <Button size="xs" variant="ghost" onClick={() => showFleetTerminal(ft.terminalId)}>
              Show
            </Button>
            <Button size="xs" variant="ghost" tone="rose" onClick={() => void closeFleetTerminal(ft.terminalId)}>
              Close terminal
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* --------------------------------------------------------------- surface */

export function Fleet() {
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
        <Label>fleet</Label>
        <span className="flex-1" />
        <IconButton label="refresh machines" disabled={loading} onClick={() => void refreshFleet()}>
          <IconRefresh />
        </IconButton>
        <Button tone="signal" variant="solid" size="xs" onClick={() => openNewSessionDialog({ where: "fleet" })}>
          Dispatch
        </Button>
        <IconButton label="close the Fleet view" onClick={closeFleet}>
          <IconClose />
        </IconButton>
      </header>
      <MachinesSection />
      <TerminalsSection />
      <UnresolvedSection />
      <DispatchesSection />
      <AuditSection />
    </div>
  );
}
