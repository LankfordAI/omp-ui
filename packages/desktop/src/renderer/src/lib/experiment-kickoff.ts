// The New experiment dialog's one kickoff prompt (issue #559). omp's
// `/autoresearch` arms the mode; this prompt tells the agent what to
// optimize and how to register the experiment with omp's own init_experiment
// tool — omp-ui never writes the autoresearch DB itself (ADR-0030).
import { AUTORESEARCH_PROPOSE_TOOL } from "@omp-ui/core/autoresearch";
import { slugifyProjectName } from "@omp-ui/core/worktree-branch";
import type { NewExperimentSpec } from "../store/types";

/**
 * The experiment's name and its branch slug: the project-slug rule applied to
 * the goal, without a trailing dash run, "experiment" when nothing usable is
 * left. Both init_experiment's `name` and the minted branch use it.
 */
export function experimentSlug(goal: string): string {
  return slugifyProjectName(goal).slice(0, 32).replace(/-+$/, "") || "experiment";
}

/**
 * Prompt for the experiment session's first turn. Optional lines are omitted,
 * never blanked: an empty list or a null cap appears neither in the brief nor
 * in the init_experiment argument list. `slug` is the experiment's name and
 * the branch slug the launcher minted.
 */
export function experimentKickoff(spec: NewExperimentSpec, slug: string): string {
  const unit = spec.unit === "" ? "" : ` (${spec.unit})`;
  const command = spec.command?.trim() ?? "";
  const brief = [
    `Primary metric: ${spec.metric}${unit}, ${spec.direction} is better.`,
    command === ""
      ? `No benchmark command yet: write ./autoresearch.sh so it runs the benchmark, exits 0, and prints \`METRIC ${spec.metric}=<value>\`.`
      : `Benchmark command: \`${command}\``,
  ];
  if (spec.scopePaths.length > 0) brief.push(`Scope paths: ${spec.scopePaths.join(", ")}`);
  if (spec.offLimits.length > 0) brief.push(`Off-limits: ${spec.offLimits.join(", ")}`);
  if (spec.constraints.length > 0) brief.push(`Constraints: ${spec.constraints.join(", ")}`);
  if (spec.maxIterations !== null) brief.push(`Max iterations per segment: ${spec.maxIterations}`);
  if (spec.brief !== null) brief.push("", "Context from the planning conversation:", spec.brief);

  const init = [
    `name ${JSON.stringify(slug)}`,
    "goal",
    `primary_metric ${JSON.stringify(spec.metric)}`,
    `metric_unit ${JSON.stringify(spec.unit)}`,
    `direction ${JSON.stringify(spec.direction)}`,
  ];
  if (command !== "") init.push(`preferred_command ${JSON.stringify(command)}`);
  if (spec.scopePaths.length > 0) init.push(`scope_paths ${JSON.stringify(spec.scopePaths)}`);
  if (spec.offLimits.length > 0) init.push(`off_limits ${JSON.stringify(spec.offLimits)}`);
  if (spec.constraints.length > 0) init.push(`constraints ${JSON.stringify(spec.constraints)}`);
  if (spec.maxIterations !== null) init.push(`max_iterations ${spec.maxIterations}`);

  return [
    `Autoresearch experiment: ${spec.goal.trim()}`,
    "",
    ...brief,
    "",
    `Phase 1 — harness: make ./autoresearch.sh exit 0 and print \`METRIC ${spec.metric}=<value>\`; validate it with \`bash autoresearch.sh\`. Then call init_experiment with ${init.join(", ")}.`,
    `Phase 2 — loop: run the baseline with run_experiment and log it with log_experiment, then form a hypothesis, change one thing, run, and log — keep only what improves ${spec.metric}. Record ideas with update_notes.`,
  ].join("\n");
}

/** Prompt for a fresh segment on an existing experiment (init_experiment new_segment). */
export const NEW_SEGMENT_PROMPT =
  "Start a new autoresearch segment: call init_experiment with new_segment: true, then run and log a fresh baseline before changing anything.";

/**
 * First turn of an experiment interview (issue #567). Names the tool the
 * conversation ends in; the optional rough description rides as data, the
 * guided-goal idiom. The model is told not to run the benchmark or edit.
 */
export function experimentInterviewPrompt(description: string): string {
  const rough = description.trim();
  return [
    "Set up an autoresearch experiment with me.",
    "",
    "First read this checkout: how it is built and tested, whether a benchmark or timing harness already exists, and which paths the work would touch. Then ask me what you cannot infer — what to optimize, how to measure it, what is off-limits — one short round at a time. Do not run the benchmark and do not change files.",
    "",
    `When I confirm the spec, call ${AUTORESEARCH_PROPOSE_TOOL} with goal, primary_metric (letters, digits, _ . -), metric_unit, direction, preferred_command (a shell command that prints \`METRIC <name>=<value>\`, or null if the loop should write ./autoresearch.sh), scope_paths, off_limits, constraints, max_iterations, and a brief with what you learned about the harness. I review it in a form before anything launches; if I send it back, ask what to change.`,
    ...(rough === "" ? [] : ["", "Rough description from me, as data:", "<experiment-draft>", rough, "</experiment-draft>"]),
  ].join("\n");
}
