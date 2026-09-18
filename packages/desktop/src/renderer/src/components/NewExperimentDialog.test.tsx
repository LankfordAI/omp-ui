// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectExperiments, SpawnRequest } from "@omp-ui/core/types";
import type { RpcTabState } from "../store/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const overview = (repo: ProjectExperiments["repo"]): ProjectExperiments => ({
  projectCwd: "/p",
  repo,
  checkouts: [],
  pendingLaunches: [],
});

// Only the channels the dialog's store path touches: the preflight read on
// mount, the spawn its submit goes through, and the rpcSend a gate answer rides.
const backendMock = {
  autoresearchOverview: vi.fn(async (): Promise<ProjectExperiments> => overview("git")),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  rpcSend: vi.fn(),
  spawnSession: vi.fn<(request: SpawnRequest) => Promise<{ tabId: string }>>(async () => ({
    tabId: "exp-1",
  })),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { t } = await import("../lib/i18n");
const { NewExperimentDialog } = await import("./NewExperimentDialog");

let root: Root | null = null;

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const PROPOSAL = {
  goal: "Cut p95 render latency",
  metric: "p95_ms",
  unit: "ms",
  direction: "lower" as const,
  command: "node bench.js",
  scopePaths: ["src/render", "src/paint"],
  offLimits: [],
  constraints: ["no new deps"],
  maxIterations: 12,
  brief: "bench.js prints METRIC p95_ms on success.",
};
const PROPOSAL_FRAME = { type: "extension_ui_request", id: "gate-1", method: "select", title: "sentinel" };

async function render(
  repo: ProjectExperiments["repo"],
  options: { proposalTabId?: string } = {},
): Promise<void> {
  backendMock.autoresearchOverview.mockResolvedValue(overview(repo));
  const proposalTabId = options.proposalTabId ?? null;
  useStore.setState({
    advisorDefaults: { "/p": { enabled: false, model: null } },
    tabs:
      proposalTabId === null
        ? []
        : [{ tabId: proposalTabId, mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null }],
    activeTabId: null,
    focusedTabByProject: {},
    rpc:
      proposalTabId === null
        ? {}
        : {
            [proposalTabId]: {
              experimentProposal: { proposal: PROPOSAL, frame: PROPOSAL_FRAME },
            } as unknown as RpcTabState,
          },
    exited: {},
    state: null,
    experiments: {},
    experimentDialog: { projectCwd: "/p", instanceId: null, ...(proposalTabId === null ? {} : { proposalTabId }) },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<NewExperimentDialog projectCwd="/p" instanceId={null} proposalTabId={proposalTabId} />));
  // The mount effect runs the preflight read.
  await act(async () => {
    await flushMicrotasks();
  });
}

const field = <T extends HTMLElement>(selector: string): T => {
  const el = document.body.querySelector<T>(selector);
  expect(el).not.toBeNull();
  return el!;
};

const launchButton = (): HTMLButtonElement => {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === t("experiment.dialog.launch"),
  );
  expect(button).toBeDefined();
  return button!;
};

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const buttonByText = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);

async function fillRequired(): Promise<void> {
  await typeInto(field<HTMLTextAreaElement>("#experiment-goal"), "Reduce p95 latency of /search");
  await typeInto(field<HTMLInputElement>("#experiment-metric"), "p95_ms");
}

beforeEach(() => {
  vi.clearAllMocks();
  // Spawn resolves but the fresh tab never boots here: the dialog's own
  // behaviour ends at the spawn request.
  backendMock.spawnSession.mockResolvedValue({ tabId: "exp-1" });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("NewExperimentDialog", () => {
  it("prefills a minted autoresearch branch from the goal in a git checkout", async () => {
    await render("git");
    await fillRequired();
    const branch = field<HTMLInputElement>("#experiment-branch");
    expect(branch.value).toMatch(/^autoresearch\/reduce-p95-latency-of-search\/[0-9a-f]{8}$/);
    // The slug follows the goal until the branch is edited by hand.
    const hash = branch.value.slice(-8);
    await typeInto(field<HTMLTextAreaElement>("#experiment-goal"), "Faster builds");
    expect(branch.value).toBe(`autoresearch/faster-builds/${hash}`);
    await typeInto(branch, "autoresearch/mine/deadbeef");
    await typeInto(field<HTMLTextAreaElement>("#experiment-goal"), "Something else");
    expect(field<HTMLInputElement>("#experiment-branch").value).toBe("autoresearch/mine/deadbeef");

    await act(async () => {
      launchButton().click();
      await flushMicrotasks();
    });
    expect(backendMock.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "rpc-ui",
        planMode: false,
        worktree: { mint: { branch: "autoresearch/mine/deadbeef", baseRef: null, baseBranch: null } },
        experiment: expect.objectContaining({
          goal: "Something else",
          metric: "p95_ms",
          launchedBranch: "autoresearch/mine/deadbeef",
        }),
      }),
    );
  });

  it("warns and launches at the project checkout when the project is not a git repository", async () => {
    await render("none");
    expect(document.body.textContent).toContain(t("experiment.dialog.whereNone"));
    expect(document.body.querySelector("#experiment-branch")).toBeNull();
    await fillRequired();
    await act(async () => {
      launchButton().click();
      await flushMicrotasks();
    });
    expect(backendMock.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ worktree: null }));
  });

  it("refuses a jj-only workspace: the message shows and Launch stays disabled", async () => {
    await render("jj-only");
    expect(document.body.textContent).toContain(t("experiment.dialog.whereJj"));
    await fillRequired();
    expect(launchButton().disabled).toBe(true);
    expect(backendMock.spawnSession).not.toHaveBeenCalled();
  });

  it("blocks submit on an invalid metric name and says why", async () => {
    await render("git");
    await typeInto(field<HTMLTextAreaElement>("#experiment-goal"), "Reduce p95");
    await typeInto(field<HTMLInputElement>("#experiment-metric"), "p95 ms");
    expect(document.body.textContent).toContain(t("experiment.dialog.metricInvalid"));
    await act(async () => {
      launchButton().click();
      await flushMicrotasks();
    });
    expect(backendMock.spawnSession).not.toHaveBeenCalled();
  });

  it("renders a rejected spawn inline and keeps the dialog open", async () => {
    await render("git");
    await fillRequired();
    backendMock.spawnSession.mockRejectedValueOnce(new Error("fatal: a branch named 'x' already exists"));
    await act(async () => {
      launchButton().click();
      await flushMicrotasks();
    });
    expect(document.body.textContent).toContain("already exists");
    expect(useStore.getState().experimentDialog).not.toBeNull();
  });

  it("seeds every field from a proposal and shows the brief block without the agent button", async () => {
    await render("git", { proposalTabId: "exp-tab" });
    expect(field<HTMLTextAreaElement>("#experiment-goal").value).toBe(PROPOSAL.goal);
    expect(field<HTMLInputElement>("#experiment-metric").value).toBe(PROPOSAL.metric);
    expect(field<HTMLInputElement>("#experiment-unit").value).toBe(PROPOSAL.unit);
    expect(field<HTMLInputElement>("#experiment-command").value).toBe(PROPOSAL.command);
    expect(field<HTMLTextAreaElement>("#experiment-scope").value).toBe("src/render\nsrc/paint");
    expect(field<HTMLTextAreaElement>("#experiment-constraints").value).toBe("no new deps");
    expect(field<HTMLInputElement>("#experiment-max-iterations").value).toBe("12");
    expect(document.body.textContent).toContain(PROPOSAL.brief);
    expect(document.body.textContent).toContain(t("experiment.dialog.proposedHint"));
    expect(buttonByText(t("experiment.dialog.withAgent"))).toBeUndefined();
  });

  it("Cancel on a proposal answers the gate with revise and closes", async () => {
    await render("git", { proposalTabId: "exp-tab" });
    const cancel = buttonByText(t("common.dialog.cancel"))!;
    await act(async () => {
      cancel.click();
      await flushMicrotasks();
    });
    expect(backendMock.rpcSend).toHaveBeenCalledWith("exp-tab", {
      type: "extension_ui_response",
      id: "gate-1",
      value: "revise",
    });
    expect(useStore.getState().experimentDialog).toBeNull();
  });

  it("Launch on a proposal spawns, then answers the gate with the launched spec", async () => {
    await render("git", { proposalTabId: "exp-tab" });
    await act(async () => {
      launchButton().click();
      await flushMicrotasks();
    });
    expect(backendMock.spawnSession).toHaveBeenCalled();
    const answer = backendMock.rpcSend.mock.calls.find(([, cmd]) => cmd.type === "extension_ui_response");
    expect(answer).toBeDefined();
    const value = String((answer![1] as { value: string }).value);
    expect(value.startsWith("launched:")).toBe(true);
    expect(JSON.parse(value.slice("launched:".length))).toMatchObject({
      goal: PROPOSAL.goal,
      metric: PROPOSAL.metric,
      brief: PROPOSAL.brief,
      branch: expect.stringMatching(/^autoresearch\//),
    });
    expect(useStore.getState().rpc["exp-tab"]!.experimentProposal).toBeNull();
  });

  it("the blank form offers Configure with the agent, carrying the typed goal", async () => {
    const startExperimentInterview = vi.fn(async () => {});
    await render("git");
    act(() => useStore.setState({ startExperimentInterview }));
    await typeInto(field<HTMLTextAreaElement>("#experiment-goal"), "make tests faster");
    const agent = buttonByText(t("experiment.dialog.withAgent"))!;
    await act(async () => {
      agent.click();
      await flushMicrotasks();
    });
    // The action owns the close (real startExperimentInterview clears the dialog);
    // the component's contract is the call with the typed goal as description.
    expect(startExperimentInterview).toHaveBeenCalledWith("/p", null, "make tests faster");
  });

  it("closes when a sibling settles the proposal", async () => {
    await render("git", { proposalTabId: "exp-tab" });
    act(() =>
      useStore.setState((s) => ({
        rpc: { ...s.rpc, "exp-tab": { ...s.rpc["exp-tab"]!, experimentProposal: null } as RpcTabState },
      })),
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(useStore.getState().experimentDialog).toBeNull();
  });
});
