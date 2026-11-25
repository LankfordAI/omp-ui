import { useEffect, useMemo, useRef, useState } from "react";
import type { RoutineRecord } from "@omp-ui/core/routine";
import { cronPreset } from "@omp-ui/core/scheduled-prompt";
import type { CatalogModelOption } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useCompactShell } from "../../lib/responsive";
import { findInstance, findRecord, useStore, type RoutineDraftArtifactSeed } from "../../store";
import { Button, Chip, Empty, IconButton, IconClose, IconPlus, Panel, Switch } from "../ui";
import { RoutineEditor } from "./RoutineEditor";
import { RoutineInspector } from "./RoutineInspector";
import { RoutinesHostMenu } from "./RoutinesHostMenu";
import {
  OUTCOME_LABEL,
  OUTCOME_TONE,
  REASON_LABEL,
  describeSchedule,
  formatWhen,
  runsOf,
  visibleRoutines,
  type RoutineFilter,
  type RoutineSort,
} from "./routine-format";

/**
 * What the wide pane shows: an inspected routine's drawer, the full editor for
 * a saved routine or a new draft, or nothing (the gallery alone). Compact mode
 * folds "routine" into the editor drill-down it always had.
 */
type Selection = { kind: "routine"; id: string } | { kind: "editor"; id: string } | { kind: "new" } | null;

const LAYOUT_STORAGE_KEY = "omp-ui:routines-layout";

type GalleryLayout = "grid" | "list";

function readInitialLayout(): GalleryLayout {
  try {
    return localStorage.getItem(LAYOUT_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * The full-pane Routines gallery (ADR-0100 §11.1, amended §8, issues #1249,
 * #1306), built on the Artifacts page's design: host-selectable header, search
 * + filter pills + sort over a Grid|List switcher, and a slide-over inspector
 * for detail so a row click never leaves the list. The full `RoutineEditor`
 * stays as drill-down behind "Edit full routine →". Local requests ride this
 * host's `routines:*` channels; remote requests ride `remote-instance:request`
 * to the selected joined host.
 */
export function RoutinesView() {
  const compact = useCompactShell();
  const backendState = useStore((s) => s.state);
  const instanceId = useStore((s) => s.routinesInstanceId);
  const localRoutinesState = useStore((s) => s.routinesState);
  const remoteRoutinesState = useStore((s) =>
    s.routinesInstanceId === null ? null : (s.routinesByInstance[s.routinesInstanceId] ?? null),
  );
  const loadError = useStore((s) =>
    s.routinesInstanceId === null ? null : (s.routinesLoadError[s.routinesInstanceId] ?? null),
  );
  const loading = useStore((s) =>
    s.routinesInstanceId === null ? false : (s.routinesLoading[s.routinesInstanceId] ?? false),
  );
  const closeRoutines = useStore((s) => s.closeRoutines);
  const refreshRoutines = useStore((s) => s.refreshRoutines);
  const updateRoutine = useStore((s) => s.updateRoutine);
  const runRoutineNow = useStore((s) => s.runRoutineNow);
  const reportError = useStore((s) => s.reportError);
  const readChatModels = useStore((s) => s.readChatModels);
  const reconnectRemoteInstance = useStore((s) => s.reconnectRemoteInstance);
  const openSettings = useStore((s) => s.openSettings);
  const openSession = useStore((s) => s.openSession);
  const [selection, setSelection] = useState<Selection>(null);
  const [drilled, setDrilled] = useState(false);
  const [newDraftSeed, setNewDraftSeed] = useState<RoutineDraftArtifactSeed | null>(null);
  const [models, setModels] = useState<readonly CatalogModelOption[]>([]);
  const [layout, setLayout] = useState<GalleryLayout>(readInitialLayout);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState<RoutineFilter>("all");
  const [sort, setSort] = useState<RoutineSort>("next");

  const remoteInstance = instanceId === null ? null : (findInstance(backendState, instanceId) ?? null);
  const remoteStatus = remoteInstance?.status ?? null;
  const state = instanceId === null ? localRoutinesState : remoteRoutinesState;

  // Switching hosts clears selection and query state so nothing crosses hosts
  // looking empty; the Grid|List layout is a display preference and persists.
  useEffect(() => {
    setSelection(null);
    setDrilled(false);
    setNewDraftSeed(null);
    setSearchInput("");
    setDebouncedQuery("");
    setFilter("all");
    setSort("next");
  }, [instanceId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchInput), 150);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const setPersistedLayout = (next: GalleryLayout): void => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    } catch {
      // ignore storage failures
    }
  };

  // Re-fetch when a remote host transitions back into joined status.
  const prevStatusRef = useRef<{ id: string | null; status: string | null }>({
    id: instanceId,
    status: remoteStatus,
  });
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = { id: instanceId, status: remoteStatus };
    if (instanceId !== null && prev.id === instanceId && prev.status !== "joined" && remoteStatus === "joined") {
      void refreshRoutines(instanceId);
    }
  }, [instanceId, remoteStatus, refreshRoutines]);

  // Load the active host's model catalog (reset first so stale models never linger across hosts).
  useEffect(() => {
    if (instanceId !== null && remoteStatus !== "joined") {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModels([]);
    void readChatModels(instanceId)
      .then((snapshot) => {
        if (!cancelled) setModels(snapshot.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [instanceId, remoteStatus, readChatModels]);

  const routines = state?.routines ?? [];
  const runs = state?.runs ?? [];
  const hostLabel =
    instanceId === null
      ? (state?.machineLabel ?? "this computer")
      : (remoteInstance?.nickname ?? state?.machineLabel ?? instanceId);

  const unsupported =
    instanceId !== null &&
    typeof loadError === "string" &&
    loadError.startsWith("unknown channel");
  const disconnected = instanceId !== null && remoteStatus !== "joined";
  const hostEnabled =
    instanceId === null
      ? (state?.enabled ?? backendState?.routinesEnabled === true)
      : (state?.enabled ?? remoteInstance?.routinesEnabled === true);
  const hostDisabled = !disconnected && !unsupported && !hostEnabled;
  const readOnly = disconnected || unsupported || hostDisabled;
  const canCreate = !readOnly;

  // A transcript review link (omp-ui://routine/<id>) picked a routine: select
  // it once the list carries it, then consume the request. A vanished id
  // (deleted between create and click) just clears.
  const routineFocusId = useStore((s) => s.routineFocusId);
  const clearRoutineFocus = useStore((s) => s.clearRoutineFocus);
  useEffect(() => {
    if (routineFocusId === null || state === null) return;
    if (routines.some((routine) => routine.id === routineFocusId)) pick({ kind: "routine", id: routineFocusId });
    clearRoutineFocus();
    // `pick` is a stable local setter over setState; wait for active host state before consuming focus.
  }, [routineFocusId, state]);

  // "Schedule refresh…" from Artifacts (ADR-0101 / #1307): copy into local state
  // before clearing the store so store clears never wipe pre-filled draft fields.
  const routineDraftArtifact = useStore((s) => s.routineDraftArtifact);
  const clearRoutineDraftArtifact = useStore((s) => s.clearRoutineDraftArtifact);
  useEffect(() => {
    if (routineDraftArtifact === null || instanceId !== null) return;
    setNewDraftSeed(routineDraftArtifact);
    setSelection({ kind: "new" });
    setDrilled(true);
    clearRoutineDraftArtifact();
  }, [routineDraftArtifact, instanceId, clearRoutineDraftArtifact]);

  // Guarded lookups: a remote removal prunes the record and closes whatever
  // showed it; the drawer never holds the record itself.
  const inspected: RoutineRecord | null =
    selection?.kind === "routine" ? (routines.find((r) => r.id === selection.id) ?? null) : null;
  const editing: RoutineRecord | null =
    selection?.kind === "new"
      ? null
      : selection !== null
        ? (routines.find((r) => r.id === selection.id) ?? null)
        : null;
  const waitingRuns = useMemo(() => runs.filter((r) => r.outcome === "waiting-approval"), [runs]);
  // The wide pane drills into the full editor only from an explicit entry:
  // "new" (draft) or "editor" (reached via the drawer's Edit / row Inspect → Edit).
  const editorOpen = selection !== null && (selection.kind === "new" || selection.kind === "editor");
  const waitingCount = waitingRuns.length;
  const enabledCount = routines.filter((r) => r.enabled).length;
  const visible = useMemo(
    () => visibleRoutines(routines, runs, { query: debouncedQuery, filter, sort }),
    [routines, runs, debouncedQuery, filter, sort],
  );
  const unfilteredAll = filter === "all" && !debouncedQuery;
  const showAttentionStrip = unfilteredAll && waitingCount > 0;

  const pick = (next: Selection): void => {
    if (next?.kind !== "new") setNewDraftSeed(null);
    setSelection(next);
    setDrilled(next !== null);
  };

  const openEditorFor = (id: string): void => {
    setNewDraftSeed(null);
    setSelection({ kind: "editor", id });
    setDrilled(true);
  };

  const setEnabled = (routine: RoutineRecord, enabled: boolean): void => {
    updateRoutine(routine.id, { enabled }, instanceId).catch((err: unknown) => reportError(err));
  };

  const runNowFromRow = (routine: RoutineRecord): void => {
    runRoutineNow(routine.id, instanceId).catch((err: unknown) => reportError(err));
  };

  const focusRow = (id: string): void => {
    document.querySelector(`[data-routine-row="${id}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const disconnectedBanner = disconnected && instanceId !== null && (
    <div className="shrink-0 border-b border-line px-4 py-2 sm:px-5" data-routines-disconnected-banner>
      <Panel tone="rose" className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="text-ink-mid">
          {`${hostLabel} is not connected — viewing cached snapshot`}
        </span>
        <Button
          size="xs"
          variant="ghost"
          tone="rose"
          onClick={() => void reconnectRemoteInstance(instanceId)}
        >
          Reconnect
        </Button>
      </Panel>
    </div>
  );

  const hostUnavailableCard = (): React.ReactNode | null => {
    if (unsupported) {
      return (
        <div className="grid flex-1 place-items-center p-6" data-routines-unsupported>
          <div className="studio-card flex max-w-md flex-col items-center gap-4 rounded-xl p-6 text-center">
            <Empty
              title={`Routines unavailable on ${hostLabel}`}
              hint={`${hostLabel} does not support Routines (update omp-ui there, or Host Lite does not run Routines).`}
            />
          </div>
        </div>
      );
    }
    if (disconnected && state === null && instanceId !== null) {
      return (
        <div className="grid flex-1 place-items-center p-6" data-routines-offline>
          <div className="studio-card flex max-w-md flex-col items-center gap-4 rounded-xl p-6 text-center">
            <Empty
              title={`${hostLabel} is offline`}
              hint={
                remoteStatus === "needs-sign-in"
                  ? `Sign in to ${hostLabel} in Settings → Remote instances to manage its routines.`
                  : `Reconnect to ${hostLabel} to view and manage its routines.`
              }
            />
            <Button size="sm" variant="solid" onClick={() => void reconnectRemoteInstance(instanceId)}>
              Reconnect
            </Button>
          </div>
        </div>
      );
    }
    if (hostDisabled) {
      return (
        <div className="grid flex-1 place-items-center p-6" data-routines-disabled>
          <div className="studio-card flex max-w-md flex-col items-center gap-4 rounded-xl p-6 text-center">
            <Empty
              title={`Routines are off on ${hostLabel}`}
              hint={
                instanceId === null
                  ? "Turn on Settings → Routines to manage or run routines on this computer."
                  : `Turn on Settings → Routines on ${hostLabel} to manage or run its routines.`
              }
            />
            {instanceId === null && (
              <Button
                size="sm"
                variant="solid"
                onClick={() => {
                  closeRoutines();
                  openSettings("routines");
                }}
              >
                Open Settings
              </Button>
            )}
          </div>
        </div>
      );
    }
    if (instanceId !== null && state === null && loadError !== null && !loading) {
      return (
        <div className="grid flex-1 place-items-center p-6" data-routines-load-error>
          <div className="studio-card flex max-w-md flex-col items-center gap-4 rounded-xl p-6 text-center">
            <Empty title={`Could not load routines from ${hostLabel}`} hint={loadError} />
            <Button size="sm" variant="solid" onClick={() => void refreshRoutines(instanceId)}>
              Retry
            </Button>
          </div>
        </div>
      );
    }
    return null;
  };

  const unavailable = hostUnavailableCard();

  const routineRows = routines.map((routine) => {
    const last = runsOf(runs, routine.id)[0];
    const active = drilled && selection !== null && "id" in selection && selection.id === routine.id;
    return (
      <div
        key={routine.id}
        data-routine-row={routine.id}
        className={cn(
          "relative overflow-hidden rounded-lg border p-2 transition-colors",
          active
            ? "border-line-strong bg-raised/90 edge-lit"
            : "border-line-soft bg-surface/55 hover:border-line hover:bg-hover/55",
        )}
      >
        {active && (
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 w-[3px]",
              routine.enabled ? "bg-signal" : "bg-ink-faint/70",
            )}
          />
        )}
        <div className="flex items-start gap-2 pl-1">
          <button
            type="button"
            onClick={() => pick({ kind: "routine", id: routine.id })}
            className="min-w-0 flex-1 text-left"
          >
            <span className="block truncate text-sm font-medium text-ink">
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
            </span>
            <span className="mt-0.5 block truncate text-xs text-ink-mid">{describeSchedule(routine.schedule)}</span>
            <span className="mt-0.5 block truncate text-xs text-ink-faint">
              {routine.enabled && routine.nextRunAtMs !== null
                ? `Next: ${formatWhen(routine.nextRunAtMs)}`
                : routine.enabled
                  ? "Never"
                  : "Paused"}
            </span>
          </button>
          <Switch
            on={routine.enabled}
            disabled={readOnly}
            label={`Enable ${routine.name}`}
            onChange={(enabled) => setEnabled(routine, enabled)}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 border-t border-line-soft pt-1.5 pl-1 text-xs">
          {last !== undefined ? (
            <>
              <Chip tone={OUTCOME_TONE[last.outcome]}>{OUTCOME_LABEL[last.outcome]}</Chip>
              <span className="truncate text-ink-faint">{relativeTime(new Date(last.firedAtMs).toISOString())}</span>
            </>
          ) : (
            <span className="text-ink-faint">No runs yet.</span>
          )}
        </div>
      </div>
    );
  });

  const hostChip =
    instanceId === null ? (
      <Chip tone="iris">Host-local</Chip>
    ) : (
      <Chip tone="iris" title={remoteInstance?.url ?? undefined}>
        {`Remote · ${hostLabel}`}
      </Chip>
    );

  const compactList = (
    <div className="flex h-full min-h-0 flex-col">
      {disconnectedBanner}
      {unavailable !== null ? (
        unavailable
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <p className="min-w-0 truncate text-xs text-ink-faint">
              {`${enabledCount} of ${routines.length} enabled`}
            </p>
            <Button size="xs" variant="solid" disabled={!canCreate} onClick={() => pick({ kind: "new" })}>
              <IconPlus className="size-3.5" />
              New routine
            </Button>
          </div>
          {waitingCount > 0 && (
            <p className="border-b border-line bg-copper-wash/60 px-3 py-2 text-xs font-medium text-copper">
              {`${waitingCount} routine run waiting on an Approval card`}
            </p>
          )}
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {routines.length === 0 ? (
              <Empty
                title="No routines on this host"
                hint="omp-ui ships no built-in routines. Add one to run your own instructions on a schedule."
              />
            ) : (
              routineRows
            )}
          </div>
        </>
      )}
    </div>
  );

  const compactDetail = (
    <div className="flex h-full min-h-0 flex-col">
      {disconnectedBanner}
      <div className="flex shrink-0 items-center gap-2 border-b border-line chrome-void px-2 py-1.5">
        <Button size="xs" variant="ghost" onClick={() => pick(null)}>
          ← All routines
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <RoutineEditor
          key={`${instanceId ?? "local"}:${editing?.id ?? `new:${newDraftSeed?.nonce ?? 0}`}`}
          routine={selection?.kind === "new" ? null : editing}
          artifactSeed={selection?.kind === "new" ? newDraftSeed : null}
          models={models}
          instanceId={instanceId}
          hostLabel={hostLabel}
          readOnly={readOnly}
          onSaved={(saved) => {
            setNewDraftSeed(null);
            setSelection({ kind: "routine", id: saved.id });
            setDrilled(false);
          }}
          onDeleted={() => pick(null)}
          onOpenSession={closeRoutines}
        />
      </div>
    </div>
  );

  // Shared wide chrome pieces.

  const attentionStrip = showAttentionStrip && (
    <section
      aria-label="Waiting on approval"
      data-routines-attention-strip
      className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-copper/40 bg-copper-wash/30 px-3 py-2 text-xs"
    >
      <span className="font-semibold text-copper">
        {`${waitingCount} run${waitingCount === 1 ? "" : "s"} waiting on an Approval card`}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {waitingRuns.map((run) => {
          const routine = routines.find((r) => r.id === run.routineId);
          if (routine === undefined) return null;
          const reachable = run.tabId !== null && !run.pruned && findRecord(backendState, run.tabId) !== undefined;
          return (
            <Button
              key={run.id}
              size="xs"
              variant="ghost"
              className="max-w-xs truncate bg-surface/80"
              onClick={() => {
                if (reachable && run.tabId !== null) {
                  void openSession(run.tabId);
                  return;
                }
                pick({ kind: "routine", id: routine.id });
                focusRow(routine.id);
              }}
            >
              {reachable ? `${routine.name} · Review approval →` : `${routine.name} →`}
            </Button>
          );
        })}
      </div>
    </section>
  );

  const galleryEmpty = routines.length === 0 ? (
    <div className="mx-auto max-w-md py-12">
      <Empty
        title="No routines on this host"
        hint="omp-ui ships no built-in routines. Add one to run your own instructions on a schedule."
      />
    </div>
  ) : visible.length === 0 ? (
    <div className="mx-auto max-w-md py-12">
      <Empty
        title="No routines match these filters"
        hint="Clear the search or switch filters to see all routines on this host."
      />
    </div>
  ) : null;

  const routineTable = (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-line bg-sunken/50 text-ink-faint">
            <th className="px-3 py-2 font-medium">Routine</th>
            <th className="px-3 py-2 font-medium">Schedule</th>
            <th className="px-3 py-2 font-medium">Next</th>
            <th className="px-3 py-2 font-medium">On</th>
            <th className="px-3 py-2 font-medium">Last run</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {visible.map((routine) => {
            const last = runsOf(runs, routine.id)[0];
            const isInspected = selection?.kind === "routine" && selection.id === routine.id;
            return (
              <tr
                key={routine.id}
                data-routine-row={routine.id}
                onClick={() => pick({ kind: "routine", id: routine.id })}
                className={cn(
                  "cursor-pointer transition-colors",
                  isInspected ? "bg-raised/90 edge-lit" : "hover:bg-hover/50",
                )}
              >
                <td className="relative max-w-xs px-3 py-2 font-medium text-ink">
                  {isInspected && (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-y-0 left-0 w-[3px]",
                        routine.enabled ? "bg-signal" : "bg-ink-faint/70",
                      )}
                    />
                  )}
                  <span className="block truncate">
                    {routine.name}
                    {routine.artifact !== null && (
                      <span
                        data-routine-artifact-badge
                        title="Scheduled artifact refresh"
                        className="ml-1.5 align-middle text-[10px] uppercase tracking-wide text-copper"
                      >
                        ↻ refresh
                      </span>
                    )}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-ink-mid">{describeSchedule(routine.schedule)}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-ink-dim">
                  {routine.enabled && routine.nextRunAtMs !== null ? (
                    <span title={new Date(routine.nextRunAtMs).toLocaleString()}>
                      {formatWhen(routine.nextRunAtMs)}
                    </span>
                  ) : (
                    <span className="text-ink-faint">{routine.enabled ? "Never" : "Paused"}</span>
                  )}
                </td>
                <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                  <Switch
                    on={routine.enabled}
                    disabled={readOnly}
                    label={`Enable ${routine.name}`}
                    onChange={(enabled) => setEnabled(routine, enabled)}
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {last !== undefined ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Chip tone={OUTCOME_TONE[last.outcome]}>{OUTCOME_LABEL[last.outcome]}</Chip>
                      <span className="text-ink-faint">{relativeTime(new Date(last.firedAtMs).toISOString())}</span>
                      {last.reasonCode !== null && <span className="text-ink-mid">{REASON_LABEL[last.reasonCode]}</span>}
                    </span>
                  ) : (
                    <span className="text-ink-faint">No runs yet.</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right" onClick={(event) => event.stopPropagation()}>
                  {!readOnly && (
                    <div className="inline-flex items-center gap-1">
                      <Button size="xs" variant="ghost" onClick={() => runNowFromRow(routine)}>
                        ▶ Run
                      </Button>
                      <Button size="xs" onClick={() => pick({ kind: "routine", id: routine.id })}>
                        Inspect
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const routineGrid = (
    <div className="grid grid-cols-1 gap-4 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3 @[78rem]:grid-cols-4">
      {visible.map((routine) => {
        const last = runsOf(runs, routine.id)[0];
        const preset = routine.schedule.kind === "cron" ? cronPreset(routine.schedule.expr) : null;
        const activeDays =
          preset === null
            ? null
            : preset.kind === "daily"
              ? [0, 1, 2, 3, 4, 5, 6]
              : preset.kind === "weekdays"
                ? [1, 2, 3, 4, 5]
                : [preset.weekday];
        return (
          <article
            key={routine.id}
            data-routine-row={routine.id}
            className="group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-line-strong"
          >
            <button
              type="button"
              onClick={() => pick({ kind: "routine", id: routine.id })}
              aria-label={`Inspect ${routine.name}`}
              className="block border-b border-line-soft bg-sunken px-3 pb-2.5 pt-8 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-copper"
            >
              <span className="block truncate font-mono text-lg font-semibold text-ink">
                {routine.enabled && routine.nextRunAtMs !== null
                  ? formatWhen(routine.nextRunAtMs)
                  : routine.enabled
                    ? "Never"
                    : "Paused"}
              </span>
              <span className="mt-1 block text-xs text-ink-mid">{describeSchedule(routine.schedule)}</span>
              {activeDays !== null ? (
                <span className="mt-1.5 flex gap-1" aria-hidden>
                  {WEEKDAY_LETTERS.map((letter, day) => (
                    <span
                      key={`${letter}-${day}`}
                      className={cn(
                        "flex size-4 items-center justify-center rounded-full text-[9px]",
                        activeDays.includes(day) ? "bg-signal/20 font-semibold text-signal" : "bg-raised text-ink-faint",
                      )}
                    >
                      {letter}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="mt-1.5 block truncate font-mono text-[10px] text-ink-faint">
                  {routine.schedule.kind === "cron" ? routine.schedule.expr : ""}
                </span>
              )}
            </button>
            <div
              className="pointer-events-none absolute left-2 top-2"
            >
              {last !== undefined ? (
                <Chip tone={OUTCOME_TONE[last.outcome]}>{OUTCOME_LABEL[last.outcome]}</Chip>
              ) : routine.artifact !== null ? (
                <Chip tone="copper">↻ refresh</Chip>
              ) : (
                <Chip tone="neutral">No runs</Chip>
              )}
            </div>
            <div className="absolute right-2 top-1.5" onClick={(event) => event.stopPropagation()}>
              <Switch
                on={routine.enabled}
                disabled={readOnly}
                label={`Enable ${routine.name}`}
                onChange={(enabled) => setEnabled(routine, enabled)}
              />
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-9 flex items-center justify-end gap-1 bg-gradient-to-b from-void/85 to-transparent px-2 pb-3 pt-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {!readOnly && (
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="pointer-events-auto bg-overlay/90 backdrop-glass"
                    onClick={() => runNowFromRow(routine)}
                  >
                    ▶ Run now
                  </Button>
                  <Button size="xs" variant="solid" className="pointer-events-auto" onClick={() => pick({ kind: "routine", id: routine.id })}>
                    Inspect
                  </Button>
                </>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-1 p-2.5 text-xs">
              <span className="block truncate font-medium text-ink">{routine.name}</span>
              <span className="block truncate text-ink-faint" title={routine.destination.projectCwd}>
                {routine.destination.projectCwd.split("/").filter(Boolean).pop() ?? routine.destination.projectCwd}
              </span>
              {last !== undefined && (
                <span className="text-ink-faint">{relativeTime(new Date(last.firedAtMs).toISOString())}</span>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );

  return (
    <section
      aria-label="Routines"
      data-routines-view
      className="absolute inset-0 flex flex-col overflow-x-hidden studio-stage text-ink"
    >
      {compact ? (
        <>
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line chrome-void px-3">
            <RoutinesHostMenu className="min-w-0" />
            <span className="hidden sm:inline-flex">{hostChip}</span>
            <span className="flex-1" />
            <IconButton label="Close Routines" onClick={closeRoutines}>
              <IconClose />
            </IconButton>
          </header>
          <div className="min-h-0 flex-1">{drilled && selection !== null && unavailable === null ? compactDetail : compactList}</div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col @container">
          <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line chrome-void px-4 py-2.5">
            <Button size="xs" variant="ghost" onClick={closeRoutines} className="-ml-1">
              ← Sessions
            </Button>
            <h1 className="text-base font-semibold tracking-tight text-ink">Routines</h1>
            <RoutinesHostMenu className="min-w-0" />
            {hostChip}
            <span className="flex-1" />
            <span className="text-xs text-ink-dim">{`${enabledCount} of ${routines.length} enabled`}</span>
            <div className="inline-flex rounded-md border border-line bg-raised p-0.5 text-xs" role="group" aria-label="Gallery layout">
              <button
                type="button"
                aria-pressed={layout === "grid"}
                onClick={() => setPersistedLayout("grid")}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  layout === "grid" ? "bg-surface font-medium text-ink" : "text-ink-dim hover:text-ink",
                )}
              >
                Grid
              </button>
              <button
                type="button"
                aria-pressed={layout === "list"}
                onClick={() => setPersistedLayout("list")}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  layout === "list" ? "bg-surface font-medium text-ink" : "text-ink-dim hover:text-ink",
                )}
              >
                List
              </button>
            </div>
            <IconButton label="Close Routines" onClick={closeRoutines}>
              <IconClose />
            </IconButton>
          </header>

          {unavailable === null && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-sunken/40 px-4 py-2">
              <label className="min-w-44 flex-1 @[48rem]:max-w-xs">
                <span className="sr-only">Search routines</span>
                <input
                  type="search"
                  placeholder="Search routines, projects, schedules…"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  className="w-full min-w-0 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-ink outline-none focus-visible:border-copper"
                />
              </label>
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Routine filter">
                {(
                  [
                    { id: "all", label: "All" },
                    { id: "enabled", label: "Enabled" },
                    { id: "paused", label: "Paused" },
                    {
                      id: "waiting",
                      label: waitingCount > 0 ? `Waiting approval (${waitingCount})` : "Waiting approval",
                    },
                    { id: "refresh", label: "Refresh" },
                  ] as const
                ).map((pill) => (
                  <Button
                    key={pill.id}
                    size="xs"
                    selected={filter === pill.id}
                    onClick={() => setFilter(pill.id)}
                  >
                    {pill.label}
                  </Button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-ink-dim">
                <span className="sr-only">Sort routines</span>
                <select
                  aria-label="Sort routines"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as RoutineSort)}
                  className="rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink"
                >
                  <option value="next">Next run</option>
                  <option value="name">Name</option>
                  <option value="lastrun">Last run</option>
                </select>
              </label>
              <span className="flex-1" />
              <Button
                size="xs"
                variant="solid"
                disabled={!canCreate}
                onClick={() => pick({ kind: "new" })}
                className="shrink-0"
              >
                <IconPlus className="size-3.5" />
                New routine
              </Button>
            </div>
          )}

          {disconnectedBanner}

          {unavailable !== null ? (
            unavailable
          ) : editorOpen && selection !== null ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => (selection.kind === "new" ? pick(null) : pick({ kind: "routine", id: selection.id }))}
                >
                  ← All routines
                </Button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <RoutineEditor
                  key={`${instanceId ?? "local"}:${editing?.id ?? `new:${newDraftSeed?.nonce ?? 0}`}`}
                  routine={selection.kind === "new" ? null : editing}
                  artifactSeed={selection.kind === "new" ? newDraftSeed : null}
                  models={models}
                  instanceId={instanceId}
                  hostLabel={hostLabel}
                  readOnly={readOnly}
                  onSaved={(saved) => {
                    setNewDraftSeed(null);
                    pick({ kind: "routine", id: saved.id });
                  }}
                  onDeleted={() => pick(null)}
                  onOpenSession={closeRoutines}
                />
              </div>
            </div>
          ) : (
            <div className="relative min-h-0 flex-1">
              <main
                className="absolute inset-0 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable]"
                aria-label="Routines"
              >
                {attentionStrip}
                {galleryEmpty !== null ? galleryEmpty : layout === "list" ? routineTable : routineGrid}
              </main>
              {inspected !== null && (
                <RoutineInspector
                  routine={inspected}
                  runs={runs}
                  hostLabel={hostLabel}
                  spendDefaults={{ warnUsd: state?.defaultWarnCostUsd ?? 0, maxUsd: state?.defaultMaxCostUsd ?? 0 }}
                  readOnly={readOnly}
                  instanceId={instanceId}
                  onClose={() => pick(null)}
                  onEdit={() => openEditorFor(inspected.id)}
                  onOpenSession={closeRoutines}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
