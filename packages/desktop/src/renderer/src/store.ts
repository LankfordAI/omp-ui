import { create } from "zustand";
import type {
  AdvisorDefaults,
  BackendState,
  ImageAttachment,
  SessionMode,
  SessionSummary,
} from "@omp-ui/core/types";
import { backend } from "./backend";
import { extensionCancelResponse, routeExtensionRequest } from "./lib/extension-router";
import { arrField, field, strField } from "./lib/fields";
import {
  emptySessionRuntime,
  parseCommandList,
  parseModelInfo,
  parseModelList,
  parseSessionRuntime,
  parseSessionStats,
  parseSubagents,
  parseTodoPhases,
  type ModelInfo,
  type PromptRoute,
  type SessionRuntime,
  type SessionStats,
  type SlashCommandInfo,
  type SubagentInfo,
  type TodoPhase,
} from "./lib/rpc-types";
import { generateTitleFromPrompt, isLowSignalTitleInput, isUntitled } from "./lib/session-title";
import {
  historyToItems,
  markerItem,
  noticeItem,
  reduceEvent,
  type RenderItem,
} from "./lib/transcript";

export interface TabInfo {
  tabId: string;
  mode: SessionMode;
  projectCwd: string;
  /** Hidden tabs stay mounted (display:none) — the xterm instance survives. */
  hidden: boolean;
}

export interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
}

/** Per-tab rpc-ui state (the phase-2 doc's state machine, concretized). */
export interface RpcTabState {
  status: "starting" | "ready" | "running" | "error";
  items: RenderItem[];
  todos: TodoPhase[];
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  commands: SlashCommandInfo[];
  session: SessionRuntime;
  stats: SessionStats | null;
  subagents: SubagentInfo[];
  /** Extension setStatus/setWidget/setTitle text, keyed by widget/status key. */
  extensionStatus: Record<string, string>;
  /** Not rendered — mutated in place. */
  pendingCommands: Map<string, PendingCommand>;
  extensionQueue: unknown[];
  bashLines: string[];
  /** Slash-command output, newest last. */
  commandOutput: string[];
  /** True while any rpc command is in flight. */
  busy: boolean;
  error?: string;
  /**
   * The first user message worth titling from. Set on the first substantive
   * prompt, cleared once the rename lands.
   */
  initialPrompt: string | null;
  /** Whether this tab's session has been auto-titled (or was already named). */
  hasRenamed: boolean;
}

function freshRpcTabState(): RpcTabState {
  return {
    status: "starting",
    items: [],
    todos: [],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [],
    extensionStatus: {},
    pendingCommands: new Map(),
    extensionQueue: [],
    bashLines: [],
    commandOutput: [],
    busy: false,
    initialPrompt: null,
    hasRenamed: false,
  };
}

interface UiStore {
  state: BackendState | null;
  tabs: TabInfo[];
  activeTabId: string | null;
  exited: Record<string, number>;
  rpc: Record<string, RpcTabState>;
  /** omp's advisor defaults, keyed by project cwd — see loadAdvisorDefaults. */
  advisorDefaults: Record<string, AdvisorDefaults>;
  init(): Promise<void>;
  addProject(): Promise<void>;
  removeProject(path: string): Promise<void>;
  toggleAdvisor(path: string, advisor: boolean): Promise<void>;
  setDefaultMode(mode: SessionMode): Promise<void>;
  newSession(projectCwd: string): Promise<void>;
  openSession(tabId: string): Promise<void>;
  focusTab(tabId: string): void;
  hideTab(tabId: string): void;
  terminate(tabId: string): Promise<void>;
  switchMode(tabId: string, mode: SessionMode): Promise<void>;
  resumeDead(tabId: string): Promise<void>;
  /** Confirms, then erases the record and its files on disk. Irreversible. */
  deleteSession(tabId: string): Promise<void>;
  bootRpcTab(tabId: string): Promise<void>;
  rpcCommand(tabId: string, cmd: Record<string, unknown>): Promise<unknown>;
  handleRpcFrame(tabId: string, frame: object): void;
  answerExtension(tabId: string, request: unknown, response: Record<string, unknown>): void;
  runBash(tabId: string, command: string): Promise<void>;
  abortBash(tabId: string): Promise<void>;
  /** Offer a user message as the auto-title source; low-signal text defers. */
  setInitialPrompt(tabId: string, prompt: string): void;
  /** Auto-title the session from the stored prompt. */
  renameSession(tabId: string): void;

  /** Routes on status: ready → prompt, running → steer|follow_up per `route`. */
  sendPrompt(
    tabId: string,
    message: string,
    route?: PromptRoute,
    images?: ImageAttachment[],
  ): Promise<void>;
  abortAgent(tabId: string): Promise<void>;
  abortAndPrompt(tabId: string, message: string, images?: ImageAttachment[]): Promise<void>;

  /**
   * omp's own advisor defaults for a project, cached per cwd. Read from omp's
   * config because the rpc protocol reports no advisor state at all.
   */
  loadAdvisorDefaults(projectCwd: string): Promise<void>;
  /**
   * Re-pins this session's advisor. Relaunches a live session — omp binds both
   * `advisor.enabled` and the `advisor` role at process start.
   */
  setSessionAdvisor(tabId: string, advisor: boolean, advisorModel: string | null): Promise<void>;

  setModel(tabId: string, model: ModelInfo): Promise<void>;
  cycleModel(tabId: string): Promise<void>;
  setThinkingLevel(tabId: string, level: string): Promise<void>;
  cycleThinkingLevel(tabId: string): Promise<void>;

  setSteeringMode(tabId: string, mode: string): Promise<void>;
  setFollowUpMode(tabId: string, mode: string): Promise<void>;
  setInterruptMode(tabId: string, mode: string): Promise<void>;

  setAutoCompaction(tabId: string, enabled: boolean): Promise<void>;
  setAutoRetry(tabId: string, enabled: boolean): Promise<void>;
  abortRetry(tabId: string): Promise<void>;
  compactSession(tabId: string): Promise<void>;

  exportHtml(tabId: string): Promise<void>;
  branchSession(tabId: string): Promise<void>;
  renameSessionTo(tabId: string, name: string): Promise<void>;
  newRpcSession(tabId: string): Promise<void>;

  /** `line` may include args, e.g. "/advisor on". Leading "/" optional. */
  runSlashCommand(tabId: string, line: string): Promise<void>;
  setTodos(tabId: string, phases: TodoPhase[]): Promise<void>;
  refreshState(tabId: string): Promise<void>;
  refreshStats(tabId: string): Promise<void>;
  refreshSubagents(tabId: string): Promise<void>;
  clearCommandOutput(tabId: string): void;
  clearBash(tabId: string): void;
}

// One IPC data listener total; each TerminalTab registers its writer here.
const termWriters = new Map<string, (data: Uint8Array) => void>();
export function registerTermWriter(tabId: string, cb: (data: Uint8Array) => void): () => void {
  termWriters.set(tabId, cb);
  return () => {
    termWriters.delete(tabId);
  };
}

export function findRecord(
  state: BackendState | null,
  tabId: string,
): SessionSummary | undefined {
  for (const group of state?.projects ?? []) {
    const hit = group.sessions.find((s) => s.tabId === tabId);
    if (hit) return hit;
  }
  return undefined;
}

function dropExited(exited: Record<string, number>, tabId: string): Record<string, number> {
  const next = { ...exited };
  delete next[tabId];
  return next;
}

function alertError(err: unknown): void {
  window.alert(err instanceof Error ? err.message : String(err));
}

// StrictMode double-invokes effects in dev, and the preload listener API has
// no unsubscribe — init must be idempotent or every listener registers twice.
let initialized = false;

/** A new rpc process emits exactly one ready frame — that's the boot signal. */
const rpcBooting = new Set<string>();

/** setStatus/setWidget/setTitle carry their text under different keys. */
function extensionStatusEntry(frame: object): { key: string; text: string | undefined } | null {
  const method = strField(frame, "method");
  const id = strField(frame, "id") ?? "";
  if (method === "setWidget") {
    const lines = arrField(frame, "widgetLines").filter((l): l is string => typeof l === "string");
    return {
      key: strField(frame, "widgetKey") ?? id,
      // `widgetLines: undefined` is the protocol's "clear this widget".
      text: field(frame, "widgetLines") === undefined ? undefined : lines.join("\n"),
    };
  }
  if (method === "setStatus") {
    return { key: strField(frame, "statusKey") ?? id, text: strField(frame, "statusText") };
  }
  if (method === "setTitle") {
    return { key: strField(frame, "widgetKey") ?? id, text: strField(frame, "title") };
  }
  return null;
}

export const useStore = create<UiStore>()((set, get) => {
  const patchRpc = (tabId: string, patch: Partial<RpcTabState>): void => {
    set((s) => {
      const tab = s.rpc[tabId];
      if (!tab) return s;
      return { rpc: { ...s.rpc, [tabId]: { ...tab, ...patch } } };
    });
  };

  // Command responses nest their payload under `data`.
  const respData = (resp: unknown): unknown =>
    resp !== null &&
    typeof resp === "object" &&
    "data" in resp &&
    resp.data !== null &&
    typeof resp.data === "object"
      ? resp.data
      : resp;

  /**
   * Every store method routes failures here: the tab keeps its status (a
   * rejected `set_model` must not wedge a live session into "error") but the
   * message surfaces instead of vanishing into a swallowed catch. Resolves to
   * the response frame, or `null` — which a real response never is — on failure.
   */
  const runCommand = async (tabId: string, cmd: Record<string, unknown>): Promise<unknown> => {
    try {
      const resp = await get().rpcCommand(tabId, cmd);
      // A later success retires a transient failure banner, but never a fatal
      // one — `status: "error"` means the process itself is gone.
      const tab = get().rpc[tabId];
      if (tab?.error !== undefined && tab.status !== "error") patchRpc(tabId, { error: undefined });
      return resp;
    } catch (err) {
      patchRpc(tabId, { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  const appendItem = (tabId: string, item: RenderItem): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    patchRpc(tabId, { items: [...tab.items, item] });
  };

  const patchSession = (tabId: string, patch: Partial<SessionRuntime>): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    patchRpc(tabId, { session: { ...tab.session, ...patch } });
  };

  const applyRpcState = (tabId: string, resp: unknown): void => {
    const tab = get().rpc[tabId];
    const payload = respData(resp);
    if (!tab || payload === null || typeof payload !== "object") return;
    patchRpc(tabId, {
      todos:
        "todoPhases" in payload ? parseTodoPhases(field(payload, "todoPhases")) : tab.todos,
      model: parseModelInfo(field(payload, "model")) ?? tab.model,
      session: parseSessionRuntime(payload, tab.session),
    });
  };

  const loadHistory = async (tabId: string): Promise<void> => {
    const resp = await get().rpcCommand(tabId, { type: "get_messages" });
    patchRpc(tabId, { items: historyToItems(arrField(respData(resp), "messages")) });
  };

  return {
    state: null,
    tabs: [],
    activeTabId: null,
    exited: {},
    rpc: {},
    advisorDefaults: {},

    async init() {
      if (initialized) return;
      initialized = true;
      backend.onStateChanged((state) => {
        set((s) => ({
          state,
          // Record mode is authoritative — tabs follow it (e.g. after switchMode).
          tabs: s.tabs.map((t) => {
            const rec = findRecord(state, t.tabId);
            return rec && rec.mode !== t.mode ? { ...t, mode: rec.mode } : t;
          }),
        }));
      });
      backend.onPtyData((tabId, data) => termWriters.get(tabId)?.(data));
      backend.onPtyExit((tabId, code) => {
        set((s) => ({ exited: { ...s.exited, [tabId]: code } }));
      });
      backend.onRpcFrame((tabId, frame) => get().handleRpcFrame(tabId, frame));
      set({ state: await backend.getState() });
    },

    async addProject() {
      await backend.addProject();
    },

    async removeProject(path) {
      if (
        !window.confirm(`Remove project ${path} and its session records? Files on disk are kept.`)
      )
        return;
      try {
        await backend.removeProject(path);
      } catch (err) {
        alertError(err);
      }
    },

    async toggleAdvisor(path, advisor) {
      await backend.setProjectAdvisor(path, advisor);
    },

    async setDefaultMode(mode) {
      await backend.setDefaultMode(mode);
    },

    async newSession(projectCwd) {
      const { state } = get();
      const project = state?.projects.find((p) => p.project.path === projectCwd)?.project;
      const mode = state?.defaultMode ?? "pty";
      try {
        const { tabId } = await backend.spawnSession({
          projectCwd,
          mode,
          advisor: project?.advisor ?? false,
          cols: 80,
          rows: 24,
        });
        set((s) => ({
          tabs: [...s.tabs, { tabId, mode, projectCwd, hidden: false }],
          activeTabId: tabId,
          exited: dropExited(s.exited, tabId),
        }));
      } catch (err) {
        alertError(err);
      }
    },

    async openSession(tabId) {
      const existing = get().tabs.find((t) => t.tabId === tabId);
      if (existing) {
        // Live session → resurface its tab, never respawn (omp has no
        // cross-process session lock; two writers would corrupt the .jsonl).
        set((s) => ({
          tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, hidden: false } : t)),
          activeTabId: tabId,
        }));
        return;
      }
      const rec = findRecord(get().state, tabId);
      if (!rec) return;
      try {
        await backend.spawnSession({
          projectCwd: rec.projectCwd,
          mode: rec.mode,
          advisor: rec.advisor,
          cols: 80,
          rows: 24,
          resumeTabId: tabId,
        });
        set((s) => ({
          tabs: [...s.tabs, { tabId, mode: rec.mode, projectCwd: rec.projectCwd, hidden: false }],
          activeTabId: tabId,
          exited: dropExited(s.exited, tabId),
        }));
      } catch (err) {
        alertError(err);
      }
    },

    focusTab(tabId) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, hidden: false } : t)),
        activeTabId: tabId,
      }));
    },

    hideTab(tabId) {
      set((s) => {
        const tabs = s.tabs.map((t) => (t.tabId === tabId ? { ...t, hidden: true } : t));
        let activeTabId = s.activeTabId;
        if (activeTabId === tabId) {
          const visible = tabs.filter((t) => !t.hidden);
          activeTabId = visible.length > 0 ? visible[visible.length - 1]!.tabId : null;
        }
        return { tabs, activeTabId };
      });
    },

    async terminate(tabId) {
      if (!window.confirm("Terminate the running agent? The session stays resumable.")) return;
      await backend.terminateSession(tabId);
    },

    async switchMode(tabId, mode) {
      const rec = findRecord(get().state, tabId);
      if (rec?.live === "live") {
        const other = mode === "pty" ? "terminal" : "native";
        if (
          !window.confirm(
            `Restart this session in ${other} mode? The process is killed and resumed.`,
          )
        )
          return;
      }
      try {
        await backend.switchMode(tabId, mode);
      } catch (err) {
        alertError(err);
      }
    },

    async resumeDead(tabId) {
      const rec = findRecord(get().state, tabId);
      if (!rec) return;
      try {
        await backend.spawnSession({
          projectCwd: rec.projectCwd,
          mode: rec.mode,
          advisor: rec.advisor,
          cols: 80,
          rows: 24,
          resumeTabId: tabId,
        });
        set((s) => ({
          tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, hidden: false } : t)),
          activeTabId: tabId,
          exited: dropExited(s.exited, tabId),
        }));
      } catch (err) {
        alertError(err);
      }
    },

    async deleteSession(tabId) {
      const rec = findRecord(get().state, tabId);
      if (!rec) return;
      // The row keeps its button enabled while live so the trash can never
      // looks broken; the backend would reject anyway, so say why up front
      // rather than opening a confirm that cannot succeed.
      if (rec.live === "live") {
        window.alert("This session is still running — terminate it before deleting.");
        return;
      }
      const label = rec.live === "missing" ? "" : " Its transcript and artifacts are erased.";
      if (!window.confirm(`Delete "${rec.title}" permanently?${label} This cannot be undone.`)) {
        return;
      }
      try {
        await backend.deleteSession(tabId);
      } catch (err) {
        alertError(err);
        return;
      }
      const tab = get().rpc[tabId];
      if (tab) {
        for (const pending of tab.pendingCommands.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("session deleted"));
        }
      }
      set((s) => {
        const rpc = { ...s.rpc };
        delete rpc[tabId];
        const tabs = s.tabs.filter((t) => t.tabId !== tabId);
        const activeTabId =
          s.activeTabId === tabId
            ? (tabs.filter((t) => !t.hidden).at(-1)?.tabId ?? null)
            : s.activeTabId;
        return { rpc, tabs, activeTabId, exited: dropExited(s.exited, tabId) };
      });
    },

    async bootRpcTab(tabId) {
      if (rpcBooting.has(tabId)) return;
      rpcBooting.add(tabId);
      try {
        patchRpc(tabId, freshRpcTabState());
        // The tab may not exist in state yet — ensure the slot exists.
        if (!get().rpc[tabId]) {
          set((s) => ({ rpc: { ...s.rpc, [tabId]: freshRpcTabState() } }));
        }
        // Boot can outrun init()'s first getState — the record decides whether
        // history (get_messages) is fetched, so don't read it from thin air.
        if (!get().state) set({ state: await backend.getState() });
        const rec = findRecord(get().state, tabId);
        // get_state is the canary: if it fails, the tab is dead, not "ready".
        const stateFailure = await get()
          .rpcCommand(tabId, { type: "get_state" })
          .then(
            (resp) => {
              applyRpcState(tabId, resp);
              return null;
            },
            (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
          );
        // allSettled, not all: a missing subagent bus or a slow stats read must
        // never leave the tab stuck in "starting".
        const boots: Promise<unknown>[] = [
          get()
            .rpcCommand(tabId, { type: "get_available_models" })
            .then((resp) => {
              patchRpc(tabId, { availableModels: parseModelList(respData(resp)) });
            }),
          get()
            .rpcCommand(tabId, { type: "get_available_commands" })
            .then((resp) => {
              patchRpc(tabId, { commands: parseCommandList(respData(resp)) });
            }),
          get()
            .rpcCommand(tabId, { type: "get_session_stats" })
            .then((resp) => {
              patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
            }),
          // "progress" | "events" are the only legal levels; progress is the
          // cheap one — per-agent status, not every subagent token.
          get().rpcCommand(tabId, { type: "set_subagent_subscription", level: "progress" }),
        ];
        if (rec?.sessionId) boots.push(loadHistory(tabId));
        await Promise.allSettled(boots);
        if (stateFailure) {
          patchRpc(tabId, { status: "error", error: `get_state failed: ${stateFailure.message}` });
        } else {
          patchRpc(tabId, { status: "ready" });
        }
      } catch (err) {
        patchRpc(tabId, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        rpcBooting.delete(tabId);
      }
    },

    rpcCommand(tabId, cmd) {
      const tab = get().rpc[tabId];
      if (!tab) return Promise.reject(new Error("rpc tab not initialized"));
      const id = crypto.randomUUID();
      // Executor form required: the pending entry must exist before send.
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          get().rpc[tabId]?.pendingCommands.delete(id);
          reject(new Error("rpc command timed out"));
        }, 30_000);
        tab.pendingCommands.set(id, { resolve, reject, timer });
      });
      patchRpc(tabId, { busy: true });
      backend.rpcSend(tabId, { ...cmd, id });
      // The map is the ref count: both settle paths remove their entry before
      // settling, so concurrent commands can't clear `busy` for each other.
      return promise.finally(() => {
        if ((get().rpc[tabId]?.pendingCommands.size ?? 0) === 0) {
          patchRpc(tabId, { busy: false });
        }
      });
    },

    handleRpcFrame(tabId, frame) {
      const tab = get().rpc[tabId];
      if (!tab || frame === null || typeof frame !== "object") return;
      const type = "type" in frame ? frame.type : undefined;
      switch (type) {
        case "response": {
          const id = "id" in frame && typeof frame.id === "string" ? frame.id : null;
          const pending = id ? tab.pendingCommands.get(id) : undefined;
          if (!pending) return;
          clearTimeout(pending.timer);
          tab.pendingCommands.delete(id!);
          if ("success" in frame && frame.success === false) {
            const message =
              "error" in frame && typeof frame.error === "string" ? frame.error : "command failed";
            pending.reject(new Error(message));
          } else {
            pending.resolve(frame);
          }
          return;
        }
        case "ready":
          // A fresh process — (re)boot this tab's state.
          void get().bootRpcTab(tabId);
          return;
        case "rpc_chunk":
          return; // reassembled in main — never expected here
        case "session_info_update":
          patchRpc(tabId, { session: parseSessionRuntime(frame, tab.session) });
          return;
        case "config_update":
          patchRpc(tabId, {
            model: parseModelInfo(field(frame, "model")) ?? tab.model,
            session: parseSessionRuntime(frame, tab.session),
          });
          return;
        case "available_commands_update":
          patchRpc(tabId, { commands: parseCommandList(frame) });
          return;
        case "subagent_lifecycle":
        case "subagent_progress":
        case "subagent_event": {
          const payload = field(frame, "payload");
          const progress = field(payload, "progress");
          const name =
            strField(payload, "agent") ??
            strField(progress, "agent") ??
            strField(payload, "id") ??
            "subagent";
          const status = strField(payload, "status") ?? strField(progress, "status");
          const label = status ? `subagent ${name}: ${status}` : `subagent ${name}`;
          // Progress frames repeat every heartbeat — collapse an identical
          // consecutive label instead of stamping the transcript each time.
          const last = tab.items.at(-1);
          if (!(last?.kind === "marker" && last.label === label)) {
            appendItem(tabId, markerItem(label, "copper"));
          }
          void get().refreshSubagents(tabId);
          return;
        }
        case "extension_error": {
          const text = strField(frame, "error") ?? "extension error";
          appendItem(tabId, {
            ...noticeItem(text, "error"),
            source: strField(frame, "extensionPath"),
          });
          return;
        }
        case "command_output": {
          const text = strField(frame, "text") ?? strField(frame, "output") ?? "";
          patchRpc(tabId, {
            bashLines: [...tab.bashLines, text],
            commandOutput: [...tab.commandOutput, text],
          });
          return;
        }
        case "extension_ui_request": {
          const action = routeExtensionRequest(frame);
          if (action.action === "dialog") {
            patchRpc(tabId, { extensionQueue: [...tab.extensionQueue, frame] });
            return;
          }
          // Every non-dialog method is answered immediately — omp blocks on the
          // reply — but status/widget/title text is recorded first, because it
          // is the extension's actual output, not an interaction to decline.
          const entry = extensionStatusEntry(frame);
          if (entry) {
            const extensionStatus = { ...tab.extensionStatus };
            if (entry.text === undefined || entry.text === "") delete extensionStatus[entry.key];
            else extensionStatus[entry.key] = entry.text;
            patchRpc(tabId, { extensionStatus });
          }
          backend.rpcSend(tabId, extensionCancelResponse("id" in frame ? frame.id : undefined));
          if (!entry) {
            const method = strField(frame, "method") ?? "?";
            appendItem(tabId, markerItem(`extension ${method} auto-cancelled`));
          }
          return;
        }
        case "prompt_result":
          patchRpc(tabId, { status: "ready" });
          return;
        case "omp_ui_error": {
          const message = strField(frame, "message") ?? "omp rpc error";
          patchRpc(tabId, { status: "error", error: message });
          return;
        }
        case "host_tool_call":
          // No host tools are registered — answer with an error, never hang the agent.
          backend.rpcSend(tabId, {
            type: "host_tool_result",
            id: "id" in frame ? frame.id : undefined,
            error: "omp-ui does not register host tools",
          });
          return;
        case "host_uri_request":
          // Same discipline: omp awaits a result for every uri request.
          backend.rpcSend(tabId, {
            type: "host_uri_result",
            id: "id" in frame ? frame.id : undefined,
            error: "omp-ui registers no uri schemes",
          });
          return;
        default: {
          // The AgentSessionEvent stream — the actual transcript.
          patchRpc(tabId, { items: reduceEvent(tab.items, frame) });
          if (type === "thinking_level_changed") {
            const level = strField(frame, "thinkingLevel");
            if (level) patchSession(tabId, { thinkingLevel: level });
          }
          if (type === "agent_start") {
            patchRpc(tabId, { status: "running" });
          }
          if (type === "agent_end") {
            if (tab.status === "running") patchRpc(tabId, { status: "ready" });

            // The transcript's first substantive prompt names the session.
            if (tab.initialPrompt && !tab.hasRenamed) get().renameSession(tabId);

            // Refresh todoPhases/contextUsage/isStreaming after each agent run.
            void get()
              .rpcCommand(tabId, { type: "get_state" })
              .then((resp) => applyRpcState(tabId, resp))
              .catch(() => {});
          }
        }
      }
    },

    answerExtension(tabId, request, response) {
      const tab = get().rpc[tabId];
      if (!tab) return;
      const id =
        request !== null && typeof request === "object" && "id" in request ? request.id : undefined;
      backend.rpcSend(tabId, { type: "extension_ui_response", id, ...response });
      patchRpc(tabId, { extensionQueue: tab.extensionQueue.filter((q) => q !== request) });
    },

    async runBash(tabId, command) {
      const resp = await get()
        .rpcCommand(tabId, { type: "bash", command })
        .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
      const tab = get().rpc[tabId];
      if (!tab) return;
      const payload = respData(resp);
      const text = strField(payload, "output") ?? strField(payload, "error") ?? "";
      if (text) patchRpc(tabId, { bashLines: [...tab.bashLines, text] });
    },

    async abortBash(tabId) {
      await get()
        .rpcCommand(tabId, { type: "abort_bash" })
        .catch(() => {});
    },

    setInitialPrompt(tabId, prompt) {
      const tab = get().rpc[tabId];
      if (!tab || tab.initialPrompt || tab.hasRenamed) return;
      // A resumed or user-named session owns its title — never overwrite it.
      // Decided here, at prompt time, because `set_session_name` writes with
      // source "user" and omp then refuses every later auto title.
      if (!isUntitled(findRecord(get().state, tabId)?.title)) {
        patchRpc(tabId, { hasRenamed: true });
        return;
      }
      // A greeting or bare ack would latch permanently — defer to the next
      // prompt instead (same policy as omp's own titling).
      if (isLowSignalTitleInput(prompt)) return;
      patchRpc(tabId, { initialPrompt: prompt });
    },

    renameSession(tabId) {
      const tab = get().rpc[tabId];
      if (!tab || !tab.initialPrompt || tab.hasRenamed) return;
      // Latch before sending so a second agent_end can't double-rename.
      patchRpc(tabId, { hasRenamed: true });
      const name = generateTitleFromPrompt(tab.initialPrompt);
      void get()
        .rpcCommand(tabId, { type: "set_session_name", name })
        .then(() => {
          patchRpc(tabId, { initialPrompt: null });
        })
        .catch((err: unknown) => {
          // Release the latch so the next agent_end retries.
          patchRpc(tabId, { hasRenamed: false });
          console.warn("[session-rename] set_session_name failed:", err);
        });
    },

    async sendPrompt(tabId, message, route = "steer", images) {
      const tab = get().rpc[tabId];
      if (!tab) return;
      // Titling reads the first substantive prompt, whichever route it took.
      get().setInitialPrompt(tabId, message);
      const type =
        tab.status === "running" ? (route === "follow_up" ? "follow_up" : "steer") : "prompt";
      // `images` is omitted entirely when empty: omp's own client sends no key
      // rather than an empty array, and every byte here is on one JSON line.
      await runCommand(tabId, images?.length ? { type, message, images } : { type, message });
    },

    async abortAgent(tabId) {
      await runCommand(tabId, { type: "abort" });
    },

    async abortAndPrompt(tabId, message, images) {
      get().setInitialPrompt(tabId, message);
      const type = "abort_and_prompt";
      await runCommand(tabId, images?.length ? { type, message, images } : { type, message });
    },

    async loadAdvisorDefaults(projectCwd) {
      if (get().advisorDefaults[projectCwd]) return;
      try {
        const defaults = await backend.getAdvisorDefaults(projectCwd);
        set((s) => ({ advisorDefaults: { ...s.advisorDefaults, [projectCwd]: defaults } }));
      } catch {
        // A missing or unreadable omp config is not an error worth a dialog —
        // the toggle just shows no inherited default.
      }
    },

    async setSessionAdvisor(tabId, advisor, advisorModel) {
      try {
        await backend.setSessionAdvisor(tabId, advisor, advisorModel);
      } catch (err) {
        alertError(err);
      }
    },

    async setModel(tabId, model) {
      const resp = await runCommand(tabId, {
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
      if (resp === null) return;
      patchRpc(tabId, { model: parseModelInfo(respData(resp)) ?? model });
    },

    async cycleModel(tabId) {
      const resp = await runCommand(tabId, { type: "cycle_model" });
      if (resp === null) return;
      const data = respData(resp);
      const model = parseModelInfo(field(data, "model"));
      if (model) patchRpc(tabId, { model });
      const level = strField(data, "thinkingLevel");
      if (level) patchSession(tabId, { thinkingLevel: level });
    },

    async setThinkingLevel(tabId, level) {
      const resp = await runCommand(tabId, { type: "set_thinking_level", level });
      if (resp === null) return;
      patchSession(tabId, { thinkingLevel: level });
    },

    async cycleThinkingLevel(tabId) {
      const resp = await runCommand(tabId, { type: "cycle_thinking_level" });
      if (resp === null) return;
      const level = strField(respData(resp), "level");
      if (level) patchSession(tabId, { thinkingLevel: level });
    },

    async setSteeringMode(tabId, mode) {
      const resp = await runCommand(tabId, { type: "set_steering_mode", mode });
      if (resp === null) return;
      patchSession(tabId, { steeringMode: mode });
    },

    async setFollowUpMode(tabId, mode) {
      const resp = await runCommand(tabId, { type: "set_follow_up_mode", mode });
      if (resp === null) return;
      patchSession(tabId, { followUpMode: mode });
    },

    async setInterruptMode(tabId, mode) {
      const resp = await runCommand(tabId, { type: "set_interrupt_mode", mode });
      if (resp === null) return;
      patchSession(tabId, { interruptMode: mode });
    },

    async setAutoCompaction(tabId, enabled) {
      const resp = await runCommand(tabId, { type: "set_auto_compaction", enabled });
      if (resp === null) return;
      patchSession(tabId, { autoCompactionEnabled: enabled });
    },

    async setAutoRetry(tabId, enabled) {
      await runCommand(tabId, { type: "set_auto_retry", enabled });
    },

    async abortRetry(tabId) {
      await runCommand(tabId, { type: "abort_retry" });
    },

    async compactSession(tabId) {
      appendItem(tabId, markerItem("compacting context", "copper"));
      const resp = await runCommand(tabId, { type: "compact" });
      if (resp === null) return;
      // `data.summary` is the entire compacted history — noted, never rendered.
      appendItem(tabId, markerItem("context compacted", "copper"));
      await get().refreshState(tabId);
      await get().refreshStats(tabId);
    },

    async exportHtml(tabId) {
      const resp = await runCommand(tabId, { type: "export_html" });
      if (resp === null) return;
      const path = strField(respData(resp), "path");
      appendItem(tabId, noticeItem(path ? `exported to ${path}` : "export finished", "info"));
    },

    async branchSession(tabId) {
      // `branch` needs the entry to branch from; the last user message is the
      // only one a "branch this session" button can mean.
      const listed = await runCommand(tabId, { type: "get_branch_messages" });
      if (listed === null) return;
      const entryId = strField(arrField(respData(listed), "messages").at(-1), "entryId");
      if (!entryId) {
        patchRpc(tabId, { error: "no user message to branch from" });
        return;
      }
      const resp = await runCommand(tabId, { type: "branch", entryId });
      if (resp === null) return;
      if (field(respData(resp), "cancelled") === true) return;
      // The session id changes; the record catches up via the watcher broadcast.
      await loadHistory(tabId).catch(() => {});
      await get().refreshState(tabId);
    },

    async renameSessionTo(tabId, name) {
      const resp = await runCommand(tabId, { type: "set_session_name", name });
      if (resp === null) return;
      // A user-chosen name is final — the auto-titler must not overwrite it.
      patchRpc(tabId, { hasRenamed: true, initialPrompt: null });
    },

    async newRpcSession(tabId) {
      const resp = await runCommand(tabId, { type: "new_session" });
      if (resp === null) return;
      if (field(respData(resp), "cancelled") === true) return;
      patchRpc(tabId, {
        items: [],
        todos: [],
        stats: null,
        subagents: [],
        commandOutput: [],
        initialPrompt: null,
        hasRenamed: false,
      });
      await get().refreshState(tabId);
    },

    async runSlashCommand(tabId, line) {
      const message = line.startsWith("/") ? line : `/${line}`;
      if (message.trim() === "/") return;
      // Output arrives asynchronously as command_output frames.
      await runCommand(tabId, { type: "prompt", message });
    },

    async setTodos(tabId, phases) {
      const resp = await runCommand(tabId, { type: "set_todos", phases });
      if (resp === null) return;
      patchRpc(tabId, { todos: parseTodoPhases(field(respData(resp), "todoPhases")) });
    },

    async refreshState(tabId) {
      const resp = await runCommand(tabId, { type: "get_state" });
      if (resp === null) return;
      applyRpcState(tabId, resp);
    },

    async refreshStats(tabId) {
      const resp = await runCommand(tabId, { type: "get_session_stats" });
      if (resp === null) return;
      patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
    },

    async refreshSubagents(tabId) {
      const resp = await runCommand(tabId, { type: "get_subagents" });
      if (resp === null) return;
      patchRpc(tabId, { subagents: parseSubagents(respData(resp)) });
    },

    clearCommandOutput(tabId) {
      patchRpc(tabId, { commandOutput: [] });
    },

    clearBash(tabId) {
      patchRpc(tabId, { bashLines: [] });
    },
  };
});
