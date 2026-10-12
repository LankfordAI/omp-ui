import type { AsyncJobsSnapshot } from "@omp-ui/core/async-jobs";
import type { SubagentInfo } from "./rpc-types";

/**
 * Running jobs the HUD counts — omp's own status-line rule
 * (StatusLine.runningBackgroundJobCount in omp/18.8.9): a `task` job whose
 * agent is already on the subagent roster is counted by the Agents pane, not
 * here. Unavailable or absent snapshots count zero.
 */
export function runningJobCount(
  snapshot: AsyncJobsSnapshot | null,
  subagents: readonly SubagentInfo[],
): number {
  if (snapshot === null || !snapshot.available) return 0;
  const roster = new Set(subagents.map((agent) => agent.id));
  return snapshot.running.filter(
    (job) => job.type !== "task" || job.agentId === null || !roster.has(job.agentId),
  ).length;
}
