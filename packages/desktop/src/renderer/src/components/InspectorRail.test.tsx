// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });

// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { InspectorRail } = await import("./InspectorRail");

const TAB = "tab-inspector";
let root: Root | null = null;

function runtime(): RpcTabState {
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
});
