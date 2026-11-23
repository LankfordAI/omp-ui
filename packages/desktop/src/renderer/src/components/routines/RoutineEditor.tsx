import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { nextRunAfter } from "@omp-ui/core/scheduled-prompt";
import {
  DEFAULT_ROUTINE_NOTIFICATIONS,
  ROUTINE_CLI_BYPASS_TOOLS,
  ROUTINE_COST_MAX_USD,
  ROUTINE_DEFAULT_ALLOW_BUILTINS,
  ROUTINE_DEFAULT_ALLOW_VAULT_TOOLS,
  ROUTINE_DEFAULT_TIMEOUT_MINUTES,
  ROUTINE_INSTRUCTIONS_MAX,
  ROUTINE_NAME_MAX,
  ROUTINE_SCRIPT_MAX,
  ROUTINE_TIMEOUT_MAX_MINUTES,
  type RoutineCatalogSnapshot,
  type RoutineDryRunResult,
  type RoutineInput,
  type RoutineMode,
  type RoutineNotifications,
  type RoutineRecord,
  type RoutineToolPolicy,
  type RoutineTestScriptResult,
  type RoutineWorkspace,
} from "@omp-ui/core/routine";
import type { CatalogModelOption } from "@omp-ui/core/types";
import type { ArtifactDatasetDefinition, ArtifactRecord } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { thinkingLevelColor } from "../../lib/thinking-colors";
import { findInstance, useStore } from "../../store";
import { ModelPalette } from "../ModelSelector";
import { FIELD } from "../settings/rows";
import { ThinkingSliderControl } from "../ThinkingSlider";
import {
  Button,
  CAPSULE_SEGMENT,
  Chevron,
  Chip,
  ChoiceCapsule,
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
  formatTimeout,
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
  timeoutMinutes: string;
  toolPolicy: RoutineToolPolicy;
  preScript: string;
  postScript: string;
  notifications: RoutineNotifications;
  /** Scheduled refresh (ADR-0101): human-only binding editor state. */
  artifactId: string | null;
  datasetIds: string[];
  autoApply: boolean;
  enabled: boolean;
}

function draftOf(
  routine: RoutineRecord | null,
  defaultProject: string,
  artifactSeed: { artifactId: string; datasetIds: string[]; projectCwd: string | null; title: string } | null = null,
): Draft {
  if (routine === null) {
    return {
      name: artifactSeed ? `Refresh ${artifactSeed.title}`.slice(0, 80) : "",
      instructions: artifactSeed ? `Refresh the selected datasets for "${artifactSeed.title}".` : "",
      schedule: scheduleDraftOf("0 8 * * 1-5"),
      projectCwd: artifactSeed?.projectCwd ?? defaultProject,
      workspace: "worktree",
      mode: "build",
      model: null,
      thinkingLevel: null,
      warnUsd: "",
      maxUsd: "",
      timeoutMinutes: "",
      toolPolicy: {
        allow: [...ROUTINE_DEFAULT_ALLOW_BUILTINS, ...ROUTINE_DEFAULT_ALLOW_VAULT_TOOLS],
        deny: [],
        // Main stamps the review on save; a fixed placeholder keeps the seed stable.
        lastReviewedAt: new Date(0).toISOString(),
        reviewedCatalog: [],
      },
      preScript: "",
      postScript: "",
      notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
      artifactId: artifactSeed?.artifactId ?? null,
      datasetIds: artifactSeed ? [...artifactSeed.datasetIds] : [],
      autoApply: false,
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
    timeoutMinutes: routine.timeoutMinutes === null ? "" : String(routine.timeoutMinutes),
    toolPolicy: routine.toolPolicy,
    // Hydrate both phases: seeding empty here would silently wipe a saved hook
    // on any unrelated edit (#1283).
    preScript: routine.scripts.pre,
    postScript: routine.scripts.post,
    notifications: { ...routine.notifications },
    artifactId: routine.artifact?.artifactId ?? null,
    datasetIds: routine.artifact ? [...routine.artifact.datasetIds] : [],
    autoApply: routine.artifact?.autoApply ?? false,
    enabled: routine.enabled,
  };
}

/** Blank = inherit the host default (null); otherwise a finite USD in range, or NaN for invalid. */
function parseSpend(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= ROUTINE_COST_MAX_USD ? value : Number.NaN;
}

/** Blank = default (null, 30 min); 0 = unlimited; 1..1440 = custom minutes; NaN = invalid. */
function parseTimeout(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= ROUTINE_TIMEOUT_MAX_MINUTES ? value : Number.NaN;
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
  artifactSeed = null,
  models,
  instanceId = null,
  hostLabel = "this computer",
  readOnly = false,
  onSaved,
  onDeleted,
  onOpenSession,
  onBackToSessions,
}: {
  routine: RoutineRecord | null;
  artifactSeed?: { nonce: number; artifactId: string; datasetIds: string[]; projectCwd: string | null; title: string } | null;
  models: readonly CatalogModelOption[];
  instanceId?: string | null;
  hostLabel?: string;
  readOnly?: boolean;
  onSaved: (routine: RoutineRecord) => void;
  onDeleted: () => void;
  onOpenSession: () => void;
  onBackToSessions?: () => void;
}) {
  const isRemote = instanceId !== null;
  const projects = useStore((s) =>
    instanceId === null ? s.state?.projects : findInstance(s.state, instanceId)?.projects,
  );
  const routinesState = useStore((s) =>
    instanceId === null ? s.routinesState : (s.routinesByInstance[instanceId] ?? null),
  );
  const desktopNotifications = useStore((s) => s.state?.desktopNotifications);
  const createRoutine = useStore((s) => s.createRoutine);
  const updateRoutine = useStore((s) => s.updateRoutine);
  const runRoutineNow = useStore((s) => s.runRoutineNow);
  const dryRunRoutine = useStore((s) => s.dryRunRoutine);
  const testRoutineScript = useStore((s) => s.testRoutineScript);
  const loadRoutineToolCatalog = useStore((s) => s.loadRoutineToolCatalog);
  const openSettings = useStore((s) => s.openSettings);
  const hostProjects = projects ?? [];
  // Re-seed when the saved editable fields change (another selection, this
  // routine's own save echo, the list's enable switch) — never on a schedule
  // bookkeeping broadcast (lastRunAtMs, notices), which would wipe an edit.
  const seedProject = artifactSeed?.projectCwd && hostProjects.some((p) => p.project.path === artifactSeed.projectCwd)
    ? artifactSeed.projectCwd
    : (hostProjects[0]?.project.path ?? "");
  const effectiveSeed = routine === null && artifactSeed !== null ? { ...artifactSeed, projectCwd: seedProject } : null;
  const seedKey = JSON.stringify([instanceId, routine?.id ?? null, effectiveSeed?.nonce ?? null, draftOf(routine, hostProjects[0]?.project.path ?? "", effectiveSeed)]);
  const initial = useMemo(() => draftOf(routine, hostProjects[0]?.project.path ?? "", effectiveSeed), [seedKey]);
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
  // Scheduled refresh picker (ADR-0101): managed records from the same list the
  // Artifacts view reads; dataset contracts follow the selected artifact.
  const artifactLibraryEnabled = useStore((s) => s.state?.artifactLibraryEnabled === true);
  const [artifactRows, setArtifactRows] = useState<ArtifactRecord[]>([]);
  const [artifactDatasets, setArtifactDatasets] = useState<ArtifactDatasetDefinition[] | null>(null);
  const [artifactMissing, setArtifactMissing] = useState(false);

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
    if (draft.projectCwd === "" || readOnly) return;
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    loadRoutineToolCatalog(draft.projectCwd, instanceId).then(
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
  }, [draft.projectCwd, instanceId, isNew, readOnly, loadRoutineToolCatalog]);

  // Managed artifacts for the scheduled-refresh picker (ADR-0101). Artifact
  // channels stay host-local: never query local artifacts for a remote host.
  useEffect(() => {
    if (isRemote || !artifactLibraryEnabled) {
      setArtifactRows([]);
      return;
    }
    let cancelled = false;
    backend
      .artifactList({ filter: "managed", limit: 50 })
      .then((page) => {
        if (!cancelled) setArtifactRows(page.artifacts.filter((row) => row.managed));
      })
      .catch(() => {
        if (!cancelled) setArtifactRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isRemote, artifactLibraryEnabled]);

  // Resolve the selected artifact's datasets — and if it sits beyond page 1 of
  // artifactList, inject its record so the picker never falsely marks it missing.
  useEffect(() => {
    if (isRemote || draft.artifactId === null || !artifactLibraryEnabled) {
      setArtifactDatasets(null);
      setArtifactMissing(false);
      return;
    }
    let cancelled = false;
    backend
      .artifactDescribe({ artifactId: draft.artifactId })
      .then((next) => {
        if (cancelled) return;
        setArtifactDatasets(next.code.definition?.datasets ?? []);
        setArtifactMissing(!next.artifact.managed);
        if (next.artifact.managed) {
          setArtifactRows((rows) =>
            rows.some((row) => row.artifactId === next.artifact.artifactId) ? rows : [next.artifact, ...rows],
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        setArtifactDatasets(null);
        setArtifactMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isRemote, draft.artifactId, artifactLibraryEnabled]);

  const timeZone = routine?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const schedule = buildSchedule(draft.schedule);
  const nextRunMs = schedule === null ? null : nextRunAfter(schedule, timeZone, Date.now());
  const warnUsd = parseSpend(draft.warnUsd);
  const maxUsd = parseSpend(draft.maxUsd);
  const timeoutMinutes = parseTimeout(draft.timeoutMinutes);
  const trimmedName = draft.name.trim();
  const problem =
    trimmedName === ""
      ? "Give the routine a name."
      : Array.from(trimmedName).length > ROUTINE_NAME_MAX
        ? `Names are at most ${ROUTINE_NAME_MAX} characters.`
        : draft.instructions.trim() === ""
          ? "Write the instructions the routine sends."
          : draft.instructions.length > ROUTINE_INSTRUCTIONS_MAX
            ? `Instructions are at most ${ROUTINE_INSTRUCTIONS_MAX} characters.`
            : schedule === null
              ? draft.schedule.repeat === "cron"
                ? "Enter a 5-field cron expression or @yearly, @monthly, @weekly, @daily, @hourly."
                : "Enter a valid 24-hour time."
              : draft.projectCwd === ""
                ? "Pick a destination project."
                : Number.isNaN(warnUsd) || Number.isNaN(maxUsd)
                  ? `Spend caps are blank (host default) or 0 to ${ROUTINE_COST_MAX_USD} USD.`
                  : Number.isNaN(timeoutMinutes)
                    ? `Run timeout is blank (30 min default), 0 (unlimited), or a whole number from 1 to ${ROUTINE_TIMEOUT_MAX_MINUTES} minutes.`
                    : draft.preScript.length > ROUTINE_SCRIPT_MAX || draft.postScript.length > ROUTINE_SCRIPT_MAX
                      ? `Each hook is at most ${ROUTINE_SCRIPT_MAX} characters.`
                      : draft.artifactId !== null && draft.datasetIds.length === 0
                        ? "Pick at least one artifact dataset to refresh."
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
          timeoutMinutes,
          notifications: draft.notifications,
          artifact:
            draft.artifactId === null
              ? null
              : { artifactId: draft.artifactId, datasetIds: [...draft.datasetIds], autoApply: draft.autoApply },
          enabled: draft.enabled,
        }
      : null;
  const dirty = routine === null || JSON.stringify(draft) !== JSON.stringify(initial);

  const save = (): void => {
    if (readOnly || input === null || busy !== null) return;
    setBusy("save");
    setSaveError(null);
    const pending =
      routine === null
        ? createRoutine(input, instanceId)
        : updateRoutine(routine.id, input, instanceId);
    pending
      .then(
        (saved) => onSaved(saved),
        (err: unknown) => setSaveError(displayMessage(err)),
      )
      .finally(() => setBusy(null));
  };

  const runNow = (): void => {
    if (readOnly || routine === null || busy !== null) return;
    setBusy("run");
    setActionError(null);
    setSkippedNow(false);
    runRoutineNow(routine.id, instanceId)
      .then((result) => {
        // Pre-hook exit 78 (#1283): a neutral "nothing to do" line, not failure.
        if (result.tabId === "") setSkippedNow(true);
      })
      .catch((err: unknown) => setActionError(displayMessage(err)))
      .finally(() => setBusy(null));
  };

  const testScriptFor = (phase: "pre" | "post"): void => {
    const command = phase === "pre" ? draft.preScript : draft.postScript;
    if (readOnly || busy !== null || draft.projectCwd === "" || command.trim() === "") return;
    setBusy("test");
    setTestResult(null);
    testRoutineScript({ projectCwd: draft.projectCwd, command }, instanceId)
      .then(
        (result) => setTestResult({ phase, result }),
        (err: unknown) => setTestResult({ phase, result: { kind: "failed", timedOut: false, exitCode: null, stdout: "", stderr: displayMessage(err) } }),
      )
      .finally(() => setBusy(null));
  };

  const preview = (): void => {
    if (readOnly || busy !== null) return;
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
    dryRunRoutine(req, instanceId)
      .then(setDryRun, (err: unknown) => setActionError(displayMessage(err)))
      .finally(() => setBusy(null));
  };

  // Catalog-only thinking resolution: never fabricate a fallback ladder.
  const selectedProject = hostProjects.find((g) => g.project.path === draft.projectCwd)?.project ?? null;
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
    const nextProject = hostProjects.find((g) => g.project.path === nextProjectCwd)?.project ?? null;
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
  const effectiveTimeoutMinutes =
    timeoutMinutes !== null && !Number.isNaN(timeoutMinutes) ? timeoutMinutes : ROUTINE_DEFAULT_TIMEOUT_MINUTES;
  const timeoutUnlimited = timeoutMinutes === 0;
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));
  const setSchedule = (patch: Partial<ScheduleDraft>): void =>
    setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }));
  const setNotifications = (patch: Partial<RoutineNotifications>): void =>
    setDraft((d) => ({ ...d, notifications: { ...d.notifications, ...patch } }));

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
  const modelDisplayName = selectedModel?.name ?? draft.model ?? "Project default";
  const defaultHint =
    projectModelSelector !== null
      ? `Uses ${projectModelSelector}`
      : "No pinned model on this project";

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
      {/* Single-row frosted header */}
      <div className="shrink-0 border-b border-line chrome-void backdrop-glass px-4 py-2.5 sm:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          {onBackToSessions !== undefined && (
            <Button size="xs" variant="ghost" onClick={onBackToSessions} className="shrink-0">
              ← Sessions
            </Button>
          )}
          <input
            type="text"
            value={draft.name}
            disabled={readOnly}
            placeholder="Untitled routine"
            aria-label="Name"
            onChange={(e) => set({ name: e.target.value })}
            className="min-w-48 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-display text-lg font-semibold text-ink transition-colors placeholder:text-ink-faint hover:border-line focus:border-line-strong focus:bg-raised/70 focus:outline-none disabled:opacity-60"
          />
          <div
            role="tablist"
            aria-label="Routines"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-sunken/70 p-0.5"
          >
            {(
              [
                { id: "config" as const, label: "Configuration", badge: null },
                {
                  id: "policy" as const,
                  label: "Tool policy",
                  badge:
                    catalog !== null
                      ? `${draft.toolPolicy.allow.length}/${policyStats.total}`
                      : String(draft.toolPolicy.allow.length),
                },
                ...(routine !== null
                  ? [{ id: "history" as const, label: "Run history", badge: String(runs.length) }]
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
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 tab-label transition-colors",
                    selected ? "bg-raised text-ink shadow-xs edge-lit" : "text-ink-mid hover:text-ink",
                  )}
                >
                  <span>{tab.label}</span>
                  {tab.badge !== null && (
                    <span className="rounded bg-sunken/80 px-1.5 py-px font-mono text-[11px] tabular-nums text-ink-faint">
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="mr-1 flex items-center gap-1.5">
              <span className="text-xs text-ink-dim">
                {draft.enabled ? "Enabled" : "Paused"}
              </span>
              <Switch
                on={draft.enabled}
                disabled={readOnly}
                onChange={(enabled) => set({ enabled })}
                label="Enabled"
              />
            </div>
            <Button size="xs" disabled={readOnly || busy !== null} onClick={preview}>
              Dry run
            </Button>
            <Button size="xs" tone="signal" disabled={readOnly || routine === null || busy !== null} onClick={runNow}>
              Run now
            </Button>
            {routine !== null && dirty && !readOnly && (
              <Button size="xs" variant="ghost" onClick={() => setDraft(initial)}>
                Reset changes
              </Button>
            )}
            <Button size="xs" variant="solid" disabled={readOnly || input === null || !dirty || busy !== null} onClick={save}>
              {routine === null ? "Create routine" : "Save routine"}
            </Button>
          </div>
        </div>

        {/* Inline error / validation alerts */}
        {actionError !== null && (
          <p role="alert" data-routine-action-error className="mt-2 px-1.5 text-xs leading-relaxed text-rose">
            {actionError}
          </p>
        )}
        {skippedNow && (
          <p role="status" data-routine-skipped-now className="mt-2 px-1.5 text-xs leading-relaxed text-ink-mid">
            Nothing to do — the pre-run script skipped this fire.
          </p>
        )}
        {validationBanner !== null && (
          <p role="alert" className="mt-1.5 px-1.5 text-xs leading-relaxed text-rose">
            {validationBanner}
          </p>
        )}
      </div>

      {/* Dry run preview sits directly below the hero on any tab */}
      {dryRun !== null && (
        <div className="shrink-0 px-4 pt-3 sm:px-5">
          <DryRunPanel
            result={dryRun}
            projectName={projectName}
            modelLabel={draft.model ?? "Project default"}
            onDismiss={() => setDryRun(null)}
          />
        </div>
      )}

      {/* Tab content */}
      {visibleTab === "config" && (
        <div className="@container min-h-0 flex-1 overflow-y-auto px-4 py-3.5 sm:px-5 @[56rem]:overflow-hidden">
          <div className="flex h-full min-h-0 flex-col gap-3.5 @[56rem]:grid @[56rem]:grid-cols-[minmax(0,1.45fr)_minmax(21rem,0.95fr)]">
            {/* Left column — Instructions card with integrated Flight check footer */}
            <section className="studio-card flex min-h-0 flex-col overflow-hidden rounded-xl">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3.5 pb-2">
                <div>
                  <h4 className="text-sm font-semibold text-ink">Instructions</h4>
                  <p className="mt-0.5 text-xs text-ink-dim">Sent as the first prompt of each fresh session.</p>
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
              <div className="flex min-h-0 flex-1 px-4 pb-3">
                <textarea
                  value={draft.instructions}
                  disabled={readOnly}
                  aria-label="Instructions"
                  onChange={(e) => set({ instructions: e.target.value })}
                  className={cn(
                    FIELD,
                    "min-h-48 h-auto flex-1 w-full resize-y @[56rem]:min-h-0 @[56rem]:resize-none bg-sunken/65 py-2.5 leading-relaxed",
                  )}
                />
              </div>
              {hooksSet && (
                <p
                  role="note"
                  className="border-t border-copper-dim bg-copper-wash px-4 py-2 text-xs leading-relaxed text-copper"
                >
                  {isRemote
                    ? `Run hooks execute on ${hostLabel} as that host's user, outside the tool policy. A post hook running npm/make/repo scripts executes files the just-finished agent may have rewritten.`
                    : "Run hooks execute as you, unattended, outside the tool policy. A post hook running npm/make/repo scripts executes files the just-finished agent may have rewritten."}
                </p>
              )}
              <div
                aria-label="Flight check"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-sunken/45 px-4 py-2.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono tabular-nums text-ink">
                    {catalog !== null
                      ? `${policyStats.allowed} of ${policyStats.total} allowed`
                      : `${draft.toolPolicy.allow.length} allowed`}
                  </span>
                  <div aria-hidden className="flex h-1.5 w-20 overflow-hidden rounded-full bg-raised">
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
                  <Chip tone="copper" title="A shell reaches any service without asking — no tool policy can stop it.">
                    Shell bypass enabled
                  </Chip>
                ) : !hooksSet ? (
                  <Chip tone="signal" title="No shell tool allowed — every non-allowed tool pauses for approval.">
                    Policy enforced
                  </Chip>
                ) : null}

                <span className="inline-flex items-center gap-1 text-ink-mid">
                  <IconLock className="size-3 text-ink-faint" />
                  Private overlay
                </span>
                <span
                  data-flight-timeout
                  title={timeoutUnlimited ? "No wall-clock limit — a stuck run holds the host routine lane until stopped manually or by spend cap." : undefined}
                  className={cn(
                    "inline-flex items-center gap-1 font-mono",
                    timeoutUnlimited ? "text-copper" : "text-ink-mid",
                  )}
                >
                  <IconClock className={cn("size-3", timeoutUnlimited ? "text-copper" : "text-ink-faint")} />
                  {formatTimeout(effectiveTimeoutMinutes)}
                </span>

                <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setActiveTab("policy")}>
                  Review all tools →
                </Button>
              </div>
            </section>

            {/* Right column — Scrollable Configuration stack */}
            <div className="flex min-h-0 flex-col gap-3 @[56rem]:overflow-y-auto @[56rem]:pr-0.5">
              {/* Card 1 — Schedule */}
              <section className="studio-card space-y-2.5 rounded-xl p-3.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label>Schedule</Label>
                  <span className="truncate font-mono text-[11px] text-ink-faint">{timeZone}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ChoiceCapsule<Repeat>
                    label="Schedule"
                    value={draft.schedule.repeat}
                    disabled={readOnly}
                    options={[
                      { value: "daily", label: "Daily" },
                      { value: "weekdays", label: "Weekdays" },
                      { value: "weekly", label: "Weekly" },
                      { value: "cron", label: "Cron" },
                    ]}
                    onChange={(repeat) => setSchedule({ repeat })}
                    optionClassName="tab-label px-2"
                  />
                  {draft.schedule.repeat !== "cron" && (
                    <div className="flex flex-wrap items-center gap-2">
                      {draft.schedule.repeat === "weekly" && (
                        <select
                          value={draft.schedule.weekday}
                          disabled={readOnly}
                          aria-label="Weekday"
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
                        disabled={readOnly}
                        aria-label="Time"
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
                    disabled={readOnly}
                    spellCheck={false}
                    aria-label="Cron expression or @macro"
                    placeholder="30 8 * * 1-5 · @daily"
                    onChange={(e) => setSchedule({ expr: e.target.value })}
                    className={cn(FIELD, "w-full font-mono")}
                  />
                )}
                <p data-next-run className={cn("text-xs", nextRunMs === null ? "text-rose" : "text-ink-dim")}>
                  {schedule === null
                    ? draft.schedule.repeat === "cron"
                      ? "Enter a 5-field cron expression or @yearly, @monthly, @weekly, @daily, @hourly."
                      : "Enter a valid 24-hour time."
                    : nextRunMs === null
                      ? "Never"
                      : `Next run: ${formatWhen(nextRunMs)} (${timeZone})`}
                </p>
              </section>

              {/* Card 2 — Execution & Spend */}
              <section className="studio-card space-y-2.5 rounded-xl p-3.5">
                <Label>{"Schedule & execution"}</Label>
                <div className="flex flex-col">
                  <StudioOptionRow icon={<IconModel />} label="Model">
                    {models.length === 0 ? (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled
                          aria-label="Model"
                          title={draft.model ?? "Project default"}
                          className="max-w-44 truncate font-mono text-xs text-ink-dim"
                        >
                          {draft.model ?? "Project default"}
                        </button>
                        {isRemote ? (
                          <span className="shrink-0 text-xs text-ink-faint">
                            {`Configure providers on ${hostLabel}`}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openSettings("providers")}
                            className="shrink-0 text-xs text-ink-faint underline decoration-dotted hover:text-ink-mid"
                          >
                            provider keys
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={readOnly}
                        aria-label="Model"
                        title={draft.model ?? defaultHint}
                        onClick={() => setModelPickerOpen(true)}
                        className={cn(CAPSULE_SEGMENT, "max-w-52 text-xs font-medium text-ink disabled:opacity-60")}
                      >
                        <span className="min-w-0 truncate">{modelDisplayName}</span>
                        <Chevron open={false} className="rotate-90 text-ink-faint" />
                      </button>
                    )}
                  </StudioOptionRow>

                  <StudioOptionRow
                    icon={<IconThinking />}
                    label="Thinking level"
                    iconStyle={thinkingIconColour !== undefined ? { color: thinkingIconColour } : undefined}
                  >
                    {efforts.length > 0 ? (
                      <>
                        <span
                          className="mr-auto min-w-0 truncate font-mono text-xs transition-colors duration-300 motion-reduce:transition-none"
                          style={thinkingIconColour !== undefined ? { color: thinkingIconColour } : undefined}
                        >
                          {thinkingAuto
                            ? "auto"
                            : (draft.thinkingLevel ?? "Project default")}
                        </span>
                        {draft.thinkingLevel !== null && !readOnly && (
                          <button
                            type="button"
                            onClick={() => set({ thinkingLevel: null })}
                            className="shrink-0 rounded px-1 py-0.5 text-[11px] text-ink-faint hover:bg-hover hover:text-ink"
                          >
                            default
                          </button>
                        )}
                        <span aria-hidden className="shrink-0 text-xs text-ink-dim">
                          auto
                        </span>
                        <Switch
                          on={thinkingAuto}
                          label="auto"
                          disabled={readOnly || busy === "save"}
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
                          ? "Not supported by project default"
                          : "Not supported by model"}
                      </span>
                    ) : draft.thinkingLevel !== null ? (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-xs text-ink-mid">{draft.thinkingLevel}</span>
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() => set({ thinkingLevel: null })}
                            className="shrink-0 rounded px-1 py-0.5 text-[11px] text-ink-faint hover:bg-hover hover:text-ink"
                          >
                            default
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="truncate text-xs text-ink-faint">
                        Follows project default
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
                        disabled={readOnly || busy === "save"}
                        onChange={(level) => set({ thinkingLevel: level })}
                      />
                    </div>
                  )}

                  <StudioOptionRow
                    icon={draft.mode === "plan" ? <IconPlanMode /> : <IconBuildMode />}
                    label="Mode"
                  >
                    <ChoiceCapsule<RoutineMode>
                      label="Mode"
                      value={draft.mode}
                      disabled={readOnly}
                      options={[
                        { value: "build", label: "Build" },
                        { value: "plan", label: "Plan" },
                      ]}
                      onChange={(mode) => set({ mode })}
                      optionClassName="tab-label px-2"
                    />
                  </StudioOptionRow>
                </div>

                <div aria-hidden className="h-px bg-line-soft" />

                <div className="flex flex-col">
                  <StudioOptionRow icon={<IconFleet />} label="Destination project">
                    <select
                      value={draft.projectCwd}
                      disabled={readOnly}
                      aria-label="Destination project"
                      onChange={(e) => handleProjectChange(e.target.value)}
                      className={cn(FIELD, "min-w-0 max-w-44")}
                    >
                      {hostProjects.length === 0 && (
                        <option value="">
                          {isRemote ? `No projects on ${hostLabel}` : "No projects on this machine"}
                        </option>
                      )}
                      {draft.projectCwd !== "" && !hostProjects.some((g) => g.project.path === draft.projectCwd) && (
                        <option value={draft.projectCwd}>{draft.projectCwd}</option>
                      )}
                      {hostProjects.map((g) => (
                        <option key={g.project.path} value={g.project.path}>
                          {g.project.name}
                        </option>
                      ))}
                    </select>
                  </StudioOptionRow>

                  <StudioOptionRow icon={<IconTune />} label="Workspace">
                    <ChoiceCapsule<RoutineWorkspace>
                      label="Workspace"
                      value={draft.workspace}
                      disabled={readOnly}
                      options={[
                        { value: "worktree", label: "New worktree" },
                        { value: "checkout", label: "Project checkout" },
                      ]}
                      onChange={(workspace) => set({ workspace })}
                      optionClassName="tab-label px-2"
                    />
                  </StudioOptionRow>
                </div>

                <div aria-hidden className="h-px bg-line-soft" />

                <div className="space-y-1.5 px-2 py-0.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs text-ink-mid">
                    <span>Spend cap override (USD)</span>
                    <span className="truncate font-mono text-[11px] text-ink-faint">
                      {`${effectiveWarn === 0 ? "no cap" : formatUsd(effectiveWarn)} / ${effectiveMax === 0 ? "no cap" : formatUsd(effectiveMax)}`}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1 text-xs text-ink-faint">
                      Warn at
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        disabled={readOnly}
                        value={draft.warnUsd}
                        placeholder={formatUsd(defaults.warn)}
                        onChange={(e) => set({ warnUsd: e.target.value })}
                        className={cn(FIELD, "w-full")}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-ink-faint">
                      Stop at
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        disabled={readOnly}
                        value={draft.maxUsd}
                        placeholder={formatUsd(defaults.max)}
                        onChange={(e) => set({ maxUsd: e.target.value })}
                        className={cn(FIELD, "w-full")}
                      />
                    </label>
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-faint">
                    Pinned per run through the session overlay. 0 disables the cap.
                  </p>
                </div>

                <div aria-hidden className="h-px bg-line-soft" />

                <div className="space-y-1.5 px-2 py-0.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs text-ink-mid">
                    <span>Run timeout (minutes)</span>
                    <span
                      className={cn(
                        "truncate font-mono text-[11px]",
                        timeoutUnlimited ? "text-copper" : "text-ink-faint",
                      )}
                    >
                      {formatTimeout(effectiveTimeoutMinutes)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ChoiceCapsule<"limited" | "unlimited">
                      label="Run timeout (minutes)"
                      value={timeoutUnlimited ? "unlimited" : "limited"}
                      disabled={readOnly}
                      options={[
                        { value: "limited", label: "Limit" },
                        { value: "unlimited", label: "Unlimited" },
                      ]}
                      onChange={(next) => set({ timeoutMinutes: next === "unlimited" ? "0" : "" })}
                      optionClassName="tab-label px-2"
                    />
                    {!timeoutUnlimited && (
                      <input
                        type="number"
                        min={1}
                        max={ROUTINE_TIMEOUT_MAX_MINUTES}
                        step={1}
                        disabled={readOnly}
                        aria-label="Run timeout (minutes)"
                        value={draft.timeoutMinutes}
                        placeholder={String(ROUTINE_DEFAULT_TIMEOUT_MINUTES)}
                        onChange={(e) => set({ timeoutMinutes: e.target.value })}
                        className={cn(FIELD, "w-28")}
                      />
                    )}
                  </div>
                  <p
                    className={cn(
                      "text-[11px] leading-relaxed",
                      timeoutUnlimited ? "text-copper" : "text-ink-faint",
                    )}
                  >
                    {timeoutUnlimited
                      ? "No wall-clock limit — a stuck run holds the host routine lane until stopped manually or by spend cap."
                      : `Blank uses the ${ROUTINE_DEFAULT_TIMEOUT_MINUTES}-minute default. Counted from fire, including Approval card wait.`}
                  </p>
                </div>
              </section>

              {/* Card 2b — Notifications (#1294) */}
              <section className="studio-card space-y-2.5 rounded-xl p-3.5" data-routine-notifications>
                <div>
                  <h4 className="text-sm font-semibold text-ink">Notifications</h4>
                  <p className="mt-0.5 text-xs text-ink-dim">
                    {isRemote
                      ? `OS desktop banners posted on ${hostLabel} for this routine's runs.`
                      : "OS desktop banners posted on this machine for this routine's runs."}
                  </p>
                </div>
                {!isRemote && desktopNotifications === false && (
                  <div
                    data-routine-notifications-disabled-note
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-copper-dim bg-copper-wash/40 px-2.5 py-2 text-xs text-copper"
                  >
                    <span>Desktop notifications are off in Settings → General.</span>
                    <Button size="xs" variant="ghost" onClick={() => openSettings("general")}>
                      Open Settings
                    </Button>
                  </div>
                )}
                <div className="space-y-2 text-xs text-ink">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.notifications.onStart}
                      disabled={readOnly || busy === "save"}
                      onChange={(e) => setNotifications({ onStart: e.target.checked })}
                      className="accent-[var(--color-signal)]"
                    />
                    <span>When routine starts</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.notifications.onApproval}
                      disabled={readOnly || busy === "save"}
                      onChange={(e) => setNotifications({ onApproval: e.target.checked })}
                      className="accent-[var(--color-signal)]"
                    />
                    <span>When approval is needed</span>
                  </label>
                  <div className="space-y-1.5">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={draft.notifications.onComplete}
                        disabled={readOnly || busy === "save"}
                        onChange={(e) => setNotifications({ onComplete: e.target.checked })}
                        className="accent-[var(--color-signal)]"
                      />
                      <span>When routine completes</span>
                    </label>
                    <div className="space-y-1 pl-6">
                      <label
                        className={cn(
                          "flex items-center gap-2",
                          draft.notifications.onComplete ? "cursor-pointer text-ink" : "cursor-not-allowed text-ink-faint",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={draft.notifications.agentMessage}
                          disabled={readOnly || busy === "save" || !draft.notifications.onComplete}
                          onChange={(e) => setNotifications({ agentMessage: e.target.checked })}
                          className="accent-[var(--color-signal)]"
                        />
                        <span>Let agent write completion message</span>
                      </label>
                      <p className="pl-5 text-[11px] leading-relaxed text-ink-faint">
                        Allows <code className="font-mono">omp-ui_notify</code> without prompting and asks the agent for a brief summary. Falls back to a standard notice if none is sent.
                      </p>
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.notifications.onFail}
                      disabled={readOnly || busy === "save"}
                      onChange={(e) => setNotifications({ onFail: e.target.checked })}
                      className="accent-[var(--color-signal)]"
                    />
                    <span>When routine fails</span>
                  </label>
                </div>
              </section>

              {/* Card 2c — Scheduled artifact refresh (ADR-0101) */}
              {isRemote ? (
                routine?.artifact != null && (
                  <section
                    className="studio-card space-y-1.5 rounded-xl p-3.5"
                    data-routine-artifact-remote-preserved
                  >
                    <h4 className="text-sm font-semibold text-ink">Artifact refresh</h4>
                    <p className="text-xs leading-relaxed text-ink-dim">
                      {`Artifact refresh binding configured on ${hostLabel} — preserved on save.`}
                    </p>
                    <p className="font-mono text-[11px] text-ink-faint">
                      {`${routine.artifact.artifactId} · ${routine.artifact.datasetIds.length} dataset${routine.artifact.datasetIds.length === 1 ? "" : "s"}${routine.artifact.autoApply ? " · auto-apply" : ""}`}
                    </p>
                  </section>
                )
              ) : artifactLibraryEnabled && (
                <section className="studio-card space-y-2.5 rounded-xl p-3.5" data-routine-artifact-refresh>
                  <div>
                    <h4 className="text-sm font-semibold text-ink">Artifact refresh</h4>
                    <p className="mt-0.5 text-xs text-ink-dim">
                      Every fire repeats one kept artifact&apos;s recorded refresh recipes and stages the results for review.
                    </p>
                  </div>
                  <label className="block space-y-1 text-xs text-ink">
                    <span className="text-ink-dim">Artifact</span>
                    <select
                      data-routine-artifact-select
                      className={cn(FIELD, "w-full")}
                      value={draft.artifactId ?? ""}
                      disabled={busy === "save"}
                      onChange={(e) => {
                        const next = e.target.value;
                        set({ artifactId: next === "" ? null : next, datasetIds: [] });
                        setArtifactDatasets(null);
                      }}
                    >
                      <option value="">No scheduled refresh</option>
                      {artifactRows.map((row) => (
                        <option key={row.artifactId} value={row.artifactId}>
                          {row.title}
                        </option>
                      ))}
                      {draft.artifactId !== null && artifactMissing && (
                        <option value={draft.artifactId}>{draft.artifactId} (missing)</option>
                      )}
                    </select>
                  </label>
                  {artifactMissing && (
                    <p data-routine-artifact-missing className="rounded-lg border border-rose-dim bg-rose-wash/40 px-2.5 py-2 text-xs text-rose">
                      The bound artifact no longer exists in the library. Until you fix this, every fire fails with
                      &ldquo;Artifact or datasets unavailable.&rdquo;
                    </p>
                  )}
                  {draft.artifactId !== null && (
                    <>
                      {artifactDatasets === null ? (
                        <p className="text-xs text-ink-faint">Loading datasets&hellip;</p>
                      ) : artifactDatasets.length === 0 ? (
                        <p className="text-xs text-ink-faint">This artifact has no refreshable datasets.</p>
                      ) : (
                        <div className="space-y-1.5" data-routine-artifact-datasets>
                          {artifactDatasets.map((dataset) => (
                            <label key={dataset.id} className="flex cursor-pointer items-center gap-2 text-xs text-ink">
                              <input
                                type="checkbox"
                                checked={draft.datasetIds.includes(dataset.id)}
                                disabled={busy === "save"}
                                onChange={(e) =>
                                  set({
                                    datasetIds: e.target.checked
                                      ? [...draft.datasetIds, dataset.id]
                                      : draft.datasetIds.filter((id) => id !== dataset.id),
                                  })
                                }
                                className="accent-[var(--color-signal)]"
                              />
                              <span>{dataset.title}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <label className="flex cursor-pointer items-start gap-2 text-xs text-ink">
                        <input
                          type="checkbox"
                          data-routine-artifact-autoapply
                          checked={draft.autoApply}
                          disabled={busy === "save"}
                          onChange={(e) => set({ autoApply: e.target.checked })}
                          className="mt-0.5 accent-[var(--color-signal)]"
                        />
                        <span>Apply each scheduled capture without review (the app still refuses if the data changed underneath)</span>
                      </label>
                      <p className="text-[11px] leading-relaxed text-ink-faint">
                        While bound, <code className="font-mono">omp-ui_artifact_capture</code> runs unprompted for this routine; a policy deny of that tool still wins.
                      </p>
                    </>
                  )}
                </section>
              )}

              {/* Card 3 — Run hooks (#1283) */}
              <section className="studio-card space-y-2.5 rounded-xl p-3.5">
                <div>
                  <h4 className="text-sm font-semibold text-ink">Run hooks</h4>
                  <p className="mt-0.5 text-xs text-ink-dim">Optional. The trigger, project, outcome and run directory arrive as OMP_UI_ROUTINE_* environment variables.</p>
                </div>
                {(["pre", "post"] as const).map((phase) => {
                  const value = phase === "pre" ? draft.preScript : draft.postScript;
                  const setPhase = (text: string): void =>
                    set(phase === "pre" ? { preScript: text } : { postScript: text });
                  return (
                    <div key={phase} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Label>{phase === "pre" ? "Run shell before starting" : "Run shell after the run ends"}</Label>
                        <Button
                          size="xs"
                          disabled={readOnly || busy !== null || draft.projectCwd === "" || value.trim() === ""}
                          onClick={() => testScriptFor(phase)}
                        >
                          Test
                        </Button>
                      </div>
                      <textarea
                        value={value}
                        disabled={readOnly}
                        rows={3}
                        spellCheck={false}
                        aria-label={phase === "pre" ? "Run shell before starting" : "Run shell after the run ends"}
                        onChange={(e) => setPhase(e.target.value)}
                        className={cn(FIELD, "h-auto w-full resize-y bg-sunken/65 py-2 font-mono leading-relaxed")}
                      />
                      <p className="text-[11px] leading-relaxed text-ink-faint">
                        {phase === "pre" ? "Runs in the project checkout, before the worktree exists. Tracked edits change your live checkout; untracked files will not appear in a worktree run. A non-zero exit refuses the fire; exit 78 skips it." : "Runs once in the run's working directory after the outcome is decided (60 s cap). It never changes the run's result."}
                      </p>
                      {testResult !== null && testResult.phase === phase && (
                        <pre
                          data-hook-test-output
                          className="max-h-40 overflow-auto rounded-lg border border-line bg-raised px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-mid"
                        >
                          {`exit: ${testResult.result.kind} (${testResult.result.exitCode ?? "—"})`}
                          {testResult.result.stdout !== "" ? `\n${testResult.result.stdout}` : ""}
                          {testResult.result.stderr !== "" ? `\n[stderr]\n${testResult.result.stderr}` : ""}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </section>

              {/* Card 4 — Latest run & Delete */}
              {routine !== null && (
                <section className="studio-card rounded-xl px-3.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label>Latest run</Label>
                      {latestRun !== null ? (
                        <>
                          <Chip tone={OUTCOME_TONE[latestRun.outcome]}>{OUTCOME_LABEL[latestRun.outcome]}</Chip>
                          <span className="tabular-nums text-ink-faint">
                            {relativeTime(new Date(latestRun.firedAtMs).toISOString())}
                          </span>
                        </>
                      ) : (
                        <span className="text-ink-faint">No runs yet.</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {latestRun !== null && (
                        <Button size="xs" variant="ghost" onClick={() => setActiveTab("history")}>
                          View run history
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" tone="rose" disabled={readOnly} onClick={() => setConfirmDelete(true)}>
                        Delete routine
                      </Button>
                    </div>
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      )}

      {visibleTab === "policy" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-5">
          <ToolPolicyEditor
            policy={draft.toolPolicy}
            catalog={catalog}
            catalogError={catalogError}
            reviewed={routine !== null}
            disabled={readOnly || busy === "save"}
            onChange={(toolPolicy) => {
              setPolicyTouched(true);
              set({ toolPolicy });
            }}
          />
        </div>
      )}

      {visibleTab === "history" && routine !== null && (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <section className="studio-card mx-auto max-w-5xl space-y-3 rounded-xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold text-ink">Run history</h4>
                <Chip mono>{runs.length}</Chip>
              </div>
              <p className="text-xs text-ink-faint">Audit entries keep 30 days of outcomes; finished runs self-settle after 60 s.</p>
            </div>
            <RunHistoryList runs={runs} onOpen={onOpenSession} />
          </section>
        </div>
      )}

      {modelPickerOpen && models.length > 0 && (
        <ModelPalette
          variant="routine"
          instanceId={instanceId}
          models={models}
          current={draft.model}
          defaultHint={defaultHint}
          onClose={() => setModelPickerOpen(false)}
          onPick={handleModelPick}
        />
      )}

      {confirmDelete && routine !== null && (
        <DeleteRoutineDialog
          routine={routine}
          instanceId={instanceId}
          onClose={() => setConfirmDelete(false)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}
