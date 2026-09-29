// Session parameter domain (decomposed for #295): prompting, slash commands,
// and every per-session parameter command — model, advisor, modes, retry,
// compaction, plan, todos, refreshes, subagent drill-down.
import type { BackendState, ImageAttachment } from "@omp-ui/core/types";
import { ADVISOR_STATS_COMMAND } from "@omp-ui/core/advisor-stats";
import { LIMITS_COMMAND } from "@omp-ui/core/limits";
import { planMessage } from "@omp-ui/core/plan";
import { parseExperimentProposalTitle } from "@omp-ui/core/autoresearch";
import {
  GOAL_OBJECTIVE_CHAR_LIMIT,
  goalMessage,
  type GoalCommandRequest,
} from "@omp-ui/core/goal";
import { backend, backendFor } from "../../backend";
import { withAttachmentRoutingContext } from "../../lib/attachment-routing";
import { t } from "../../lib/i18n";
import { projectKey } from "../../lib/project-key";
import { hasSeenSharePrivacy } from "../../lib/share-privacy";
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
import { randomId } from "../../lib/random-id";
import {
  COMPACT_SETTLE_DEADLINE_MS,
  RPC_COMMAND_TIMEOUT_MS,
  RpcCommandAbandonedError,
  dropPlanHandoff,
  respData,
  setRewindPrefill,
  takeRewindPrefill,
  type GetState,
  type SetState,
  type StoreMachinery,
  type Watchers,
} from "./shared";
import { rpcCommandMachinery } from "./rpc-command";
import { buildTitleTranscript } from "../../lib/session-transcript";
import { findOwner, findRecord, sessionCwd } from "./view";
import type { CompactionOutcome, UiStore } from "../types";

export type SessionParamsSlice = Pick<
  UiStore,
  | "advisorDefaults"
  | "answerExtension"
  | "reconcilePendingDialogs"
  | "sendPrompt"
  | "abortAgent"
  | "abortAndPrompt"
  | "loadAdvisorDefaults"
  | "setSessionAdvisor"
  | "setAdvisorModel"
  | "setModel"
  | "setThinkingLevel"
  | "setSteeringMode"
  | "setFollowUpMode"
  | "setInterruptMode"
  | "setAutoCompaction"
  | "setFastMode"
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
  | "stageNavigate"
  | "renameSessionTo"
  | "regenerateSessionTitle"
  | "setPlanMode"
  | "runSlashCommand"
  | "runShellCommand"
  | "abortShellCommands"
  | "runGoalCommand"
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

/** Monotonic per-tab re-titling request ids (the `rpcBooting` pattern): a
 *  settle only lands while its id is still the tab's newest (issue #433). */
const retitleCounters = new Map<string, number>();

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
    // omp's goal family is TUI-only: over rpc a `/goal` line would reach the
    // model as literal prompt text (issue #381). A native tab drives the root
    // goal bridge instead; a terminal tab's TUI keeps omp's own implementation.
    match: /^\/(?:goal|guided-goal)(?:\s[\s\S]*)?$/,
    run(tabId, get, line) {
      const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.mode !== "rpc-ui") return false;
      return get().runGoalCommand(tabId, line);
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
      for (const frame of pending) {
        if (parseExperimentProposalTitle(strField(frame, "title")) !== null) proposalFrame = frame;
        else generic.push(frame);
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
    }
  };

  const sendPrompt = async (
    tabId: string,
    message: string,
    route: PromptRoute = "steer",
    images?: ImageAttachment[],
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
    const wireMessage = withAttachmentRoutingContext(message, images?.length ?? 0);
    const cmd = { type: "prompt" as const, message: wireMessage, streamingBehavior };
    // `images` is omitted entirely when empty: omp's own client sends no key
    // rather than an empty array, and every byte here is on one JSON line.
    const response = await m.runCommand(tabId, images?.length ? { ...cmd, images } : cmd);
    return response !== null;
  };

  const abortAgent = async (tabId: string): Promise<void> => {
    await m.runCommand(tabId, { type: "abort" });
  };

  const abortAndPrompt = async (
    tabId: string,
    message: string,
    images?: ImageAttachment[],
  ): Promise<void> => {
    if (!m.acceptsCommands(tabId)) return;
    set((state) => ({ handedOffFor: dropPlanHandoff(state.handedOffFor, tabId) }));
    get().setInitialPrompt(tabId, message);
    advisorReplyWatcher.reset(tabId);
    stallContinueWatcher.reset(tabId);
    const type = "abort_and_prompt";
    const wireMessage = withAttachmentRoutingContext(message, images?.length ?? 0);
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

  /**
   * omp's fast mode: `enabled` is the session setting, `active` the computed
   * truth. The response always reports both as computed values, so there is
   * no optimistic patch. A same-value enable is NOT skipped: after a direct
   * Anthropic rejection the setting is already true while `active` is false,
   * and only an explicit enable clears that sticky fallback (rpc.md).
   */
  const setFastMode = async (tabId: string, enabled: boolean): Promise<void> => {
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
      get().reportError(t("session.error.rewindBusy"));
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
      // context; the images are omp's re-encoded mime types.
      images: clicked.images ?? [],
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
   * completion (the `runGoalCommand` correlation discipline, simplified:
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
    m.patchRpc(tabId, { hasRenamed: true, initialPrompt: null });
  };

  const regenerateSessionTitle = async (tabId: string): Promise<void> => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    const owner = findOwner(get().state, tabId);
    const rec = owner?.record;
    if (rec === undefined || rec.live !== "live" || get().exited[tabId] !== undefined) {
      // No process to take `set_session_name`, and omp-ui does not write
      // session files — resume first, then re-title (CONTEXT.md, Session).
      get().reportError(t("session.error.retitleNotLive"));
      return;
    }
    const digest = buildTitleTranscript(tab.items);
    if (digest.userTurns < 1 || digest.assistantTurns < 1) {
      get().reportError(t("session.error.retitleNoTranscript"));
      return;
    }
    const previousTitle = rec.title ?? "";
    const requestId = (retitleCounters.get(tabId) ?? 0) + 1;
    retitleCounters.set(tabId, requestId);
    // Nulling initialPrompt in the same patch makes an in-flight phase-2
    // auto-title abort on its own `initialPrompt !== prompt` check instead
    // of racing this send.
    m.patchRpc(tabId, { titleRegeneration: { requestId, previousTitle }, initialPrompt: null });
    const name = await backendFor(owner!.instanceId)
      .retitleSession(rec.projectCwd, previousTitle, digest.text)
      .catch(() => null);
    const current = get().rpc[tabId];
    // Tab gone, or a second click took over: the newest request owns the row.
    if (!current || current.titleRegeneration?.requestId !== requestId) return;
    m.patchRpc(tabId, { titleRegeneration: null });
    // A manual rename mid-flight wins: the row keeps what the user typed.
    if ((findRecord(get().state, tabId)?.title ?? "") !== previousTitle) return;
    // Declined, failed, or unchanged — the current title stands, silently.
    if (name === null || name === "" || name === previousTitle) return;
    const resp = await m.runCommand(
      tabId,
      { type: "set_session_name", name },
      { quiet: true },
    );
    if (resp === null) return;
    // The model answered for the user's click: latch like a rename, and
    // record the sent name so no auto-title path claims this row is unnamed.
    m.patchRpc(tabId, { hasRenamed: true, autoTitleSent: name });
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
    if (command.name === "compact" || command.name === "fast") await m.refreshUsage(tabId);
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

  /**
   * One goal-family line, dispatched as a command rather than as prose (issue
   * #381). The row keeps the line the user typed; the wire carries the hidden
   * bridge command with this client's requestId, and the bridge's published
   * snapshot — not the prompt acknowledgement — supplies the outcome. An
   * unavailable bridge is answered here with an actionable reason and sends
   * nothing at all to the model.
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
    const snapshot = get().rpc[tabId]?.goal ?? null;
    if (snapshot === null) {
      // An older live process cannot gain an extension by refreshing the
      // composer, and nothing is respawned on the user's behalf.
      settle({ status: "failed", error: t("composer.goal.needsRestart") });
      return;
    }
    if (!snapshot.available) {
      settle({
        status: "failed",
        error: t("composer.goal.unavailable", {
          reason: snapshot.unavailable ?? t("composer.goal.unavailableUnknown"),
        }),
      });
      return;
    }
    if (args.length > GOAL_OBJECTIVE_CHAR_LIMIT) {
      settle({ status: "failed", error: t("composer.goal.tooLong") });
      return;
    }
    const request: GoalCommandRequest = {
      requestId: randomId(),
      sessionId: snapshot.sessionId,
      processKey: snapshot.processKey,
      command: name === "guided-goal" ? "guided-goal" : "goal",
      args,
    };
    m.runtime(tabId).goalRequests.set(request.requestId, item.id);
    const resp = await m.runCommand(tabId, {
      type: "prompt",
      message: goalMessage(request),
    });
    if (resp !== null) return;
    // The prompt never reached the bridge: the snapshot can no longer answer
    // for it, so the row settles failed and its correlation is dropped. A
    // result that arrived first has already settled the row.
    m.runtime(tabId).goalRequests.delete(request.requestId);
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
    reconcilePendingDialogs,
    sendPrompt,
    abortAgent,
    abortAndPrompt,
    loadAdvisorDefaults,
    setSessionAdvisor,
    setAdvisorModel,
    setModel,
    setThinkingLevel,
    setSteeringMode,
    setFollowUpMode,
    setInterruptMode,
    setAutoCompaction,
    setFastMode,
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
    stageNavigate,
    renameSessionTo,
    regenerateSessionTitle,
    setPlanMode,
    runSlashCommand,
    runShellCommand,
    abortShellCommands,
    runGoalCommand,
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
