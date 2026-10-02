// Subagent control (issues #684, #713, ADR-0045): the Agents pane's steer/kill
// verbs ride omp's native rpc commands, `steer_subagent` and `cancel_subagent`
// (omp 18.4.9+). The response is the whole result: acceptance, or omp's own
// refusal sentence rendered verbatim. The roster stays the status truth — a
// cancel's aborted lifecycle frame and the follow-up get_subagents retire the row.
import type { SessionCommand } from "@omp-ui/core/session-command";
import { t } from "../../lib/i18n";
import type { SubagentControlAction, UiStore } from "../types";
import { RpcCommandAbandonedError, type GetState, type StoreMachinery } from "./shared";

export type SubagentControlSlice = Pick<UiStore, "steerSubagent" | "killSubagent">;

/** omp's dispatch answer for a verb its build does not know (rpc-mode.ts). */
const UNKNOWN_COMMAND_PREFIX = "Unknown command:";

export function createSubagentControlSlice(
  get: GetState,
  m: StoreMachinery,
): SubagentControlSlice {
  const clearBusy = (tabId: string, agentId: string): void => {
    const busy = { ...get().rpc[tabId]?.subagentControlBusy };
    delete busy[agentId];
    m.patchRpc(tabId, { subagentControlBusy: busy });
  };

  /**
   * One verb per agent at a time. Direct rpcCommand, never runCommand: a quiet
   * runCommand swallows the failure text, and omp's sentence is the message
   * the pane must show. A dropped process says nothing here (its overlay
   * already does); an omp without the verb gets the update hint and no
   * fallback path is ever tried.
   */
  const run = async (
    tabId: string,
    agentId: string,
    action: SubagentControlAction,
    cmd: SessionCommand,
  ): Promise<void> => {
    const tab = get().rpc[tabId];
    if (tab === undefined) return;
    if (tab.subagentControlBusy[agentId] !== undefined) return;
    m.patchRpc(tabId, {
      subagentControlBusy: { ...tab.subagentControlBusy, [agentId]: action },
      subagentControlError: null,
    });
    try {
      await get().rpcCommand(tabId, cmd, { quiet: true });
    } catch (err) {
      if (err instanceof RpcCommandAbandonedError) return;
      const message = err instanceof Error ? err.message : String(err);
      m.patchRpc(tabId, {
        subagentControlError: message.startsWith(UNKNOWN_COMMAND_PREFIX)
          ? t("rail.agents.needsNewerOmp")
          : message,
      });
    } finally {
      clearBusy(tabId, agentId);
    }
    // A settled kill (cancelled or not, even a tombstone-write failure — the
    // agent is aborted either way) re-reads the roster; the lifecycle frame
    // covers subscribed sessions, this covers one whose subscription is off.
    if (action === "kill") void get().refreshSubagents(tabId);
  };

  const steerSubagent = async (
    tabId: string,
    agentId: string,
    text: string,
  ): Promise<void> => {
    const message = text.trim();
    if (message === "") return;
    await run(tabId, agentId, "steer", { type: "steer_subagent", subagentId: agentId, message });
  };

  const killSubagent = async (tabId: string, agentId: string): Promise<void> => {
    await run(tabId, agentId, "kill", { type: "cancel_subagent", subagentId: agentId });
  };

  return { steerSubagent, killSubagent };
}
