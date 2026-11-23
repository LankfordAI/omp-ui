import { useEffect, useState } from "react";
import type { RoutineRecord } from "@omp-ui/core/routine";
import type { CatalogModelOption } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useT } from "../../lib/i18n";
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
  const t = useT();
  const compact = useCompactShell();
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
    if (routineFocusId === null) return;
    if (routines.some((routine) => routine.id === routineFocusId)) pick({ kind: "routine", id: routineFocusId });
    clearRoutineFocus();
    // `pick` is a stable local setter over setState; routines read once per request.
  }, [routineFocusId]);
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

  const pick = (next: Selection): void => {
    setSelection(next);
    setDrilled(next !== null);
  };

  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className="min-w-0 truncate text-xs text-ink-faint">
          {t("routines.enabledCount", { n: routines.filter((r) => r.enabled).length, total: routines.length })}
        </p>
        <Button size="xs" variant="solid" onClick={() => pick({ kind: "new" })}>
          <IconPlus className="size-3.5" />
          {t("routines.new")}
        </Button>
      </div>
      {waitingCount > 0 && (
        <p className="border-b border-line bg-copper-wash/60 px-3 py-2 text-xs font-medium text-copper">
          {t("routines.waitingBanner", { n: waitingCount })}
        </p>
      )}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {routines.length === 0 ? (
          <Empty title={t("routines.emptyTitle")} hint={t("routines.emptyHint")} />
        ) : (
          routines.map((routine) => {
            const last = runsOf(runs, routine.id)[0];
            const active = effective?.kind === "routine" && effective.id === routine.id;
            return (
              <div
                key={routine.id}
                data-routine-row={routine.id}
                className={cn(
                  "relative overflow-hidden rounded-lg border p-2.5 transition-colors",
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
                    <span className="block truncate text-sm font-medium text-ink">{routine.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-ink-mid">{describeSchedule(routine.schedule)}</span>
                    <span className="mt-0.5 block truncate text-xs text-ink-faint">
                      {routine.enabled && routine.nextRunAtMs !== null
                        ? t("routines.next", { when: formatWhen(routine.nextRunAtMs) })
                        : routine.enabled
                          ? t("routines.never")
                          : t("routines.paused")}
                    </span>
                  </button>
                  <Switch
                    on={routine.enabled}
                    label={t("routines.enableNamed", { name: routine.name })}
                    onChange={(enabled) => {
                      updateRoutine(routine.id, { enabled }).catch((err: unknown) => reportError(err));
                    }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 border-t border-line-soft pt-1.5 pl-1 text-xs">
                  {last !== undefined ? (
                    <>
                      <Chip tone={OUTCOME_TONE[last.outcome]}>{t(OUTCOME_LABEL[last.outcome])}</Chip>
                      <span className="truncate text-ink-faint">{relativeTime(new Date(last.firedAtMs).toISOString())}</span>
                    </>
                  ) : (
                    <span className="text-ink-faint">{t("routines.history.empty")}</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  const detail = (
    <div className="flex h-full min-h-0 flex-col">
      {compact && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line chrome-void px-2 py-1.5">
          <Button size="xs" variant="ghost" onClick={() => pick(null)}>
            ← {t("routines.backAll")}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {effective === null ? (
          <div className="grid flex-1 place-items-center p-6">
            <div className="studio-card max-w-md rounded-xl p-6">
              <Empty title={t("routines.emptyTitle")} hint={t("routines.emptyHint")} />
            </div>
          </div>
        ) : (
          <RoutineEditor
            routine={editing}
            models={models}
            onSaved={(saved) => setSelection({ kind: "routine", id: saved.id })}
            onDeleted={() => pick(null)}
            onOpenSession={closeRoutines}
          />
        )}
      </div>
    </div>
  );

  return (
    <section aria-label={t("routines.title")} data-routines-view className="absolute inset-0 flex flex-col overflow-x-hidden stage-void text-ink">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line chrome-void px-3">
        <Label className="min-w-0 truncate">
          {state === null ? t("routines.title") : t("routines.headerOn", { machine: state.machineLabel })}
        </Label>
        <Chip tone="iris" className="hidden sm:inline-flex">
          {t("routines.experimental")}
        </Chip>
        <span className="flex-1" />
        <IconButton label={t("routines.close")} onClick={closeRoutines}>
          <IconClose />
        </IconButton>
      </header>
      {compact ? (
        <div className="min-h-0 flex-1">{drilled && effective !== null ? detail : list}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 border-r border-line chrome-sunken">{list}</div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
        </div>
      )}
    </section>
  );
}
