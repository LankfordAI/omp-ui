import { useEffect, useMemo, useState } from "react";
import { composeWorktreeBranch } from "@omp-ui/core/worktree-branch";
import { useT } from "../lib/i18n";
import type { ModelInfo } from "../lib/rpc-types";
import { projectKey } from "../lib/project-key";
import { experimentSlug } from "../lib/experiment-kickoff";
import type { NewExperimentSpec } from "../store/types";
import { findInstance, useStore } from "../store";
import { ModelPalette } from "./ModelSelector";
import { Button, ChoiceCapsule, ConfirmDialog } from "./ui";
import { mintBranchName } from "./WorktreeBranchFields";

/** What omp's `METRIC name=value` line accepts as a name. */
const METRIC_NAME_RE = /^[A-Za-z0-9_.-]+$/;
/** omp's own cap on published goal text; the composer input stops there too. */
const GOAL_CHAR_LIMIT = 4096;

const FIELD =
  "mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong";
const LABEL = "block text-[10px] text-ink-faint";
const HINT = "mt-1.5 text-[10px] leading-snug text-ink-faint";

/** One-per-line textarea → trimmed, non-empty entries. */
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Stable empty list so the palette does not resubscribe on every store tick. */
const EMPTY_MODELS: ModelInfo[] = [];

/**
 * The New experiment dialog (issue #559, CONTEXT.md "New experiment"): what to
 * optimize, how it is measured, and where it runs. Submit spawns a worktree
 * rpc-ui session on a minted `autoresearch/<slug>/<hash>` branch, arms omp's
 * `/autoresearch`, and sends one kickoff prompt — omp's own init_experiment
 * then records the row the Lab reads. The "where" segment is the overview
 * channel's preflight: a git checkout mints a branch, a plain directory runs
 * at the project checkout with omp's isolation off, and a jj-only workspace
 * cannot launch at all (omp's loop needs git).
 */
export function NewExperimentDialog({
  projectCwd,
  instanceId,
}: {
  projectCwd: string;
  /** The remote instance owning the project (issue #416); null for this host. */
  instanceId: string | null;
}) {
  const t = useT();
  const [goal, setGoal] = useState("");
  const [metric, setMetric] = useState("");
  const [unit, setUnit] = useState("");
  const [direction, setDirection] = useState<NewExperimentSpec["direction"]>("lower");
  const [command, setCommand] = useState("");
  const [scopePaths, setScopePaths] = useState("");
  const [offLimits, setOffLimits] = useState("");
  const [constraints, setConstraints] = useState("");
  const [maxIterations, setMaxIterations] = useState("");
  // The mint tail is drawn once per dialog; the slug follows the goal until
  // the user edits the branch, after which the typed name stands.
  const [hash] = useState(() => mintBranchName("autoresearch").slice("autoresearch/".length));
  const [branchDraft, setBranchDraft] = useState<string | null>(null);
  const [pickingModel, setPickingModel] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = projectKey(instanceId, projectCwd);
  const repo = useStore((s) => s.experiments[key]?.result?.repo);
  const loadExperiments = useStore((s) => s.loadExperiments);
  const newExperiment = useStore((s) => s.newExperiment);
  const closeExperimentDialog = useStore((s) => s.closeExperimentDialog);
  const state = useStore((s) => s.state);
  const rpc = useStore((s) => s.rpc);

  // Preflight: the overview answer names the repository kind.
  useEffect(() => {
    void loadExperiments(projectCwd, instanceId);
  }, [projectCwd, instanceId, loadExperiments]);

  const group = useMemo(() => {
    const groups = instanceId === null ? state?.projects : findInstance(state, instanceId)?.projects;
    return groups?.find((g) => g.project.path === projectCwd) ?? null;
  }, [state, instanceId, projectCwd]);

  // A live session's catalog is all the model list that exists (the
  // ProjectSettings idiom); the first non-empty one wins.
  const models = useMemo(() => {
    for (const session of group?.sessions ?? []) {
      if (session.live !== "live") continue;
      const list = rpc[session.tabId]?.availableModels;
      if (list !== undefined && list.length > 0) return list;
    }
    return EMPTY_MODELS;
  }, [group, rpc]);

  // Pinned model first, else the project's last-used one; null lets omp's
  // own default stand when neither resolves against the catalog.
  const [model, setModel] = useState<ModelInfo | null | undefined>(undefined);
  const defaultModel = useMemo(() => {
    const selector = group?.project.defaultModel ?? group?.project.lastModel ?? null;
    return selector === null ? null : (models.find((m) => `${m.provider}/${m.id}` === selector) ?? null);
  }, [group, models]);
  const pickedModel = model === undefined ? defaultModel : model;

  const slug = experimentSlug(goal);
  const branch = branchDraft ?? composeWorktreeBranch("autoresearch", slug, hash);
  const projectName = group?.project.name ?? projectCwd.split(/[\\/]+/).filter((s) => s !== "").pop() ?? projectCwd;

  const goalMissing = goal.trim() === "";
  const metricMissing = metric.trim() === "";
  const metricInvalid = !metricMissing && !METRIC_NAME_RE.test(metric.trim());

  const close = (): void => {
    setError(null);
    closeExperimentDialog();
  };

  const submit = async (): Promise<void> => {
    if (pending || repo === undefined || repo === "jj-only") return;
    setAttempted(true);
    if (goalMissing || metricMissing || metricInvalid) return;
    setPending(true);
    setError(null);
    const cap = Number.parseInt(maxIterations.trim(), 10);
    try {
      await newExperiment(
        projectCwd,
        {
          goal: goal.trim(),
          metric: metric.trim(),
          unit: unit.trim(),
          direction,
          command: command.trim() === "" ? null : command.trim(),
          scopePaths: lines(scopePaths),
          offLimits: lines(offLimits),
          constraints: lines(constraints),
          maxIterations: Number.isInteger(cap) && cap > 0 ? cap : null,
          model: pickedModel,
          worktree:
            repo === "git" ? { mint: { branch: branch.trim(), baseRef: null, baseBranch: null } } : null,
        },
        instanceId,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <ConfirmDialog
      kicker={t("experiment.dialog.kicker")}
      title={t("experiment.dialog.title", { name: projectName })}
      tone="iris"
      onClose={close}
      width="w-[28rem]"
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t("common.dialog.cancel")}
          </Button>
          <Button
            variant="solid"
            tone="iris"
            disabled={pending || repo === undefined || repo === "jj-only"}
            onClick={() => void submit()}
          >
            {pending ? t("experiment.dialog.launching") : t("experiment.dialog.launch")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="experiment-goal" className={LABEL}>
            {t("experiment.dialog.goal")}
          </label>
          <textarea
            id="experiment-goal"
            rows={3}
            value={goal}
            maxLength={GOAL_CHAR_LIMIT}
            placeholder={t("experiment.dialog.goalPlaceholder")}
            spellCheck={false}
            onChange={(event) => setGoal(event.target.value)}
            className={`${FIELD} resize-none`}
            data-modal-initial-focus
          />
          {attempted && goalMissing && (
            <p className="mt-1.5 text-[10px] leading-snug text-rose">{t("experiment.dialog.goalRequired")}</p>
          )}
        </div>

        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <div>
            <label htmlFor="experiment-metric" className={LABEL}>
              {t("experiment.dialog.metric")}
            </label>
            <input
              id="experiment-metric"
              value={metric}
              spellCheck={false}
              onChange={(event) => setMetric(event.target.value)}
              className={FIELD}
            />
            {metricInvalid ? (
              <p className="mt-1.5 text-[10px] leading-snug text-rose">{t("experiment.dialog.metricInvalid")}</p>
            ) : attempted && metricMissing ? (
              <p className="mt-1.5 text-[10px] leading-snug text-rose">{t("experiment.dialog.metricRequired")}</p>
            ) : (
              <p className={HINT}>{t("experiment.dialog.metricHint")}</p>
            )}
          </div>
          <div>
            <label htmlFor="experiment-unit" className={LABEL}>
              {t("experiment.dialog.unit")}
            </label>
            <input
              id="experiment-unit"
              value={unit}
              spellCheck={false}
              onChange={(event) => setUnit(event.target.value)}
              className={FIELD}
            />
          </div>
        </div>

        <ChoiceCapsule
          label={t("experiment.dialog.direction")}
          value={direction}
          onChange={setDirection}
          tone="iris"
          options={[
            { value: "lower", label: t("experiment.dialog.lower") },
            { value: "higher", label: t("experiment.dialog.higher") },
          ]}
        />

        <div>
          <label htmlFor="experiment-command" className={LABEL}>
            {t("experiment.dialog.command")}
          </label>
          <input
            id="experiment-command"
            value={command}
            spellCheck={false}
            onChange={(event) => setCommand(event.target.value)}
            className={FIELD}
          />
          <p className={HINT}>{t("experiment.dialog.commandHint")}</p>
        </div>

        {(
          [
            ["scope", "experiment.dialog.scopePaths", scopePaths, setScopePaths],
            ["off-limits", "experiment.dialog.offLimits", offLimits, setOffLimits],
            ["constraints", "experiment.dialog.constraints", constraints, setConstraints],
          ] as const
        ).map(([id, labelKey, value, onChange]) => (
          <div key={id}>
            <label htmlFor={`experiment-${id}`} className={LABEL}>
              {t(labelKey)}{" "}
              <span className="text-ink-faint/70">· {t("experiment.dialog.onePerLine")}</span>
            </label>
            <textarea
              id={`experiment-${id}`}
              rows={2}
              value={value}
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
              className={`${FIELD} resize-none`}
            />
          </div>
        ))}

        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <div>
            <label htmlFor="experiment-max-iterations" className={LABEL}>
              {t("experiment.dialog.maxIterations")}
            </label>
            <input
              id="experiment-max-iterations"
              type="number"
              min={1}
              step={1}
              value={maxIterations}
              onChange={(event) => setMaxIterations(event.target.value)}
              className={FIELD}
            />
          </div>
          <div>
            <span className={LABEL}>{t("experiment.dialog.model")}</span>
            <button
              type="button"
              id="experiment-model"
              disabled={models.length === 0}
              title={pickedModel === null ? t("plan.review.sessionDefault") : `${pickedModel.provider}/${pickedModel.id}`}
              onClick={() => setPickingModel(true)}
              className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 text-left font-mono text-[11px] text-ink hover:border-line-strong disabled:cursor-default disabled:text-ink-faint"
            >
              {pickedModel === null ? t("plan.review.sessionDefault") : pickedModel.name || pickedModel.id}
            </button>
          </div>
        </div>

        <div>
          <span className={LABEL}>{t("experiment.dialog.where")}</span>
          {repo === undefined ? (
            <p className={HINT}>{t("experiment.dialog.preflight")}</p>
          ) : repo === "git" ? (
            <>
              <p className={HINT}>{t("experiment.dialog.whereGit")}</p>
              <input
                id="experiment-branch"
                aria-label={t("worktree.field.branch")}
                value={branch}
                spellCheck={false}
                onChange={(event) => setBranchDraft(event.target.value)}
                className={FIELD}
              />
            </>
          ) : repo === "none" ? (
            <p className="mt-1.5 text-[10px] leading-snug text-copper">{t("experiment.dialog.whereNone")}</p>
          ) : (
            <p className="mt-1.5 text-[10px] leading-snug text-rose">{t("experiment.dialog.whereJj")}</p>
          )}
        </div>

        {error !== null && <p className="text-xs leading-relaxed text-rose">{error}</p>}
      </div>

      {pickingModel && (
        <ModelPalette
          variant="main"
          models={models}
          current={pickedModel}
          instanceId={instanceId}
          onClose={() => setPickingModel(false)}
          onPick={(picked) => {
            setPickingModel(false);
            setModel(picked);
          }}
        />
      )}
    </ConfirmDialog>
  );
}
