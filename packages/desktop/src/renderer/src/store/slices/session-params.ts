// Session parameter domain (decomposed for #295): prompting, slash commands,
// and every per-session parameter command — model, advisor, modes, retry,
// compaction, plan, todos, refreshes, subagent drill-down.
import type { ApprovalMode, BackendState, ImageAttachment, ServiceTier } from "@omp-ui/core/types";
import { ADVISOR_STATS_COMMAND } from "@omp-ui/core/advisor-stats";
import { LIMITS_COMMAND } from "@omp-ui/core/limits";
import { isHtmlPlanPath, planMessage } from "@omp-ui/core/plan";
import { parseExperimentProposalTitle } from "@omp-ui/core/autoresearch";
import { parseApprovalPrompt } from "@omp-ui/core/approval";
import {
  goalOwnsSession as coreGoalOwnsSession,
  guidedGoalPrompt,
  parseGoalState,
} from "@omp-ui/core/goal";
import { goalDetails } from "../../lib/goal-format";
import {
  VIBE_ARGS_BYTE_LIMIT,
  vibeMessage,
  type VibeCommandRequest,
  type VibeSubcommand,
} from "@omp-ui/core/vibe";
import { backend, backendFor } from "../../backend";
import { withAttachmentRoutingContext } from "../../lib/attachment-routing";
import { withDocumentContext, type DocumentRef } from "../../lib/document-context";
import { DOCUMENT_MIME } from "../../lib/clipboard-image";
import { t, type MessageKey } from "../../lib/i18n";
import { projectKey } from "../../lib/project-key";
import { hasSeenSharePrivacy } from "../../lib/share-privacy";
import { supportsRestoreQueue } from "../../lib/queue-chip";
import { parseRestoreResult, projectImages, splitQueuedWireText } from "../../lib/queue-restore";
import { arrField, boolField, field, numField, strField } from "../../lib/fields";
import {
  parseModelInfo,
  parseSessionStats,
  parseSubagents,
  parseTodoPhases,
  type ModelInfo,
  type PromptRoute,
  type TodoPhase,
} from "../../lib/rpc-types";
import {
  commandItem,
  historyToItems,
  markerItem,
  noticeItem,
  shellItem,
  type CommandItem,
  type ShellItem,
} from "../../lib/transcript";
import {
  correlatePromptEntry,
  discardedEntryCount,
  entryUserPrompt,
} from "../../lib/session-rewind";
import {
  parseTreeSnapshot,
  TREE_STATUS_KEY,
  treeNavigateMessage,
  type TreeSnapshot,
} from "@omp-ui/core/session-tree";
import { randomId, randomUuid } from "../../lib/random-id";
import {
  bumpLiveVoiceGeneration,
  cancelLiveSwitch,
  claimLiveSwitch,
  clearLiveWorkTimers,
  finishLiveSwitch,
  liveVoiceGeneration,
  planReviewGateKey,
  type LiveSwitchEntry,
  type LiveSwitchRequest,
} from "./live-work-park";
import {
  COMPACT_SETTLE_DEADLINE_MS,
  RPC_COMMAND_TIMEOUT_MS,
  RpcCommandAbandonedError,
  dropPlanHandoff,
  peekTabRuntime,
  respData,
  setRewindPrefill,
  takeRewindPrefill,
  type GetState,
  type SetState,
  type StoreMachinery,
  type TabRuntime,
  type Watchers,
} from "./shared";
import { rpcCommandMachinery } from "./rpc-command";
import { findOwner, findRecord, sessionCwd } from "./view";
import type { SessionCommand } from "@omp-ui/core/session-command";
import {
  appendLiveRecap,
  applyLiveEnd,
  applyLivePhase,
  buildLiveInstructions,
  emptyLiveSnapshot,
  type LiveSnapshot,
  type LivePlanReviewContext,
} from "@omp-ui/core/live-voice";
import { liveAudioLocalToClient, supportsNativeLive } from "../../lib/live-voice";
import { planReviewText } from "../../lib/plan-review-text";
import type { CompactionOutcome, UiStore, WordPredictionFeedback } from "../types";

export type SessionParamsSlice = Pick<
  UiStore,
  | "advisorDefaults"
  | "acceptApprovalPrompt"
  | "answerApprovalPrompt"
  | "answerExtension"
  | "reconcilePendingDialogs"
  | "sendPrompt"
  | "abortAgent"
  | "abortAndPrompt"
  | "loadAdvisorDefaults"
  | "setSessionAdvisor"
  | "setSessionApprovalMode"
  | "setAdvisorModel"
  | "setModel"
  | "setThinkingLevel"
  | "setSteeringMode"
  | "setFollowUpMode"
  | "promoteQueuedMessage"
  | "editQueuedMessage"
  | "setInterruptMode"
  | "setAutoCompaction"
  | "setFastMode"
  | "startLiveVoice"
  | "parkLiveVoice"
  | "stopLiveVoice"
  | "setLiveMuted"
  | "clearLiveError"
  | "switchLiveVoice"
  | "reconcileLivePlanReview"
  | "explainPlanVoice"
  | "setSessionServiceTier"
  | "setServiceTier"
  | "setAutoRetry"
  | "abortRetry"
  | "compactSession"
  | "exportHtml"
  | "shareSession"
  | "branchSession"
  | "stageRewind"
  | "performRewind"
  | "performNavigate"
  | "stageRewindEntry"
  | "stageForkEntry"
  | "performFork"
  | "stageNavigate"
  | "renameSessionTo"
  | "regenerateSessionTitle"
  | "setPlanMode"
  | "runSlashCommand"
  | "runShellCommand"
  | "abortShellCommands"
  | "predictWord"
  | "sendWordPredictionFeedback"
  | "runGoalCommand"
  | "runVibeCommand"
  | "runHiddenCommand"
  | "setTodos"
  | "refreshState"
  | "refreshStats"
  | "refreshAdvisorStats"
  | "refreshLimits"
  | "refreshSubagents"
  | "openSubagent"
  | "closeSubagent"
>;

export interface SessionParamsDeps extends Watchers {
  prepareRpcRelaunch(tabId: string): void;
}

/** Whole parameter actions, including their authoritative registry write. */
const pendingSessionParameterActions = new Map<string, Set<Promise<void>>>();

type LocalCommandResult = false | void | Promise<void>;

interface LocalCommand {
  readonly match: RegExp;
  /** `line` is the trimmed slash line, so a family can read its own arguments. */
  run(tabId: string, get: GetState, line: string): LocalCommandResult;
}

/** omp's dispatch answer for a command its build does not know (rpc-mode.ts). */
const UNKNOWN_COMMAND_PREFIX = "Unknown command:";

/** What one `/goal` or `/guided-goal` line asks for, before anything is sent. */
type GoalIntent =
  | { kind: "show" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "drop" }
  | { kind: "create"; objective: string; budget: number | undefined; replace: boolean }
  | { kind: "guided"; rough: string }
  | { kind: "invalid"; error: string };

const GOAL_SUBCOMMANDS = ["set", "show", "pause", "resume", "drop"] as const;

/**
 * Parses one goal-family line (ADR-0046). The budget rides creation only —
 * `[--budget N] <objective>` — because omp sets a goal's budget when it is
 * created and has no op to change it afterwards.
 */
function parseGoalLine(name: string, args: string): GoalIntent {
  const text = args.trim();
  if (name === "guided-goal") return { kind: "guided", rough: text };
  if (text === "") return { kind: "show" };
  const spaceAt = text.search(/\s/);
  const head = (spaceAt === -1 ? text : text.slice(0, spaceAt)).toLowerCase();
  const rest = spaceAt === -1 ? "" : text.slice(spaceAt + 1).trim();
  if (head === "budget") return { kind: "invalid", error: t("composer.goal.budgetAtCreate") };
  const sub = GOAL_SUBCOMMANDS.find((candidate) => candidate === head);
  if (sub === undefined) return parseGoalObjective(text, false);
  if (sub === "set") {
    if (rest === "") return { kind: "invalid", error: t("composer.goal.needsObjective") };
    return parseGoalObjective(rest, true);
  }
  if (rest !== "") return { kind: "invalid", error: t("composer.goal.noArgs", { sub }) };
  return { kind: sub };
}

function parseGoalObjective(text: string, replace: boolean): GoalIntent {
  if (!/^--budget(?:\s|$)/.test(text)) {
    return { kind: "create", objective: text, budget: undefined, replace };
  }
  const match = /^--budget\s+(\S+)\s+([\s\S]*\S[\s\S]*)$/.exec(text);
  const raw = match?.[1];
  const objective = match?.[2]?.trim();
  const budget = raw !== undefined && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
  if (objective === undefined || !Number.isSafeInteger(budget)) {
    return { kind: "invalid", error: t("composer.goal.badBudget") };
  }
  return { kind: "create", objective, budget, replace };
}

/** Renderer-owned commands, in the order they take precedence over omp. */
const localCommands: readonly LocalCommand[] = [
  {
    // omp-ui's own /new: a new live session in a new tab, not omp's in-process
    // lineage switch (that stays on the HUD's new-session button and in terminal
    // tabs' TUI). Bare command only — "/new …" still reaches omp verbatim.
    match: /^\/new$/,
    run(tabId, get) {
      const projectCwd = get().tabs.find(
        (tab) => tab.tabId === tabId,
      )?.projectCwd;
      // A composer only exists for a mounted tab; without one, keep the old path.
      if (projectCwd === undefined) return false;
      return get().newSession(projectCwd);
    },
  },
  // omp-ui's plan toggle: omp's /plan is TUI-only, so over rpc it would
  // reach the model as literal prompt text and start an agent turn
  // (ADR-0007). Bare forms only — "/plan …" with any other argument still
  // reaches omp verbatim, and a pty tab's TUI owns its own /plan.
  {
    match: /^\/plan(?:\s+on)?$/,
    run(tabId, get) {
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.mode !== "rpc-ui") return false;
      return get().setPlanMode(tabId, true);
    },
  },
  {
    match: /^\/(?:plan\s+off|no-plan)$/,
    run(tabId, get) {
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.mode !== "rpc-ui") return false;
      return get().setPlanMode(tabId, false);
    },
  },
  {
    // omp's goal family is TUI-only as slash text: over rpc a `/goal` line
    // would reach the model as literal prompt text (issue #381). A native tab
    // drives omp's native goal command instead (ADR-0046); a terminal tab's
    // TUI keeps omp's own implementation.
    match: /^\/(?:goal|guided-goal)(?:\s[\s\S]*)?$/,
    run(tabId, get, line) {
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.mode !== "rpc-ui") return false;
      return get().runGoalCommand(tabId, line);
    },
  },
  {
    // omp's /vibe is TUI-only: over rpc the line would reach the model as
    // literal prompt text (issue #683). A native tab drives the root vibe
    // bridge instead; a terminal tab's TUI keeps omp's own implementation.
    match: /^\/vibe(?:\s[\s\S]*)?$/i,
    run(tabId, get, line) {
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.mode !== "rpc-ui") return false;
      return get().runVibeCommand(tabId, line);
    },
  },
  {
    // omp's /btw is TUI-only: over rpc the line would reach the model as
    // literal prompt text (issue #682). A native tab dispatches omp's native
    // `btw` command instead (issue #775); a terminal tab's TUI keeps omp's
    // own implementation.
    match: /^\/btw(?:\s[\s\S]*)?$/,
    run(tabId, get, line) {
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.mode !== "rpc-ui") return false;
      return get().runSideQuestionCommand(tabId, line);
    },
  },
  // omp-ui's autoresearch surfaces (ADR-0030, #567): `start` is the New
  // experiment dialog (its own agent interview with text), `lab` the Lab.
  // Bare `/autoresearch`, `off`, `clear`, and anything else stay omp's own
  // command and reach it verbatim with the normal command lifecycle; a
  // terminal tab's TUI keeps omp's dashboard for all of them.
  {
    // Bare `start` opens the New experiment dialog; `start <text>` starts the
    // experiment interview in this tab with the text as the rough description
    // (issue #567) — the /guided-goal shape.
    match: /^\/autoresearch\s+start(?:\s+[\s\S]+)?$/i,
    run(tabId, get, line) {
      if (get().state?.experimentsEnabled !== true) return false;
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.mode !== "rpc-ui") return false;
      const text = line.replace(/^\/autoresearch\s+start/i, "").trim();
      if (text === "") {
        get().openExperimentDialog(tab.projectCwd, tab.instanceId);
        return;
      }
      return get().startExperimentInterview(tab.projectCwd, tab.instanceId, text, tabId);
    },
  },
  {
    match: /^\/autoresearch\s+lab$/i,
    run(tabId, get) {
      if (get().state?.experimentsEnabled !== true) return false;
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.mode !== "rpc-ui") return false;
      get().openLab(tab.projectCwd, tab.instanceId, { tabId });
    },
  },
  {
    // The capabilities viewer's MCP tab owns the /mcp list surface. Bare
    // forms only — every other subcommand (reauth, add, …) works over rpc
    // and reaches omp verbatim with the normal command lifecycle. The viewer
    // opens at the session's own working tree — a worktree session's
    // checkout (#325) — falling back to the tab's project root when no
    // record is loaded yet.
    match: /^\/mcp(?:\s+list)?$/,
    run(tabId, get) {
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      const scopeCwd = sessionCwd(findRecord(get().state, tabId)) ?? tab?.projectCwd;
      if (scopeCwd === undefined) return false;
      get().openCapabilitiesViewer(scopeCwd, tabId, "mcp", tab?.instanceId ?? null);
    },
  },
];

export function createSessionParamsSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
  deps: SessionParamsDeps,
): SessionParamsSlice {
  // The bodies moved from the root closure keep their original names.
  const { advisorReply: advisorReplyWatcher, stall: stallContinueWatcher } =
    deps;

  const trackSessionParameterAction = (tabId: string, action: Promise<void>): Promise<void> => {
    const actions = pendingSessionParameterActions.get(tabId) ?? new Set<Promise<void>>();
    actions.add(action);
    pendingSessionParameterActions.set(tabId, actions);
    const remove = (): void => {
      actions.delete(action);
      if (actions.size === 0) pendingSessionParameterActions.delete(tabId);
    };
    void action.then(remove, remove);
    return action;
  };


  const answerExtension = (
    tabId: string,
    request: unknown,
    response: Record<string, unknown>,
  ): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    const id =
      request !== null && typeof request === "object" && "id" in request
        ? request.id
        : undefined;
    backend.rpcSend(tabId, {
      type: "extension_ui_response",
      id,
      ...response,
    });
    m.patchRpc(tabId, {
      extensionQueue: tab.extensionQueue.filter((q) => q !== request),
    });
  };

  /**
   * Holds a live approval frame on its tab (issue #681). The OLDEST unanswered
   * frame wins: a second stacked approval while one is held is already counted
   * by main's tracker and reconciles in once the first is answered — replacing
   * the held frame would strand the runner blocked on the older one.
   */
  const acceptApprovalPrompt: SessionParamsSlice["acceptApprovalPrompt"] = (
    tabId,
    prompt,
    frame,
  ) => {
    const held = get().rpc[tabId]?.approvalPrompt;
    if (held !== undefined && held !== null) return; // replayed, or an older frame still waits
    m.patchRpc(tabId, { approvalPrompt: { prompt, frame } });
  };

  /** Answers the held approval. Exit-guarded like the experiment proposal. */
  const answerApprovalPrompt: SessionParamsSlice["answerApprovalPrompt"] = (tabId, verdict) => {
    const held = get().rpc[tabId]?.approvalPrompt;
    if (!held) return false;
    // The agent is blocked on this reply — clear only after sending. An exited
    // process has nothing to release; the card was still worth showing.
    if (get().exited[tabId] === undefined)
      backend.rpcSend(tabId, {
        type: "extension_ui_response",
        id: strField(held.frame, "id"),
        value: verdict,
      });
    m.patchRpc(tabId, { approvalPrompt: null });
    return true;
  };

  /**
   * Reconciles each open rpc tab's blocking-dialog queue against the
   * main-process-owned list on the session summary (issue #555). The record
   * wins: a frame another client answered drops out, a frame this client
   * never received is hydrated, and a late joiner sees the question its
   * sibling is showing. Idempotent — patches only when the id sequence
   * differs, so it is safe to run on every state read. Skipped entirely
   * when the host published no list (undefined), which is not the same
   * claim as "no open dialogs" (ADR-0028 version skew).
   *
   * Compare by `id`, never by object identity: broadcast frames are freshly
   * deserialized each time, while `answerExtension`'s optimistic filter
   * compares by identity against the object currently in the queue — both
   * stay correct because the queue is always internally consistent.
   *
   * A second client answering a frame main already settled is harmless and
   * deliberately unhandled: the protocol has no "revise", so the stale
   * `ext_response` forwards, the tracker's delete is a no-op, and the next
   * broadcast corrects the lagging client's queue. No per-answer reservation
   * set like `planAnswerReservations` — a plan verdict spawns an
   * implementation, a dialog answer does not. Do not "fix" this later.
   */
  const reconcilePendingDialogs = (state: BackendState): void => {
    for (const [tabId, tab] of Object.entries(get().rpc)) {
      const rec = findRecord(state, tabId);
      const pending = rec?.pendingDialogs;
      if (pending === undefined) continue;
      // A propose_experiment select is main's generic blocking dialog but the
      // renderer's experimentProposal (issue #567): split it out before the
      // queue compare, or the two lists would disagree on every pass.
      const generic: unknown[] = [];
      let proposalFrame: unknown = undefined;
      let approvalFrame: unknown = undefined;
      for (const frame of pending) {
        if (parseExperimentProposalTitle(strField(frame, "title")) !== null) proposalFrame = frame;
        // An `Allow tool:` select is main's generic blocking dialog but the
        // renderer's approvalPrompt (issue #681): same split, same reason. The
        // OLDEST held frame wins — parallel tool calls can stack — and each
        // answer releases exactly one blocked runner, the next reconciling in.
        else if (parseApprovalPrompt(strField(frame, "title"), field(frame, "options")) !== null) {
          if (approvalFrame === undefined) approvalFrame = frame;
        } else generic.push(frame);
      }
      const localIds = tab.extensionQueue.map((q) => strField(q, "id"));
      const remoteIds = generic.map((q) => strField(q, "id"));
      if (localIds.length !== remoteIds.length || localIds.some((id, i) => id !== remoteIds[i]))
        m.patchRpc(tabId, { extensionQueue: generic });
      const heldId = tab.experimentProposal === null ? undefined : strField(tab.experimentProposal.frame, "id");
      if (proposalFrame === undefined) {
        // A sibling answered it: drop ours; the dialog bound to it closes itself.
        if (tab.experimentProposal !== null) m.patchRpc(tabId, { experimentProposal: null });
      } else if (strField(proposalFrame, "id") !== heldId) {
        const proposal = parseExperimentProposalTitle(strField(proposalFrame, "title"));
        if (proposal !== null) get().acceptExperimentProposal(tabId, proposal, proposalFrame);
      }
      const heldApprovalId =
        tab.approvalPrompt === null ? undefined : strField(tab.approvalPrompt.frame, "id");
      if (approvalFrame === undefined) {
        if (tab.approvalPrompt !== null) m.patchRpc(tabId, { approvalPrompt: null });
      } else if (strField(approvalFrame, "id") !== heldApprovalId) {
        const prompt = parseApprovalPrompt(
          strField(approvalFrame, "title"),
          field(approvalFrame, "options"),
        );
        if (prompt !== null) m.patchRpc(tabId, { approvalPrompt: { prompt, frame: approvalFrame } });
      }
    }
  };

  const sendPrompt = async (
    tabId: string,
    message: string,
    route: PromptRoute = "steer",
    images?: ImageAttachment[],
    docRefs?: DocumentRef[],
  ): Promise<boolean> => {
    if (!m.acceptsCommands(tabId)) return false;
    if (route === "advisor_reply" || route === "stall_continue") {
      // omp-ui's own prompt (a late-review answer, a stall continue): it
      // must not title the session and must not re-arm either loop guard —
      // an auto-prompt is not human direction.
    } else {
      // Human direction makes a previously handed-off source active again,
      // even when its immediate hibernation was declined.
      set((state) => ({ handedOffFor: dropPlanHandoff(state.handedOffFor, tabId) }));
      // Titling reads the first substantive prompt, whichever route it took.
      get().setInitialPrompt(tabId, message);
      advisorReplyWatcher.reset(tabId);
      stallContinueWatcher.reset(tabId);
    }
    // Always the `prompt` frame, never `steer`/`follow_up`: only AgentSession.prompt
    // builds the magic-keyword notices (orchestrate/ultrathink/workflowz), so those
    // frames would silently drop the keyword mid-run. `streamingBehavior` is what
    // omp's own TUI passes, and omp ignores it while the agent is idle.
    //
    // An advisor reply rides followUp, not steer: if a turn started between the
    // settle and this send, the reply queues behind it instead of interrupting.
    const streamingBehavior =
      route === "follow_up" || route === "advisor_reply" || route === "stall_continue"
        ? "followUp"
        : "steer";
    // The document block attaches to the prose; the image routing suffix
    // stays last, preserving stripAttachmentRoutingContext's endsWith round-trip.
    const wireMessage = withAttachmentRoutingContext(
      withDocumentContext(message, docRefs ?? []),
      images?.length ?? 0,
    );
    const cmd = { type: "prompt" as const, message: wireMessage, streamingBehavior };
    // `images` is omitted entirely when empty: omp's own client sends no key
    // rather than an empty array, and every byte here is on one JSON line.
    const response = await m.runCommand(tabId, images?.length ? { ...cmd, images } : cmd);
    // The early title shot does NOT ride the ack: the ack pre-dates omp
    // committing the user message to history, so `/rename` dispatched here
    // finds an empty digest and declines (issue #795). The reducer fires it
    // at the user message's `message_start`, and the first untitled
    // `agent_end` stays the safety net for a prompt whose ack never came.
    return response !== null;
  };

  const abortAgent = async (tabId: string): Promise<void> => {
    const version = get().rpc[tabId]?.capabilities?.ompVersion ?? null;
    if (!supportsRestoreQueue(version)) {
      await m.runCommand(tabId, { type: "abort" });
      return;
    }
    // Esc and both stop controls land here (issue #776): omp withdraws every
    // user-authored steering/follow-up message and aborts the turn in one
    // verb. A rejection is recorded by runCommand and NOTHING is retried —
    // the turn was aborted by omp or it wasn't, and a second `abort` can
    // only duplicate a guess.
    const resp = await m.runCommand(tabId, { type: "abort_and_restore_queue" });
    if (resp === null) return;
    const restored = parseRestoreResult(respData(resp));
    if (restored !== null) {
      // Staging rides the existing composerQueue drain — the identical
      // plumbing rewind's edit-resend uses and the browser pane's hand-back.
      for (const entry of [...restored.steering, ...restored.followUp]) {
        const { text, documents } = splitQueuedWireText(entry.text);
        if (text !== "") get().queueComposerText(tabId, text);
        for (const image of entry.images)
          get().queueComposerAttachment(tabId, image, "");
        // Path-only re-attach: zero re-upload; a swept scratch file fails at
        // send with `document not found` and the draft survives for re-pick.
        for (const doc of documents)
          get().queueComposerDocument(
            tabId,
            { type: "document", mimeType: DOCUMENT_MIME, name: doc.name, path: doc.path },
            "",
          );
      }
      if (restored.imagesDropped)
        m.appendItem(tabId, noticeItem(t("composer.queue.restoreImagesDropped"), "info"));
      if (restored.truncated)
        m.appendItem(tabId, noticeItem(t("composer.queue.restoreTruncated"), "info"));
    }
    // The chip count/list settle now, not at the next turn end (the
    // promoteQueuedMessage `promoted:false` idiom).
    void get().refreshState(tabId);
  };

  const abortAndPrompt = async (
    tabId: string,
    message: string,
    images?: ImageAttachment[],
    docRefs?: DocumentRef[],
  ): Promise<void> => {
    if (!m.acceptsCommands(tabId)) return;
    set((state) => ({ handedOffFor: dropPlanHandoff(state.handedOffFor, tabId) }));
    get().setInitialPrompt(tabId, message);
    advisorReplyWatcher.reset(tabId);
    stallContinueWatcher.reset(tabId);
    const type = "abort_and_prompt";
    const wireMessage = withAttachmentRoutingContext(
      withDocumentContext(message, docRefs ?? []),
      images?.length ?? 0,
    );
    // The title shot rides the user message's `message_start` in the
    // reducer, same as `sendPrompt` (issue #795).
    await m.runCommand(
      tabId,
      images?.length ? { type, message: wireMessage, images } : { type, message: wireMessage },
    );
  };

  const loadAdvisorDefaults = async (
    projectCwd: string,
    instanceId: string | null = null,
  ): Promise<void> => {
    const key = projectKey(instanceId, projectCwd);
    if (get().advisorDefaults[key]) return;
    try {
      const defaults = await backendFor(instanceId).getAdvisorDefaults(projectCwd);
      set((s) => ({
        advisorDefaults: { ...s.advisorDefaults, [key]: defaults },
      }));
    } catch {
      // A missing or unreadable omp config is not an error worth a dialog —
      // the toggle just shows no inherited default.
    }
  };

  const setSessionAdvisor = async (
    tabId: string,
    advisor: boolean,
    advisorModel: string | null,
  ): Promise<void> => {
    if (!m.acceptsCommands(tabId)) return;
    const tab = get().rpc[tabId];
    const rec = findRecord(get().state, tabId);
    const changedLive =
      rec?.live === "live" &&
      rec.mode === "rpc-ui" &&
      (rec.advisor !== advisor || rec.advisorModel !== advisorModel);
    if (changedLive && tab) {
      const commandIds = rpcCommandMachinery.snapshotPending(tabId, {
        includeQuiet: false,
      });
      const parameterActions = [
        ...(pendingSessionParameterActions.get(tabId) ?? []),
      ];
      const deadline = Date.now() + RPC_COMMAND_TIMEOUT_MS + 1_000;
      m.patchRpc(tabId, { commandAdmissionBlocked: true });
      await m.pollUntil(
        tabId,
        (current) =>
          current !== undefined &&
          [...commandIds].every((id) => !rpcCommandMachinery.hasPending(tabId, id)),
        RPC_COMMAND_TIMEOUT_MS + 1_000,
      );
      const remainingMs = Math.max(0, deadline - Date.now());
      if (parameterActions.length > 0 && remainingMs > 0) {
        await Promise.race([
          Promise.allSettled(parameterActions),
          new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs)),
        ]);
      }
      const current = get().rpc[tabId];
      const commandsRemain =
        current === undefined ||
        [...commandIds].some((id) => rpcCommandMachinery.hasPending(tabId, id));
      const parametersRemain = parameterActions.some((action) =>
        pendingSessionParameterActions.get(tabId)?.has(action),
      );
      if (commandsRemain || parametersRemain) {
        if (current) m.patchRpc(tabId, { commandAdmissionBlocked: false });
        get().reportError(t("session.error.advisorBusy"));
        return;
      }
      deps.prepareRpcRelaunch(tabId);
    }
    try {
      await backend.setSessionAdvisor(tabId, advisor, advisorModel);
    } catch (err) {
      // Changing the advisor relaunches the agent, so a failure here means
      // the session is down, not merely that a setting did not stick. Say
      // that, rather than surfacing the bare IPC error. The relaunch failure
      // policy is unchanged: no claim of success, no auto-resume.
      const reason = err instanceof Error ? err.message : String(err);
      get().reportError(
        t(advisor ? "session.error.advisorEnable" : "session.error.advisorDisable", {
          reason,
        }),
      );
    }
  };

  const setSessionApprovalMode = async (
    tabId: string,
    mode: ApprovalMode | null,
  ): Promise<void> => {
    if (!m.acceptsCommands(tabId)) return;
    const tab = get().rpc[tabId];
    const rec = findRecord(get().state, tabId);
    const changedLive =
      rec?.live === "live" && rec.mode === "rpc-ui" && rec.approvalMode !== mode;
    if (changedLive && tab) {
      // Same drain as setSessionAdvisor: the relaunch must not strand a loud
      // command, and commands still pending means busy, not relaunch.
      const commandIds = rpcCommandMachinery.snapshotPending(tabId, {
        includeQuiet: false,
      });
      const parameterActions = [
        ...(pendingSessionParameterActions.get(tabId) ?? []),
      ];
      const deadline = Date.now() + RPC_COMMAND_TIMEOUT_MS + 1_000;
      m.patchRpc(tabId, { commandAdmissionBlocked: true });
      await m.pollUntil(
        tabId,
        (current) =>
          current !== undefined &&
          [...commandIds].every((id) => !rpcCommandMachinery.hasPending(tabId, id)),
        RPC_COMMAND_TIMEOUT_MS + 1_000,
      );
      const remainingMs = Math.max(0, deadline - Date.now());
      if (parameterActions.length > 0 && remainingMs > 0) {
        await Promise.race([
          Promise.allSettled(parameterActions),
          new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs)),
        ]);
      }
      const current = get().rpc[tabId];
      const commandsRemain =
        current === undefined ||
        [...commandIds].some((id) => rpcCommandMachinery.hasPending(tabId, id));
      const parametersRemain = parameterActions.some((action) =>
        pendingSessionParameterActions.get(tabId)?.has(action),
      );
      if (commandsRemain || parametersRemain) {
        if (current) m.patchRpc(tabId, { commandAdmissionBlocked: false });
        get().reportError(t("session.error.approvalBusy"));
        return;
      }
      deps.prepareRpcRelaunch(tabId);
    }
    try {
      await backend.setSessionApprovalMode(tabId, mode);
    } catch (err) {
      // Changing the approval mode relaunches the agent, so a failure here
      // means the session is down, not merely that a setting did not stick
      // (the advisor's honesty rule at the same seam).
      const reason = err instanceof Error ? err.message : String(err);
      get().reportError(t("session.error.approval", { reason }));
    }
  };

  const setAdvisorModel = async (
    tabId: string,
    selector: string | null,
  ): Promise<void> => {
    // setSessionAdvisor persists the complete advisor tuple for both this
    // session and the next one; selecting a model also enables the advisor.
    await get().setSessionAdvisor(tabId, true, selector);
  };

  const setModel = async (tabId: string, model: ModelInfo): Promise<void> => {
    if (!m.acceptsCommands(tabId)) return;
    const action = (async (): Promise<void> => {
      const resp = await m.runCommand(tabId, {
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
      if (resp === null) return;
      const selected = parseModelInfo(respData(resp)) ?? model;
      m.patchRpc(tabId, { model: selected });
      // Persist the SELECTOR, not the resolved level: under auto the store's
      // thinkingLevel is a classification output, and freezing it here would
      // silently pin the model switch to whatever the last turn resolved to.
      const session = get().rpc[tabId]?.session;
      const thinkingLevel =
        session?.thinkingConfigured === "auto"
          ? "auto"
          : session?.thinkingLevel ?? null;
      await backend.setSessionModel(
        tabId,
        `${selected.provider}/${selected.id}`,
        thinkingLevel,
      );
      // rpc.md: re-read after a model change — the set_model response carries
      // only the selected Model and no model_changed frame is handled here, so
      // this is the convergence point where fastMode* (also per-model) and the
      // session runtime re-sync.
      await refreshState(tabId);
    })();
    await trackSessionParameterAction(tabId, action);
  };

  const setThinkingLevel = async (
    tabId: string,
    level: string,
  ): Promise<void> => {
    if (!m.acceptsCommands(tabId)) return;
    const action = (async (): Promise<void> => {
      const resp = await m.runCommand(tabId, {
        type: "set_thinking_level",
        level,
      });
      if (resp === null) return;
      // A concrete set that changes nothing emits no frame, so the store must
      // update optimistically. `auto` flips only the selector — the pill's
      // concrete value stays the current resolved level until the next
      // resolution frame says otherwise. The record stores "auto" verbatim.
      m.patchSession(
        tabId,
        level === "auto"
          ? { thinkingConfigured: "auto" }
          : { thinkingLevel: level, thinkingConfigured: null },
      );
      const model = get().rpc[tabId]?.model;
      await backend.setSessionModel(
        tabId,
        model ? `${model.provider}/${model.id}` : null,
        level,
      );
    })();
    await trackSessionParameterAction(tabId, action);
  };

  const setSteeringMode = async (tabId: string, mode: string): Promise<void> => {
    const resp = await m.runCommand(tabId, { type: "set_steering_mode", mode });
    if (resp === null) return;
    m.patchSession(tabId, { steeringMode: mode });
  };

  const setFollowUpMode = async (tabId: string, mode: string): Promise<void> => {
    const resp = await m.runCommand(tabId, {
      type: "set_follow_up_mode",
      mode,
    });
    if (resp === null) return;
    m.patchSession(tabId, { followUpMode: mode });
  };

  const promoteQueuedMessage = async (tabId: string, message: string): Promise<void> => {
    // Loud: a user action. A rejection (older runtime) surfaces as the
    // command failure and nothing else is sent — a `steer` fallback would
    // enqueue a duplicate (omp docs/rpc.md).
    const resp = await m.runCommand(tabId, { type: "promote_queued_message", message });
    if (resp === null) return;
    // promoted:false means it was delivered first — not an error. Re-read
    // state so the chip count and list settle without waiting for a turn end.
    if (boolField(respData(resp), "promoted") === false) void get().refreshState(tabId);
  };

  const editQueuedMessage = async (
    tabId: string,
    message: string,
    queue: "steering" | "followUp",
  ): Promise<void> => {
    // Loud: a user action. A rejection (older runtime) surfaces as the
    // command failure and nothing else is sent — the same discipline as
    // promoteQueuedMessage, never a fallback verb (issue #776).
    const resp = await m.runCommand(tabId, { type: "remove_queued_message", message, queue });
    if (resp === null) return;
    const data = respData(resp);
    if (boolField(data, "removed") !== true) {
      // Delivered between render and click — not an error (the promote
      // `promoted:false` shape). Re-read so the list settles.
      void get().refreshState(tabId);
      return;
    }
    const { text, documents } = splitQueuedWireText(message);
    if (text !== "") get().queueComposerText(tabId, text);
    for (const image of projectImages(arrField(data, "images")))
      get().queueComposerAttachment(tabId, image, "");
    for (const doc of documents)
      get().queueComposerDocument(
        tabId,
        { type: "document", mimeType: DOCUMENT_MIME, name: doc.name, path: doc.path },
        "",
      );
    if (boolField(data, "imagesDropped") === true)
      m.appendItem(tabId, noticeItem(t("composer.queue.restoreImagesDropped"), "info"));
  };

  const setInterruptMode = async (tabId: string, mode: string): Promise<void> => {
    const resp = await m.runCommand(tabId, {
      type: "set_interrupt_mode",
      mode,
    });
    if (resp === null) return;
    m.patchSession(tabId, { interruptMode: mode });
  };

  const setAutoCompaction = async (
    tabId: string,
    enabled: boolean,
  ): Promise<void> => {
    const resp = await m.runCommand(tabId, {
      type: "set_auto_compaction",
      enabled,
    });
    if (resp === null) return;
    m.patchSession(tabId, { autoCompactionEnabled: enabled });
  };

  /** The existing RPC+patch body, unchanged: every pre-#719 setFastMode
   *  test rides this path untouched. */
  const setFastModeRpc = async (tabId: string, enabled: boolean): Promise<void> => {
    const resp = await m.runCommand(tabId, { type: "set_fast_mode", enabled });
    if (resp === null) return; // failure already recorded; state untouched
    const data = respData(resp);
    m.patchSession(tabId, {
      fastModeEnabled: boolField(data, "enabled") ?? enabled,
      ...(boolField(data, "active") !== undefined
        ? { fastModeActive: boolField(data, "active") === true }
        : {}),
    });
  };

  /**
   * omp's fast mode: `enabled` is the session setting, `active` the computed
   * truth. The response always reports both as computed values, so there is
   * no optimistic patch. A same-value enable is NOT skipped: after a direct
   * Anthropic rejection the setting is already true while `active` is false,
   * and only an explicit enable clears that sticky fallback (rpc.md).
   * Disable doubles as the single off-rail from either tier (issue #719):
   * one set_fast_mode(false) clears the whole family tier entry — priority
   * or ultrafast, the Fireworks provider tier included — and the record's
   * tier selection clears with it.
   */
  const setFastMode = async (tabId: string, enabled: boolean): Promise<void> => {
    if (enabled) return void (await setFastModeRpc(tabId, true));
    const clear = get().setSessionServiceTier(tabId, null);
    await setFastModeRpc(tabId, false);
    await clear;
  };

  /**
   * omp's live voice (issue #778). omp runs the realtime session and records
   * audio itself; these verbs only dispatch — the truth arrives as the
   * `live_*` frames frame-reduction applies, and each one carries the
   * `supportsNativeLive` gate so an older omp can never dispatch (the
   * side-questions.ts rule: gate both rendering AND dispatch).
   *
   * Park/resume (issue #811): `liveArmed` is the intent, `liveParked` the
   * call-closed-because-unviewed state; the sidebar badge mirrors both.
   */
  const livePatch = (tabId: string, next: LiveSnapshot): void => {
    m.patchRpc(tabId, { live: next });
  };

  // A late view may receive levels before a phase. An unended snapshot still
  // reports a call; a command error does not release that call's ownership.
  const hasLiveCall = (live: LiveSnapshot | null | undefined): live is LiveSnapshot =>
    live != null && !live.ended;

  // Only an in-flight explicit request may override observed mute state.
  // Tokens also keep a stopped call's late acknowledgement from restoring intent.
  const liveMuteRequests = new WeakMap<TabRuntime, object>();
  const rememberedLiveMute = (rt: TabRuntime, live: LiveSnapshot | null | undefined): boolean =>
    liveMuteRequests.has(rt) ? rt.liveUserMuted === true :
      rt.liveUserMuted === true || live?.phase === "muted";

  /** An explicit stop disarms everything the park/resume machinery owns
   *  (#811) — shared by the open-call and parked-call stop paths. */
  const clearLiveVoiceState: Partial<TabRuntime> = {
    liveArmed: false,
    liveParked: false,
    liveUserMuted: undefined,
    liveRecap: [],
    livePendingFeedback: [],
    liveCallSawDelegation: false,
    liveOrphanRestart: false,
    livePendingIncluded: undefined,
    // #815: an explicit stop disarms work-parking too — no wake follows.
    liveWorkPark: false,
    liveOutputLoudAt: undefined,
    liveReviewTextCache: undefined,
    liveReviewAppliedSourceKey: null,
    liveReviewAutoRequestedGateKey: undefined,
    liveReviewExplicitBriefingKey: undefined,
    liveReviewFailedSourceKey: undefined,
    liveMuteRequestGeneration: undefined,
  };

  /** Exact loaded bytes are projected once per source, never from a second read. */
  const readyLiveReview = (tabId: string, rt: TabRuntime, cache = true): {
    sourceKey: string;
    gateKey: string;
    context: LivePlanReviewContext;
  } | null => {
    const tab = get().rpc[tabId];
    const review = tab?.planReview;
    const sourceKey = tab?.planSourceKey;
    if (tab === undefined || review === null || review === undefined ||
      sourceKey === null || sourceKey === undefined) return null;
    const html = isHtmlPlanPath(review.request.planFilePath);
    const source = html ? tab.planHtml : tab.planText;
    if (source === null || source.trim() === "") return null;
    if (html && (tab.planReadiness?.sourceKey !== sourceKey ||
      tab.planReadiness.status !== "ready" ||
      (review.request.sourceHash !== undefined &&
        tab.planReadiness.identity !== review.request.sourceHash))) return null;
    let text = rt.liveReviewTextCache?.sourceKey === sourceKey
      ? rt.liveReviewTextCache.text : undefined;
    if (text === undefined) {
      try {
        text = planReviewText(source, html ? "html" : "markdown");
      } catch {
        text = "";
      }
      if (cache) m.patchRuntime(tabId, { liveReviewTextCache: { sourceKey, text } });
    }
    if (text.trim() === "") return null;
    return {
      sourceKey,
      gateKey: planReviewGateKey(review),
      context: {
        title: review.request.title,
        planFilePath: review.request.planFilePath,
        sourceHash: review.request.sourceHash,
        text,
        briefOverview: false,
      },
    };
  };

  const publishPlanVoice = (tabId: string): void => {
    const tab = get().rpc[tabId];
    const rt = peekTabRuntime(tabId);
    if (tab === undefined || rt === undefined) return;
    const review = readyLiveReview(tabId, rt, rt.liveArmed === true);
    const ownedElsewhere = hasLiveCall(tab.live) && rt.liveVoiceOwner !== true &&
      rt.liveStartInFlight === undefined;
    const unavailable = tab.planSourceKey != null && review === null &&
      (!isHtmlPlanPath(tab.planReview?.request.planFilePath) ||
        tab.planReadiness?.status === "ready" || tab.planReadiness?.status === "failed" ||
        tab.planReadiness?.status === "unavailable");
    const error = ownedElsewhere ? t("plan.review.voiceOwnedElsewhere") :
      unavailable ? t("plan.review.voiceUnavailable") :
        tab.planSourceKey == null ? tab.planVoice.error : null;
    const next = {
      ready: review !== null,
      busy: rt.liveStartInFlight !== undefined || rt.liveStopInFlight !== undefined,
      error: tab.planReview === null ? null : error,
    };
    if (tab.planVoice.ready !== next.ready || tab.planVoice.busy !== next.busy ||
      tab.planVoice.error !== next.error) m.patchRpc(tabId, { planVoice: next });
  };

  /** Both the promise slot and its cleanup are scoped to one process lifetime. */
  const trackLiveDispatch = (
    tabId: string,
    rt: TabRuntime,
    field: "liveStartInFlight" | "liveStopInFlight",
    dispatch: Promise<unknown>,
  ): Promise<unknown> => {
    const tracked = dispatch.finally(() => {
      if (peekTabRuntime(tabId) === rt && rt[field] === tracked) {
        m.patchRuntime(tabId, { [field]: undefined });
        publishPlanVoice(tabId);
      }
    });
    if (peekTabRuntime(tabId) === rt) {
      m.patchRuntime(tabId, { [field]: tracked });
      publishPlanVoice(tabId);
    }
    return tracked;
  };

  const liveAdmitted = (tabId: string): boolean => {
    const tab = get().rpc[tabId];
    return tab !== undefined && tab.status !== "error" && m.acceptsCommands(tabId) &&
      get().exited[tabId] === undefined &&
      supportsNativeLive(tab.capabilities?.ompVersion ?? null);
  };

  const dispatchLiveStart = async (
    tabId: string,
    rt: TabRuntime,
    valid: (startedHere?: boolean) => boolean,
    request?: LiveSwitchRequest,
    opts?: { instructions?: string },
  ): Promise<void> => {
    if (!valid() || !liveAdmitted(tabId) || rt.liveStartInFlight !== undefined) return;
    // #816: live_start arms the *host's* microphone; only a client that is
    // the host may dispatch it. Render gates already hide the control —
    // this closes the store-level path (handoff carry-over, hotkeys, any
    // future caller).
    if (!liveAudioLocalToClient(findOwner(get().state, tabId)?.instanceId ?? null)) return;
    if (rt.liveStopInFlight !== undefined) {
      const stopped = await rt.liveStopInFlight.catch(() => null);
      if (stopped === null || !valid() || !liveAdmitted(tabId)) return;
    }
    if (rt.liveStartInFlight !== undefined || hasLiveCall(get().rpc[tabId]?.live)) return;
    const review = readyLiveReview(tabId, rt);
    if (opts?.instructions === undefined && get().rpc[tabId]?.planReview !== null && review === null) return;
    // Requested mute is intent; observed phase is still omp's UI truth.
    // Choose speech only now, after all waits, and claim immediately before dispatch.
    const muted = rt.liveUserMuted === true || get().rpc[tabId]?.live?.phase === "muted";
    const briefOverview = opts?.instructions === undefined && review !== null &&
      get().rpc[tabId]?.planDeferred !== true &&
      (request?.briefOverview === true ||
        (!muted && rt.liveReviewAutoRequestedGateKey !== review.gateKey));
    const built = opts?.instructions !== undefined
      ? { instructions: opts.instructions, pendingUsed: 0 }
      : buildLiveInstructions({
          recap: rt.liveRecap,
          pending: rt.livePendingFeedback,
          review: review === null ? undefined : { ...review.context, briefOverview },
        });
    if (!valid() || !liveAdmitted(tabId)) return;
    const generation = liveVoiceGeneration(tabId);
    if (briefOverview && review !== null)
      m.patchRuntime(tabId, { liveReviewAutoRequestedGateKey: review.gateKey });
    const beforeStart = get().rpc[tabId]?.live;
    const resp = await trackLiveDispatch(tabId, rt, "liveStartInFlight",
      m.runCommand(tabId, { type: "live_start", instructions: built.instructions }, { quiet: true }));
    if (!valid(resp !== null) || liveVoiceGeneration(tabId) !== generation || !liveAdmitted(tabId)) {
      // A late successful call is closed without restoring intent or markers.
      // A new process with the same id is not this call's lifetime.
      if (resp !== null && peekTabRuntime(tabId) === rt && rt.liveStopInFlight === undefined) {
        const closing = get().rpc[tabId]?.live;
        void trackLiveDispatch(tabId, rt, "liveStopInFlight",
          m.runCommand(tabId, { type: "live_stop" }, { quiet: true }).then((stopped) => {
            const current = get().rpc[tabId]?.live;
            if (peekTabRuntime(tabId) !== rt || current?.connectionId !== closing?.connectionId)
              return stopped;
            if (stopped === null) {
              m.patchRuntime(tabId, {
                liveReviewFailedSourceKey: get().rpc[tabId]?.planSourceKey ?? null,
              });
              livePatch(tabId, { ...(current ?? emptyLiveSnapshot()), error: t("composer.live.sendFailed") });
            } else if (current !== null && current !== undefined) {
              livePatch(tabId, applyLiveEnd(current, null));
            }
            return stopped;
          }));
      }
      return;
    }
    m.patchRuntime(tabId, { liveReviewExplicitBriefingKey: undefined });
    if (resp === null) {
      m.patchRuntime(tabId, { liveReviewFailedSourceKey: review?.sourceKey ?? null });
      livePatch(tabId, { ...emptyLiveSnapshot(), ended: true, error: t("composer.live.sendFailed") });
      publishPlanVoice(tabId);
      return;
    }
    m.patchRuntime(tabId, {
      liveVoiceOwner: true,
      liveArmed: true,
      liveParked: false,
      liveCallSawDelegation: false,
      liveOrphanRestart: false,
      livePendingIncluded: built.pendingUsed,
      liveReviewAppliedSourceKey: opts?.instructions === undefined ? review?.sourceKey ?? null : null,
      liveReviewFailedSourceKey: undefined,
    });
    m.syncLiveVoiceBadge(tabId);
    const reported = get().rpc[tabId]?.live;
    livePatch(tabId, {
      ...(reported != null && reported !== beforeStart
        ? reported : applyLivePhase(emptyLiveSnapshot(), "connecting")),
      connectionId: randomUuid(),
    });
    if (rt.liveUserMuted === true) void setLiveMuted(tabId, true);
    reconcileLivePlanReview(tabId);
  };

  const startLiveVoice = async (tabId: string, opts?: { instructions?: string }): Promise<void> => {
    if (get().activeTabId !== tabId || !liveAdmitted(tabId) || hasLiveCall(get().rpc[tabId]?.live)) return;
    const rt = m.runtime(tabId);
    const generation = liveVoiceGeneration(tabId);
    const sourceKey = get().rpc[tabId]?.planSourceKey ?? null;
    const gateKey = get().rpc[tabId]?.planReview;
    const valid = (): boolean => peekTabRuntime(tabId) === rt &&
      liveVoiceGeneration(tabId) === generation && get().activeTabId === tabId &&
      (opts?.instructions !== undefined ||
        (get().rpc[tabId]?.planSourceKey === sourceKey && get().rpc[tabId]?.planReview === gateKey));
    m.patchRuntime(tabId, { liveReviewFailedSourceKey: undefined });
    await dispatchLiveStart(tabId, rt, valid, undefined, opts);
  };

  /** Fold once and wait for the exact stop. Never let an old ack end a new call. */
  const parkLiveCall = async (tabId: string): Promise<boolean> => {
    if (!liveAdmitted(tabId)) return false;
    const live = get().rpc[tabId]?.live;
    const rt = peekTabRuntime(tabId);
    if (rt === undefined) return false;
    if (!hasLiveCall(live)) return true;
    if (rt.liveStopInFlight !== undefined) {
      const resp = await rt.liveStopInFlight.catch(() => null);
      return resp !== null && peekTabRuntime(tabId) === rt;
    }
    if (rt.liveParked === true) return false;
    clearLiveWorkTimers(tabId);
    m.patchRuntime(tabId, {
      liveRecap: appendLiveRecap(rt.liveRecap, live.turns),
      liveUserMuted: rememberedLiveMute(rt, live),
      liveParked: true,
    });
    m.syncLiveVoiceBadge(tabId);
    const resp = await trackLiveDispatch(tabId, rt, "liveStopInFlight",
      m.runCommand(tabId, { type: "live_stop" }, { quiet: true }));
    const current = get().rpc[tabId]?.live;
    if (peekTabRuntime(tabId) !== rt || current === null || current === undefined ||
      current.connectionId !== live.connectionId) return false;
    if (resp === null) {
      m.patchRuntime(tabId, {
        liveParked: false,
        liveReviewFailedSourceKey: get().rpc[tabId]?.planSourceKey ?? null,
      });
      m.syncLiveVoiceBadge(tabId);
      livePatch(tabId, { ...current, error: t("composer.live.sendFailed") });
      return false;
    }
    livePatch(tabId, applyLiveEnd(current, null));
    publishPlanVoice(tabId);
    return true;
  };

  const parkLiveVoice = async (tabId: string): Promise<void> => {
    await parkLiveCall(tabId);
  };

  const switchPassValid = (tabId: string, entry: LiveSwitchEntry, request: LiveSwitchRequest, startedHere = false): boolean => {
    const rt = peekTabRuntime(tabId);
    const tab = get().rpc[tabId];
    if (rt === undefined || rt !== entry.runtime || liveVoiceGeneration(tabId) !== entry.generation ||
      !liveAdmitted(tabId) || tab === undefined) return false;
    if (request.mode === "park") return rt.liveVoiceOwner === true && rt.liveArmed === true;
    const intentional = request.briefOverview === true;
    if (!intentional && rt.liveReviewFailedSourceKey !== undefined &&
      rt.liveReviewFailedSourceKey === (tab.planSourceKey ?? null)) return false;
    if (get().activeTabId !== tabId ||
      (!intentional && (rt.liveVoiceOwner !== true || rt.liveArmed !== true)) ||
      (hasLiveCall(tab.live) && rt.liveVoiceOwner !== true && rt.liveStartInFlight === undefined && !startedHere) ||
      (rt.liveWorkPark === true && tab.planReview === null)) return false;
    if (request.reviewKey === null) return tab.planReview === null;
    if (tab.planReview === null) return request.reviewKey === undefined;
    const review = readyLiveReview(tabId, rt);
    return review !== null &&
      (request.reviewKey === undefined ||
        (!tab.planDeferred && request.reviewKey === review.sourceKey));
  };

  const runLiveCallPass = async (tabId: string, entry: LiveSwitchEntry): Promise<void> => {
    const request = entry.request;
    const valid = (startedHere = false): boolean => switchPassValid(tabId, entry, request, startedHere);
    if (!valid()) return;
    const rt = peekTabRuntime(tabId)!;
    if (rt.liveStartInFlight !== undefined) {
      await rt.liveStartInFlight.catch(() => null);
      if (!valid()) return;
    }
    if (rt.liveStopInFlight !== undefined) {
      const stopped = await rt.liveStopInFlight.catch(() => null);
      if (stopped === null || !valid()) return;
    }
    if (request.mode === "park") {
      await parkLiveCall(tabId);
      return;
    }
    if (hasLiveCall(get().rpc[tabId]?.live)) {
      const stopped = await parkLiveCall(tabId);
      if (!stopped || !valid()) return;
    }
    if (!valid() || hasLiveCall(get().rpc[tabId]?.live)) return;
    clearLiveWorkTimers(tabId);
    bumpLiveVoiceGeneration(tabId);
    entry.generation = liveVoiceGeneration(tabId);
    await dispatchLiveStart(tabId, rt, valid, request);
  };

  const switchLiveVoice = async (tabId: string, request: LiveSwitchRequest): Promise<void> => {
    const rt = peekTabRuntime(tabId);
    if (rt === undefined) return;
    const claimed = claimLiveSwitch(tabId, request, rt);
    if (claimed === "coalesced") return;
    let entry: LiveSwitchEntry | null = claimed;
    do {
      await runLiveCallPass(tabId, entry);
      entry = finishLiveSwitch(tabId, entry);
    } while (entry !== null);
    publishPlanVoice(tabId);
  };

  const reconcileLivePlanReview = (tabId: string): void => {
    const rt = peekTabRuntime(tabId);
    const tab = get().rpc[tabId];
    if (rt === undefined || tab === undefined) return;
    const review = readyLiveReview(tabId, rt);
    publishPlanVoice(tabId);
    // Readiness must queue a replacement even during an old dispatch; the
    // common switch runner waits for that dispatch and its stale-call close.
    if (review === null || tab.planDeferred || get().activeTabId !== tabId ||
      !liveAdmitted(tabId) || rt.liveVoiceOwner !== true || rt.liveArmed !== true ||
      rt.liveReviewFailedSourceKey === review.sourceKey) return;
    const briefOverview = rt.liveReviewAutoRequestedGateKey !== review.gateKey &&
      rt.liveUserMuted !== true && tab.live?.phase !== "muted";
    if (rt.liveReviewAppliedSourceKey === review.sourceKey && !briefOverview) return;
    void switchLiveVoice(tabId, { mode: "wake", reviewKey: review.sourceKey });
  };

  const explainPlanVoice = async (tabId: string): Promise<void> => {
    if (!liveAdmitted(tabId) || get().activeTabId !== tabId) return;
    const rt = m.runtime(tabId);
    const tab = get().rpc[tabId]!;
    const review = readyLiveReview(tabId, rt);
    publishPlanVoice(tabId);
    if (review === null || tab.planDeferred) return;
    if (hasLiveCall(tab.live) && rt.liveVoiceOwner !== true && rt.liveStartInFlight === undefined) {
      m.patchRpc(tabId, { planVoice: { ...tab.planVoice, error: t("plan.review.voiceOwnedElsewhere") } });
      return;
    }
    if (rt.liveReviewExplicitBriefingKey === review.sourceKey || rt.liveStartInFlight !== undefined) return;
    m.patchRuntime(tabId, {
      liveReviewExplicitBriefingKey: review.sourceKey,
      liveReviewFailedSourceKey: undefined,
    });
    await switchLiveVoice(tabId, { mode: "wake", reviewKey: review.sourceKey, briefOverview: true });
    if (peekTabRuntime(tabId) === rt && rt.liveReviewExplicitBriefingKey === review.sourceKey)
      m.patchRuntime(tabId, { liveReviewExplicitBriefingKey: undefined });
    publishPlanVoice(tabId);
  };

  const stopLiveVoice = async (tabId: string): Promise<void> => {
    if (!supportsNativeLive(get().rpc[tabId]?.capabilities?.ompVersion ?? null)) return;
    const current = get().rpc[tabId]?.live;
    const rt = peekTabRuntime(tabId) ?? (get().rpc[tabId] === undefined ? undefined : m.runtime(tabId));
    if (rt === undefined) return;
    bumpLiveVoiceGeneration(tabId);
    cancelLiveSwitch(tabId);
    clearLiveWorkTimers(tabId);
    const existingStop = rt.liveStopInFlight;
    liveMuteRequests.delete(rt);
    m.patchRuntime(tabId, clearLiveVoiceState);
    m.syncLiveVoiceBadge(tabId);
    publishPlanVoice(tabId);
    if (current === null || current === undefined || current.ended || existingStop !== undefined) return;
    const resp = await trackLiveDispatch(tabId, rt, "liveStopInFlight",
      m.runCommand(tabId, { type: "live_stop" }, { quiet: true }));
    const after = get().rpc[tabId]?.live;
    if (peekTabRuntime(tabId) !== rt || after === null || after === undefined ||
      after.connectionId !== current.connectionId) return;
    if (resp === null) {
      livePatch(tabId, { ...after, error: t("composer.live.sendFailed") });
      return;
    }
    livePatch(tabId, applyLiveEnd(after, null));
  };

  const setLiveMuted = async (tabId: string, muted: boolean): Promise<void> => {
    if (!supportsNativeLive(get().rpc[tabId]?.capabilities?.ompVersion ?? null) ||
      get().rpc[tabId] === undefined) return;
    const rt = m.runtime(tabId);
    const previous = rt.liveUserMuted;
    const request = (rt.liveMuteRequestGeneration ?? 0) + 1;
    const connectionId = get().rpc[tabId]?.live?.connectionId;
    const token = {};
    liveMuteRequests.set(rt, token);
    m.patchRuntime(tabId, { liveUserMuted: muted, liveMuteRequestGeneration: request });
    const resp = await m.runCommand(tabId, { type: "live_mute", muted }, { quiet: true });
    if (liveMuteRequests.get(rt) !== token) return;
    liveMuteRequests.delete(rt);
    if (peekTabRuntime(tabId) !== rt || rt.liveMuteRequestGeneration !== request ||
      get().rpc[tabId]?.live?.connectionId !== connectionId) return;
    if (resp === null) {
      m.patchRuntime(tabId, { liveUserMuted: previous });
      const current = get().rpc[tabId]?.live;
      if (current !== undefined && current !== null)
        livePatch(tabId, { ...current, error: t("composer.live.sendFailed") });
      reconcileLivePlanReview(tabId);
      return;
    }
    // Phase frames remain truth. Explicit unmute can request an initial overview.
    reconcileLivePlanReview(tabId);
  };

  const clearLiveError = (tabId: string): void => {
    const current = get().rpc[tabId]?.live;
    if (current === null || current === undefined) return;
    if (current.ended) {
      // A dead session leaves nothing worth rendering.
      m.patchRpc(tabId, { live: null });
      return;
    }
    livePatch(tabId, { ...current, error: null });
  };

  const setSessionServiceTier = async (
    tabId: string,
    tier: ServiceTier | null,
  ): Promise<void> => {
    await backend.setSessionServiceTier(tabId, tier);
  };

  /** The control's tier picks (issue #719). The record write is the
   *  authority — a process that accepts no commands (hibernated, starting)
   *  keeps the record-only contract, its next spawn replaying the tier
   *  through initialCommands. */
  const setServiceTier = async (tabId: string, tier: ServiceTier): Promise<void> => {
    const session = get().rpc[tabId]?.session;
    const wasEnabled = session?.fastModeEnabled ?? false;
    const wasActive = session?.fastModeActive ?? false;
    if (!wasEnabled) {
      // Enabling straight onto the chosen tier: no intermediate priority
      // set through which an ultrafast selection could be declined.
      await get().setSessionServiceTier(tabId, tier);
      if (tier === "priority") return void (await setFastModeRpc(tabId, true));
      if (!m.acceptsCommands(tabId)) return;
      await m.runCommand(tabId, { type: "prompt", message: "/fast ultra" });
      await refreshState(tabId); // get_state re-read: the declined truth converges
      return;
    }
    const recordTier = findRecord(get().state, tabId)?.serviceTier ?? null;
    await get().setSessionServiceTier(tabId, tier);
    if (tier === "ultrafast" && (recordTier !== "ultrafast" || !wasActive)) {
      // Switching to ultrafast while on, or the declined ultrafast retry:
      // the record already says ultrafast, yet the same-value pick sends.
      if (!m.acceptsCommands(tabId)) return;
      await m.runCommand(tabId, { type: "prompt", message: "/fast ultra" });
      await refreshState(tabId);
      return;
    }
    if (tier === "priority" && !wasActive) {
      // The declined retry on the priority rail; from a declined ultrafast
      // record, set_fast_mode(true) names the family's default tier again.
      await setFastModeRpc(tabId, true);
    }
    // tier→priority while active: priority IS what set_fast_mode(true)
    // set, which is already live — a record-only change, replay applies.
  };

  const setAutoRetry = async (tabId: string, enabled: boolean): Promise<void> => {
    await m.runCommand(tabId, { type: "set_auto_retry", enabled });
  };

  const abortRetry = async (tabId: string): Promise<void> => {
    await m.runCommand(tabId, { type: "abort_retry" });
  };

  /**
   * See `UiStore.compactSession`. The response ack is the completion event
   * (#336); when it beats the response budget, the late response frame closes
   * the record from the reducer instead, and this call reports `pending`
   * (issue #625).
   */
  const compactSession = async (
    tabId: string,
    options?: { waitForCompletion?: boolean },
  ): Promise<CompactionOutcome> => {
    const tab = get().rpc[tabId];
    // omp refuses a second compaction outright ("Compaction already in
    // progress"), so a click during one in flight reports, never re-sends.
    if (tab?.compacting !== undefined || !m.acceptsCommands(tabId)) return "failed";
    m.appendItem(tabId, markerItem("compacting context", "copper"));
    m.patchRpc(tabId, { compacting: { startedAt: Date.now() } });
    m.patchRuntime(tabId, { compactionOutcome: undefined });
    const resp = await m.runCommand(tabId, { type: "compact" });
    if (resp !== null) {
      // The id was pending, so the reducer never claimed this observation:
      // this call appends the completion Marker.
      m.finishCompaction(tabId, "acked");
      return "acked";
    }
    // No ack yet, but the chain may still be working: the timeout attribution
    // entry outlives the budget until the response is observed (#302), so it
    // is the authoritative "still coming" signal.
    if (
      m
        .runtime(tabId)
        .timedOutCommands.some((c) => c.command === "compact")
    ) {
      if (options?.waitForCompletion !== true) return "pending";
      await m.pollUntil(
        tabId,
        (t) => t?.compacting === undefined,
        COMPACT_SETTLE_DEADLINE_MS,
      );
      if (get().rpc[tabId]?.compacting !== undefined) return "pending"; // deadline passed
      return m.runtime(tabId).compactionOutcome ?? "failed";
    }
    // Refused outright, or the process left (abandoned): the banner or the
    // exit overlay owns the story; no completion Marker is earned.
    m.finishCompaction(tabId, "failed");
    return "failed";
  };

  const exportHtml = async (tabId: string): Promise<void> => {
    const resp = await m.runCommand(tabId, { type: "export_html" });
    if (resp === null) return;
    const path = strField(respData(resp), "path");
    // The path rides the notice as data so the transcript can offer
    // open/reveal without parsing it back out of the text (issue #84).
    m.appendItem(tabId, {
      ...noticeItem(path ? `exported to ${path}` : "export finished", "info"),
      ...(path === undefined ? {} : { path }),
    });
  };

  const shareSession = async (tabId: string): Promise<void> => {
    // An unadvertised slash line would reach the model as literal prompt text
    // (runSlashCommand's fallback), so a share with no omp-side command ends
    // here instead (issue #679).
    const advertised = get().rpc[tabId]?.commands.some(
      (c) => c.name === "share" || (c.aliases?.includes("share") ?? false),
    );
    if (!advertised) {
      m.appendItem(tabId, noticeItem(t("notice.share.needsOmpCommand"), "info"));
      return;
    }
    if (!hasSeenSharePrivacy()) {
      set({ shareConfirmTab: tabId });
      return;
    }
    await get().runSlashCommand(tabId, "/share");
  };

  const branchSession = async (tabId: string): Promise<void> => {
    // Full-fidelity branch (issue #83): the backend copies the transcript
    // into a new lineage and registers it; the source session — this tab
    // included — keeps running untouched. omp's `branch` RPC is the wrong
    // tool here: it rewinds past the last user message in place.
    if (!findRecord(get().state, tabId)) return;
    try {
      const { tabId: forked } = await backend.forkSession(tabId);
      // The fork's record normally arrives by broadcast, but openSession
      // reads it from state — pull state explicitly so a slow broadcast
      // can't strand the new tab.
      set({ state: await backend.getState() });
      await get().openSession(forked);
    } catch (err) {
      get().reportError(err);
    }
  };

  /**
   * The liveness/idle guard every rewind and navigate affordance shares,
   * plus the `get_entries` read the correlation needs (issue #680). Null
   * means the click was refused or the read failed, and the reason has
   * already been reported.
   */
  const readEntriesForRewind = async (
    tabId: string,
    busyKey: MessageKey = "session.error.rewindBusy",
  ): Promise<Record<string, unknown> | null> => {
    const rec = findRecord(get().state, tabId);
    const tab = get().rpc[tabId];
    // Streaming is refused, not queued: `branch`/`navigateTree` switch the
    // live process in place, and doing it mid-turn races the agent.
    if (
      !rec ||
      rec.mode !== "rpc-ui" ||
      rec.live !== "live" ||
      !m.acceptsCommands(tabId) ||
      !tab ||
      tab.session.isStreaming ||
      tab.status === "running" ||
      tab.busy
    ) {
      get().reportError(t(busyKey));
      return null;
    }
    // Direct rpcCommand, never runCommand: an older omp without
    // `get_entries` degrades quietly (the `openSubagent` pattern) — the
    // correlation failure owns the story, not the failure panel.
    const resp = await get()
      .rpcCommand(tabId, { type: "get_entries" }, { quiet: true })
      .catch(() => null);
    if (resp === null) {
      get().reportError(t("session.error.rewindCorrelation"));
      return null;
    }
    const data = respData(resp);
    return data !== null && typeof data === "object"
      ? (data as Record<string, unknown>)
      : null;
  };
  /**
   * The "rewind here" / "edit and resend" affordance (issue #680). Neither
   * the event stream nor get_messages carries omp entry ids, so the clicked
   * row's position among user items is correlated against the leaf-path
   * entries at click time; a failed correlation refuses the rewind rather
   * than guessing an id. The staged confirmation carries only the resolved
   * entry id — the prompt's visible text/images ride the module-map prefill
   * because staging→confirm can outlive a stream tick.
   */
  const stageRewind = async (
    tabId: string,
    itemIndex: number,
    editResend: boolean,
  ): Promise<void> => {
    // Guard first: a refused click reports the reason, whatever the
    // transcript looks like at the instant of the click.
    const data = await readEntriesForRewind(tabId);
    if (data === null) return;
    const items = get().rpc[tabId]?.items;
    const clicked = items?.filter((i) => i.kind === "user")[itemIndex];
    if (items === undefined || clicked === undefined || clicked.kind !== "user") return;
    const entryId = correlatePromptEntry(
      items,
      arrField(data, "entries"),
      field(data, "leafId"),
      itemIndex,
    );
    if (entryId === null) {
      get().reportError(t("session.error.rewindCorrelation"));
      return;
    }
    // Rows strictly after the clicked user row: what the dialog counts as
    // discarded. (The clicked prompt's own later siblings on the path.)
    const clickedAt = items.indexOf(clicked);
    const laterTurns = Math.max(0, items.length - clickedAt - 1);
    setRewindPrefill(tabId, {
      text: clicked.text,
      // Visible prose only — omp's raw entry text still carries @-routing
      // context; the images are omp's re-encoded mime types. Documents
      // re-send by scratch path: the file already lives on the owner (ADR-0044).
      images: clicked.images ?? [],
      documents: clicked.documents ?? [],
    });
    get().stageLifecycleConfirmation({
      kind: "rewind",
      tabId,
      entryId,
      laterTurns,
      editResend,
    });
  };

  /**
   * The navigator's rewind: same effect, but the entry id comes from the
   * tree itself, so no positional correlation runs (issue #680). The entry
   * must still be a user message — `branch` throws on anything else.
   */
  const stageRewindEntry = async (
    tabId: string,
    entryId: string,
    editResend: boolean,
  ): Promise<void> => {
    const data = await readEntriesForRewind(tabId);
    if (data === null) return;
    const prompt = entryUserPrompt(arrField(data, "entries"), entryId);
    if (prompt === null) {
      get().reportError(t("session.error.rewindCorrelation"));
      return;
    }
    const laterTurns =
      discardedEntryCount(
        arrField(data, "entries"),
        field(data, "leafId"),
        entryId,
      ) ?? 0;
    setRewindPrefill(tabId, prompt);
    get().stageLifecycleConfirmation({
      kind: "rewind",
      tabId,
      entryId,
      laterTurns,
      editResend,
    });
  };

  /** The tree row's "fork from here" (issue #717): the entry id rides straight
   *  to omp's `fork`, so — like stageRewindEntry — no positional correlation
   *  runs; the entry must exist and be a message (`fork` throws otherwise),
   *  and the dialog counts the turns the current branch gives up. */
  const stageForkEntry = async (tabId: string, entryId: string): Promise<void> => {
    const data = await readEntriesForRewind(tabId, "session.error.forkBusy");
    if (data === null) return;
    if (entryUserPrompt(arrField(data, "entries"), entryId) === null) {
      get().reportError(t("session.error.forkEntry"));
      return;
    }
    const laterTurns =
      discardedEntryCount(
        arrField(data, "entries"),
        field(data, "leafId"),
        entryId,
      ) ?? 0;
    get().stageLifecycleConfirmation({ kind: "fork", tabId, entryId, laterTurns });
  };

  /** The accepted fork effect (issue #717): same shape as performRewind minus
   *  the prefill — the fork keeps the clicked prompt, so nothing re-fills the
   *  composer. Identity lands via the watcher (same-dir adoption) plus the
   *  quiet get_state merge. */
  const performFork = async (tabId: string, entryId: string): Promise<void> => {
    const resp = await m.runCommand(tabId, { type: "fork", entryId });
    if (resp === null) return; // failure already reported by runCommand
    if (boolField(respData(resp), "cancelled")) {
      // A session_before_branch hook cancelled the fork; nothing moved.
      m.appendItem(tabId, noticeItem(t("transcript.fork.cancelled"), "info"));
      return;
    }
    await get().reloadHistory(tabId);
    // Identity belt-and-braces (same as performRewind): the watcher adopts
    // the new same-dir file, and applyRpcState merges sessionId/sessionFile
    // from this get_state even if the runtime omits session_info_update.
    void m.runCommand(tabId, { type: "get_state" }, { quiet: true });
    m.appendItem(tabId, noticeItem(t("transcript.fork.done"), "info"));
  };

  /** Stages a tree jump for an entry that is not a user prompt (issue #680). */
  const stageNavigate = async (
    tabId: string,
    entryId: string,
    summarize: boolean,
  ): Promise<void> => {
    const data = await readEntriesForRewind(tabId);
    if (data === null) return;
    const laterTurns =
      discardedEntryCount(
        arrField(data, "entries"),
        field(data, "leafId"),
        entryId,
      ) ?? 0;
    get().stageLifecycleConfirmation({
      kind: "navigate",
      tabId,
      entryId,
      summarize,
      laterTurns,
    });
  };

  /** The accepted rewind effect (issue #680), run only by the confirmation. */
  const performRewind = async (
    tabId: string,
    entryId: string,
    editResend: boolean,
  ): Promise<void> => {
    try {
      const resp = await m.runCommand(tabId, { type: "branch", entryId });
      if (resp === null) return; // failure already reported by runCommand
      if (boolField(respData(resp), "cancelled")) {
        // A hook cancelled the branch; nothing moved and nothing reloads.
        takeRewindPrefill(tabId);
        return;
      }
      await get().reloadHistory(tabId);
      // Identity belt-and-braces: the new session file in the same lineage
      // dir is adopted by the watcher, but applyRpcState merges
      // sessionId/sessionFile from get_state even if this runtime omits
      // session_info_update on branch (the boot pattern).
      void m.runCommand(tabId, { type: "get_state" }, { quiet: true });
      const source = takeRewindPrefill(tabId);
      if (editResend && source !== null) {
        if (source.text !== "") get().queueComposerText(tabId, source.text);
        for (const image of source.images)
          void get().queueComposerAttachment(tabId, { type: "image", ...image }, "");
        // Path-only re-attach: zero re-upload; a swept file fails at send
        // with `document not found` and the draft survives for re-pick.
        for (const document of source.documents ?? [])
          get().queueComposerDocument(
            tabId,
            { type: "document", mimeType: DOCUMENT_MIME, ...document },
            "",
          );
      }
      m.appendItem(tabId, noticeItem(t("transcript.rewind.done"), "info"));
    } catch (err) {
      takeRewindPrefill(tabId);
      throw err;
    }
  };

  /**
   * The accepted tree-jump effect (issue #680, Phase 2): rides the generated
   * bridge, whose published snapshot field — not the prompt ack — settles
   * completion (the `runVibeCommand` correlation discipline, simplified:
   * navigation results are per-process and monotonic in `revision`).
   */
  const performNavigate = async (
    tabId: string,
    entryId: string,
    summarize: boolean,
  ): Promise<void> => {
    const publishedTree = (): TreeSnapshot | null => {
      const text = get().rpc[tabId]?.extensionStatus[TREE_STATUS_KEY];
      return text === undefined ? null : parseTreeSnapshot(text);
    };
    const before = publishedTree()?.revision ?? 0;
    const resp = await m.runCommand(tabId, {
      type: "prompt",
      message: treeNavigateMessage(entryId, summarize),
    });
    if (resp === null) return;
    // The navigate handler publishes its result before the ack chain drains;
    // wait for a snapshot newer than the dispatch, then read its verdict.
    await m.pollUntil(
      tabId,
      (tab) => {
        const text = tab?.extensionStatus[TREE_STATUS_KEY];
        const snapshot = text === undefined ? null : parseTreeSnapshot(text);
        return (snapshot?.revision ?? 0) > before;
      },
      summarize ? 120_000 : RPC_COMMAND_TIMEOUT_MS,
    );
    const result = publishedTree()?.navigation;
    if (result === undefined || result.entryId !== entryId) {
      get().reportError(t("session.error.navigateUnconfirmed"));
      return;
    }
    if (!result.ok) {
      get().reportError(
        result.error ?? t("session.error.navigateFailed"),
      );
      return;
    }
    await get().reloadHistory(tabId);
    void m.runCommand(tabId, { type: "get_state" }, { quiet: true });
    m.appendItem(tabId, noticeItem(t("transcript.rewind.navigated"), "info"));
  };

  const renameSessionTo = async (tabId: string, name: string): Promise<void> => {
    const resp = await m.runCommand(tabId, { type: "set_session_name", name });
    if (resp === null) return;
    // A user-chosen name is final — the auto-titler must not overwrite it.
    // Clearing the attempt retires any in-flight retry budget (issue #791).
    m.patchRpc(tabId, { hasRenamed: true, initialPrompt: null, titleAttempt: null });
    // omp-ui's mirror of omp's `titleSource === "user"` gate: a typed name
    // also clears the auto-title marker, so replans stop refreshing (issue #804).
    void backend.setSessionAutoTitled(tabId, false);
  };

  const regenerateSessionTitle = async (tabId: string): Promise<void> => {
    if (!get().rpc[tabId]) return;
    const rec = findOwner(get().state, tabId)?.record;
    if (rec === undefined || rec.live !== "live" || get().exited[tabId] !== undefined) {
      // No process to run `/rename`, and omp-ui does not write session
      // files — resume first, then re-title (CONTEXT.md, Session).
      get().reportError(t("session.error.retitleNotLive"));
      return;
    }
    // omp's generator digests the session itself and answers in the
    // transcript: the command row plus its settlement notice are the
    // feedback (issue #788).
    await get().runSlashCommand(tabId, "/rename");
    // The user asked the generator to name the session, so the result is
    // again an auto-title: mark it so later replans keep it fresh (issue #804).
    void backend.setSessionAutoTitled(tabId, true);
  };

  const setPlanMode = async (tabId: string, enabled: boolean): Promise<void> => {
    if (!m.acceptsCommands(tabId)) return;
    // The extension owns the state; the UI never assumes the toggle took —
    // it re-renders when the extension publishes its status frame.
    // The format rides the `on` command, so the extension — not a later
    // Settings flip — decides what this session's plans are authored as.
    const format = get().state?.planFormat ?? "html";
    await m.runCommand(tabId, {
      type: "prompt",
      message: planMessage(enabled, format),
    });
  };

  const runSlashCommand = async (tabId: string, line: string): Promise<void> => {
    const message = line.startsWith("/") ? line : `/${line}`;
    const trimmed = message.trim();
    if (trimmed === "/") return;
    const localCommand = localCommands.find(({ match }) => match.test(trimmed));
    if (localCommand !== undefined) {
      const result = localCommand.run(tabId, get, trimmed);
      if (result !== false) {
        if (result !== undefined) await result;
        return;
      }
    }
    // A first word matching no advertised command is a literal model prompt
    // (omp forwards it verbatim) — the user/assistant items tell that story;
    // it gets no command row.
    const body = trimmed.slice(1);
    const spaceAt = body.search(/\s/);
    const name = spaceAt === -1 ? body : body.slice(0, spaceAt);
    const args = spaceAt === -1 ? "" : body.slice(spaceAt + 1).trim();
    const command = get().rpc[tabId]?.commands.find(
      (c) => c.name === name || (c.aliases?.includes(name) ?? false),
    );
    if (command === undefined) {
      await m.runCommand(tabId, { type: "prompt", message });
      return;
    }
    // The acknowledgement row: makes the command visibly run - and settle -
    // while the reply itself rides command_output frames (omp 17.3.8+
    // emits them for builtin replies too).
    const item = commandItem(name, args);
    m.appendItem(tabId, item);
    const byRequest = m.runtime(tabId).slashCommandItems;
    let requestId: string | undefined;
    const resp = await m.runCommand(
      tabId,
      { type: "prompt", message },
      {
        captureId: (id) => {
          requestId = id;
          byRequest.set(id, item.id);
        },
      },
    );
    const settle = (patch: Partial<CommandItem>): void => {
      if (requestId !== undefined) byRequest.delete(requestId);
      m.patchItems(tabId, (i) =>
        i.kind === "command" && i.id === item.id ? { ...i, ...patch } : i,
      );
    };
    if (resp === null) {
      // runCommand recorded the RpcFailure — mirror its text onto the row.
      settle({
        status: "failed",
        error: get().rpc[tabId]?.failure?.message ?? "command failed",
      });
      return;
    }
    const invoked = boolField(respData(resp), "agentInvoked");
    if (invoked === false) settle({ status: "done" });
    else if (invoked === true) settle({ status: "agent" });
    if (
      command.name === "compact" ||
      command.name === "fast" ||
      command.name === "slow"
    )
      await m.refreshUsage(tabId);
    // `agentInvoked` absent (older runtime): stay running — prompt_result's
    // id mapping or the next agent_start settles it.
  };

  /** Display cap for a shell row's output — same budget as slash output. */
  const SHELL_OUTPUT_CAP = 64 * 1024;

  /**
   * One "!" composer draft as omp's concurrent bash RPC (issue #678): no
   * model turn — the shell row settles from the command's own completion
   * response, and omp records a bashExecution entry so the model still
   * sees the output.
   */
  const runShellCommand = async (tabId: string, command: string): Promise<void> => {
    if (!m.acceptsCommands(tabId)) return;
    const item = shellItem(command);
    m.appendItem(tabId, item);
    const settle = (patch: Partial<ShellItem>): void => {
      m.patchItems(tabId, (i) =>
        i.kind === "shell" && i.id === item.id && i.status === "running"
          ? { ...i, ...patch }
          : i,
      );
    };
    try {
      // Quiet: a long user command must not strobe `busy` (the agent-working
      // sweeps), and a failed command is the row's story, not a session
      // banner. The bus never expires a bash (issue #678), so the only
      // rejections here are omp failures and process abandonment.
      const resp = await get().rpcCommand(tabId, { type: "bash", command }, { quiet: true });
      const data = respData(resp);
      const raw = strField(data, "output") ?? "";
      settle({
        status: boolField(data, "cancelled") === true ? "cancelled" : "done",
        output:
          raw.length <= SHELL_OUTPUT_CAP
            ? raw
            : `${raw.slice(0, SHELL_OUTPUT_CAP)}\n… output truncated`,
        exitCode: numField(data, "exitCode"),
        truncated: boolField(data, "truncated") === true,
      });
      void m.refreshUsage(tabId);
    } catch (err) {
      settle({
        status: err instanceof RpcCommandAbandonedError ? "cancelled" : "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const abortShellCommands = async (tabId: string): Promise<void> => {
    // omp aborts every running bash in the process; each row settles
    // cancelled from its own response. Never optimistic here.
    await m.runCommand(tabId, { type: "abort_bash" }, { quiet: true });
  };

  /** omp's predict client backs a failing daemon off for 30 s (predict/client.ts RETRY_AFTER_MS). */
  const WORD_PREDICTION_RETRY_MS = 30_000;

  const predictWord = async (
    tabId: string,
    text: string,
    cursor: number,
  ): Promise<string | null> => {
    if (!m.acceptsCommands(tabId)) return null;
    const runtime = m.runtime(tabId);
    if (runtime.wordPredictionUnsupported === true) return null;
    if (runtime.wordPredictionRetryAt !== undefined && Date.now() < runtime.wordPredictionRetryAt)
      return null;
    try {
      // Quiet: a keystroke must never strobe `busy`, and the bus never
      // expires an off-chain command (session-command.ts `offChain`).
      const resp = await get().rpcCommand(
        tabId,
        { type: "predict_word", text, cursor },
        { quiet: true },
      );
      const suffix = strField(respData(resp), "suffix");
      return suffix === undefined || suffix === "" ? null : suffix;
    } catch (err) {
      // A replaced process abandons the wait; the next runtime probes afresh.
      if (err instanceof RpcCommandAbandonedError) return null;
      const message = err instanceof Error ? err.message : String(err);
      m.patchRuntime(
        tabId,
        message.startsWith("Unknown command:")
          ? { wordPredictionUnsupported: true }
          : { wordPredictionRetryAt: Date.now() + WORD_PREDICTION_RETRY_MS },
      );
      return null;
    }
  };

  const sendWordPredictionFeedback = (
    tabId: string,
    feedback: WordPredictionFeedback,
  ): void => {
    if (!m.acceptsCommands(tabId) || m.runtime(tabId).wordPredictionUnsupported === true) return;
    // No id, so nothing awaits it: feedback rides omp's serial chain, and a
    // tracked wait queued behind a long compact would expire on the strict
    // budget and pollute the #302 attribution. omp's id-less response is
    // dropped by frame-reduction's response branch.
    const frame: SessionCommand = { type: "predict_word_feedback", ...feedback };
    backend.rpcSend(tabId, frame);
  };

  /**
   * One goal-family line, dispatched as omp's native `goal` command (ADR-0046)
   * rather than as prose. The row keeps the line the user typed; omp's
   * response is the whole outcome — acceptance, or its own refusal sentence
   * rendered verbatim. Goal state itself arrives through frame intake (the
   * same response, get_state, goal_updated), never patched here.
   */
  const runGoalCommand = async (tabId: string, line: string): Promise<void> => {
    const message = line.startsWith("/") ? line : `/${line}`;
    const body = message.slice(1).trim();
    const spaceAt = body.search(/\s/);
    const name = spaceAt === -1 ? body : body.slice(0, spaceAt);
    const args = spaceAt === -1 ? "" : body.slice(spaceAt + 1);
    const item = commandItem(name, args);
    m.appendItem(tabId, item);
    const settle = (patch: Partial<CommandItem>): void => {
      m.patchItems(tabId, (i) =>
        i.kind === "command" && i.id === item.id && i.status === "running"
          ? { ...i, ...patch }
          : i,
      );
    };
    const fail = (error: string): void => settle({ status: "failed", error });
    const done = (output: string): void => settle({ status: "done", output });

    const intent = parseGoalLine(name, args);
    if (intent.kind === "invalid") {
      fail(intent.error);
      return;
    }
    if (!m.acceptsCommands(tabId)) {
      fail(t("composer.goal.notReady"));
      return;
    }
    const startsWork =
      intent.kind === "create" || intent.kind === "resume" || intent.kind === "guided";
    if (startsWork && get().rpc[tabId]?.vibe?.enabled === true) {
      fail(t("composer.goal.vibeBlocks"));
      return;
    }
    const before = get().rpc[tabId]?.goal ?? null;

    if (intent.kind === "guided") {
      if (get().rpc[tabId]?.plan?.enabled === true) {
        fail(t("composer.goal.planBlocks"));
        return;
      }
      if (before !== null && coreGoalOwnsSession(before)) {
        fail(t("composer.goal.guidedHasGoal", { status: before.goal.status }));
        return;
      }
      const result = await get().setSessionToolEnabled(tabId, "goal", true);
      if (result.status !== "applied") {
        fail(
          result.status === "busy"
            ? t("composer.goal.busy")
            : t("composer.goal.guidedToolFailed", { status: result.status }),
        );
        return;
      }
      const sent = await get().sendPrompt(tabId, guidedGoalPrompt(intent.rough), "prompt");
      if (!sent) fail(t("composer.goal.notReady"));
      else done(t("composer.goal.guidedStarted"));
      return;
    }

    if (intent.kind === "show") {
      const reply = await goalOp(tabId, { op: "get" });
      if (!reply.ok) return fail(reply.error);
      const state = parseGoalState(field(reply.data, "state"));
      done(state ? goalDetails(state) : t("composer.goal.none"));
      return;
    }
    if (intent.kind === "pause" || intent.kind === "resume" || intent.kind === "drop") {
      const reply = await goalOp(tabId, { op: intent.kind });
      if (!reply.ok) return fail(reply.error);
      const nothing = before === null && field(reply.data, "goal") == null;
      if (intent.kind === "pause")
        done(t(nothing ? "composer.goal.nothingToPause" : "composer.goal.paused"));
      else if (intent.kind === "drop")
        done(t(nothing ? "composer.goal.nothingToDrop" : "composer.goal.dropped"));
      else done(t("composer.goal.resumed"));
      return;
    }

    // create, or set: replacing an enabled goal is drop then create, because
    // omp refuses a second create while one is active.
    const create = {
      op: "create",
      objective: intent.objective,
      ...(intent.budget === undefined ? {} : { token_budget: intent.budget }),
    };
    const replacing = intent.replace && before?.enabled === true;
    if (replacing) {
      const dropped = await goalOp(tabId, { op: "drop" });
      if (!dropped.ok) return fail(dropped.error);
    }
    const reply = await goalOp(tabId, create);
    if (!reply.ok) {
      fail(
        replacing && !reply.abandoned
          ? t("composer.goal.replaceFailed", { reason: reply.error })
          : reply.error,
      );
      return;
    }
    done(
      t(replacing ? "composer.goal.replaced" : "composer.goal.set", {
        objective: intent.objective,
      }),
    );
  };

  /**
   * One native goal op. Direct rpcCommand, never runCommand: a quiet
   * runCommand swallows the failure text, and omp's sentence is the message
   * the row must show. An omp without the command gets the update hint and no
   * fallback path is ever tried.
   */
  const goalOp = async (
    tabId: string,
    args: Record<string, unknown>,
  ): Promise<
    { ok: true; data: unknown } | { ok: false; error: string; abandoned: boolean }
  > => {
    try {
      const resp = await get().rpcCommand(tabId, { type: "goal", ...args }, { quiet: true });
      return { ok: true, data: respData(resp) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RpcCommandAbandonedError)
        return { ok: false, error: message, abandoned: true };
      return {
        ok: false,
        error: message.startsWith(UNKNOWN_COMMAND_PREFIX)
          ? t("composer.goal.needsNewerOmp")
          : message,
        abandoned: false,
      };
    }
  };

  /**
   * One `/vibe` line, dispatched as a command against the session's own vibe
   * bridge (issue #683) rather than as prose. The row keeps the line the user
   * typed; the wire carries the hidden bridge command with this client's
   * requestId, and the bridge's published snapshot — never the prompt ack —
   * supplies the outcome. The human subcommand is translated here into the
   * JSON args the bridge's worker tools expect, so worker prompts never reach
   * the model. An unavailable bridge is answered with an actionable reason and
   * sends nothing at all.
   */
  const runVibeCommand = async (tabId: string, line: string): Promise<void> => {
    const message = line.startsWith("/") ? line : `/${line}`;
    const body = message.slice(1).trim();
    const spaceAt = body.search(/\s/);
    // The interceptor's regex guarantees the family word `vibe`; what steers
    // the bridge is the subcommand after it.
    const afterHead = spaceAt === -1 ? "" : body.slice(spaceAt + 1).trim();
    const subSpace = afterHead.search(/\s/);
    const name = (subSpace === -1 ? afterHead : afterHead.slice(0, subSpace)).toLowerCase();
    const rest = subSpace === -1 ? "" : afterHead.slice(subSpace + 1).trim();
    const item = commandItem("vibe", afterHead);
    m.appendItem(tabId, item);
    const settle = (patch: Partial<CommandItem>): void => {
      m.patchItems(tabId, (i) =>
        i.kind === "command" && i.id === item.id && i.status === "running"
          ? { ...i, ...patch }
          : i,
      );
    };
    const snapshot = get().rpc[tabId]?.vibe ?? null;
    if (snapshot === null) {
      settle({ status: "failed", error: t("composer.vibe.needsRestart") });
      return;
    }
    if (!snapshot.available) {
      settle({
        status: "failed",
        error: t("composer.vibe.unavailable", {
          reason: snapshot.unavailable ?? t("composer.vibe.unavailableUnknown"),
        }),
      });
      return;
    }
    // Translate the human subcommand into the bridge's JSON worker-tool args.
    // An unknown verb and `on`/`toggle` carry no args; a mode verb settles even
    // while the mode is off, but the worker verbs need it on (the bridge says
    // so), so those are only refused here if the shape is empty.
    let command: VibeSubcommand;
    let args = "";
    if (name === "" || name === "vibe" || name === "on") command = "toggle";
    else if (name === "off") command = "off";
    else if (name === "list") command = "list";
    else if (name === "spawn") {
      const good = /^--good\b(?:\s+|$)/.test(rest);
      const named = rest.replace(/^--good\b\s*/i, "").match(/^--name\s+(\S+)\s+([\s\S]*)$/i);
      const cli = good ? "good" : "fast";
      const prompt = named ? named[2]!.trim() : rest.replace(/^--good\b\s*/i, "").trim();
      if (prompt === "") {
        settle({ status: "failed", error: t("composer.vibe.spawnNeedsPrompt") });
        return;
      }
      command = "spawn";
      args = JSON.stringify(named ? { cli, prompt, name: named[1] } : { cli, prompt });
    } else if (name === "send") {
      const sendId = rest.split(/\s+/)[0] ?? "";
      const text = rest.slice(sendId.length).trim();
      if (sendId === "" || text === "") {
        settle({ status: "failed", error: t("composer.vibe.sendNeedsArgs") });
        return;
      }
      command = "send";
      args = JSON.stringify({ session: sendId, message: text });
    } else if (name === "kill") {
      if (rest === "") {
        settle({ status: "failed", error: t("composer.vibe.killNeedsId") });
        return;
      }
      command = "kill";
      args = JSON.stringify({ session: rest.split(/\s+/)[0] });
    } else if (name === "wait") {
      const ids = rest.split(/\s+/).filter((token) => token !== "");
      command = "wait";
      args = JSON.stringify(ids.length > 0 ? { sessions: ids } : {});
    } else {
      // omp's own /vibe verb (scope, undo, …) has no rpc surface; the bridge
      // answers none of them, and prose would reach the director as a prompt.
      settle({ status: "failed", error: t("composer.vibe.unsupportedVerb", { verb: name }) });
      return;
    }
    if (new TextEncoder().encode(args).length > VIBE_ARGS_BYTE_LIMIT) {
      settle({ status: "failed", error: t("composer.vibe.tooLong") });
      return;
    }
    const request: VibeCommandRequest = {
      requestId: randomId(),
      sessionId: snapshot.sessionId,
      processKey: snapshot.processKey,
      command,
      args,
    };
    m.runtime(tabId).vibeRequests.set(request.requestId, item.id);
    const resp = await m.runCommand(tabId, {
      type: "prompt",
      message: vibeMessage(request),
    });
    if (resp !== null) return;
    m.runtime(tabId).vibeRequests.delete(request.requestId);
    settle({
      status: "failed",
      error: get().rpc[tabId]?.failure?.message ?? "command failed",
    });
  };

  /**
   * One hidden bridge command as a quiet prompt (the `refreshLimits` shape,
   * issue #680): the bridge's published snapshot — not the ack — answers for
   * it, so the transcript gets no row and the busy sweep no strobe.
   */
  const runHiddenCommand = async (
    tabId: string,
    command: string,
    args: string,
  ): Promise<void> => {
    await m.runCommand(
      tabId,
      { type: "prompt", message: `/${command}${args === "" ? "" : ` ${args}`}` },
      { allowDuringBoot: true, quiet: true },
    );
  };

  const setTodos = async (tabId: string, phases: TodoPhase[]): Promise<void> => {
    const resp = await m.runCommand(tabId, { type: "set_todos", phases });
    if (resp === null) return;
    m.patchRpc(tabId, {
      todos: parseTodoPhases(field(respData(resp), "todoPhases")),
    });
  };

  const refreshState = async (tabId: string): Promise<void> => {
    const resp = await m.runCommand(
      tabId,
      { type: "get_state" },
      { quiet: true },
    );
    if (resp === null) return;
    m.applyRpcState(tabId, resp);
  };

  const refreshStats = async (tabId: string): Promise<void> => {
    const resp = await m.runCommand(
      tabId,
      { type: "get_session_stats" },
      { quiet: true },
    );
    if (resp === null) return;
    m.patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
  };

  const refreshAdvisorStats = async (tabId: string): Promise<void> => {
    // The extension answers by publishing over setStatus. Until omp has run a
    // turn the session is uncaptured, so it reports a live-session wait which
    // the HUD treats as "not yet" rather than an error.
    await m.runCommand(
      tabId,
      {
        type: "prompt",
        message: `/${ADVISOR_STATS_COMMAND}`,
      },
      { allowDuringBoot: true },
    );
  };

  const refreshLimits = async (tabId: string): Promise<void> => {
    // The bridge answers by publishing over setStatus. Quiet: the arm rides
    // every boot and HUD refresh, and a busy sweep per shot would strobe the
    // command indicator for a readout the user never invoked (issue #673).
    await m.runCommand(
      tabId,
      {
        type: "prompt",
        message: `/${LIMITS_COMMAND}`,
      },
      { allowDuringBoot: true, quiet: true },
    );
  };

  const refreshSubagents = async (tabId: string): Promise<void> => {
    // Heartbeat-driven (every subagent_* frame) — quiet, or the busy sweeps
    // strobe for the lifetime of every spawned subagent.
    const resp = await m.runCommand(
      tabId,
      { type: "get_subagents" },
      { quiet: true },
    );
    if (resp === null) return;
    m.patchRpc(tabId, { subagents: parseSubagents(respData(resp)) });
  };

  const openSubagent = (tabId: string, key: string): void => {
    const tab = get().rpc[tabId];
    if (!tab || tab.selectedSubagent === key) return;
    m.patchRpc(tabId, { selectedSubagent: key });
    m.syncSubagentSubscription(tabId);
    // Backfill the run's full history from the subagent's own transcript
    // file, so the view shows the whole run — not just what streamed
    // since the click. Wholesale replace, the same contract as
    // loadHistory; the live event stream keeps appending after.
    // Direct rpcCommand, never runCommand: a failure (omp older than
    // v17.1.8, or an id the process forgot across a respawn) degrades to
    // the live buffer, not to a session-level failure panel.
    void get()
      .rpcCommand(
        tabId,
        { type: "get_subagent_messages", subagentId: key },
        { quiet: true },
      )
      .then((resp) => {
        // A switch or close while the read was in flight must not
        // clobber the new selection's buffer.
        if (get().rpc[tabId]?.selectedSubagent !== key) return;
        const messages = arrField(respData(resp), "messages");
        const buffers = get().rpc[tabId]?.subagentItems ?? {};
        m.patchRpc(tabId, {
          subagentItems: { ...buffers, [key]: historyToItems(messages) },
        });
      })
      .catch(() => {});
  };

  const closeSubagent = (tabId: string): void => {
    m.patchRpc(tabId, { selectedSubagent: null });
    m.syncSubagentSubscription(tabId);
  };

  return {
    advisorDefaults: {},
    answerExtension,
    acceptApprovalPrompt,
    answerApprovalPrompt,
    reconcilePendingDialogs,
    sendPrompt,
    abortAgent,
    abortAndPrompt,
    loadAdvisorDefaults,
    setSessionAdvisor,
    setSessionApprovalMode,
    setAdvisorModel,
    setModel,
    setThinkingLevel,
    setSteeringMode,
    setFollowUpMode,
    promoteQueuedMessage,
    editQueuedMessage,
    setInterruptMode,
    setAutoCompaction,
    setFastMode,
    startLiveVoice,
    parkLiveVoice,
    stopLiveVoice,
    setLiveMuted,
    clearLiveError,
    switchLiveVoice,
    reconcileLivePlanReview,
    explainPlanVoice,
    setSessionServiceTier,
    setServiceTier,
    setAutoRetry,
    abortRetry,
    compactSession,
    exportHtml,
    shareSession,
    branchSession,
    stageRewind,
    performRewind,
    performNavigate,
    stageRewindEntry,
    stageForkEntry,
    performFork,
    stageNavigate,
    renameSessionTo,
    regenerateSessionTitle,
    setPlanMode,
    runSlashCommand,
    runShellCommand,
    abortShellCommands,
    predictWord,
    sendWordPredictionFeedback,
    runGoalCommand,
    runVibeCommand,
    runHiddenCommand,
    setTodos,
    refreshState,
    refreshStats,
    refreshAdvisorStats,
    refreshLimits,
    refreshSubagents,
    openSubagent,
    closeSubagent,
  };
}
