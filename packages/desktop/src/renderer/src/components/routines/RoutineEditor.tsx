import { useEffect, useMemo, useState } from "react";
import { nextRunAfter } from "@omp-ui/core/scheduled-prompt";
import {
  ROUTINE_COST_MAX_USD,
  ROUTINE_DEFAULT_ALLOW_BUILTINS,
  ROUTINE_DEFAULT_ALLOW_VAULT_TOOLS,
  ROUTINE_INSTRUCTIONS_MAX,
  ROUTINE_NAME_MAX,
  type RoutineCatalogSnapshot,
  type RoutineDryRunResult,
  type RoutineInput,
  type RoutineMode,
  type RoutineRecord,
  type RoutineToolPolicy,
  type RoutineWorkspace,
} from "@omp-ui/core/routine";
import type { CatalogModelOption } from "@omp-ui/core/types";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { FIELD, Row } from "../settings/rows";
import { Button, ChoiceCapsule, Switch } from "../ui";
import { DeleteRoutineDialog } from "./DeleteRoutineDialog";
import { DryRunPanel } from "./DryRunPanel";
import { RunHistoryList } from "./RunHistoryList";
import { ToolPolicyEditor } from "./ToolPolicyEditor";
import {
  buildSchedule,
  formatUsd,
  formatWhen,
  runsOf,
  scheduleDraftOf,
  weekdayName,
  type Repeat,
  type ScheduleDraft,
} from "./routine-format";

/** omp's thinking ladder, for a model whose catalog row lists no efforts. */
const FALLBACK_EFFORTS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

interface Draft {
  name: string;
  instructions: string;
  schedule: ScheduleDraft;
  projectCwd: string;
  workspace: RoutineWorkspace;
  mode: RoutineMode;
  model: string | null;
  thinkingLevel: string | null;
  warnUsd: string;
  maxUsd: string;
  toolPolicy: RoutineToolPolicy;
  enabled: boolean;
}

function draftOf(routine: RoutineRecord | null, defaultProject: string): Draft {
  if (routine === null) {
    return {
      name: "",
      instructions: "",
      schedule: scheduleDraftOf("0 8 * * 1-5"),
      projectCwd: defaultProject,
      workspace: "worktree",
      mode: "build",
      model: null,
      thinkingLevel: null,
      warnUsd: "",
      maxUsd: "",
      toolPolicy: {
        allow: [...ROUTINE_DEFAULT_ALLOW_BUILTINS, ...ROUTINE_DEFAULT_ALLOW_VAULT_TOOLS],
        deny: [],
        // Main stamps the review on save; a fixed placeholder keeps the seed stable.
        lastReviewedAt: new Date(0).toISOString(),
        reviewedCatalog: [],
      },
      enabled: true,
    };
  }
  return {
    name: routine.name,
    instructions: routine.instructions,
    schedule: scheduleDraftOf(routine.schedule.kind === "cron" ? routine.schedule.expr : ""),
    projectCwd: routine.destination.projectCwd,
    workspace: routine.destination.workspace,
    mode: routine.mode,
    model: routine.model,
    thinkingLevel: routine.thinkingLevel,
    warnUsd: routine.spend.warnUsd === null ? "" : String(routine.spend.warnUsd),
    maxUsd: routine.spend.maxUsd === null ? "" : String(routine.spend.maxUsd),
    toolPolicy: routine.toolPolicy,
    enabled: routine.enabled,
  };
}

/** Blank = inherit the host default (null); otherwise a finite USD in range, or NaN for invalid. */
function parseSpend(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= ROUTINE_COST_MAX_USD ? value : Number.NaN;
}

/**
 * The Routine editor (ADR-0100 §11.1). Edits stay local until Save; Dry run
 * compiles the saved routine, or the current draft when it differs; Run now
 * fires the saved routine and shows main's refusal (busy host lane, gate off)
 * verbatim beside the header. `routine === null` is a new, unsaved routine.
 */
export function RoutineEditor({
  routine,
  models,
  onSaved,
  onDeleted,
  onOpenSession,
}: {
  routine: RoutineRecord | null;
  models: readonly CatalogModelOption[];
  onSaved: (routine: RoutineRecord) => void;
  onDeleted: () => void;
  onOpenSession: () => void;
}) {
  const t = useT();
  const projects = useStore((s) => s.state?.projects);
  const routinesState = useStore((s) => s.routinesState);
  const createRoutine = useStore((s) => s.createRoutine);
  const updateRoutine = useStore((s) => s.updateRoutine);
  const runRoutineNow = useStore((s) => s.runRoutineNow);
  const dryRunRoutine = useStore((s) => s.dryRunRoutine);
  const loadRoutineToolCatalog = useStore((s) => s.loadRoutineToolCatalog);
  const localProjects = projects ?? [];
  // Re-seed when the saved editable fields change (another selection, this
  // routine's own save echo, the list's enable switch) — never on a schedule
  // bookkeeping broadcast (lastRunAtMs, notices), which would wipe an edit.
  const seedKey = JSON.stringify([routine?.id ?? null, draftOf(routine, localProjects[0]?.project.path ?? "")]);
  const initial = useMemo(() => draftOf(routine, localProjects[0]?.project.path ?? ""), [seedKey]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [policyTouched, setPolicyTouched] = useState(false);
  const [catalog, setCatalog] = useState<RoutineCatalogSnapshot | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | "dry" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<RoutineDryRunResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setDraft(initial);
    setPolicyTouched(false);
    setSaveError(null);
    setActionError(null);
    setDryRun(null);
    setConfirmDelete(false);
  }, [initial]);

  // The live catalog of the destination project feeds the checklist.
  const isNew = routine === null;
  useEffect(() => {
    if (draft.projectCwd === "") return;
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    loadRoutineToolCatalog(draft.projectCwd).then(
      (snapshot) => {
        if (cancelled) return;
        setCatalog(snapshot);
        // A new routine's defaults keep only the default tools this project
        // actually offers (no vault configured → no vault rows).
        if (isNew && !policyTouched) {
          const present = new Set(snapshot.tools.map((tool) => tool.key));
          setDraft((d) => ({ ...d, toolPolicy: { ...d.toolPolicy, allow: d.toolPolicy.allow.filter((k) => present.has(k)) } }));
        }
      },
      (err: unknown) => {
        if (!cancelled) setCatalogError(displayMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
    // policyTouched is read at resolve time only; re-fetching on a checkbox would be wrong.
    }, [draft.projectCwd, isNew, loadRoutineToolCatalog]);

  const timeZone = routine?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const schedule = buildSchedule(draft.schedule);
  const nextRunMs = schedule === null ? null : nextRunAfter(schedule, timeZone, Date.now());
  const warnUsd = parseSpend(draft.warnUsd);
  const maxUsd = parseSpend(draft.maxUsd);
  const trimmedName = draft.name.trim();
  const problem =
    trimmedName === ""
      ? t("routines.error.name")
      : Array.from(trimmedName).length > ROUTINE_NAME_MAX
        ? t("routines.error.nameTooLong", { max: ROUTINE_NAME_MAX })
        : draft.instructions.trim() === ""
          ? t("routines.error.instructions")
          : draft.instructions.length > ROUTINE_INSTRUCTIONS_MAX
            ? t("routines.error.instructionsTooLong", { max: ROUTINE_INSTRUCTIONS_MAX })
            : schedule === null
              ? draft.schedule.repeat === "cron"
                ? t("routines.error.cron")
                : t("routines.error.time")
              : draft.projectCwd === ""
                ? t("routines.error.project")
                : Number.isNaN(warnUsd) || Number.isNaN(maxUsd)
                  ? t("routines.error.spend", { max: ROUTINE_COST_MAX_USD })
                  : null;

  const input: RoutineInput | null =
    problem === null && schedule !== null
      ? {
          name: trimmedName,
          instructions: draft.instructions,
          schedule,
          timeZone,
          destination: { projectCwd: draft.projectCwd, workspace: draft.workspace },
          mode: draft.mode,
          model: draft.model,
          thinkingLevel: draft.thinkingLevel,
          spend: { warnUsd, maxUsd },
          toolPolicy: draft.toolPolicy,
          enabled: draft.enabled,
        }
      : null;
  const dirty = routine === null || JSON.stringify(draft) !== JSON.stringify(initial);

  const save = (): void => {
    if (input === null || busy !== null) return;
    setBusy("save");
    setSaveError(null);
    const pending = routine === null ? createRoutine(input) : updateRoutine(routine.id, input);
    pending
      .then(
        (saved) => onSaved(saved),
        (err: unknown) => setSaveError(displayMessage(err)),
      )
      .finally(() => setBusy(null));
  };

  const runNow = (): void => {
    if (routine === null || busy !== null) return;
    setBusy("run");
    setActionError(null);
    runRoutineNow(routine.id)
      .catch((err: unknown) => setActionError(displayMessage(err)))
      .finally(() => setBusy(null));
  };

  const preview = (): void => {
    if (busy !== null) return;
    const req =
      routine !== null && !dirty ? ({ kind: "saved", id: routine.id } as const) : input === null ? null : ({ kind: "draft", input } as const);
    if (req === null) {
      setActionError(problem);
      return;
    }
    setBusy("dry");
    setActionError(null);
    dryRunRoutine(req)
      .then(setDryRun, (err: unknown) => setActionError(displayMessage(err)))
      .finally(() => setBusy(null));
  };

  const selectedModel = models.find((m) => `${m.provider}/${m.id}` === draft.model);
  const efforts = selectedModel?.thinking?.efforts ?? FALLBACK_EFFORTS;
  const projectName = localProjects.find((g) => g.project.path === draft.projectCwd)?.project.name ?? draft.projectCwd;
  const runs = routine === null ? [] : runsOf(routinesState?.runs ?? [], routine.id);
  const defaults = { warn: routinesState?.defaultWarnCostUsd ?? 2, max: routinesState?.defaultMaxCostUsd ?? 5 };
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));
  const setSchedule = (patch: Partial<ScheduleDraft>): void =>
    setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }));

  return (
    <div className="space-y-4" data-routine-editor>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <h3 className="min-w-0 truncate font-display text-base font-semibold text-ink">
          {trimmedName || t("routines.untitled")}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" tone="signal" disabled={routine === null || busy !== null} onClick={runNow}>
            {t("routines.runNow")}
          </Button>
          <Button size="xs" disabled={busy !== null} onClick={preview}>
            {t("routines.dryRun")}
          </Button>
        </div>
        {actionError !== null && (
          <p role="alert" data-routine-action-error className="w-full text-sm leading-relaxed text-rose">
            {actionError}
          </p>
        )}
      </div>

      {dryRun !== null && (
        <DryRunPanel
          result={dryRun}
          projectName={projectName}
          modelLabel={draft.model ?? t("routines.projectDefault")}
          onDismiss={() => setDryRun(null)}
        />
      )}

      <div className="divide-y divide-line-soft">
        <Row title={t("routines.field.name")}>
          <input
            type="text"
            value={draft.name}
            aria-label={t("routines.field.name")}
            onChange={(e) => set({ name: e.target.value })}
            className={cn(FIELD, "w-40 sm:w-64")}
          />
        </Row>
        <Row title={t("routines.field.enabled")} hint={t("routines.field.enabledHint")}>
          <Switch on={draft.enabled} onChange={(enabled) => set({ enabled })} label={t("routines.field.enabled")} />
        </Row>
        <Row title={t("routines.field.instructions")} hint={t("routines.field.instructionsHint")} stacked>
          <textarea
            value={draft.instructions}
            aria-label={t("routines.field.instructions")}
            rows={5}
            onChange={(e) => set({ instructions: e.target.value })}
            className={cn(FIELD, "h-auto w-full resize-y py-1.5 leading-relaxed")}
          />
          <p
            className={cn(
              "mt-1 text-right text-xs tabular-nums",
              draft.instructions.length > ROUTINE_INSTRUCTIONS_MAX ? "text-rose" : "text-ink-faint",
            )}
          >
            {draft.instructions.length.toLocaleString()} / {ROUTINE_INSTRUCTIONS_MAX.toLocaleString()}
          </p>
        </Row>
        <Row title={t("routines.field.schedule")} hint={t("routines.field.scheduleHint")} stacked>
          <div className="space-y-2">
            <ChoiceCapsule<Repeat>
              label={t("routines.field.schedule")}
              value={draft.schedule.repeat}
              options={[
                { value: "daily", label: t("dialog.schedule.daily") },
                { value: "weekdays", label: t("dialog.schedule.weekdays") },
                { value: "weekly", label: t("dialog.schedule.weekly") },
                { value: "cron", label: t("dialog.schedule.cron") },
              ]}
              onChange={(repeat) => setSchedule({ repeat })}
              optionClassName="tab-label px-2"
            />
            {draft.schedule.repeat === "cron" ? (
              <input
                type="text"
                value={draft.schedule.expr}
                spellCheck={false}
                aria-label={t("routines.field.cron")}
                placeholder="30 8 * * 1-5 · @daily"
                onChange={(e) => setSchedule({ expr: e.target.value })}
                className={cn(FIELD, "w-full font-mono")}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {draft.schedule.repeat === "weekly" && (
                  <select
                    value={draft.schedule.weekday}
                    aria-label={t("routines.field.weekday")}
                    onChange={(e) => setSchedule({ weekday: Number(e.target.value) })}
                    className={FIELD}
                  >
                    {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                      <option key={day} value={day}>
                        {weekdayName(day)}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="time"
                  value={draft.schedule.time}
                  aria-label={t("routines.field.time")}
                  onChange={(e) => setSchedule({ time: e.target.value })}
                  className={FIELD}
                />
              </div>
            )}
            <p data-next-run className={cn("text-xs", nextRunMs === null ? "text-rose" : "text-ink-dim")}>
              {schedule === null
                ? draft.schedule.repeat === "cron"
                  ? t("routines.error.cron")
                  : t("routines.error.time")
                : nextRunMs === null
                  ? t("routines.never")
                  : t("routines.nextRun", { when: formatWhen(nextRunMs), zone: timeZone })}
            </p>
          </div>
        </Row>
        <Row title={t("routines.field.project")}>
          <select
            value={draft.projectCwd}
            aria-label={t("routines.field.project")}
            onChange={(e) => set({ projectCwd: e.target.value })}
            className={cn(FIELD, "max-w-[11rem] sm:max-w-64")}
          >
            {localProjects.length === 0 && <option value="">{t("routines.noProjects")}</option>}
            {draft.projectCwd !== "" && !localProjects.some((g) => g.project.path === draft.projectCwd) && (
              <option value={draft.projectCwd}>{draft.projectCwd}</option>
            )}
            {localProjects.map((g) => (
              <option key={g.project.path} value={g.project.path}>
                {g.project.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t("routines.field.workspace")}>
          <ChoiceCapsule<RoutineWorkspace>
            label={t("routines.field.workspace")}
            value={draft.workspace}
            options={[
              { value: "worktree", label: t("settings.webhooks.workspace.worktree") },
              { value: "checkout", label: t("settings.webhooks.workspace.checkout") },
            ]}
            onChange={(workspace) => set({ workspace })}
            optionClassName="tab-label px-2"
          />
        </Row>
        <Row title={t("routines.field.mode")}>
          <ChoiceCapsule<RoutineMode>
            label={t("routines.field.mode")}
            value={draft.mode}
            options={[
              { value: "build", label: t("settings.webhooks.mode.build") },
              { value: "plan", label: t("settings.webhooks.mode.plan") },
            ]}
            onChange={(mode) => set({ mode })}
            optionClassName="tab-label px-2"
          />
        </Row>
        <Row title={t("routines.field.model")}>
          <select
            value={draft.model ?? ""}
            aria-label={t("routines.field.model")}
            onChange={(e) => set({ model: e.target.value === "" ? null : e.target.value })}
            className={cn(FIELD, "max-w-[11rem] sm:max-w-64")}
          >
            <option value="">{t("routines.projectDefault")}</option>
            {draft.model !== null && selectedModel === undefined && <option value={draft.model}>{draft.model}</option>}
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.name} · {m.provider}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t("routines.field.thinking")}>
          <select
            value={draft.thinkingLevel ?? ""}
            aria-label={t("routines.field.thinking")}
            onChange={(e) => set({ thinkingLevel: e.target.value === "" ? null : e.target.value })}
            className={cn(FIELD, "w-36")}
          >
            <option value="">{t("routines.projectDefault")}</option>
            {draft.thinkingLevel !== null && !efforts.includes(draft.thinkingLevel) && (
              <option value={draft.thinkingLevel}>{draft.thinkingLevel}</option>
            )}
            {efforts.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t("routines.field.spend")} hint={t("settings.experimental.routineCostHint")} stacked>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-xs text-ink-mid">
              {t("routines.field.warnUsd")}
              <input
                type="number"
                min={0}
                step="0.01"
                value={draft.warnUsd}
                placeholder={formatUsd(defaults.warn)}
                onChange={(e) => set({ warnUsd: e.target.value })}
                className={cn(FIELD, "w-28")}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-mid">
              {t("routines.field.maxUsd")}
              <input
                type="number"
                min={0}
                step="0.01"
                value={draft.maxUsd}
                placeholder={formatUsd(defaults.max)}
                onChange={(e) => set({ maxUsd: e.target.value })}
                className={cn(FIELD, "w-28")}
              />
            </label>
          </div>
        </Row>
        <Row title={t("routines.field.toolPolicy")} hint={t("routines.field.toolPolicyHint")} stacked>
          <ToolPolicyEditor
            policy={draft.toolPolicy}
            catalog={catalog}
            catalogError={catalogError}
            reviewed={routine !== null}
            disabled={busy === "save"}
            onChange={(toolPolicy) => {
              setPolicyTouched(true);
              set({ toolPolicy });
            }}
          />
        </Row>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {routine !== null && (
          <Button size="xs" variant="ghost" tone="rose" onClick={() => setConfirmDelete(true)}>
            {t("routines.delete.confirm")}
          </Button>
        )}
        {(saveError ?? (dirty ? problem : null)) !== null && (
          <p role="alert" className="min-w-0 flex-1 text-sm leading-relaxed text-rose">
            {saveError ?? problem}
          </p>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {routine !== null && dirty && (
            <Button size="xs" variant="ghost" onClick={() => setDraft(initial)}>
              {t("routines.reset")}
            </Button>
          )}
          <Button size="xs" variant="solid" disabled={input === null || !dirty || busy !== null} onClick={save}>
            {routine === null ? t("routines.create") : t("routines.save")}
          </Button>
        </div>
      </div>

      {routine !== null && (
        <section className="space-y-2 border-t border-line pt-4">
          <h4 className="text-sm font-semibold text-ink">{t("routines.history.title")}</h4>
          <RunHistoryList runs={runs} onOpen={onOpenSession} />
        </section>
      )}

      {confirmDelete && routine !== null && (
        <DeleteRoutineDialog routine={routine} onClose={() => setConfirmDelete(false)} onDeleted={onDeleted} />
      )}
    </div>
  );
}
