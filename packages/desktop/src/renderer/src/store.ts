import { create } from "zustand";
import type { BackendState, SessionMode, SessionSummary } from "@omp-ui/core/types";
import { backend } from "./backend";
import { extensionCancelResponse, routeExtensionRequest } from "./lib/extension-router";
import { historyToItems, markerItem, reduceEvent, type RenderItem } from "./lib/transcript";

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
  todos: unknown[];
  model: unknown | null;
  availableModels: unknown[];
  sessionStats: unknown | null;
  /** Not rendered — mutated in place. */
  pendingCommands: Map<string, PendingCommand>;
  extensionQueue: unknown[];
  bashLines: string[];
  error?: string;
}

function freshRpcTabState(): RpcTabState {
  return {
    status: "starting",
    items: [],
    todos: [],
    model: null,
    availableModels: [],
    sessionStats: null,
    pendingCommands: new Map(),
    extensionQueue: [],
    bashLines: [],
  };
}

interface UiStore {
  state: BackendState | null;
  tabs: TabInfo[];
  activeTabId: string | null;
  exited: Record<string, number>;
  rpc: Record<string, RpcTabState>;
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
  prune(tabId: string): Promise<void>;
  bootRpcTab(tabId: string): Promise<void>;
  rpcCommand(tabId: string, cmd: Record<string, unknown>): Promise<unknown>;
  handleRpcFrame(tabId: string, frame: object): void;
  answerExtension(tabId: string, request: unknown, response: Record<string, unknown>): void;
  runBash(tabId: string, command: string): Promise<void>;
  abortBash(tabId: string): Promise<void>;
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

  const applyRpcState = (tabId: string, resp: unknown): void => {
    const tab = get().rpc[tabId];
    const payload = respData(resp);
    if (!tab || payload === null || typeof payload !== "object") return;
    patchRpc(tabId, {
      todos:
        "todoPhases" in payload && Array.isArray(payload.todoPhases)
          ? payload.todoPhases
          : tab.todos,
      model: "model" in payload ? payload.model : tab.model,
      sessionStats: payload,
    });
  };

  return {
    state: null,
    tabs: [],
    activeTabId: null,
    exited: {},
    rpc: {},

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

    async prune(tabId) {
      await backend.removeSession(tabId);
      const tab = get().rpc[tabId];
      if (tab) {
        for (const pending of tab.pendingCommands.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("tab pruned"));
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
        return { rpc, tabs, activeTabId };
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
        const boots: Promise<unknown>[] = [
          get()
            .rpcCommand(tabId, { type: "get_available_models" })
            .then((resp) => {
              const payload = respData(resp);
              const models =
                payload !== null &&
                typeof payload === "object" &&
                "models" in payload &&
                Array.isArray(payload.models)
                  ? payload.models
                  : [];
              patchRpc(tabId, { availableModels: models });
            }),
        ];
        if (rec?.sessionId) {
          boots.push(
            get()
              .rpcCommand(tabId, { type: "get_messages" })
              .then((resp) => {
                const payload = respData(resp);
                const messages =
                  payload !== null &&
                  typeof payload === "object" &&
                  "messages" in payload &&
                  Array.isArray(payload.messages)
                    ? payload.messages
                    : [];
                patchRpc(tabId, { items: historyToItems(messages) });
              }),
          );
        }
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
      backend.rpcSend(tabId, { ...cmd, id });
      return promise;
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
          patchRpc(tabId, { sessionStats: frame });
          return;
        case "config_update":
          patchRpc(tabId, { model: frame });
          return;
        case "command_output": {
          const text =
            "text" in frame && typeof frame.text === "string"
              ? frame.text
              : "output" in frame && typeof frame.output === "string"
                ? frame.output
                : "";
          patchRpc(tabId, { bashLines: [...tab.bashLines, text] });
          return;
        }
        case "extension_ui_request": {
          const action = routeExtensionRequest(frame);
          if (action.action === "dialog") {
            patchRpc(tabId, { extensionQueue: [...tab.extensionQueue, frame] });
          } else {
            backend.rpcSend(
              tabId,
              extensionCancelResponse("id" in frame ? frame.id : undefined),
            );
            const method = "method" in frame && typeof frame.method === "string" ? frame.method : "?";
            patchRpc(tabId, {
              items: [...tab.items, markerItem(`extension ${method} auto-cancelled`)],
            });
          }
          return;
        }
        case "prompt_result":
          patchRpc(tabId, { status: "ready" });
          return;
        case "omp_ui_error": {
          const message =
            "message" in frame && typeof frame.message === "string"
              ? frame.message
              : "omp rpc error";
          patchRpc(tabId, { status: "error", error: message });
          return;
        }
        case "host_tool_call":
          // v0 registers no host tools — answer with an error, never hang the agent.
          backend.rpcSend(tabId, {
            type: "host_tool_result",
            id: "id" in frame ? frame.id : undefined,
            error: "omp-ui does not register host tools",
          });
          return;
        default: {
          // The AgentSessionEvent stream — the actual transcript.
          const items = reduceEvent(tab.items, frame);
          patchRpc(tabId, { items });
          if (type === "agent_start") {
            patchRpc(tabId, { status: "running" });
          }
          if (type === "agent_end") {
            if (tab.status === "running") patchRpc(tabId, { status: "ready" });
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
      const text =
        payload !== null && typeof payload === "object"
          ? "output" in payload && typeof payload.output === "string"
            ? payload.output
            : "error" in payload && typeof payload.error === "string"
              ? payload.error
              : ""
          : "";
      if (text) patchRpc(tabId, { bashLines: [...tab.bashLines, text] });
    },

    async abortBash(tabId) {
      await get()
        .rpcCommand(tabId, { type: "abort_bash" })
        .catch(() => {});
    },
  };
});
