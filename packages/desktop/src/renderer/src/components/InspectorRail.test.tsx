// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// rpcSend is the one bridge call the drill-down's subscription escalation makes.
Object.assign(window, { ompBackend: { rpcSend: vi.fn() } });

// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { InspectorRail } = await import("./InspectorRail");

const TAB = "tab-inspector";
let root: Root | null = null;

function runtime(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready",
    items: [],
    todos: [{ phase: "work", tasks: [{ content: "First task", status: "pending" }] }],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [{ id: "agent-1", name: "worker", status: "working" }],
    extensionStatus: {},
    pendingCommands: new Map(),
    extensionQueue: [],
    busy: false,
    initialPrompt: null,
    hasRenamed: true,
    plan: null,
    planReview: null,
    planText: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
    ...patch,
  };
}

function renderRail(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<InspectorRail tabId={TAB} />));
}

function button(label: string): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

/** The rail's tab button in either posture: aria-label on the collapsed
 * strip (with a badge in the title), bare title on the expanded tab row. */
function railTab(label: string): HTMLButtonElement | null {
  return (
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        b.title === label ||
        b.title.startsWith(`${label} (`),
    ) ?? null
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  useStore.setState({ rpc: { [TAB]: runtime() }, compactSurface: null });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("desktop InspectorRail", () => {
  it("starts collapsed with its icon badges accessible and can expand (issue #48)", () => {
    renderRail();

    const expand = button("expand inspector");
    expect(expand).not.toBeNull();
    for (const label of ["todos", "agents", "session", "plans", "diffs"]) {
      expect(button(label)).not.toBeNull();
    }
    expect(button("todos")?.title).toBe("todos (1)");
    expect(button("todos")?.textContent).toBe("1");
    expect(button("agents")?.title).toBe("agents (1)");

    act(() => expand!.click());

    expect(button("expand inspector")).toBeNull();
    expect(button("collapse inspector")).not.toBeNull();
    expect(document.body.textContent).toContain("First task");
  });

  it("unions the live roster with retained buffers and drills into a detail view (issue #63)", () => {
    useStore.setState({
      rpc: {
        [TAB]: runtime({
          subagents: [{ id: "agent-1", name: "worker", status: "working" }],
          subagentItems: {
            "agent-1": [
              {
                kind: "assistant",
                id: "i1",
                text: "hello from worker",
                thinking: "",
                streaming: false,
              },
            ],
            // agent-2 settled out of the live roster; its buffer is retained.
            "agent-2": [{ kind: "marker", id: "i2", label: "mapping done" }],
          },
        }),
      },
    });
    renderRail();
    // Whatever posture the previous test left: select the Agents pane.
    act(() => railTab("agents")!.click());

    // The roster is live agents UNION retained ones; retained render dimmed.
    expect(document.body.textContent).toContain("worker");
    expect(document.body.textContent).toContain("agent-2");
    expect(document.body.textContent).toContain("settled");
    expect(button("open agent agent-2")?.className).toContain("opacity-50");
    expect(button("open agent worker")?.className).not.toContain("opacity-50");

    // Drill into the live agent: detail view shows its buffered render items.
    act(() => button("open agent worker")!.click());
    expect(button("back to agents")).not.toBeNull();
    expect(document.body.textContent).toContain("hello from worker");
    expect(document.body.textContent).toContain("working");
    expect(button("open agent worker")).toBeNull();

    // Back returns to the roster.
    act(() => button("back to agents")!.click());
    expect(button("open agent worker")).not.toBeNull();

    // A settled agent keeps its retained buffer in the detail view.
    act(() => button("open agent agent-2")!.click());
    expect(document.body.textContent).toContain("mapping done");
    expect(document.body.textContent).toContain("settled");
  });
});
