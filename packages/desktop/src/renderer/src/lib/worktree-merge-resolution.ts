import type { UiStore } from "../store/types";
import { findOwner, sessionCwd } from "../store/slices/view";
import { t } from "./i18n";

/** The Finish dialog and dispatch action share the same live-checkout guard. */
export function worktreeMergeResolutionState(
  s: Pick<UiStore, "state" | "tabs" | "rpc" | "exited">,
  tabId: string,
): { route: "current" | "fresh"; blockedReason: string | null } | null {
  const owner = findOwner(s.state, tabId);
  if (!owner?.record.worktree) return null;
  const { record, instanceId } = owner;
  const tab = s.tabs.find((candidate) => candidate.tabId === tabId);
  const rpc = s.rpc[tabId];
  // A spawned native process can precede its live registry snapshot (#622).
  // A starting/failed mounted original is blocked, not silently replaced.
  const mountedProcess = tab?.mode === "rpc-ui" && (rpc?.status === "starting" || rpc?.status === "error");
  const route = record.mode === "rpc-ui" && s.exited[tabId] === undefined &&
    (record.live === "live" || mountedProcess) ? "current" : "fresh";
  if (route === "current") {
    if (
      record.pendingPlan != null || record.awaitingHumanAnswer === true ||
      rpc?.planReview != null || rpc?.approvalPrompt != null ||
      rpc?.experimentProposal != null || (rpc?.extensionQueue.length ?? 0) > 0
    ) {
      return { route, blockedReason: t("finish.resolution.blockedAnswer") };
    }
    if (
      tab?.mode !== "rpc-ui" || tab.instanceId !== instanceId || tab.projectCwd !== record.projectCwd ||
      !rpc || rpc.status !== "ready" || rpc.commandAdmissionBlocked === true ||
      rpc.busy || rpc.compacting !== undefined || rpc.session.isStreaming ||
      rpc.session.isCompacting || rpc.session.queuedMessageCount > 0
    ) {
      return { route, blockedReason: t("finish.resolution.blockedSource") };
    }
  }
  for (const tab of s.tabs) {
    if (tab.tabId === tabId || tab.mode !== "rpc-ui" || s.rpc[tab.tabId]?.status !== "running") continue;
    const target = findOwner(s.state, tab.tabId);
    if (target?.instanceId === instanceId && sessionCwd(target.record) === record.projectCwd) {
      return { route, blockedReason: t("finish.resolution.blockedTarget", { title: target.record.title }) };
    }
  }
  return { route, blockedReason: null };
}
