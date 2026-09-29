// Side questions (`/btw`) in a native tab (issue #682): what the composer's
// `/btw` line dispatches and what the Side questions rail pane calls. The
// bridge (packages/core/src/side-questions-extension.ts) owns the run and the
// history files; every verb here is a quiet hidden prompt whose answer is the
// snapshot the bridge publishes — never the ack — so the transcript gets no
// row and the busy sweep no strobe (the goal/tree precedent, issue #680).
import {
  BTW_QUESTION_CHAR_LIMIT,
  btwAskMessage,
  btwCancelMessage,
  btwRefreshMessage,
  type BtwSnapshot,
} from "@omp-ui/core/side-questions";
import { t } from "../../lib/i18n";
import { randomId } from "../../lib/random-id";
import type { UiStore } from "../types";
import type { GetState, StoreMachinery } from "./shared";

export type SideQuestionsSlice = Pick<
  UiStore,
  | "runSideQuestionCommand"
  | "askSideQuestion"
  | "cancelSideQuestion"
  | "refreshSideQuestions"
>;

/** Whole hidden bridge frames ride quiet prompts: allowed while booting, no command row. */
const QUIET = { allowDuringBoot: true, quiet: true } as const;

export function createSideQuestionsSlice(
  get: GetState,
  m: StoreMachinery,
): SideQuestionsSlice {
  /** A refusal line the pane shows until the bridge's next publish replaces it. */
  const refuse = (tabId: string, busy: string): void => {
    const current = get().rpc[tabId]?.sideQuestions;
    const next: BtwSnapshot = {
      available: current?.available ?? true,
      ...(current?.unavailableReason !== undefined
        ? { unavailableReason: current.unavailableReason }
        : {}),
      busy,
      active: current?.active ?? null,
      topics: current?.topics ?? [],
      publishedAt: current?.publishedAt ?? 0,
    };
    m.patchRpc(tabId, { sideQuestions: next });
  };

  /** Sends one hidden bridge frame; a frame that never reached the bridge cannot be answered by a snapshot. */
  const send = async (tabId: string, message: string): Promise<boolean> => {
    const resp = await m.runCommand(tabId, { type: "prompt", message }, QUIET);
    if (resp !== null) return true;
    refuse(tabId, t("rail.btw.sendFailed"));
    return false;
  };

  const askSideQuestion = async (
    tabId: string,
    question: string,
    topicId?: string,
  ): Promise<void> => {
    const text = question.trim();
    if (text === "") return;
    if (text.length > BTW_QUESTION_CHAR_LIMIT) {
      refuse(tabId, t("rail.btw.tooLong", { limit: BTW_QUESTION_CHAR_LIMIT }));
      return;
    }
    // One at a time, no queue: refused locally for instant feedback; the
    // bridge enforces the same rule as the truth.
    if (get().rpc[tabId]?.sideQuestions?.active != null) {
      refuse(tabId, t("rail.btw.busy"));
      return;
    }
    await send(
      tabId,
      btwAskMessage({
        requestId: randomId(),
        question: text,
        ...(topicId !== undefined ? { topicId } : {}),
      }),
    );
  };

  const cancelSideQuestion = async (tabId: string): Promise<void> => {
    await send(tabId, btwCancelMessage({ requestId: randomId() }));
  };

  const refreshSideQuestions = async (tabId: string): Promise<void> => {
    await send(tabId, btwRefreshMessage({ requestId: randomId() }));
  };

  const runSideQuestionCommand = async (
    tabId: string,
    line: string,
  ): Promise<void> => {
    const question = line.trim().replace(/^\/btw\b/, "").trim();
    // The pane is the surface: no transcript row for either form, and the
    // pane opens first so the answer streams into a visible card.
    get().focusRailPane(tabId, "btw");
    if (question === "") {
      await refreshSideQuestions(tabId);
      return;
    }
    await askSideQuestion(tabId, question);
  };

  return {
    runSideQuestionCommand,
    askSideQuestion,
    cancelSideQuestion,
    refreshSideQuestions,
  };
}
