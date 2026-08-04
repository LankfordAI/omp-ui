// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, BranchList } from "@omp-ui/core/types";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const branches: BranchList = {
  repoRoot: "/p",
  current: "main",
  branches: ["main", "feature/y"],
  defaultBranch: "main",
};

const backendMock = {
  listBranches: vi.fn(async () => branches),
  checkoutBranch: vi.fn(async () => {}),
  suggestBranchName: vi.fn(async (): Promise<string | null> => null),
  rpcSend: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { PlanReview } = await import("./PlanReview");

const TAB = "tab-1";

function tabState(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready",
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
    commandOutput: [],
    busy: false,
    initialPrompt: null,
    // Skip the auto-title path: the implementation prompt would otherwise
    // reach for backend.generateTitle, which this mock does not provide.
    hasRenamed: true,
    plan: null,
    planReview: {
      request: {
        title: "Fix the login race",
        planFilePath: "local://fix-login-race-plan.md",
        planAbsPath: "/x/fix-login-race-plan.md",
      },
      frame: { id: "p1" },
    },
    planText: "# Fix\n\nsteps",
    planDeferred: false,
    plans: [],
    advisorStats: null,
    ...patch,
  };
}

function sessionRecord(tabId: string, title: string) {
  return {
    tabId,
    sessionId: `session-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui" as const,
    advisor: false,
    advisorModel: null,
    cachedTitle: title,
    cachedModified: "t",
    title,
    status: "complete" as const,
    live: "live" as const,
  };
}

function backendState(titles: Record<string, string>): BackendState {
  return {
    defaultMode: "rpc-ui",
    modelFavorites: [],
    skipDeleteConfirmation: false,
    themeId: "graphite",
    appUpdateCheckOnLaunch: true,
    ompUpdateCheckOnLaunch: true,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    projects: [
      {
        project: {
          path: "/p",
          name: "P",
          addedAt: "t",
          lastModel: null,
          lastAdvisorModel: null,
        },
        sessions: Object.entries(titles).map(([tabId, title]) => sessionRecord(tabId, title)),
      },
    ],
  };
}

/** The standard seed: one gate-blocked review tab on a git-backed project. */
function seed(): void {
  useStore.setState({
    tabs: [{ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false }],
    branches: { "/p": branches },
    rpc: { [TAB]: tabState() },
    state: backendState({ [TAB]: "Planning session" }),
  });
}

let root: Root | null = null;

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<PlanReview tabId={TAB} />));
}

const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
};

/** The current/new/existing option cards carry aria-pressed; label + hint is their text. */
const branchOption = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
    (candidate) => candidate.textContent?.startsWith(label),
  );
  expect(found).toBeDefined();
  return found!;
};

const newNameInput = (): HTMLInputElement => {
  const input = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="new branch name"]',
  );
  expect(input).not.toBeNull();
  return input!;
};

const executeButton = (): HTMLButtonElement => buttonByText("execute in this session");

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The verdict frame answering the blocked plan-review select, if one was sent. */
function verdictFrame(): Record<string, unknown> | undefined {
  const call = backendMock.rpcSend.mock.calls.find(
    (c) => (c[1] as Record<string, unknown>).type === "extension_ui_response",
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.listBranches.mockResolvedValue(branches);
  backendMock.suggestBranchName.mockResolvedValue(null);
  seed();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("PlanReview git branch section (issue #25)", () => {
  it("renders no git branch section off-git", () => {
    useStore.setState({
      branches: { "/p": { repoRoot: null, current: null, branches: [], defaultBranch: null } },
    });
    render();
    expect(document.body.textContent).not.toContain("git branch");
  });

  it("prefills the new-branch name from the plan slug", async () => {
    render();
    await act(async () => branchOption("new branch").click());
    expect(newNameInput().value).toBe("fix-login-race");
  });

  it("executes on the current branch without touching git", async () => {
    render();
    await act(async () => executeButton().click());
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
  });

  it("creates and switches to a new branch before answering the gate", async () => {
    render();
    await act(async () => branchOption("new branch").click());
    await typeInto(newNameInput(), "feat/x");
    await act(async () => executeButton().click());

    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feat/x", { create: true });
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
    // The checkout must land first: a verdict before it would dispatch the
    // implementation onto the wrong branch.
    const verdictCall = backendMock.rpcSend.mock.calls.findIndex(
      (c) => (c[1] as Record<string, unknown>).type === "extension_ui_response",
    );
    expect(backendMock.checkoutBranch.mock.invocationCallOrder[0]!).toBeLessThan(
      backendMock.rpcSend.mock.invocationCallOrder[verdictCall]!,
    );
  });

  it("keeps the gate blocked when git refuses the checkout", async () => {
    backendMock.checkoutBranch.mockRejectedValueOnce(
      new Error("error: pathspec 'feat/x' did not match any file(s) known to git"),
    );
    render();
    await act(async () => branchOption("new branch").click());
    await typeInto(newNameInput(), "feat/x");
    await act(async () => executeButton().click());

    expect(document.body.textContent).toContain("pathspec 'feat/x' did not match");
    expect(verdictFrame()).toBeUndefined();
    // The review is still pending — the agent stays blocked on its select.
    expect(useStore.getState().rpc[TAB]!.planReview).not.toBeNull();
  });

  it("confirms before switching branches under a mid-turn session", async () => {
    useStore.setState({
      tabs: [
        { tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false },
        { tabId: "tab-2", mode: "rpc-ui", projectCwd: "/p", hidden: false },
      ],
      rpc: {
        [TAB]: tabState(),
        "tab-2": tabState({ planReview: null, planText: null, status: "running" }),
      },
      state: backendState({ [TAB]: "Planning session", "tab-2": "Busy work" }),
    });
    render();

    await act(async () => branchOption("existing branch").click());
    await act(async () => buttonByText("feature/y").click());
    await act(async () => executeButton().click());

    expect(document.body.textContent).toContain("is mid-turn");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
    expect(verdictFrame()).toBeUndefined();

    await act(async () => buttonByText("switch anyway").click());
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feature/y", undefined);
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
  });

  it("lets the model's suggestion replace an untouched prefill", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/model-name");
    render();
    await act(async () => {}); // flush the suggestion's .then
    await act(async () => branchOption("new branch").click());
    expect(newNameInput().value).toBe("feat/model-name");
  });

  it("never overwrites a typed name with the model's suggestion", async () => {
    // Executor form required: this tsconfig's lib predates Promise.withResolvers.
    let resolveSuggest!: (value: string | null) => void;
    backendMock.suggestBranchName.mockReturnValue(
      new Promise((resolve) => {
        resolveSuggest = resolve;
      }),
    );
    render();
    await act(async () => branchOption("new branch").click());
    await typeInto(newNameInput(), "my-branch");
    await act(async () => {
      resolveSuggest("feat/model-name");
    });
    expect(newNameInput().value).toBe("my-branch");
  });
});
