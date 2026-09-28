// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { backendState, rpcTabState, tabInfo } from "../test/fixtures";

// The store reads window.ompBackend at module load; this viewer reaches main
// only through store actions a case replaces, so the module mock suffices.
vi.mock("../backend", () => ({
  backend: new Proxy(
    {},
    { get: () => vi.fn(async () => undefined) },
  ),
  backendFor: () => new Proxy({}, { get: () => vi.fn(async () => undefined) }),
}));

import { useStore } from "../store";
import { SessionTreeViewer } from "./SessionTreeViewer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = "tab-tree";

/** A branch plus an abandoned sibling: the navigator's whole reason to exist. */
const SNAPSHOT = {
  available: true,
  revision: 1,
  leafId: "e4",
  activePath: ["e1", "e2", "e4"],
  nodes: [
    { id: "e1", parentId: null, type: "message", role: "user", text: "first prompt", timestamp: "t" },
    { id: "e2", parentId: "e1", type: "message", role: "assistant", text: "answer", timestamp: "t" },
    { id: "e3", parentId: "e2", type: "message", role: "user", text: "abandoned prompt", timestamp: "t" },
    { id: "e4", parentId: "e2", type: "message", role: "assistant", text: "kept answer", timestamp: "t" },
  ],
};

function liveState(): void {
  useStore.setState({
    state: {
      ...backendState(),
      projects: [
        {
          project: {
            path: "/p",
            name: "p",
            addedAt: "t",
            lastModel: null,
            lastThinkingLevel: null,
            lastAdvisor: null,
            lastAdvisorModel: null,
            defaultModel: null,
            defaultAdvisorModel: null,
            browserClock: false,
          },
          sessions: [
            {
              tabId: TAB,
              sessionId: "s1",
              lineageDir: "d",
              projectCwd: "/p",
              launchedAt: "t",
              mode: "rpc-ui",
              worktree: null,
              planImplementationSource: null,
              experiment: null,
              agentMode: "build",
              compactionMethod: null,
              model: null,
              thinkingLevel: null,
              advisor: false,
              advisorModel: null,
              subagentModels: null,
              proposedPlans: [],
              cachedTitle: null,
              cachedModified: null,
              title: "Tree",
              status: null,
              live: "live",
              pendingPlan: null,
              planSettle: null,
              streamStalled: false,
            },
          ],
        },
      ],
    },
    tabs: [tabInfo({ tabId: TAB })],
    rpc: {
      [TAB]: rpcTabState({
        extensionStatus: { "omp-ui:tree": JSON.stringify(SNAPSHOT) },
      }),
    },
    sessionTreeView: { tabId: TAB },
  });
}

let root: Root | null = null;

/** Modal content portals to document.body, so every assertion reads the body. */
function render(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  // Modal content portals to document.body, so assertions read the body.
  act(() => r.render(<SessionTreeViewer />));
  return document.body;
}

function rowOf(el: Element, text: string): HTMLElement {
  const row = [...el.querySelectorAll("[data-entry-id]")].find((n) =>
    n.textContent?.includes(text),
  );
  if (!row) throw new Error(`no row containing ${text}`);
  return row as HTMLElement;
}

function buttonIn(row: HTMLElement, label: string): HTMLButtonElement {
  const button = [...row.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`no ${label} button`);
  return button as HTMLButtonElement;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("SessionTreeViewer (issue #680)", () => {
  beforeEach(() => {
    useStore.setState({ state: null, rpc: {}, sessionTreeView: null });
  });

  it("renders nothing when closed", () => {
    const el = render();
    expect(el.textContent).toBe("");
  });

  it("marks the active path and badges the leaf", () => {
    liveState();
    const el = render();
    expect(el.textContent).toContain("first prompt");
    expect(el.textContent).toContain("abandoned prompt");
    // e3 hangs off e2 but is off the leaf path: never "current branch".
    expect(rowOf(el, "abandoned prompt").textContent).not.toContain("current branch");
    // e4 is the leaf: badged, and its ancestor chain carries the marker.
    expect(rowOf(el, "kept answer").textContent).toContain("leaf");
    expect(rowOf(el, "answer").textContent).toContain("current branch");
  });

  it("user rows expose the rewind affordances; other rows expose navigate", () => {
    liveState();
    const el = render();
    const labels = [...el.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toContain("rewind here");
    expect(labels).toContain("edit and resend");
    expect(labels).toContain("navigate here");
  });

  it("a prompt row's rewind stages through the tree entry id", () => {
    liveState();
    const stageRewindEntry = vi.fn(async () => {});
    useStore.setState({ stageRewindEntry });
    const el = render();
    act(() => buttonIn(rowOf(el, "first prompt"), "rewind here").click());
    expect(stageRewindEntry).toHaveBeenCalledWith(TAB, "e1", false);
  });

  it("a non-prompt row navigates with the summarize preference", () => {
    liveState();
    const stageNavigate = vi.fn(async () => {});
    useStore.setState({ stageNavigate });
    const el = render();
    const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    act(() => buttonIn(rowOf(el, "answer"), "navigate here").click());
    expect(checkbox.checked).toBe(true);
    expect(stageNavigate).toHaveBeenCalledWith(TAB, "e2", true);
  });

  it("disables every jump while the tab is running", () => {
    liveState();
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          status: "running",
          extensionStatus: { "omp-ui:tree": JSON.stringify(SNAPSHOT) },
        }),
      },
    });
    const el = render();
    const buttons = el.querySelectorAll(
      "button[aria-label='navigate here'], button[aria-label='rewind here']",
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("an unavailable bridge reads as its reason, not an empty tree", () => {
    liveState();
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          extensionStatus: {
            "omp-ui:tree": JSON.stringify({
              available: false,
              reason: "missing-api",
              revision: 1,
              leafId: null,
              activePath: [],
              nodes: [],
            }),
          },
        }),
      },
    });
    const el = render();
    expect(el.textContent).toContain("this omp build exposes no tree API");
  });

  it("a missing publish prompts a refresh rather than an empty tree", () => {
    liveState();
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
    const el = render();
    expect(el.textContent).toContain("has not published a snapshot yet");
  });

  it("closing goes through the store action", () => {
    liveState();
    const closeSessionTreeView = vi.fn();
    useStore.setState({ closeSessionTreeView });
    const el = render();
    const close = el.querySelector(".compact-modal-close") as HTMLButtonElement;
    act(() => close.click());
    expect(closeSessionTreeView).toHaveBeenCalled();
  });
});
