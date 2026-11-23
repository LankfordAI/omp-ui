import { useEffect, useState } from "react";
import type { RoutineRecord } from "@omp-ui/core/routine";
import type { CatalogModelOption } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useCompactShell } from "../../lib/responsive";
import { useStore } from "../../store";
import { Button, Chip, Empty, IconButton, IconClose, IconPlus, Label, Switch } from "../ui";
import { RoutineEditor } from "./RoutineEditor";
import { OUTCOME_LABEL, OUTCOME_TONE, describeSchedule, formatWhen, runsOf } from "./routine-format";

/** The editor's selection: a saved routine's id, a new unsaved one, or nothing. */
type Selection = { kind: "routine"; id: string } | { kind: "new" } | null;

/**
 * The full-pane Routines view (ADR-0100 §11.1, prototype #1249): host-named
 * header, split list + editor at ≥ 900 px, list → editor drill-down below
 * it. Every read and write rides this host's routines:* channels; the list
 * follows the routines:state broadcast.
 */
export function RoutinesView() {
  const compact = useCompactShell();
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const state = useStore((s) => s.routinesState);
  const closeRoutines = useStore((s) => s.closeRoutines);
  const updateRoutine = useStore((s) => s.updateRoutine);
  const reportError = useStore((s) => s.reportError);
  const readChatModels = useStore((s) => s.readChatModels);
  const [selection, setSelection] = useState<Selection>(null);
  const [drilled, setDrilled] = useState(false);
  const [models, setModels] = useState<readonly CatalogModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void readChatModels()
      .then((snapshot) => {
        if (!cancelled) setModels(snapshot.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [readChatModels]);

  const routines = state?.routines ?? [];
  const runs = state?.runs ?? [];
  // A transcript review link (omp-ui://routine/<id>) picked a routine: select
  // it once the list carries it, then consume the request. A vanished id
  // (deleted between create and click) just clears.
  const routineFocusId = useStore((s) => s.routineFocusId);
  const clearRoutineFocus = useStore((s) => s.clearRoutineFocus);
  useEffect(() => {
    if (routineFocusId === null || state === null) return;
    if (routines.some((routine) => routine.id === routineFocusId)) pick({ kind: "routine", id: routineFocusId });
    clearRoutineFocus();
    // `pick` is a stable local setter over setState; wait for routinesState before consuming focus.
  }, [routineFocusId, state]);
  const selected: RoutineRecord | null =
    selection?.kind === "routine" ? (routines.find((r) => r.id === selection.id) ?? null) : null;
  // Wide layout always shows a detail: the first routine when nothing is picked.
  const effective: Selection =
    selection?.kind === "new" || selected !== null
      ? selection
      : !compact && routines[0] !== undefined
        ? { kind: "routine", id: routines[0].id }
        : null;
  const editing = effective?.kind === "routine" ? (routines.find((r) => r.id === effective.id) ?? null) : null;
  const waitingCount = runs.filter((r) => r.outcome === "waiting-approval").length;
  const enabledCount = routines.filter((r) => r.enabled).length;

  const pick = (next: Selection): void => {
    setSelection(next);
    setDrilled(next !== null);
  };

  const routineRows = routines.map((routine) => {
    const last = runsOf(runs, routine.id)[0];
    const active = effective?.kind === "routine" && effective.id === routine.id;
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
            label={`Enable ${routine.name}`}
            onChange={(enabled) => {
              updateRoutine(routine.id, { enabled }).catch((err: unknown) => reportError(err));
            }}
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

  const hostHeaderLabel =
    state === null ? "Routines" : `Routines on ${state.machineLabel}`;

  const compactList = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className="min-w-0 truncate text-xs text-ink-faint">
          {`${enabledCount} of ${routines.length} enabled`}
        </p>
        <Button size="xs" variant="solid" onClick={() => pick({ kind: "new" })}>
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
          <Empty title="No routines on this host" hint="omp-ui ships no built-in routines. Add one to run your own instructions on a schedule." />
        ) : (
          routineRows
        )}
      </div>
    </div>
  );

  const compactDetail = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line chrome-void px-2 py-1.5">
        <Button size="xs" variant="ghost" onClick={() => pick(null)}>
          ← All routines
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <RoutineEditor
          routine={editing}
          models={models}
          onSaved={(saved) => setSelection({ kind: "routine", id: saved.id })}
          onDeleted={() => pick(null)}
          onOpenSession={closeRoutines}
        />
      </div>
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
            <Label className="min-w-0 truncate">{hostHeaderLabel}</Label>
            <Chip tone="iris" className="hidden sm:inline-flex">
              Host-local
            </Chip>
            <span className="flex-1" />
            <IconButton label="Close Routines" onClick={closeRoutines}>
              <IconClose />
            </IconButton>
          </header>
          <div className="min-h-0 flex-1">{drilled && effective !== null ? compactDetail : compactList}</div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!sidebarCollapsed && (
            <aside
              data-routines-sidebar
              className="flex w-68 shrink-0 flex-col border-r border-line glass-sunken"
            >
              <header className="shrink-0 space-y-2 border-b border-line px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <Button size="xs" variant="ghost" onClick={closeRoutines} className="-ml-1.5">
                    ← Sessions
                  </Button>
                  <div className="flex items-center gap-1.5">
                    {waitingCount > 0 && <Chip tone="copper">{waitingCount}</Chip>}
                    <IconButton label="Close Routines" onClick={closeRoutines}>
                      <IconClose />
                    </IconButton>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <Label className="block truncate">{hostHeaderLabel}</Label>
                    <p className="mt-0.5 truncate text-xs text-ink-faint">
                      {`${enabledCount} of ${routines.length} enabled`}
                    </p>
                  </div>
                  <Button size="xs" variant="solid" onClick={() => pick({ kind: "new" })} className="shrink-0">
                    <IconPlus className="size-3.5" />
                    New routine
                  </Button>
                </div>
              </header>
              {waitingCount > 0 && (
                <p className="border-b border-line bg-copper-wash/60 px-3 py-2 text-xs font-medium text-copper">
                  {`${waitingCount} routine run waiting on an Approval card`}
                </p>
              )}
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                {routines.length === 0 ? (
                  <Empty title="No routines on this host" hint="omp-ui ships no built-in routines. Add one to run your own instructions on a schedule." />
                ) : (
                  routineRows
                )}
              </div>
              <div className="shrink-0 border-t border-line px-3 py-2">
                <Chip tone="iris">Host-local</Chip>
              </div>
            </aside>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {effective === null ? (
              <>
                {sidebarCollapsed && (
                  <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line chrome-void px-3">
                    <Button size="xs" variant="ghost" onClick={closeRoutines} className="-ml-1.5">
                      ← Sessions
                    </Button>
                    <Label className="min-w-0 truncate">{hostHeaderLabel}</Label>
                    <span className="flex-1" />
                    <IconButton label="Close Routines" onClick={closeRoutines}>
                      <IconClose />
                    </IconButton>
                  </header>
                )}
                <div className="grid flex-1 place-items-center p-6">
                  <div className="studio-card flex max-w-md flex-col items-center gap-4 rounded-xl p-6">
                    <Empty title="No routines on this host" hint="omp-ui ships no built-in routines. Add one to run your own instructions on a schedule." />
                    <Button size="sm" variant="solid" onClick={() => pick({ kind: "new" })}>
                      <IconPlus className="size-3.5" />
                      New routine
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <RoutineEditor
                routine={editing}
                models={models}
                onSaved={(saved) => setSelection({ kind: "routine", id: saved.id })}
                onDeleted={() => pick(null)}
                onOpenSession={closeRoutines}
                onBackToSessions={sidebarCollapsed ? closeRoutines : undefined}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
