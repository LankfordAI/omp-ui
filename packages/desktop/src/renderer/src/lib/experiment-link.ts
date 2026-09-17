// Session ↔ experiment linking (issue #559, ADR-0030). An Experiment is a row
// of omp's per-project autoresearch DB; an owned session is linked to one by
// effective checkout and branch, never by a stored id — omp assigns the row
// only when the agent calls init_experiment, after the session already exists.
// Pure: both the Lab (record → session) and the Session HUD (session → record)
// derive the link from the same overview answer.
import type { ExperimentRecord, ProjectExperiments, SessionSummary } from "@omp-ui/core/types";

export interface ExperimentLink {
  /** The owned worktree session whose checkout's DB holds the row; null = the project checkout. */
  checkoutTabId: string | null;
  record: ExperimentRecord;
}

/** Newest row recorded on `branch`, an open one preferred; null when the branch has none. */
function newestOnBranch(
  experiments: readonly ExperimentRecord[],
  branch: string | null,
): ExperimentRecord | null {
  const onBranch = experiments.filter((e) => e.branch === branch);
  return onBranch.find((e) => e.closedAt === null) ?? onBranch[0] ?? null;
}

/**
 * The experiment a session is linked to: its own worktree checkout's DB
 * (branch match first, then newest open), or — for a non-worktree session
 * with launch provenance — the project checkout's row whose branch equals
 * `experiment.launchedBranch` (newest open first). null when nothing matches.
 */
export function linkedExperiment(
  result: ProjectExperiments | null,
  tabId: string,
  summary: SessionSummary | undefined,
): ExperimentLink | null {
  if (result === null || summary === undefined) return null;
  if (summary.worktree !== null) {
    const path = summary.worktree.path;
    // A fork shares its origin's checkout under another tabId, so the path
    // is the identity; the tabId match is the common fast case.
    const checkout =
      result.checkouts.find((c) => c.tabId === tabId) ??
      result.checkouts.find((c) => c.tabId !== null && c.cwd === path);
    if (checkout === undefined) return null;
    const experiments = checkout.result.experiments;
    const record =
      newestOnBranch(experiments, summary.worktree.branch) ??
      experiments.find((e) => e.closedAt === null) ??
      null;
    return record === null ? null : { checkoutTabId: checkout.tabId, record };
  }
  if (summary.experiment === null) return null;
  const project = result.checkouts.find((c) => c.tabId === null);
  if (project === undefined) return null;
  const record = newestOnBranch(project.result.experiments, summary.experiment.launchedBranch);
  return record === null ? null : { checkoutTabId: null, record };
}

/**
 * The owned session an experiment is linked to: the checkout's own session
 * for a worktree checkout; else the newest non-worktree session (by
 * `launchedAt`) whose launch provenance named the record's branch.
 */
export function experimentSession(
  checkoutTabId: string | null,
  record: ExperimentRecord,
  sessions: readonly SessionSummary[],
): SessionSummary | null {
  if (checkoutTabId !== null) return sessions.find((s) => s.tabId === checkoutTabId) ?? null;
  let newest: SessionSummary | null = null;
  for (const s of sessions) {
    if (s.worktree !== null || s.experiment === null) continue;
    if (s.experiment.launchedBranch !== record.branch) continue;
    if (newest === null || s.launchedAt > newest.launchedAt) newest = s;
  }
  return newest;
}
