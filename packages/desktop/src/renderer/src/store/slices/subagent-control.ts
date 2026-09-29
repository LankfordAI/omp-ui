// Subagent control (issue #684, ADR-0040): the Agents pane's steer/kill/revive
// verbs. The bridge (packages/core/src/subagent-control-extension.ts) drives
// omp's in-process registry APIs and publishes the settled result over
// `setStatus`; every verb here is a quiet hidden prompt whose answer is that
// snapshot — never the ack — so the transcript gets no row and the busy sweep
// no strobe (the goal/tree/btw precedent, issue #680).
import {
  SUBAGENT_STEER_CHAR_LIMIT,
  findSubagentControlResult,
  subagentControlMessage,
  type SubagentControlAction,
} from "@omp-ui/core/subagent-control";
import { t } from "../../lib/i18n";
import { randomId } from "../../lib/random-id";
import type { UiStore } from "../types";
import type { GetState, StoreMachinery } from "./shared";
import { RPC_COMMAND_TIMEOUT_MS } from "./shared";

export type SubagentControlSlice = Pick<
  UiStore,
  "steerSubagent" | "killSubagent" | "reviveSubagent"
>;

/** Whole hidden bridge frames ride quiet prompts: allowed while booting, no command row. */
const QUIET = { allowDuringBoot: true, quiet: true } as const;

export function createSubagentControlSlice(
  get: GetState,
  m: StoreMachinery,
): SubagentControlSlice {
  /** A local refusal line the pane shows until the next dispatch replaces it. */
  const refuse = (tabId: string, busy: string): void => {
    m.patchRpc(tabId, { subagentControlError: busy });
  };

  const clearBusy = (tabId: string, agentId: string): void => {
    const busy = { ...get().rpc[tabId]?.subagentControlBusy };
    delete busy[agentId];
    m.patchRpc(tabId, { subagentControlBusy: busy });
  };

  /**
   * One verb, correlated by requestId: send the hidden frame, wait for the
   * bridge's publish to carry the matching result, then refresh the roster —
   * kill/revive flip a status the roster (not this slice) reports. A frame
   * that never reached the bridge cannot be answered by a snapshot, so it
   * refuses locally; omp's own refusal sentences arrive verbatim in the
   * snapshot's results and are rendered, never rewritten here.
   */
  const runControl = async (
    tabId: string,
    agentId: string,
    action: SubagentControlAction,
    text?: string,
  ): Promise<void> => {
    const tab = get().rpc[tabId];
    if (tab === undefined) return;
    // One verb per agent at a time; the bridge enforces the same rule and is
    // the truth — this guard only keeps the UI's disabled state honest.
    if (tab.subagentControlBusy[agentId] !== undefined) return;
    const requestId = randomId();
    m.patchRpc(tabId, {
      subagentControlBusy: { ...tab.subagentControlBusy, [agentId]: action },
      subagentControlError: null,
    });
    try {
      const resp = await m.runCommand(
        tabId,
        {
          type: "prompt",
          message: subagentControlMessage({
            requestId,
            agentId,
            action,
            ...(text !== undefined ? { text } : {}),
          }),
        },
        QUIET,
      );
      if (resp === null) {
        refuse(tabId, t("rail.agents.sendFailed"));
        return;
      }
      await m.pollUntil(
        tabId,
        (next) =>
          findSubagentControlResult(next?.subagentControl ?? null, requestId) !==
          undefined,
        RPC_COMMAND_TIMEOUT_MS,
      );
      void get().refreshSubagents(tabId);
    } finally {
      clearBusy(tabId, agentId);
    }
  };

  const steerSubagent = async (
    tabId: string,
    agentId: string,
    text: string,
  ): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    // Checked before anything is sent: never silently truncate a steer.
    if (trimmed.length > SUBAGENT_STEER_CHAR_LIMIT) {
      refuse(
        tabId,
        t("rail.agents.steerTooLong", { limit: SUBAGENT_STEER_CHAR_LIMIT }),
      );
      return;
    }
    await runControl(tabId, agentId, "steer", trimmed);
  };

  const killSubagent = async (tabId: string, agentId: string): Promise<void> => {
    await runControl(tabId, agentId, "kill");
  };

  const reviveSubagent = async (
    tabId: string,
    agentId: string,
  ): Promise<void> => {
    await runControl(tabId, agentId, "revive");
  };

  return { steerSubagent, killSubagent, reviveSubagent };
}
