// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderItem } from "../lib/transcript";
import type { RpcTabState } from "../store";
import { rpcTabState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: no scrollIntoView, no ResizeObserver (TranscriptView
// constructs one unconditionally on mount).
HTMLElement.prototype.scrollIntoView = vi.fn();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

// store.ts captures window.ompBackend at module evaluation.
const rpcSendMock = vi.fn();
Object.assign(window, { ompBackend: { rpcSend: rpcSendMock } });

const { useStore } = await import("../store");
const { SubagentView } = await import("./SubagentView");

const TAB = "tab-subagent-view";
let root: Root | null = null;

const ITEMS: RenderItem[] = [
  { kind: "user", id: "u1", text: "map the store" },
  {
    kind: "assistant",
    id: "a1",
    text: "hello from worker",
    thinking: "",
    streaming: false,
    model: "m1",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.001 },
  },
  {
    kind: "tool",
    id: "t1",
    toolCallId: "t1",
    name: "bash",
    args: { command: "ls src" },
    status: "done",
    intent: "Listing src",
  },
];

function seed(patch: Partial<RpcTabState> = {}): void {
  useStore.setState({
    rpc: {
      [TAB]: rpcTabState({
        subagents: [
          { id: "agent-1", name: "worker", agent: "task", status: "running", label: "map the store" },
        ],
        selectedSubagent: "agent-1",
        subagentItems: { "agent-1": ITEMS },
        ...patch,
      }),
    },
  });
}

function renderView(agentKey = "agent-1"): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SubagentView tabId={TAB} agentKey={agentKey} />));
}

/** Every command sent so far, as the backend saw it. */
function sentCommands(): Array<{ id: string; type: string; subagentId?: unknown }> {
  return rpcSendMock.mock.calls.flatMap(([, frame]: unknown[]) =>
    typeof frame === "object" &&
    frame !== null &&
    "id" in frame &&
    typeof frame.id === "string" &&
    "type" in frame &&
    typeof frame.type === "string"
      ? [{ id: frame.id, type: frame.type, subagentId: "subagentId" in frame ? frame.subagentId : undefined }]
      : [],
  );
}

function answer(frame: { id: string; type: string }, data: unknown): void {
  act(() => {
    useStore.getState().handleRpcFrame(TAB, { type: "response", id: frame.id, command: frame.type, success: true, data });
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  rpcSendMock.mockClear();
  if (root) act(() => root!.unmount());
  root = null;
});

describe("SubagentView", () => {
  it("renders the banner, the control strip, and the buffered transcript through TranscriptView", () => {
    seed();
    renderView();
    const text = document.body.textContent ?? "";
    // Banner: back control, name, type chip, status, task label, controls.
    expect(text).toContain("‹ main agent");
    expect(text).toContain("worker");
    expect(text).toContain("task");
    expect(text).toContain("running");
    expect(text).toContain("map the store");
    // A running agent is controllable (issue #684): steer + kill, no read-only.
    expect(document.body.querySelector('button[aria-label="steer"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="kill"]')).not.toBeNull();
    expect(text).not.toContain("read-only subagent view");
    // Full transcript surface: user prompt, assistant text, tool card with intent.
    expect(text).toContain("hello from worker");
    expect(text).toContain("Listing src");
    // The usage receipt (model id) renders — the proof this is TranscriptView,
    // not the old SubagentRow, which never surfaced model/usage.
    expect(text).toContain("m1");
  });

  it("a running agent's kill dispatches cancel_subagent (issue #713)", async () => {
    seed();
    renderView();
    const kill = document.body.querySelector<HTMLButtonElement>('button[aria-label="kill"]')!;
    await act(async () => void kill.click());
    const cancels = sentCommands().filter((f) => f.type === "cancel_subagent");
    expect(cancels).toEqual([expect.objectContaining({ subagentId: "agent-1" })]);
    answer(cancels[0]!, { cancelled: true });
    await act(async () => {});
    // The follow-up roster read, answered so nothing dangles.
    for (const f of sentCommands().filter((c) => c.type === "get_subagents")) answer(f, { subagents: [] });
  });

  it("a completed agent still on the roster offers no controls (issue #713)", () => {
    seed({ subagents: [{ id: "agent-1", name: "worker", status: "completed" }] });
    renderView();
    expect(document.body.textContent).toContain("read-only subagent view");
    expect(document.body.querySelector('button[aria-label="steer"]')).toBeNull();
    expect(document.body.querySelector('button[aria-label="kill"]')).toBeNull();
  });

  it("a settled agent keeps the read-only banner with no controls (issue #684)", () => {
    seed({ subagents: [] });
    renderView();
    expect(document.body.textContent).toContain("read-only subagent view");
    expect(document.body.querySelector('button[aria-label="kill"]')).toBeNull();
  });

  it("back returns to the main agent", () => {
    seed();
    renderView();
    const back = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="back to main agent"]',
    )!;
    act(() => back.click());
    expect(useStore.getState().rpc[TAB]!.selectedSubagent).toBeNull();
  });

  it("a settled agent shows its retained buffer with settled status", () => {
    seed({
      subagents: [],
      selectedSubagent: "agent-2",
      subagentItems: { "agent-2": [{ kind: "marker", id: "i2", label: "mapping done" }] },
    });
    renderView("agent-2");
    const text = document.body.textContent ?? "";
    expect(text).toContain("agent-2");
    expect(text).toContain("settled");
    expect(text).toContain("mapping done");
  });

  it("an empty buffer renders the quiet empty state", () => {
    seed({ subagentItems: {} });
    renderView();
    expect(document.body.textContent).toContain("No activity captured yet");
  });
});
