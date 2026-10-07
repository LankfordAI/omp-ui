// Side questions (`/btw`) in a native tab (issue #775): what the composer's
// `/btw` line dispatches and what the Side questions rail pane calls. omp ≥
// 18.6.3 owns the run and the `btw-history/` files natively (upstream #14110);
// every verb here is a quiet native command whose truth arrives as the
// `btw_delta`/`btw_record` frames frame-reduction applies — never the ack — so
// the transcript gets no row and the busy sweep no strobe (the goal/tree
// precedent, issue #680). Below the version floor the pane shows itself
// unavailable and nothing is dispatched.
import {
  BTW_QUESTION_CHAR_LIMIT,
  applyBtwRecord,
  btwSnapshotFromRecords,
  type BtwSnapshot,
  parseBtwRecord,
} from "@omp-ui/core/side-questions";
import { field } from "../../lib/fields";
import { t } from "../../lib/i18n";
import { supportsNativeBtw } from "../../lib/native-btw";
import type { UiStore } from "../types";
import type { GetState, StoreMachinery } from "./shared";
import { respData } from "./shared";

export type SideQuestionsSlice = Pick<
  UiStore,
  | "runSideQuestionCommand"
  | "askSideQuestion"
  | "cancelSideQuestion"
  | "refreshSideQuestions"
>;

/** Whole native commands ride quiet dispatch: allowed while booting, no command row. */
const QUIET = { allowDuringBoot: true, quiet: true } as const;

export function createSideQuestionsSlice(
  get: GetState,
  m: StoreMachinery,
): SideQuestionsSlice {
  /** A refusal line the pane shows until the next snapshot-producing publish replaces it. */
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
    // An omp below the native-command floor cannot answer: silence here, the
    // pane renders the unavailable line. Checked before the busy rule so an
    // unsupported omp never sees a false refusal.
    if (
      !supportsNativeBtw(get().rpc[tabId]?.capabilities?.ompVersion ?? null)
    )
      return;
    // One at a time, no queue: refused locally for instant feedback; omp
    // enforces the same rule as the truth (its refusal surfaces as sendFailed).
    if (get().rpc[tabId]?.sideQuestions?.active != null) {
      refuse(tabId, t("rail.btw.busy"));
      return;
    }
    const resp = await m.runCommand(
      tabId,
      {
        type: "btw",
        question: text,
        ...(topicId !== undefined ? { recordId: topicId } : {}),
      },
      QUIET,
    );
    if (resp === null) {
      refuse(tabId, t("rail.btw.sendFailed"));
      return;
    }
    // The response record may be absent or malformed — then do nothing local;
    // the btw_record/btw_delta frames carry the truth.
    const parsed = parseBtwRecord(
      JSON.stringify(field(respData(resp), "record") ?? null),
    );
    if (parsed !== null) {
      m.patchRpc(tabId, {
        sideQuestions: applyBtwRecord(
          get().rpc[tabId]?.sideQuestions ?? null,
          parsed,
        ),
      });
    }
  };

  const cancelSideQuestion = async (tabId: string): Promise<void> => {
    const resp = await m.runCommand(tabId, { type: "btw_cancel" }, QUIET);
    if (resp === null) {
      refuse(tabId, t("rail.btw.sendFailed"));
      return;
    }
    // The turn finished before the cancel landed: omp says nothing was
    // cancelled, so the final record may already exist unseen — refresh heals.
    if (field(respData(resp), "cancelled") === false)
      void refreshSideQuestions(tabId);
  };

  const refreshSideQuestions = async (tabId: string): Promise<void> => {
    if (
      !supportsNativeBtw(get().rpc[tabId]?.capabilities?.ompVersion ?? null)
    )
      return;
    const resp = await m.runCommand(tabId, { type: "get_btw_history" }, QUIET);
    if (resp === null) {
      refuse(tabId, t("rail.btw.sendFailed"));
      return;
    }
    const records = field(respData(resp), "records");
    if (!Array.isArray(records)) return;
    m.patchRpc(tabId, {
      sideQuestions: btwSnapshotFromRecords(records, Date.now()),
    });
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
