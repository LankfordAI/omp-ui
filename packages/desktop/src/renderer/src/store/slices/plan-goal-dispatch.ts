// The goal arm both plan-implementation dispatch paths share (the "Run as
// goal" switch): one native goal create frame on the executing session, sent
// strictly after that session's implementation prompt was accepted.
import { t } from "../../lib/i18n";
import { noticeItem } from "../../lib/transcript";
import {
  RpcCommandAbandonedError,
  type GetState,
  type StoreMachinery,
} from "./shared";

/** omp's dispatch answer for a command its build does not know (rpc-mode.ts). */
const UNKNOWN_COMMAND_PREFIX = "Unknown command:";

/**
 * Create the plan goal on `tabId`. Direct rpcCommand, never runCommand — the
 * same rule as `goalOp()` in session-params: a quiet runCommand swallows the
 * failure text, and omp's sentence is the message the notice must show. A
 * failure never cancels the run (the implementation prompt already executed):
 * it appends a warn notice carrying omp's own error sentence, or the update
 * hint for an omp without the goal command. A dropped channel means the
 * process died with the frame; nothing observable changed, so it stays quiet.
 * Success needs no notice: the goal HUD mirrors `goal_updated` into
 * `RpcTabState.goal`.
 */
export async function armPlanGoal(
  get: GetState,
  m: StoreMachinery,
  tabId: string,
  objective: string,
): Promise<void> {
  try {
    await get().rpcCommand(
      tabId,
      { type: "goal", op: "create", objective },
      { quiet: true },
    );
  } catch (err) {
    if (err instanceof RpcCommandAbandonedError) return;
    const message = err instanceof Error ? err.message : String(err);
    m.appendItem(
      tabId,
      noticeItem(
        message.startsWith(UNKNOWN_COMMAND_PREFIX)
          ? t("composer.goal.needsNewerOmp")
          : message,
        "warn",
      ),
    );
  }
}
