import { useEffect, useMemo, useRef, useState } from "react";
import { composeWorktreeBranch, mintBranchName } from "@omp-ui/core/worktree-branch";
import { AUTORESEARCH_METRIC_NAME_RE, EXPERIMENT_PROPOSAL_REVISE } from "@omp-ui/core/autoresearch";
import type { ModelInfo } from "../lib/rpc-types";
import { projectKey } from "../lib/project-key";
import { experimentSlug } from "../lib/experiment-kickoff";
import type { NewExperimentSpec } from "../store/types";
import { findInstance, useStore } from "../store";
import { ModelPalette } from "./ModelSelector";
import { Button, ChoiceCapsule, ConfirmDialog } from "./ui";
/** omp's own cap on published goal text; the composer input stops there too. */
const GOAL_CHAR_LIMIT = 4096;

const FIELD =
  "mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-line-strong";
const LABEL = "block text-xs text-ink-faint";
const HINT = "mt-1.5 text-xs leading-snug text-ink-faint";

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
 * cannot launch at all (omp's loop needs git). With `proposalTabId`, an agent's
 * propose_experiment prefills the form (issue #567): Launch answers that
 * blocked select with the spec as launched; closing answers it `revise`.
 */
export function NewExperimentDialog({
  projectCwd,
  instanceId,
  proposalTabId,
}: {
  projectCwd: string;
  /** The remote instance owning the project (issue #416); null for this host. */
  instanceId: string | null;
  /** The tab whose agent proposed this spec (issue #567); null for the blank form. */
  proposalTabId: string | null;
}) {
  // The proposal that opened this dialog, captured once: App remounts the
  // dialog per proposal so these initializers seed from it (issue #567).
  const draft = useStore((s) => (proposalTabId === null ? null : s.rpc[proposalTabId]?.experimentProposal ?? null));
  const seed = useRef(draft?.proposal ?? null).current;
  const [goal, setGoal] = useState(seed?.goal ?? "");
  const [metric, setMetric] = useState(seed?.metric ?? "");
  const [unit, setUnit] = useState(seed?.unit ?? "");
  const [direction, setDirection] = useState<NewExperimentSpec["direction"]>(seed?.direction ?? "lower");
  const [command, setCommand] = useState(seed?.command ?? "");
  const [scopePaths, setScopePaths] = useState(seed?.scopePaths.join("\n") ?? "");
  const [offLimits, setOffLimits] = useState(seed?.offLimits.join("\n") ?? "");
  const [constraints, setConstraints] = useState(seed?.constraints.join("\n") ?? "");
  const [maxIterations, setMaxIterations] = useState(
    seed === null || seed.maxIterations === null ? "" : String(seed.maxIterations),
  );
  const brief = seed?.brief ?? null;
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
  const answerExperimentProposal = useStore((s) => s.answerExperimentProposal);
  const startExperimentInterview = useStore((s) => s.startExperimentInterview);
  const state = useStore((s) => s.state);
  const rpc = useStore((s) => s.rpc);

  // Preflight: the overview answer names the repository kind.
  useEffect(() => {
    void loadExperiments(projectCwd, instanceId);
  }, [projectCwd, instanceId, loadExperiments]);

  // A sibling client launched or cancelled this proposal, or the tab relaunched: the gate is gone.
  useEffect(() => {
    if (proposalTabId !== null && draft === null) closeExperimentDialog();
  }, [proposalTabId, draft, closeExperimentDialog]);

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
  const metricInvalid = !metricMissing && !AUTORESEARCH_METRIC_NAME_RE.test(metric.trim());

  const close = (): void => {
    setError(null);
    // Cancel, Escape, and the backdrop all send the proposal back (decision: close = revise).
    if (proposalTabId !== null) answerExperimentProposal(proposalTabId, EXPERIMENT_PROPOSAL_REVISE);
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
          brief,
          model: pickedModel,
          worktree:
            repo === "git" ? { mint: { branch: branch.trim(), baseRef: null, baseBranch: null } } : null,
        },
        instanceId,
        proposalTabId === null ? undefined : { tabId: proposalTabId },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <ConfirmDialog
      kicker="new experiment"
      title={`New experiment in ${projectName}`}
      tone="iris"
      onClose={close}
      androidBack={proposalTabId === null ? "dismiss" : "block"}
      width="w-[28rem]"
      actions={
        <>
          {proposalTabId === null && (
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={pending}
              onClick={() => void startExperimentInterview(projectCwd, instanceId, goal)}
            >
              Configure with the agent
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="solid"
            tone="iris"
            disabled={pending || repo === undefined || repo === "jj-only"}
            onClick={() => void submit()}
          >
            {pending ? "Launching…" : "Launch"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {seed !== null && <p className={HINT}>Proposed by the agent. Edit anything, then Launch — Cancel sends it back to the conversation.</p>}
        <div>
          <label htmlFor="experiment-goal" className={LABEL}>
            What to optimize
          </label>
          <textarea
            id="experiment-goal"
            rows={3}
            value={goal}
            maxLength={GOAL_CHAR_LIMIT}
            placeholder="e.g. reduce the p95 latency of the /search endpoint"
            spellCheck={false}
            onChange={(event) => setGoal(event.target.value)}
            className={`${FIELD} resize-none`}
            data-modal-initial-focus
          />
          {attempted && goalMissing && (
            <p className="mt-1.5 text-xs leading-snug text-rose">describe what to optimize</p>
          )}
        </div>

        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <div>
            <label htmlFor="experiment-metric" className={LABEL}>
              Metric name
            </label>
            <input
              id="experiment-metric"
              value={metric}
              spellCheck={false}
              onChange={(event) => setMetric(event.target.value)}
              className={FIELD}
            />
            {metricInvalid ? (
              <p className="mt-1.5 text-xs leading-snug text-rose">metric name may only contain letters, digits, _ . and -</p>
            ) : attempted && metricMissing ? (
              <p className="mt-1.5 text-xs leading-snug text-rose">name the metric</p>
            ) : (
              <p className={HINT}>letters, digits, _ . and - (what METRIC name=value accepts)</p>
            )}
          </div>
          <div>
            <label htmlFor="experiment-unit" className={LABEL}>
              Unit
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
          label="Direction"
          value={direction}
          onChange={setDirection}
          tone="iris"
          options={[
            { value: "lower", label: "lower is better" },
            { value: "higher", label: "higher is better" },
          ]}
        />

        <div>
          <label htmlFor="experiment-command" className={LABEL}>
            Benchmark command
          </label>
          <input
            id="experiment-command"
            value={command}
            spellCheck={false}
            onChange={(event) => setCommand(event.target.value)}
            className={FIELD}
          />
          <p className={HINT}>empty: the agent writes ./autoresearch.sh</p>
        </div>

        {(
          [
            ["scope", "Scope paths", scopePaths, setScopePaths],
            ["off-limits", "Off-limits", offLimits, setOffLimits],
            ["constraints", "Constraints", constraints, setConstraints],
          ] as const
        ).map(([id, label, value, onChange]) => (
          <div key={id}>
            <label htmlFor={`experiment-${id}`} className={LABEL}>
              {label}{" "}
              <span className="text-ink-faint/70">· one per line</span>
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

        {brief !== null && (
          <div>
            <span className={LABEL}>
              Agent brief{" "}
              <span className="text-ink-faint/70">· sent with the kickoff prompt</span>
            </span>
            <pre className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink-mid">
              {brief}
            </pre>
          </div>
        )}

        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <div>
            <label htmlFor="experiment-max-iterations" className={LABEL}>
              Max iterations per segment
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
            <span className={LABEL}>Model</span>
            <button
              type="button"
              id="experiment-model"
              disabled={models.length === 0}
              title={pickedModel === null ? "session default" : `${pickedModel.provider}/${pickedModel.id}`}
              onClick={() => setPickingModel(true)}
              className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 text-left font-mono text-xs text-ink hover:border-line-strong disabled:cursor-default disabled:text-ink-faint"
            >
              {pickedModel === null ? "session default" : pickedModel.name || pickedModel.id}
            </button>
          </div>
        </div>

        <div>
          <span className={LABEL}>Where it runs</span>
          {repo === undefined ? (
            <p className={HINT}>checking the repository…</p>
          ) : repo === "git" ? (
            <>
              <p className={HINT}>in a new worktree on branch</p>
              <input
                id="experiment-branch"
                aria-label="Branch"
                value={branch}
                spellCheck={false}
                onChange={(event) => setBranchDraft(event.target.value)}
                className={FIELD}
              />
            </>
          ) : repo === "none" ? (
            <p className="mt-1.5 text-xs leading-snug text-copper">not a git repository: no branch isolation, baseline reset, or auto-commits — the experiment runs at the project checkout</p>
          ) : (
            <p className="mt-1.5 text-xs leading-snug text-rose">Autoresearch needs a Git checkout. This is a jj-only workspace; run jj git init --colocate first.</p>
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
