// Side questions (`/btw`) in a native tab (issue #775): what the composer's
// `/btw` line dispatches and what the Side questions rail pane calls. omp ≥
// 18.6.3 owns the run and the `btw-history/` files natively (upstream #14110);
// every verb here is a quiet native command whose truth arrives as the
// `btw_delta`/`btw_record` frames frame-reduction applies — never the ack — so
// the transcript gets no row and the busy sweep no strobe (the goal/tree
// precedent, issue #680). Below the version floor the pane shows itself
// unavailable and nothing is dispatched. A `side: true` file slash command
// (issue #955) is rendered by the side-commands bridge through a hidden prompt,
// then asked through the same native `btw`, titled by the typed command.
import {
  BTW_QUESTION_CHAR_LIMIT,
  applyBtwRecord,
  btwSnapshotFromRecords,
  type BtwSnapshot,
  parseBtwRecord,
} from "@omp-ui/core/side-questions";
import {
  SIDE_COMMANDS_COMMAND,
  type SideCommandFailure,
  type SideCommandsSnapshot,
  sideCommandRenderMessage,
  sideCommandTitle,
} from "@omp-ui/core/side-commands";
import { field } from "../../lib/fields";
import { t } from "../../lib/i18n";
import { supportsNativeBtw } from "../../lib/native-btw";
import { randomId } from "../../lib/random-id";
import {
  loadSideQuestionTitles,
  rememberSideQuestionTitle,
} from "../../lib/side-question-titles";
import { isNewerSnapshot } from "../snapshot-acceptance";
import type { UiStore } from "../types";
import type { GetState, SetState, StoreMachinery } from "./shared";
import { respData } from "./shared";

export type SideQuestionsSlice = Pick<
  UiStore,
  | "runSideQuestionCommand"
  | "askSideQuestion"
  | "cancelSideQuestion"
  | "refreshSideQuestions"
  | "sideQuestionTitles"
  | "runSideCommand"
  | "refreshSideCommands"
>;

/** Whole native commands ride quiet dispatch: allowed while booting, no command row. */
const QUIET = { allowDuringBoot: true, quiet: true } as const;

/** A refusal line the pane shows until the next snapshot-producing publish replaces it. */
export function refuseSideQuestion(
  tabId: string,
  busy: string,
  get: GetState,
  m: StoreMachinery,
): void {
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
}

/** The pane's busy line for a side command the bridge could not turn into a question. */
function sideCommandFailureText(
  reason: SideCommandFailure,
  message: string | null,
  title: string,
): string {
  switch (reason) {
    case "too-long":
      return t("rail.btw.tooLong", { limit: BTW_QUESTION_CHAR_LIMIT });
    case "empty":
      return t("rail.btw.sideCommandEmpty", { command: title });
    case "not-side":
      return t("rail.btw.sideCommandGone", { command: title });
    case "render-failed":
      return t("rail.btw.sideCommandFailed", {
        command: title,
        message: message ?? "",
      });
  }
}

/**
 * The one acceptance rule for a side-commands snapshot (issue #955), under the
 * same `isNewerSnapshot` revision/processKey rule as vibe snapshots. A render
 * result addressed to this tab's pending request becomes the native `btw`
 * question, titled by the typed command, or the pane's refusal line.
 */
export function acceptSideCommandsSnapshot(
  tabId: string,
  snapshot: SideCommandsSnapshot,
  get: GetState,
  m: StoreMachinery,
): void {
  if (!isNewerSnapshot(get().rpc[tabId]?.sideCommands ?? null, snapshot))
    return;
  m.patchRpc(tabId, { sideCommands: snapshot });
  const result = snapshot.result;
  if (result === null) return;
  const requests = m.runtime(tabId).sideCommandRequests;
  const title = requests.get(result.requestId);
  if (title === undefined) return; // another client's request, or a re-arm republish
  requests.delete(result.requestId);
  if (result.ok) {
    void get().askSideQuestion(tabId, result.question, undefined, title);
    return;
  }
  refuseSideQuestion(
    tabId,
    sideCommandFailureText(result.reason, result.message, title),
    get,
    m,
  );
}

export function createSideQuestionsSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
): SideQuestionsSlice {
  const askSideQuestion = async (
    tabId: string,
    question: string,
    topicId?: string,
    title?: string,
  ): Promise<void> => {
    const text = question.trim();
    if (text === "") return;
    if (text.length > BTW_QUESTION_CHAR_LIMIT) {
      refuseSideQuestion(
        tabId,
        t("rail.btw.tooLong", { limit: BTW_QUESTION_CHAR_LIMIT }),
        get,
        m,
      );
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
      refuseSideQuestion(tabId, t("rail.btw.busy"), get, m);
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
      refuseSideQuestion(tabId, t("rail.btw.sendFailed"), get, m);
      return;
    }
    // The response record may be absent or malformed — then do nothing local;
    // the btw_record/btw_delta frames carry the truth.
    const parsed = parseBtwRecord(
      JSON.stringify(field(respData(resp), "record") ?? null),
    );
    if (parsed !== null) {
      // A side command's topic is titled by what the user typed: rpc strips
      // omp's own title (issue #955). Follow-ups keep the topic's title.
      if (title !== undefined && topicId === undefined) {
        set({ sideQuestionTitles: rememberSideQuestionTitle(parsed.id, title) });
      }
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
      refuseSideQuestion(tabId, t("rail.btw.sendFailed"), get, m);
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
      refuseSideQuestion(tabId, t("rail.btw.sendFailed"), get, m);
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

  const refreshSideCommands = async (tabId: string): Promise<void> => {
    await m.runBridgeCommand(tabId, SIDE_COMMANDS_COMMAND, "", QUIET);
  };

  const runSideCommand = async (
    tabId: string,
    name: string,
    args: string,
  ): Promise<void> => {
    // The pane is the surface, opened first like /btw (issue #775).
    get().focusRailPane(tabId, "btw");
    if (args.length > BTW_QUESTION_CHAR_LIMIT) {
      refuseSideQuestion(
        tabId,
        t("rail.btw.tooLong", { limit: BTW_QUESTION_CHAR_LIMIT }),
        get,
        m,
      );
      return;
    }
    if (
      !supportsNativeBtw(get().rpc[tabId]?.capabilities?.ompVersion ?? null)
    )
      return;
    if (get().rpc[tabId]?.sideQuestions?.active != null) {
      refuseSideQuestion(tabId, t("rail.btw.busy"), get, m);
      return;
    }
    const requestId = randomId();
    const requests = m.runtime(tabId).sideCommandRequests;
    requests.set(requestId, sideCommandTitle(name, args));
    const resp = await m.runCommand(
      tabId,
      {
        type: "prompt",
        message: sideCommandRenderMessage({ requestId, name, args }),
      },
      QUIET,
    );
    // The result rides the bridge's status frame, which omp sends before this ack.
    if (resp === null && requests.delete(requestId)) {
      refuseSideQuestion(tabId, t("rail.btw.sendFailed"), get, m);
    }
  };

  return {
    sideQuestionTitles: loadSideQuestionTitles(),
    runSideQuestionCommand,
    askSideQuestion,
    cancelSideQuestion,
    refreshSideQuestions,
    runSideCommand,
    refreshSideCommands,
  };
}
