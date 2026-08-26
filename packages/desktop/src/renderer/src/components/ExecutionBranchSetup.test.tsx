// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, SessionWorktree } from "@omp-ui/core/types";
import { backendState, rpcTabState, tabInfo } from "../test/fixtures";
import type { RpcTabState } from "../store";

const branches: BranchList = {
  repoRoot: "/p",
  current: "main",
  branches: ["main", "feature/y"],
  defaultBranch: "main",
  upstreamRef: null,
  upstreamRemote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  upstreamFetchedAt: null,
  upstreamRefreshError: null,
};

const OFF_REPO: BranchList = {
  ...branches,
  repoRoot: null,
  current: null,
  branches: [],
  defaultBranch: null,
};

const backendMock = {
  listBranches: vi.fn(async (): Promise<BranchList> => OFF_REPO),
  checkoutBranch: vi.fn(async (): Promise<void> => {}),
  suggestBranchName: vi.fn(async (): Promise<string | null> => null),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ExecutionBranchSetup, useExecutionBranch } = await import("./ExecutionBranchSetup");

const TAB = "tab-1";

interface HookProps {
  projectCwd?: string;
  planFilePath?: string;
  planText?: string | null;
  planTitle?: string | null;
}

function hookProps(p: HookProps = {}): {
  tabId: string;
  projectCwd: string | undefined;
  planFilePath: string | undefined;
  planText: string | null;
  planTitle: string | null;
} {
  return {
    tabId: TAB,
    projectCwd: p.projectCwd,
    planFilePath: p.planFilePath ?? "local://fix-login-race-plan.md",
    planText: p.planText ?? "# Fix\n\nsteps",
    planTitle: p.planTitle ?? "Fix the login race",
  };
}

/** Reactive values + one action per hook member, readable without a full component. */
function Probe(p: HookProps = {}) {
  const branch = useExecutionBranch(hookProps(p));
  const [result, setResult] = useState<string | null>(null);
  return (
    <div>
      <span data-testid="isRepo">{String(branch.isRepo)}</span>
      <span data-testid="choice">{branch.branchChoice}</span>
      <input
        data-testid="newName"
        value={branch.newName}
        onChange={(e) => branch.onNewNameChange(e.target.value)}
      />
      <span data-testid="existing">{branch.existingName ?? ""}</span>
      <span data-testid="invalid">{String(branch.branchInvalid)}</span>
      <span data-testid="error">{branch.branchError ?? ""}</span>
      <span data-testid="confirmBusy">{String(branch.confirmBusy)}</span>
      <span data-testid="busyTitle">{branch.busyTitle ?? ""}</span>
      <span data-testid="checkingOut">{String(branch.checkingOut)}</span>
      <span data-testid="summary">{branch.summary ?? ""}</span>
      <span data-testid="result">{result ?? ""}</span>
      <button data-testid="resolve" onClick={() => void branch.resolve().then((ok) => setResult(String(ok)))}>
        resolve
      </button>
      <button data-testid="select-current" onClick={() => branch.selectChoice("current")}>current</button>
      <button data-testid="select-new" onClick={() => branch.selectChoice("new")}>new</button>
      <button data-testid="select-existing" onClick={() => branch.selectChoice("existing")}>existing</button>
      <button data-testid="select-main" onClick={() => branch.selectExisting("main")}>main</button>
      <button data-testid="select-feature" onClick={() => branch.selectExisting("feature/y")}>feature/y</button>
      <button data-testid="dismiss" onClick={() => branch.dismissConfirm()}>dismiss</button>
    </div>
  );
}

let root: Root | null = null;

function mount(p: HookProps = {}): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe {...p} />));
}

const byId = (id: string): HTMLElement => document.querySelector(`[data-testid="${id}"]`)!;

const click = (id: string): void => act(() => (byId(id) as HTMLButtonElement).click());

async function resolve(): Promise<void> {
  await act(async () => (byId("resolve") as HTMLButtonElement).click());
}

async function typeNewName(value: string): Promise<void> {
  const input = byId("newName") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sessionRecord(tabId: string, title: string) {
  return {
    tabId,
    sessionId: `session-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui" as const,
    planImplementationSource: null,
    agentMode: "build" as const,
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: title,
    cachedModified: "t",
    title,
    status: "complete" as const,
    live: "live" as const,
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

function stateWithSessions(
  titles: Record<string, string>,
  worktrees: Record<string, SessionWorktree> = {},
) {
  return backendState({
    projects: [
      {
        project: {
          path: "/p",
          name: "P",
          addedAt: "t",
          lastModel: null,
          lastThinkingLevel: null,
          lastAdvisor: null,
          lastAdvisorModel: null,
          defaultModel: null,
          defaultAdvisorModel: null,
        },
        sessions: Object.entries(titles).map(([tabId, title]) => ({
          ...sessionRecord(tabId, title),
          worktree: worktrees[tabId] ?? null,
        })),
      },
    ],
  });
}

function seed(opts: { offRepo?: boolean; busyTitle?: string; busyWorktree?: SessionWorktree } = {}): void {
  const titles: Record<string, string> = { [TAB]: "Planning session" };
  const tabs = [tabInfo({ tabId: TAB, projectCwd: "/p" })];
  const rpc: Record<string, RpcTabState> = {
    [TAB]: rpcTabState({ status: "ready" }),
  };
  if (opts.busyTitle !== undefined) {
    tabs.push(tabInfo({ tabId: "tab-2", projectCwd: "/p" }));
    rpc["tab-2"] = rpcTabState({ status: "running" });
    titles["tab-2"] = opts.busyTitle;
  }
  useStore.setState({
    tabs,
    branches: { "/p": opts.offRepo ? OFF_REPO : branches },
    rpc,
    state: stateWithSessions(titles, opts.busyWorktree ? { "tab-2": opts.busyWorktree } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.listBranches.mockResolvedValue(OFF_REPO);
  backendMock.checkoutBranch.mockResolvedValue(undefined);
  backendMock.suggestBranchName.mockResolvedValue(null);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("useExecutionBranch resolve", () => {
  it("resolves true off-repo without touching git", async () => {
    seed({ offRepo: true });
    mount({ projectCwd: "/p" });
    expect(byId("isRepo").textContent).toBe("false");
    await resolve();
    expect(byId("result").textContent).toBe("true");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
  });

  it("resolves true on the current branch without touching git", async () => {
    seed();
    mount({ projectCwd: "/p" });
    await resolve();
    expect(byId("result").textContent).toBe("true");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
  });

  it("creates and switches to a new branch before resolve returns true", async () => {
    seed();
    mount({ projectCwd: "/p" });
    click("select-new");
    await resolve();
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "fix-login-race", { create: true });
    expect(byId("result").textContent).toBe("true");
  });

  it("leaves the gate blocked with git's message when the checkout is refused", async () => {
    backendMock.checkoutBranch.mockRejectedValueOnce(
      new Error("error: pathspec 'feat/x' did not match any file(s) known to git"),
    );
    seed();
    mount({ projectCwd: "/p" });
    click("select-new");
    await typeNewName("feat/x");
    await resolve();
    expect(byId("result").textContent).toBe("false");
    expect(byId("error").textContent).toBe(
      "error: pathspec 'feat/x' did not match any file(s) known to git",
    );
  });

  it("resolves true when the existing pick is already the current branch", async () => {
    seed();
    mount({ projectCwd: "/p" });
    click("select-existing");
    click("select-main");
    await resolve();
    expect(byId("result").textContent).toBe("true");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
  });

  it("checks out an existing branch directly when no session is mid-turn", async () => {
    seed();
    mount({ projectCwd: "/p" });
    click("select-existing");
    click("select-feature");
    await resolve();
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feature/y", undefined);
    expect(byId("result").textContent).toBe("true");
  });

  it("earns a confirm under a mid-turn session, then proceeds once confirmed", async () => {
    seed({ busyTitle: "Busy work" });
    mount({ projectCwd: "/p" });
    expect(byId("busyTitle").textContent).toBe("Busy work");
    click("select-existing");
    click("select-feature");
    await resolve();
    expect(byId("result").textContent).toBe("false");
    expect(byId("confirmBusy").textContent).toBe("true");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
    // The confirmed re-entry sees the latch and proceeds to the checkout.
    await resolve();
    expect(byId("result").textContent).toBe("true");
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feature/y", undefined);
  });

  it("does not confirm for a running worktree session of the project (issue #292)", async () => {
    seed({ busyTitle: "Busy work", busyWorktree: { path: "/wt/busy", branch: "feat/busy", base: null } });
    mount({ projectCwd: "/p" });
    expect(byId("busyTitle").textContent).toBe("");
    click("select-existing");
    click("select-feature");
    await resolve();
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feature/y", undefined);
    expect(byId("result").textContent).toBe("true");
  });

  it("never confirms its own tab (issue #292 self-exclusion)", async () => {
    useStore.setState({
      tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" }), tabInfo({ tabId: "tab-2", projectCwd: "/p" })],
      branches: { "/p": branches },
      rpc: {
        [TAB]: rpcTabState({ status: "running" }),
        "tab-2": rpcTabState({ status: "ready" }),
      },
      state: stateWithSessions({ [TAB]: "Planning session", "tab-2": "Idle work" }),
    });
    mount({ projectCwd: "/p" });
    expect(byId("busyTitle").textContent).toBe("");
  });

  it("returns false for an empty new-branch name", async () => {
    seed();
    mount({ projectCwd: "/p" });
    click("select-new");
    await typeNewName("   ");
    expect(byId("invalid").textContent).toBe("true");
    await resolve();
    expect(byId("result").textContent).toBe("false");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
  });
});

describe("useExecutionBranch prefill", () => {
  it("seeds the new-branch name from the plan slug", async () => {
    seed();
    mount({ projectCwd: "/p" });
    await act(async () => {});
    expect((byId("newName") as HTMLInputElement).value).toBe("fix-login-race");
  });

  it("lets the model's suggestion replace the untouched fallback", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/model-name");
    seed();
    mount({ projectCwd: "/p" });
    await act(async () => {}); // flush the suggestion's .then
    expect((byId("newName") as HTMLInputElement).value).toBe("feat/model-name");
  });

  it("never overwrites a typed name with the model's suggestion", async () => {
    // Executor form required: this tsconfig's lib predates Promise.withResolvers.
    let resolveSuggest!: (value: string | null) => void;
    backendMock.suggestBranchName.mockReturnValue(
      new Promise((resolve) => {
        resolveSuggest = resolve;
      }),
    );
    seed();
    mount({ projectCwd: "/p" });
    await act(async () => {});
    await typeNewName("my-branch");
    await act(async () => {
      resolveSuggest("feat/model-name");
    });
    expect((byId("newName") as HTMLInputElement).value).toBe("my-branch");
  });

  it("tracks the footer summary with the choice", async () => {
    seed();
    mount({ projectCwd: "/p" });
    await act(async () => {});
    expect(byId("summary").textContent).toBe("main");
    click("select-new");
    await typeNewName("feat/x");
    expect(byId("summary").textContent).toBe("feat/x");
    click("select-existing");
    expect(byId("summary").textContent).toBe("choose a branch");
    click("select-feature");
    expect(byId("summary").textContent).toBe("feature/y");
  });
});

/** The fieldset under its real parent contract: execute awaits resolve. */
function mountFieldset(onExecute: () => void, p: HookProps = { projectCwd: "/p" }): void {
  function Harness() {
    const branch = useExecutionBranch(hookProps(p));
    const execute = async (): Promise<void> => {
      if (!(await branch.resolve())) return;
      onExecute();
    };
    return (
      <>
        <button data-testid="parent-execute" onClick={() => void execute()}>
          execute
        </button>
        <ExecutionBranchSetup branch={branch} onExecute={() => void execute()} />
      </>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
}

const fieldsetButton = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
};

describe("ExecutionBranchSetup fieldset", () => {
  it("switches panels across the three choices and shows the no-checkout note", async () => {
    seed();
    mountFieldset(() => {});
    await act(async () => {});

    expect(document.body.textContent).toContain("Git branch");
    expect(document.body.textContent).toContain("No checkout. Existing working-tree changes stay in place.");
    expect(document.body.textContent).toContain("main");

    const option = (label: string): HTMLButtonElement => {
      const found = document.body.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
      expect(found).not.toBeNull();
      return found!;
    };
    await act(async () => option("new branch").click());
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="new branch name"]')!.value).toBe(
      "fix-login-race",
    );
    await act(async () => option("existing branch").click());
    expect(document.body.querySelector('input[aria-label="filter branches"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("No checkout. Existing working-tree changes stay in place.");
    await act(async () => option("current branch").click());
    expect(document.body.textContent).toContain("Implement on");
  });

  it("filters the existing list, disables the current row, and selects on pick", async () => {
    seed();
    mountFieldset(() => {});
    await act(async () => {});
    await act(async () => fieldsetButton("switch").click());

    const rows = (): HTMLButtonElement[] =>
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) =>
          button.textContent?.startsWith("main") ||
          button.textContent?.startsWith("feature/y"),
      );
    expect(rows()).toHaveLength(2);
    const current = rows()[0]!;
    expect(current.disabled).toBe(true);
    expect(current.textContent).toContain("current");

    const filter = document.body.querySelector<HTMLInputElement>('input[aria-label="filter branches"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(filter, "feature");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toHaveLength(1);

    await act(async () => fieldsetButton("feature/y").click());
    expect(rows()[0]!.className).toContain("bg-hover");
  });

  it("confirms under a mid-turn session: switch anyway executes, cancel keeps the gate", async () => {
    const verdict = vi.fn();
    seed({ busyTitle: "Busy work" });
    mountFieldset(verdict);
    await act(async () => {});
    await act(async () => fieldsetButton("switch").click());
    await act(async () => fieldsetButton("feature/y").click());
    await act(async () => (byId("parent-execute") as HTMLButtonElement).click());

    expect(document.body.textContent).toContain("“Busy work” is mid-turn. Switching changes its working tree.");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
    expect(verdict).not.toHaveBeenCalled();

    await act(async () => fieldsetButton("cancel").click());
    expect(document.body.textContent).not.toContain("is mid-turn");
    expect(verdict).not.toHaveBeenCalled();
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();

    await act(async () => (byId("parent-execute") as HTMLButtonElement).click());
    await act(async () => fieldsetButton("switch anyway").click());
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feature/y", undefined);
    expect(verdict).toHaveBeenCalledTimes(1);
  });

  it("renders the refused-checkout error in the fieldset", async () => {
    backendMock.checkoutBranch.mockRejectedValueOnce(new Error("checkout rejected"));
    seed();
    mountFieldset(() => {});
    await act(async () => {});
    await act(async () => fieldsetButton("new").click());
    await act(async () => (byId("parent-execute") as HTMLButtonElement).click());
    expect(document.body.textContent).toContain("checkout rejected");
  });
});
