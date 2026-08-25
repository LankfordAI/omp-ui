// Session parameter domain (decomposed for #295): prompting, slash commands,
// and every per-session parameter command — model, advisor, modes, retry,
// compaction, plan, todos, refreshes, subagent drill-down.
import type { ImageAttachment } from "@omp-ui/core/types";
import { ADVISOR_STATS_COMMAND } from "@omp-ui/core/advisor-stats";
import { planMessage } from "@omp-ui/core/plan";
import { backend } from "../../backend";
import { arrField, boolField, field, strField } from "../../lib/fields";
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
  type CommandItem,
} from "../../lib/transcript";
import {
  RPC_COMMAND_TIMEOUT_MS,
  alertError,
  handedOffPlanSources,
  respData,
  type GetState,
  type SetState,
  type StoreMachinery,
  type Watchers,
} from "./shared";
import { findRecord } from "./view";
import type { UiStore } from "../types";

export type SessionParamsSlice = Pick<
  UiStore,
  | "advisorDefaults"
  | "answerExtension"
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
  | "setAutoRetry"
  | "abortRetry"
  | "compactSession"
  | "exportHtml"
  | "branchSession"
  | "renameSessionTo"
  | "setPlanMode"
  | "runSlashCommand"
  | "setTodos"
  | "refreshState"
  | "refreshStats"
  | "refreshAdvisorStats"
  | "refreshSubagents"
  | "openSubagent"
  | "closeSubagent"
>;

export interface SessionParamsDeps extends Watchers {
  prepareRpcRelaunch(tabId: string): void;
}

/** Whole parameter actions, including their authoritative registry write. */
const pendingSessionParameterActions = new Map<string, Set<Promise<void>>>();

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

  const sendPrompt = async (
    tabId: string,
    message: string,
    route: PromptRoute = "steer",
    images?: ImageAttachment[],
  ): Promise<boolean> => {
    const tab = get().rpc[tabId];
    if (!tab || tab.status === "starting") return false;
    if (route === "advisor_reply" || route === "stall_continue") {
      // omp-ui's own prompt (a late-review answer, a stall continue): it
      // must not title the session and must not re-arm either loop guard —
      // an auto-prompt is not human direction.
    } else {
      // Human direction makes a previously handed-off source active again,
      // even when its immediate hibernation was declined.
      handedOffPlanSources.delete(tabId);
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
    const cmd = { type: "prompt", message, streamingBehavior };
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
    if (get().rpc[tabId]?.status === "starting") return;
    handedOffPlanSources.delete(tabId);
    get().setInitialPrompt(tabId, message);
    advisorReplyWatcher.reset(tabId);
    stallContinueWatcher.reset(tabId);
    const type = "abort_and_prompt";
    await m.runCommand(
      tabId,
      images?.length ? { type, message, images } : { type, message },
    );
  };

  const loadAdvisorDefaults = async (projectCwd: string): Promise<void> => {
    if (get().advisorDefaults[projectCwd]) return;
    try {
      const defaults = await backend.getAdvisorDefaults(projectCwd);
      set((s) => ({
        advisorDefaults: { ...s.advisorDefaults, [projectCwd]: defaults },
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
    preservedPlanMode?: boolean,
  ): Promise<void> => {
    const tab = get().rpc[tabId];
    if (tab?.status === "starting") return;
    const rec = findRecord(get().state, tabId);
    const changedLive =
      rec?.live === "live" &&
      rec.mode === "rpc-ui" &&
      (rec.advisor !== advisor || rec.advisorModel !== advisorModel);
    if (changedLive && tab) {
      const previousStatus = tab.status;
      const previousStreaming = tab.session.isStreaming;
      const previousPlan = tab.plan;
      const commandIds = new Set(
        [...tab.pendingCommands.entries()]
          .filter(([, pending]) => !pending.quiet)
          .map(([id]) => id),
      );
      const parameterActions = [
        ...(pendingSessionParameterActions.get(tabId) ?? []),
      ];
      const deadline = Date.now() + RPC_COMMAND_TIMEOUT_MS + 1_000;
      deps.prepareRpcRelaunch(tabId);
      await m.pollUntil(
        tabId,
        (current) =>
          current !== undefined &&
          [...commandIds].every((id) => !current.pendingCommands.has(id)),
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
        [...commandIds].some((id) => current.pendingCommands.has(id));
      const parametersRemain = parameterActions.some((action) =>
        pendingSessionParameterActions.get(tabId)?.has(action),
      );
      if (commandsRemain || parametersRemain) {
        if (current) {
          m.patchRpc(tabId, {
            status: previousStatus,
            session: { ...current.session, isStreaming: previousStreaming },
            plan: previousPlan,
          });
        }
        window.alert(
          "Could not restart the advisor because an in-flight session command did not settle. The session is still running.",
        );
        return;
      }
    }
    const startInPlanMode =
      preservedPlanMode ??
      (changedLive
        ? (get().rpc[tabId]?.plan?.enabled ?? tab?.plan?.enabled ?? false)
        : false);
    try {
      await backend.setSessionAdvisor(tabId, advisor, advisorModel, startInPlanMode);
    } catch (err) {
      // Changing the advisor relaunches the agent, so a failure here means
      // the session is down, not merely that a setting did not stick. Say
      // that, rather than surfacing the bare IPC error.
      const reason = err instanceof Error ? err.message : String(err);
      window.alert(
        `Could not ${advisor ? "enable" : "disable"} the advisor: ${reason}\n\n` +
          "The agent has stopped — resume the session to continue.",
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
    if (get().rpc[tabId]?.status === "starting") return;
    const action = (async (): Promise<void> => {
      const resp = await m.runCommand(tabId, {
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
      if (resp === null) return;
      const selected = parseModelInfo(respData(resp)) ?? model;
      m.patchRpc(tabId, { model: selected });
      const thinkingLevel = get().rpc[tabId]?.session.thinkingLevel ?? null;
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
    if (get().rpc[tabId]?.status === "starting") return;
    const action = (async (): Promise<void> => {
      const resp = await m.runCommand(tabId, {
        type: "set_thinking_level",
        level,
      });
      if (resp === null) return;
      m.patchSession(tabId, { thinkingLevel: level });
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

  const setAutoRetry = async (tabId: string, enabled: boolean): Promise<void> => {
    await m.runCommand(tabId, { type: "set_auto_retry", enabled });
  };

  const abortRetry = async (tabId: string): Promise<void> => {
    await m.runCommand(tabId, { type: "abort_retry" });
  };

  const compactSession = async (tabId: string): Promise<void> => {
    m.appendItem(tabId, markerItem("compacting context", "copper"));
    const resp = await m.runCommand(tabId, { type: "compact" });
    if (resp === null) return;
    // `data.summary` is the entire compacted history — noted, never rendered.
    m.appendItem(tabId, markerItem("context compacted", "copper"));
    await m.refreshUsage(tabId);
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
      alertError(err);
    }
  };

  const renameSessionTo = async (tabId: string, name: string): Promise<void> => {
    const resp = await m.runCommand(tabId, { type: "set_session_name", name });
    if (resp === null) return;
    // A user-chosen name is final — the auto-titler must not overwrite it.
    m.patchRpc(tabId, { hasRenamed: true, initialPrompt: null });
  };

  const setPlanMode = async (tabId: string, enabled: boolean): Promise<void> => {
    if (get().rpc[tabId]?.status === "starting") return;
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
    if (message.trim() === "/") return;
    // omp-ui's own /new: a new live session in a new tab, not omp's in-process
    // lineage switch (that stays on the HUD's new-session button and in terminal
    // tabs' TUI). Bare command only — "/new …" still reaches omp verbatim.
    if (message.trim() === "/new") {
      const projectCwd = get().tabs.find(
        (t) => t.tabId === tabId,
      )?.projectCwd;
      // A composer only exists for a mounted tab; without one, keep the old path.
      if (projectCwd !== undefined) {
        await get().newSession(projectCwd);
        return;
      }
    }
    // omp-ui's plan toggle: omp's /plan is TUI-only, so over rpc it would
    // reach the model as literal prompt text and start an agent turn
    // (ADR-0007). Bare forms only — "/plan …" with any other argument still
    // reaches omp verbatim, and a pty tab's TUI owns its own /plan.
    const trimmed = message.trim();
    const planOn = /^\/plan(?:\s+on)?$/.test(trimmed);
    const planOff = /^\/(?:plan\s+off|no-plan)$/.test(trimmed);
    if (planOn || planOff) {
      const tab = get().tabs.find((t) => t.tabId === tabId);
      if (tab?.mode === "rpc-ui") {
        await get().setPlanMode(tabId, planOn);
        return;
      }
    }
    // omp-ui's MCP manager already owns the /mcp list surface. Bare forms
    // only — every other subcommand (reauth, add, …) works over rpc and
    // reaches omp verbatim with the normal command lifecycle.
    if (/^\/mcp(?:\s+list)?$/.test(trimmed)) {
      const projectCwd = get().tabs.find(
        (t) => t.tabId === tabId,
      )?.projectCwd;
      if (projectCwd !== undefined) {
        get().openMcpManager(projectCwd, tabId);
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
    const byRequest =
      m.slashCommandItems.get(tabId) ?? new Map<string, string>();
    m.slashCommandItems.set(tabId, byRequest);
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
    if (command.name === "compact") await m.refreshUsage(tabId);
    // `agentInvoked` absent (older runtime): stay running — prompt_result's
    // id mapping or the next agent_start settles it.
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
    await m.runCommand(tabId, {
      type: "prompt",
      message: `/${ADVISOR_STATS_COMMAND}`,
    });
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
    setAutoRetry,
    abortRetry,
    compactSession,
    exportHtml,
    branchSession,
    renameSessionTo,
    setPlanMode,
    runSlashCommand,
    setTodos,
    refreshState,
    refreshStats,
    refreshAdvisorStats,
    refreshSubagents,
    openSubagent,
    closeSubagent,
  };
}
