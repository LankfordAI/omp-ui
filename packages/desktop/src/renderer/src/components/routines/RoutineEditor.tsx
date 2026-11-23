import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { nextRunAfter } from "@omp-ui/core/scheduled-prompt";
import {
  ROUTINE_CLI_BYPASS_TOOLS,
  ROUTINE_COST_MAX_USD,
  ROUTINE_DEFAULT_ALLOW_BUILTINS,
  ROUTINE_DEFAULT_ALLOW_VAULT_TOOLS,
  ROUTINE_INSTRUCTIONS_MAX,
  ROUTINE_NAME_MAX,
  ROUTINE_SCRIPT_MAX,
  type RoutineCatalogSnapshot,
  type RoutineDryRunResult,
  type RoutineInput,
  type RoutineMode,
  type RoutineRecord,
  type RoutineToolPolicy,
  type RoutineTestScriptResult,
  type RoutineWorkspace,
} from "@omp-ui/core/routine";
import type { CatalogModelOption } from "@omp-ui/core/types";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { thinkingLevelColor } from "../../lib/thinking-colors";
import { useStore } from "../../store";
import { ModelPalette } from "../ModelSelector";
import { FIELD } from "../settings/rows";
import { ThinkingSliderControl } from "../ThinkingSlider";
import {
  Button,
  CAPSULE_SEGMENT,
  Chevron,
  Chip,
  ChoiceCapsule,
  Dot,
  IconBuildMode,
  IconClock,
  IconFleet,
  IconLock,
  IconModel,
  IconPlanMode,
  IconThinking,
  IconTune,
  Label,
  Switch,
} from "../ui";
import { DeleteRoutineDialog } from "./DeleteRoutineDialog";
import { DryRunPanel } from "./DryRunPanel";
import { RunHistoryList } from "./RunHistoryList";
import { ToolPolicyEditor } from "./ToolPolicyEditor";
import {
  OUTCOME_LABEL,
  OUTCOME_TONE,
  buildSchedule,
  describeSchedule,
  formatUsd,
  formatWhen,
  runsOf,
  scheduleDraftOf,
  weekdayName,
  type Repeat,
  type ScheduleDraft,
} from "./routine-format";

type StudioTab = "config" | "policy" | "history";

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
  preScript: string;
  postScript: string;
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
      preScript: "",
      postScript: "",
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
    // Hydrate both phases: seeding empty here would silently wipe a saved hook
    // on any unrelated edit (#1283).
    preScript: routine.scripts.pre,
    postScript: routine.scripts.post,
    enabled: routine.enabled,
  };
}

/** Blank = inherit the host default (null); otherwise a finite USD in range, or NaN for invalid. */
function parseSpend(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= ROUTINE_COST_MAX_USD ? value : Number.NaN;
}

/** Composer-style icon row shared by the execution control surfaces. */
function StudioOptionRow({
  icon,
  label,
  iconStyle,
  children,
}: {
  icon: ReactNode;
  label: string;
  iconStyle?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-xs text-ink">
      <span
        aria-hidden
        className="shrink-0 text-ink-mid transition-colors duration-300 motion-reduce:transition-none"
        style={iconStyle}
      >
        {icon}
      </span>
      <span className="shrink-0 text-ink-mid">{label}</span>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{children}</span>
    </div>
  );
}

/**
 * The Routine Tabbed Studio editor (ADR-0100 §11.1, issue #1278). Edits stay
 * local until Save; Dry run compiles the saved routine or current draft; Run
 * now fires the saved routine and shows main's refusal verbatim in the pinned
 * hero. `routine === null` is a new, unsaved routine.
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
  const testRoutineScript = useStore((s) => s.testRoutineScript);
  const loadRoutineToolCatalog = useStore((s) => s.loadRoutineToolCatalog);
  const openSettings = useStore((s) => s.openSettings);
  const localProjects = projects ?? [];

  // Re-seed when the saved editable fields change (another selection, this
  // routine's own save echo, the list's enable switch) — never on a schedule
  // bookkeeping broadcast (lastRunAtMs, notices), which would wipe an edit.
  const seedKey = JSON.stringify([routine?.id ?? null, draftOf(routine, localProjects[0]?.project.path ?? "")]);
  const initial = useMemo(() => draftOf(routine, localProjects[0]?.project.path ?? ""), [seedKey]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [activeTab, setActiveTab] = useState<StudioTab>("config");
  const [policyTouched, setPolicyTouched] = useState(false);
  const [catalog, setCatalog] = useState<RoutineCatalogSnapshot | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | "dry" | "test" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [skippedNow, setSkippedNow] = useState(false);
  const [testResult, setTestResult] = useState<{ phase: "pre" | "post"; result: RoutineTestScriptResult } | null>(
    null,
  );
  const [dryRun, setDryRun] = useState<RoutineDryRunResult | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const routineId = routine?.id ?? null;
  useEffect(() => {
    setActiveTab("config");
    setModelPickerOpen(false);
  }, [routineId]);

  useEffect(() => {
    setDraft(initial);
    setPolicyTouched(false);
    setSaveError(null);
    setActionError(null);
    setSkippedNow(false);
    setTestResult(null);
    setDryRun(null);
    setConfirmDelete(false);
  }, [initial]);

  // The live catalog of the destination project feeds the tool policy editor.
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
          setDraft((d) => ({
            ...d,
            toolPolicy: { ...d.toolPolicy, allow: d.toolPolicy.allow.filter((k) => present.has(k)) },
          }));
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
                  : draft.preScript.length > ROUTINE_SCRIPT_MAX || draft.postScript.length > ROUTINE_SCRIPT_MAX
                    ? t("routines.hooks.tooLong", { max: ROUTINE_SCRIPT_MAX })
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
          scripts: { pre: draft.preScript, post: draft.postScript },
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
    setSkippedNow(false);
    runRoutineNow(routine.id)
      .then((result) => {
        // Pre-hook exit 78 (#1283): a neutral "nothing to do" line, not failure.
        if (result.tabId === "") setSkippedNow(true);
      })
      .catch((err: unknown) => setActionError(displayMessage(err)))
      .finally(() => setBusy(null));
  };

  const testScriptFor = (phase: "pre" | "post"): void => {
    const command = phase === "pre" ? draft.preScript : draft.postScript;
    if (busy !== null || draft.projectCwd === "" || command.trim() === "") return;
    setBusy("test");
    setTestResult(null);
    testRoutineScript({ projectCwd: draft.projectCwd, command })
      .then(
        (result) => setTestResult({ phase, result }),
        (err: unknown) => setTestResult({ phase, result: { kind: "failed", timedOut: false, exitCode: null, stdout: "", stderr: displayMessage(err) } }),
      )
      .finally(() => setBusy(null));
  };

  const preview = (): void => {
    if (busy !== null) return;
    const req =
      routine !== null && !dirty
        ? ({ kind: "saved", id: routine.id } as const)
        : input === null
          ? null
          : ({ kind: "draft", input } as const);
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

  // Catalog-only thinking resolution: never fabricate a fallback ladder.
  const selectedProject = localProjects.find((g) => g.project.path === draft.projectCwd)?.project ?? null;
  const projectModelSelector = selectedProject?.defaultModel ?? selectedProject?.lastModel ?? null;
  const effectiveModelSelector = draft.model ?? projectModelSelector;
  const selectedModel =
    draft.model === null ? null : (models.find((m) => `${m.provider}/${m.id}` === draft.model) ?? null);
  const effectiveModel =
    effectiveModelSelector === null
      ? null
      : (models.find((m) => `${m.provider}/${m.id}` === effectiveModelSelector) ?? null);
  const efforts: readonly string[] = effectiveModel?.thinking?.efforts ?? [];

  const reconcileThinking = (nextModel: string | null, nextProjectCwd: string, currentThinking: string | null): string | null => {
    const nextProject = localProjects.find((g) => g.project.path === nextProjectCwd)?.project ?? null;
    const nextEffectiveSelector = nextModel ?? nextProject?.defaultModel ?? nextProject?.lastModel ?? null;
    const nextEffectiveModel =
      nextEffectiveSelector === null
        ? null
        : (models.find((m) => `${m.provider}/${m.id}` === nextEffectiveSelector) ?? null);
    const nextEfforts = nextEffectiveModel?.thinking?.efforts ?? [];
    if (nextEfforts.length === 0) return null;
    if (currentThinking !== null && currentThinking !== "auto" && !nextEfforts.includes(currentThinking)) {
      return null;
    }
    return currentThinking;
  };

  const handleModelPick = (nextModel: string | null): void => {
    setModelPickerOpen(false);
    setDraft((d) => ({
      ...d,
      model: nextModel,
      thinkingLevel: reconcileThinking(nextModel, d.projectCwd, d.thinkingLevel),
    }));
  };

  const handleProjectChange = (nextProjectCwd: string): void => {
    setTestResult(null); // a stale tail beside a different project lies (#1283)
    setDraft((d) => ({
      ...d,
      projectCwd: nextProjectCwd,
      thinkingLevel: reconcileThinking(d.model, nextProjectCwd, d.thinkingLevel),
    }));
  };

  // Same for an edited command: clear the tail whenever the tested text changes.
  useEffect(() => {
    setTestResult(null);
  }, [draft.preScript, draft.postScript]);

  const projectName = selectedProject?.name ?? draft.projectCwd;
  const runs = routine === null ? [] : runsOf(routinesState?.runs ?? [], routine.id);
  const latestRun = runs[0] ?? null;
  const defaults = { warn: routinesState?.defaultWarnCostUsd ?? 2, max: routinesState?.defaultMaxCostUsd ?? 5 };
  const effectiveWarn = warnUsd !== null && !Number.isNaN(warnUsd) ? warnUsd : defaults.warn;
  const effectiveMax = maxUsd !== null && !Number.isNaN(maxUsd) ? maxUsd : defaults.max;
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));
  const setSchedule = (patch: Partial<ScheduleDraft>): void =>
    setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }));

  // Policy metrics for tab badge and Flight check distribution bar.
  const policyStats = useMemo(() => {
    const keys = new Set((catalog?.tools ?? []).map((tool) => tool.key));
    for (const key of draft.toolPolicy.allow) keys.add(key);
    for (const key of draft.toolPolicy.deny) keys.add(key);
    const allowSet = new Set(draft.toolPolicy.allow);
    const denySet = new Set(draft.toolPolicy.deny);
    let allowed = 0;
    let denied = 0;
    for (const key of keys) {
      if (allowSet.has(key)) allowed += 1;
      else if (denySet.has(key)) denied += 1;
    }
    return { total: keys.size, allowed, denied, ask: Math.max(0, keys.size - allowed - denied) };
  }, [catalog, draft.toolPolicy.allow, draft.toolPolicy.deny]);

  const cliBypass = draft.toolPolicy.allow.some((key) => ROUTINE_CLI_BYPASS_TOOLS.has(key));
  const hooksSet = draft.preScript.trim() !== "" || draft.postScript.trim() !== "";
  const modelDisplayName = selectedModel?.name ?? draft.model ?? t("routines.projectDefault");
  const defaultHint =
    projectModelSelector !== null
      ? t("routines.model.defaultPinned", { model: projectModelSelector })
      : t("routines.model.defaultUnpinned");

  const thinkingAuto = draft.thinkingLevel === "auto";
  const thinkingPreviewIndex = Math.max(0, efforts.length - 2);
  const thinkingActiveIndex = thinkingAuto
    ? thinkingPreviewIndex
    : draft.thinkingLevel === null
      ? -1
      : efforts.indexOf(draft.thinkingLevel);
  const thinkingIconColour =
    efforts.length > 0 && thinkingActiveIndex >= 0
      ? thinkingLevelColor(thinkingActiveIndex, efforts.length)
      : undefined;

  const validationBanner = saveError ?? (dirty ? problem : null);
  const visibleTab: StudioTab = routine === null && activeTab === "history" ? "config" : activeTab;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-routine-editor>
      {/* Pinned hero */}
      <div className="shrink-0 border-b border-line chrome-void px-4 pt-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={draft.name}
            placeholder={t("routines.untitled")}
            aria-label={t("routines.field.name")}
            onChange={(e) => set({ name: e.target.value })}
            className="min-w-44 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-display text-lg font-semibold text-ink transition-colors placeholder:text-ink-faint hover:border-line focus:border-line-strong focus:bg-raised/70 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="mr-1 flex items-center gap-1.5">
              <span className="text-xs text-ink-dim">
                {draft.enabled ? t("routines.field.enabled") : t("routines.paused")}
              </span>
              <Switch
                on={draft.enabled}
                onChange={(enabled) => set({ enabled })}
                label={t("routines.field.enabled")}
              />
            </div>
            <Button size="xs" disabled={busy !== null} onClick={preview}>
              {t("routines.dryRun")}
            </Button>
            <Button size="xs" tone="signal" disabled={routine === null || busy !== null} onClick={runNow}>
              {t("routines.runNow")}
            </Button>
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

        {/* Summary chips */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1.5">
          <Chip tone={draft.enabled ? "signal" : "neutral"}>
            <Dot tone={draft.enabled ? "signal" : "neutral"} />
            {draft.enabled ? t("routines.studio.armed") : t("routines.paused")}
          </Chip>
          {schedule !== null && <Chip>{describeSchedule(schedule)}</Chip>}
          {projectName !== "" && (
            <Chip>
              {projectName} · {draft.workspace}
            </Chip>
          )}
          <Chip>{modelDisplayName}</Chip>
          {draft.thinkingLevel !== null && (
            <Chip tone="iris" mono>
              {draft.thinkingLevel}
            </Chip>
          )}
        </div>

        {/* Inline error / validation alerts */}
        {actionError !== null && (
          <p role="alert" data-routine-action-error className="mt-2 px-1.5 text-xs leading-relaxed text-rose">
            {actionError}
          </p>
        )}
        {skippedNow && (
          <p role="status" data-routine-skipped-now className="mt-2 px-1.5 text-xs leading-relaxed text-ink-mid">
            {t("routines.run.skippedNow")}
          </p>
        )}
        {validationBanner !== null && (
          <p role="alert" className="mt-1.5 px-1.5 text-xs leading-relaxed text-rose">
            {validationBanner}
          </p>
        )}

        {/* Tab bar */}
        <div role="tablist" aria-label={t("routines.title")} className="mt-3 flex items-center gap-1">
          {(
            [
              { id: "config" as const, label: t("routines.tab.config"), badge: null },
              {
                id: "policy" as const,
                label: t("routines.tab.policy"),
                badge:
                  catalog !== null
                    ? `${draft.toolPolicy.allow.length}/${policyStats.total}`
                    : String(draft.toolPolicy.allow.length),
              },
              ...(routine !== null
                ? [{ id: "history" as const, label: t("routines.tab.history"), badge: String(runs.length) }]
                : []),
            ] as const
          ).map((tab) => {
            const selected = visibleTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-routine-tab={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "relative -mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 tab-label transition-colors",
                  selected
                    ? "border-signal text-ink"
                    : "border-transparent text-ink-mid hover:border-line-strong hover:text-ink",
                )}
              >
                <span>{tab.label}</span>
                {tab.badge !== null && (
                  <span className="rounded bg-raised px-1.5 py-px font-mono text-[11px] tabular-nums text-ink-faint">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Dry run preview sits directly below the hero on any tab */}
      {dryRun !== null && (
        <div className="shrink-0 px-4 pt-3 sm:px-5">
          <div className="mx-auto max-w-6xl">
            <DryRunPanel
              result={dryRun}
              projectName={projectName}
              modelLabel={draft.model ?? t("routines.projectDefault")}
              onDismiss={() => setDryRun(null)}
            />
          </div>
        </div>
      )}

      {/* Tab content */}
      {visibleTab === "config" && (
        <div className="@container min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="mx-auto flex max-w-6xl flex-col gap-4 @[48rem]:flex-row @[48rem]:items-start">
            {/* Main column */}
            <div className="min-w-0 flex-1 space-y-4">
              {/* Instructions card */}
              <section className="studio-card rounded-xl p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-ink">{t("routines.field.instructions")}</h4>
                    <p className="mt-0.5 text-xs text-ink-dim">{t("routines.field.instructionsHint")}</p>
                  </div>
                  <span
                    className={cn(
                      "font-mono text-xs tabular-nums",
                      draft.instructions.length > ROUTINE_INSTRUCTIONS_MAX ? "text-rose" : "text-ink-faint",
                    )}
                  >
                    {draft.instructions.length.toLocaleString()} / {ROUTINE_INSTRUCTIONS_MAX.toLocaleString()}
                  </span>
                </div>
                <textarea
                  value={draft.instructions}
                  aria-label={t("routines.field.instructions")}
                  rows={6}
                  onChange={(e) => set({ instructions: e.target.value })}
                  className={cn(FIELD, "mt-3 h-auto w-full resize-y py-2 leading-relaxed")}
                />
              </section>

              {/* Schedule & execution card */}
              <section className="@container studio-card space-y-4 rounded-xl p-4">
                <div>
                  <h4 className="text-sm font-semibold text-ink">{t("routines.studio.execution")}</h4>
                  <p className="mt-0.5 text-xs text-ink-dim">{t("routines.field.scheduleHint")}</p>
                </div>

                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
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
                    {draft.schedule.repeat !== "cron" && (
                      <div className="flex flex-wrap items-center gap-2">
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
                  </div>
                  {draft.schedule.repeat === "cron" && (
                    <input
                      type="text"
                      value={draft.schedule.expr}
                      spellCheck={false}
                      aria-label={t("routines.field.cron")}
                      placeholder="30 8 * * 1-5 · @daily"
                      onChange={(e) => setSchedule({ expr: e.target.value })}
                      className={cn(FIELD, "w-full font-mono")}
                    />
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

                <div aria-hidden className="h-px bg-line-soft" />

                <div className="grid grid-cols-1 gap-3 @[42rem]:grid-cols-2">
                  {/* Model / Thinking / Mode composer-style surface */}
                  <div className="flex flex-col rounded-lg border border-line bg-raised/70 p-2">
                    <StudioOptionRow icon={<IconModel />} label={t("routines.field.model")}>
                      {models.length === 0 ? (
                        <div className="flex min-w-0 items-center gap-1.5">
                          <button
                            type="button"
                            disabled
                            aria-label={t("routines.field.model")}
                            title={draft.model ?? t("routines.projectDefault")}
                            className="max-w-44 truncate font-mono text-xs text-ink-dim"
                          >
                            {draft.model ?? t("routines.projectDefault")}
                          </button>
                          <button
                            type="button"
                            onClick={() => openSettings("providers")}
                            className="shrink-0 text-xs text-ink-faint underline decoration-dotted hover:text-ink-mid"
                          >
                            {t("composer.model.providerKeys")}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          aria-label={t("routines.field.model")}
                          title={draft.model ?? defaultHint}
                          onClick={() => setModelPickerOpen(true)}
                          className={cn(CAPSULE_SEGMENT, "max-w-52 text-xs font-medium text-ink")}
                        >
                          <span className="min-w-0 truncate">{modelDisplayName}</span>
                          <Chevron open={false} className="rotate-90 text-ink-faint" />
                        </button>
                      )}
                    </StudioOptionRow>

                    <StudioOptionRow
                      icon={<IconThinking />}
                      label={t("routines.field.thinking")}
                      iconStyle={thinkingIconColour !== undefined ? { color: thinkingIconColour } : undefined}
                    >
                      {efforts.length > 0 ? (
                        <>
                          <span
                            className="mr-auto min-w-0 truncate font-mono text-xs transition-colors duration-300 motion-reduce:transition-none"
                            style={thinkingIconColour !== undefined ? { color: thinkingIconColour } : undefined}
                          >
                            {thinkingAuto
                              ? t("composer.thinking.auto")
                              : (draft.thinkingLevel ?? t("routines.projectDefault"))}
                          </span>
                          {draft.thinkingLevel !== null && (
                            <button
                              type="button"
                              onClick={() => set({ thinkingLevel: null })}
                              className="shrink-0 rounded px-1 py-0.5 text-[11px] text-ink-faint hover:bg-hover hover:text-ink"
                            >
                              {t("routines.thinking.useDefault")}
                            </button>
                          )}
                          <span aria-hidden className="shrink-0 text-xs text-ink-dim">
                            {t("composer.thinking.auto")}
                          </span>
                          <Switch
                            on={thinkingAuto}
                            label={t("composer.thinking.auto")}
                            disabled={busy === "save"}
                            onChange={(next) =>
                              set({
                                thinkingLevel: next ? "auto" : efforts[Math.max(0, efforts.length - 2)]!,
                              })
                            }
                          />
                        </>
                      ) : effectiveModel !== null ? (
                        <span className="truncate text-xs text-ink-faint">
                          {draft.model === null
                            ? t("routines.thinking.notSupportedDefault")
                            : t("routines.thinking.notSupported")}
                        </span>
                      ) : draft.thinkingLevel !== null ? (
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-mono text-xs text-ink-mid">{draft.thinkingLevel}</span>
                          <button
                            type="button"
                            onClick={() => set({ thinkingLevel: null })}
                            className="shrink-0 rounded px-1 py-0.5 text-[11px] text-ink-faint hover:bg-hover hover:text-ink"
                          >
                            {t("routines.thinking.useDefault")}
                          </button>
                        </div>
                      ) : (
                        <span className="truncate text-xs text-ink-faint">
                          {t("routines.thinking.followsProjectDefault")}
                        </span>
                      )}
                    </StudioOptionRow>

                    {efforts.length > 0 && (
                      <div className="pb-1.5 pr-2 pl-[30px]">
                        <ThinkingSliderControl
                          efforts={efforts}
                          value={thinkingAuto ? null : draft.thinkingLevel}
                          auto={thinkingAuto}
                          autoPreviewIndex={thinkingPreviewIndex}
                          disabled={busy === "save"}
                          onChange={(level) => set({ thinkingLevel: level })}
                        />
                      </div>
                    )}

                    <div aria-hidden className="mx-1.5 my-1.5 h-px bg-line-soft" />

                    <StudioOptionRow
                      icon={draft.mode === "plan" ? <IconPlanMode /> : <IconBuildMode />}
                      label={t("routines.field.mode")}
                    >
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
                    </StudioOptionRow>
                  </div>

                  {/* Project / Workspace / Spend surface */}
                  <div className="flex flex-col rounded-lg border border-line bg-raised/70 p-2">
                    <StudioOptionRow icon={<IconFleet />} label={t("routines.field.project")}>
                      <select
                        value={draft.projectCwd}
                        aria-label={t("routines.field.project")}
                        onChange={(e) => handleProjectChange(e.target.value)}
                        className={cn(FIELD, "min-w-0 max-w-44")}
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
                    </StudioOptionRow>

                    <StudioOptionRow icon={<IconTune />} label={t("routines.field.workspace")}>
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
                    </StudioOptionRow>

                    <div aria-hidden className="mx-1.5 my-1.5 h-px bg-line-soft" />

                    <div className="space-y-1.5 px-2 py-1">
                      <div className="flex items-center justify-between gap-2 text-xs text-ink-mid">
                        <span>{t("routines.field.spend")}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1 text-xs text-ink-faint">
                          {t("routines.field.warnUsd")}
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={draft.warnUsd}
                            placeholder={formatUsd(defaults.warn)}
                            onChange={(e) => set({ warnUsd: e.target.value })}
                            className={cn(FIELD, "w-full")}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-ink-faint">
                          {t("routines.field.maxUsd")}
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={draft.maxUsd}
                            placeholder={formatUsd(defaults.max)}
                            onChange={(e) => set({ maxUsd: e.target.value })}
                            className={cn(FIELD, "w-full")}
                          />
                        </label>
                      </div>
                      <p className="text-[11px] leading-relaxed text-ink-faint">
                        {t("settings.experimental.routineCostHint")}
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              {/* Run hooks card (#1283) */}
              <section className="studio-card space-y-3 rounded-xl p-4">
                <div>
                  <h4 className="text-sm font-semibold text-ink">{t("routines.hooks.title")}</h4>
                  <p className="mt-0.5 text-xs text-ink-dim">{t("routines.hooks.skipHint")}</p>
                </div>
                {(["pre", "post"] as const).map((phase) => {
                  const value = phase === "pre" ? draft.preScript : draft.postScript;
                  const setPhase = (text: string): void =>
                    set(phase === "pre" ? { preScript: text } : { postScript: text });
                  return (
                    <div key={phase} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Label>{phase === "pre" ? t("routines.hooks.preLabel") : t("routines.hooks.postLabel")}</Label>
                        <Button
                          size="xs"
                          disabled={
                            busy !== null || draft.projectCwd === "" || value.trim() === ""
                          }
                          onClick={() => testScriptFor(phase)}
                        >
                          {t("routines.hooks.testButton")}
                        </Button>
                      </div>
                      <textarea
                        value={value}
                        rows={3}
                        spellCheck={false}
                        aria-label={phase === "pre" ? t("routines.hooks.preLabel") : t("routines.hooks.postLabel")}
                        onChange={(e) => setPhase(e.target.value)}
                        className={cn(FIELD, "h-auto w-full resize-y py-2 font-mono leading-relaxed")}
                      />
                      <p className="text-[11px] leading-relaxed text-ink-faint">
                        {phase === "pre" ? t("routines.hooks.preNote") : t("routines.hooks.postNote")}
                      </p>
                      {testResult !== null && testResult.phase === phase && (
                        <pre
                          data-hook-test-output
                          className="max-h-40 overflow-auto rounded-lg border border-line bg-raised px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-mid"
                        >
                          {t("routines.hooks.testResult", {
                            kind: testResult.result.kind,
                            code: testResult.result.exitCode ?? "—",
                          })}
                          {testResult.result.stdout !== "" ? `\n${testResult.result.stdout}` : ""}
                          {testResult.result.stderr !== "" ? `\n[stderr]\n${testResult.result.stderr}` : ""}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </section>

              {/* Narrow-viewport delete footer */}
              {routine !== null && (
                <div className="flex items-center justify-end pt-1 @[48rem]:hidden">
                  <Button size="xs" variant="ghost" tone="rose" onClick={() => setConfirmDelete(true)}>
                    {t("routines.delete.confirm")}
                  </Button>
                </div>
              )}
            </div>

            {/* Right Flight check rail (>=46rem) */}
            <aside
              aria-label={t("routines.studio.flightCheck")}
              className="hidden w-64 shrink-0 flex-col gap-3 @[48rem]:flex"
            >
              <div className="studio-card space-y-3 rounded-xl p-3.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <Label>{t("routines.studio.flightCheck")}</Label>
                  <Chip tone={draft.enabled ? "signal" : "neutral"}>
                    {draft.enabled ? t("routines.studio.armed") : t("routines.paused")}
                  </Chip>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ink-mid">{t("routines.field.toolPolicy")}</span>
                    <span className="font-mono tabular-nums text-ink">
                      {catalog !== null
                        ? t("routines.studio.policyRatio", {
                            allow: policyStats.allowed,
                            total: policyStats.total,
                          })
                        : t("routines.studio.policyCountOnly", { allow: draft.toolPolicy.allow.length })}
                    </span>
                  </div>
                  <div
                    aria-hidden
                    className="flex h-1.5 overflow-hidden rounded-full bg-raised"
                  >
                    {policyStats.total > 0 && (
                      <>
                        <span
                          className="bg-signal"
                          style={{ width: `${(policyStats.allowed / policyStats.total) * 100}%` }}
                        />
                        <span
                          className="bg-ink-faint/35"
                          style={{ width: `${(policyStats.ask / policyStats.total) * 100}%` }}
                        />
                        <span
                          className="bg-rose"
                          style={{ width: `${(policyStats.denied / policyStats.total) * 100}%` }}
                        />
                      </>
                    )}
                  </div>
                </div>

                {cliBypass ? (
                  <p
                    role="note"
                    className="rounded-lg border border-copper-dim bg-copper-wash px-2.5 py-2 leading-relaxed text-copper"
                  >
                    {t("routines.policy.cliBypassWarning")}
                  </p>
                ) : null}
                {hooksSet ? (
                  <p
                    role="note"
                    className="rounded-lg border border-copper-dim bg-copper-wash px-2.5 py-2 leading-relaxed text-copper"
                  >
                    {t("routines.hooks.warning")}
                  </p>
                ) : null}
                {!cliBypass && !hooksSet ? (
                  <p className="rounded-lg border border-signal-dim/60 bg-signal-wash/50 px-2.5 py-2 leading-relaxed text-signal">
                    {t("routines.studio.policySafe")}
                  </p>
                ) : null}

                <dl className="space-y-1.5 border-t border-line-soft pt-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-faint">{t("routines.field.model")}</dt>
                    <dd className="min-w-0 truncate font-medium text-ink">{modelDisplayName}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-faint">{t("routines.field.thinking")}</dt>
                    <dd className="min-w-0 truncate font-mono text-ink-mid">
                      {draft.thinkingLevel ?? t("routines.projectDefault")}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="inline-flex items-center gap-1 text-ink-faint">
                      <IconLock className="size-3" />
                      {t("routines.studio.privacy")}
                    </dt>
                    <dd className="text-ink-mid">{t("routines.studio.privateOverlay")}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="inline-flex items-center gap-1 text-ink-faint">
                      <IconClock className="size-3" />
                      {t("routines.studio.wallClock")}
                    </dt>
                    <dd className="font-mono text-ink-mid">{t("routines.studio.wallClockLimit")}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="shrink-0 text-ink-faint">{t("routines.studio.spendCap")}</dt>
                    <dd className="min-w-0 truncate text-right font-mono text-ink-mid">
                      {t("routines.studio.spendSummary", {
                        warn: effectiveWarn === 0 ? t("routines.noCap") : formatUsd(effectiveWarn),
                        max: effectiveMax === 0 ? t("routines.noCap") : formatUsd(effectiveMax),
                      })}
                    </dd>
                  </div>
                </dl>

                <Button
                  size="xs"
                  className="w-full justify-center"
                  onClick={() => setActiveTab("policy")}
                >
                  {t("routines.studio.reviewAllTools")}
                </Button>
              </div>

              {routine !== null && (
                <div className="studio-card space-y-2.5 rounded-xl p-3.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <Label>{t("routines.studio.latestRun")}</Label>
                    {latestRun !== null && (
                      <span className="tabular-nums text-ink-faint">
                        {relativeTime(new Date(latestRun.firedAtMs).toISOString())}
                      </span>
                    )}
                  </div>
                  {latestRun !== null ? (
                    <div className="flex items-center justify-between gap-2">
                      <Chip tone={OUTCOME_TONE[latestRun.outcome]}>{t(OUTCOME_LABEL[latestRun.outcome])}</Chip>
                      <Button size="xs" variant="ghost" onClick={() => setActiveTab("history")}>
                        {t("routines.studio.viewHistory")}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-ink-faint">{t("routines.history.empty")}</p>
                  )}
                  <div className="border-t border-line-soft pt-2.5">
                    <Button
                      size="xs"
                      variant="ghost"
                      tone="rose"
                      className="w-full justify-center"
                      onClick={() => setConfirmDelete(true)}
                    >
                      {t("routines.delete.confirm")}
                    </Button>
                  </div>
                </div>
              )}
            </aside>
          </div>
        </div>
      )}

      {visibleTab === "policy" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-5">
          <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
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
          </div>
        </div>
      )}

      {visibleTab === "history" && routine !== null && (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <section className="studio-card mx-auto max-w-4xl space-y-3 rounded-xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold text-ink">{t("routines.history.title")}</h4>
                <Chip mono>{runs.length}</Chip>
              </div>
              <p className="text-xs text-ink-faint">{t("routines.studio.historyRetention")}</p>
            </div>
            <RunHistoryList runs={runs} onOpen={onOpenSession} />
          </section>
        </div>
      )}

      {modelPickerOpen && models.length > 0 && (
        <ModelPalette
          variant="routine"
          instanceId={null}
          models={models}
          current={draft.model}
          defaultHint={defaultHint}
          onClose={() => setModelPickerOpen(false)}
          onPick={handleModelPick}
        />
      )}

      {confirmDelete && routine !== null && (
        <DeleteRoutineDialog routine={routine} onClose={() => setConfirmDelete(false)} onDeleted={onDeleted} />
      )}
    </div>
  );
}
