// Background jobs (issue #835, ADR-0054): the Jobs pane's kill verbs ride the
// generated async-jobs bridge as a hidden slash command. omp runs extension
// commands inside AgentSession.prompt before its streaming check, so the
// command lands mid-turn without streamingBehavior; the bridge's published
// snapshot, never the prompt ack, carries the outcome.
import {
  ASYNC_JOBS_COMMAND,
  asyncJobsKillMessage,
  type AsyncJobsSnapshot,
} from "@omp-ui/core/async-jobs";
import { t } from "../../lib/i18n";
import { randomId } from "../../lib/random-id";
import { isNewerSnapshot } from "../snapshot-acceptance";
import type { UiStore } from "../types";
import { RpcCommandAbandonedError, type GetState, type StoreMachinery } from "./shared";

export type AsyncJobsSlice = Pick<UiStore, "refreshAsyncJobs" | "killAsyncJob">;

/**
 * How long a kill may wait for its result snapshot after omp acknowledged the
 * prompt. omp acks an extension command at admission (AgentSession calls
 * onPromptAdmitted before the handler), so the result can trail the ack; a
 * bridge that never answers must not disable every kill button forever.
 */
export const ASYNC_JOBS_KILL_ANSWER_MS = 5_000;

/**
 * The one acceptance rule for a jobs snapshot: isNewerSnapshot (a new
 * processKey replaces, one process needs a strictly newer revision). A result
 * settles this client's pending kill only when its requestId matches.
 */
export function acceptAsyncJobsSnapshot(
  tabId: string,
  snapshot: AsyncJobsSnapshot,
  get: GetState,
  m: StoreMachinery,
): boolean {
  const tab = get().rpc[tabId];
  if (tab === undefined || !isNewerSnapshot(tab.asyncJobs, snapshot)) return false;
  const pending = tab.asyncJobsKill;
  const result = snapshot.result;
  if (pending !== null && result !== null && result.requestId === pending.requestId) {
    m.patchRpc(tabId, {
      asyncJobs: snapshot,
      asyncJobsKill: null,
      asyncJobsKillError: result.ok ? null : result.text,
    });
    return true;
  }
  m.patchRpc(tabId, { asyncJobs: snapshot });
  return true;
}

export function createAsyncJobsSlice(get: GetState, m: StoreMachinery): AsyncJobsSlice {
  /** The refreshLimits shape: quiet, allowed during boot, answered by setStatus. */
  const refreshAsyncJobs = async (tabId: string): Promise<void> => {
    await m.runBridgeCommand(tabId, ASYNC_JOBS_COMMAND, "", {
      allowDuringBoot: true,
      quiet: true,
    });
  };

  /**
   * One kill per tab at a time. Sends nothing unless THIS process's bridge
   * published an available, cancel-capable snapshot: an unregistered slash
   * command on an idle session would reach the model as a prompt. Direct
   * rpcCommand (the subagent-control shape) so a refusal's text is kept.
   */
  const killAsyncJob = async (
    tabId: string,
    job: { id: string; startTime: number } | null,
  ): Promise<void> => {
    const tab = get().rpc[tabId];
    const snapshot = tab?.asyncJobs ?? null;
    if (tab === undefined || snapshot === null || !snapshot.available || !snapshot.canCancel) return;
    if (tab.asyncJobsKill !== null) return;
    const requestId = randomId();
    m.patchRpc(tabId, {
      asyncJobsKill: { requestId, jobId: job?.id ?? null },
      asyncJobsKillError: null,
    });
    try {
      await get().rpcCommand(
        tabId,
        {
          type: "prompt",
          message: asyncJobsKillMessage({
            requestId,
            processKey: snapshot.processKey,
            jobId: job?.id ?? null,
            startTime: job?.startTime ?? null,
          }),
        },
        { quiet: true },
      );
      setTimeout(() => {
        if (get().rpc[tabId]?.asyncJobsKill?.requestId !== requestId) return;
        m.patchRpc(tabId, { asyncJobsKill: null, asyncJobsKillError: t("rail.jobs.noAnswer") });
      }, ASYNC_JOBS_KILL_ANSWER_MS);
    } catch (err) {
      // A dropped process says nothing here: disposeTabRuntime resets the fields.
      if (err instanceof RpcCommandAbandonedError) return;
      if (get().rpc[tabId]?.asyncJobsKill?.requestId !== requestId) return;
      m.patchRpc(tabId, {
        asyncJobsKill: null,
        asyncJobsKillError: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { refreshAsyncJobs, killAsyncJob };
}
