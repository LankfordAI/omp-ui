import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState } from "@omp-ui/core/types";
import type { RpcTabState } from "./store";

// --- Bridge mock: store.ts reads window.ompBackend at module load -----------

const sent: Array<{ tabId: string; cmd: Record<string, unknown> }> = [];
let backendState: BackendState = { projects: [], defaultMode: "rpc-ui" };

const mockBackend = {
  getState: vi.fn(async () => backendState),
  rpcSend: vi.fn((tabId: string, cmd: Record<string, unknown>) => {
    sent.push({ tabId, cmd });
  }),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  addProject: vi.fn(),
  removeProject: vi.fn(),
  setProjectAdvisor: vi.fn(),
  setDefaultMode: vi.fn(),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  switchMode: vi.fn(),
  removeSession: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
};

const windowStub = {
  ompBackend: mockBackend,
  alert: () => {},
  confirm: () => true,
  get setTimeout() {
    return globalThis.setTimeout;
  },
  get clearTimeout() {
    return globalThis.clearTimeout;
  },
};
Object.assign(globalThis, { window: windowStub });

// Dynamic import is required: ./backend reads window.ompBackend at module
// load, so the stub above must land before the store module evaluates.
const { useStore } = await import("./store");

/** Deterministic event-drain for promise chains (no wall-clock waiting). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const TAB = "tab-test-1";

function tabState(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready",
    items: [],
    todos: [],
    model: null,
    availableModels: [],
    sessionStats: null,
    pendingCommands: new Map(),
    extensionQueue: [],
    bashLines: [],
    ...patch,
  };
}

function stateWithRecord(sessionId: string | null): BackendState {
  return {
    defaultMode: "rpc-ui",
    projects: [
      {
        project: { path: "/p", name: "p", advisor: false, addedAt: "t" },
        sessions: [
          {
            tabId: TAB,
            sessionId,
            lineageDir: "omp-ui--p--11111111-2222-3333-4444-555555555555",
            projectCwd: "/p",
            launchedAt: "t",
            mode: "rpc-ui",
            advisor: false,
            cachedTitle: null,
            cachedModified: null,
            title: "New session",
            status: null,
            live: "live",
          },
        ],
      },
    ],
  };
}

function respond(tabId: string, cmd: Record<string, unknown>, data: unknown, success = true) {
  useStore.getState().handleRpcFrame(tabId, {
    type: "response",
    id: cmd.id,
    command: cmd.type,
    success,
    ...(success ? { data } : { error: String(data) }),
  });
}

/** Runs bootRpcTab while answering every command it emits, in wave order. */
async function driveBoot(
  tabId: string,
  responses: Record<string, { data?: unknown; success?: boolean }> = {},
): Promise<string[]> {
  const boot = useStore.getState().bootRpcTab(tabId);
  const answered: string[] = [];
  // Commands arrive in waves: get_state is awaited first, then
  // models/messages — drain and answer each wave deterministically.
  for (let wave = 0; wave < 3; wave++) {
    await flushMicrotasks();
    for (const { cmd } of sent.splice(0)) {
      answered.push(String(cmd.type));
      const r = responses[String(cmd.type)] ?? {};
      respond(tabId, cmd, r.data ?? {}, r.success ?? true);
    }
  }
  await boot;
  return answered;
}

beforeEach(() => {
  sent.length = 0;
  backendState = { projects: [], defaultMode: "rpc-ui" };
  useStore.setState({ state: null, tabs: [], activeTabId: null, exited: {}, rpc: {} });
  vi.clearAllMocks();
});

describe("bootRpcTab", () => {
  it("unwraps data payloads for state, models, and history", async () => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({ state: backendState });
    await driveBoot(TAB, {
      get_state: {
        data: { todoPhases: [{ phase: "P", items: [] }], model: { id: "m1", provider: "p" } },
      },
      get_available_models: { data: { models: [{ id: "m1", provider: "p" }] } },
      get_messages: {
        data: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      },
    });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.status).toBe("ready");
    expect(tab.todos).toEqual([{ phase: "P", items: [] }]);
    expect(tab.model).toEqual({ id: "m1", provider: "p" });
    expect(tab.availableModels).toEqual([{ id: "m1", provider: "p" }]);
    expect(tab.items).toEqual([expect.objectContaining({ kind: "user", text: "hi" })]);
  });

  it("fetches backend state when store state is null, then loads history", async () => {
    // Regression: boot outrunning init()'s first getState must not skip
    // get_messages — the record decides, so state is pulled from the backend.
    backendState = stateWithRecord("sess-2");
    const commands = await driveBoot(TAB, { get_messages: { data: { messages: [] } } });
    expect(mockBackend.getState).toHaveBeenCalled();
    expect(commands).toContain("get_messages");
  });

  it("does not request history for a never-materialized session", async () => {
    backendState = stateWithRecord(null);
    useStore.setState({ state: backendState });
    const commands = await driveBoot(TAB);
    expect(commands).not.toContain("get_messages");
  });

  it("reports error, not ready, when get_state fails", async () => {
    backendState = stateWithRecord("s");
    useStore.setState({ state: backendState });
    await driveBoot(TAB, { get_state: { success: false, data: "process dead" } });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.status).toBe("error");
    expect(tab.error).toMatch(/process dead/);
  });
});

describe("rpcCommand / handleRpcFrame correlation", () => {
  beforeEach(() => {
    useStore.setState({ rpc: { [TAB]: tabState() } });
  });

  it("resolves a command by matching response id", async () => {
    const promise = useStore.getState().rpcCommand(TAB, { type: "get_state" });
    const cmd = sent.pop()!.cmd;
    respond(TAB, cmd, { ok: 1 });
    await expect(promise).resolves.toMatchObject({ command: "get_state", data: { ok: 1 } });
  });

  it("rejects with the server error on success:false", async () => {
    const promise = useStore.getState().rpcCommand(TAB, { type: "set_model" });
    const cmd = sent.pop()!.cmd;
    respond(TAB, cmd, "unknown model", false);
    await expect(promise).rejects.toThrow("unknown model");
  });

  it("rejects after the 30s timeout", async () => {
    vi.useFakeTimers();
    try {
      const promise = useStore.getState().rpcCommand(TAB, { type: "get_state" });
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh ready frame re-boots the tab", async () => {
    useStore.getState().handleRpcFrame(TAB, { type: "ready", maxFrameBytes: 1048576 });
    await flushMicrotasks();
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(true);
  });
});

describe("handleRpcFrame routing", () => {
  beforeEach(() => {
    useStore.setState({ rpc: { [TAB]: tabState() } });
  });

  it("omp_ui_error sets the error banner", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "omp_ui_error", message: "handshake failed" });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.status).toBe("error");
    expect(tab.error).toBe("handshake failed");
  });

  it("agent_end refreshes get_state", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(true);
  });

  it("agent_start flips status to running; prompt_result back to ready", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    expect(useStore.getState().rpc[TAB]!.status).toBe("running");
    useStore.getState().handleRpcFrame(TAB, { type: "prompt_result" });
    expect(useStore.getState().rpc[TAB]!.status).toBe("ready");
  });

  it("folds session events into render items", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "yo" }] },
    });
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
      expect.objectContaining({ kind: "user", text: "yo" }),
    ]);
  });

  it("queues dialog extension requests", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "e1",
      method: "confirm",
      title: "sure?",
    });
    expect(useStore.getState().rpc[TAB]!.extensionQueue).toHaveLength(1);
  });

  it("auto-cancels non-dialog extension requests with a marker", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "e2",
      method: "setWidget",
    });
    expect(sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "e2",
      cancelled: true,
    });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.extensionQueue).toHaveLength(0);
    expect(tab.items).toEqual([
      expect.objectContaining({ kind: "marker", label: "extension setWidget auto-cancelled" }),
    ]);
  });

  it("answers stray host_tool_call with an error result", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "host_tool_call", id: "h1", name: "x" });
    expect(sent.pop()!.cmd).toMatchObject({ type: "host_tool_result", id: "h1" });
  });

  it("appends command_output to bash lines", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "command_output", text: "out-1" });
    expect(useStore.getState().rpc[TAB]!.bashLines).toEqual(["out-1"]);
  });
});
