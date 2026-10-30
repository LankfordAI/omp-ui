// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetDispatchRequest, FleetHostProject, FleetMachine } from "@omp-ui/core/fleet";
import type { BackendState, BranchList, SpawnRequest } from "@omp-ui/core/types";
import { en } from "../lib/i18n/en";
import { backendState, remoteInstance, rpcTabState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function project(path: string, headCommit: string): FleetHostProject {
  return {
    path,
    name: "repo",
    repositoryKey: "github.com/acme/repo",
    headCommit,
    providerReady: true,
    advisor: false,
    advisorModel: null,
  };
}

function machine(key: string, nickname: string | null, projects: FleetHostProject[]): FleetMachine {
  return {
    key,
    nickname,
    status: "ready",
    error: null,
    preference: "normal",
    receivedAt: 1,
    grantRung: "dispatch",
    address: key === "local" ? null : "10.0.0.5",
    sshReachable: null,
    maintenance: null,
    report: {
      instanceId: `id-${key}`,
      label: key,
      version: "1.0.0",
      platform: "linux",
      arch: "x64",
      cpuCount: 8,
      cpuUtilization: 0.1,
      totalMemoryBytes: 100,
      availableMemoryBytes: 50,
      liveSessions: 0,
      runningTurns: 0,
      sampledAt: 1,
      projects,
      user: null,
      projectRoots: [],
      os: null,
      packageManagers: null,
      ompVersion: null,
      ompPath: null,
      ompPinned: false,
      ompBelowMinimum: false,
      packageFormat: null,
      appLatestVersion: null,
      appUpdateStaged: false,
      modelFavorites: [],
    },
  };
}

/** A registry group with the full ProjectRecord fields the dialog reads. */
function group(path: string, name: string, repositoryKey: string | null) {
  return {
    project: {
      path,
      name,
      addedAt: "t",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      reviewRoster: null,
      knowledgeHome: null,
      repositoryKey,
      icon: null,
    },
    sessions: [],
  };
}

/** `github.com/acme/repo` checked out locally AND on the joined box-a (#903). */
const dualHostState = (): BackendState =>
  backendState({
    projects: [group("/p", "p", "github.com/acme/repo")],
    remoteInstances: [remoteInstance({ projects: [group("/srv/p", "repo", "github.com/acme/repo")] })],
  });

/** A healthy git repo answer for the spawn path's fire-and-forget refresh. */
const branchFixture: BranchList = {
  repoRoot: "/p",
  current: "main",
  branches: ["main", "feature/x"],
  defaultBranch: "main",
  upstreamRef: null,
  upstreamRemote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  mergeInProgress: false,
  upstreamFetchedAt: null,
  upstreamRefreshError: null,
  defaultRemote: "origin",
};

const localProjectState = (): BackendState =>
  backendState({
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
          reviewRoster: null,
          knowledgeHome: null,
          repositoryKey: null,
          icon: null,
        },
        sessions: [],
      },
    ],
  });

// Only the channels the dialog's store path touches: the fleet reads it
// lazy-loads and submits through, the spawn its local launch goes through,
// the advisor defaults resolveSpawnParams reads, the branch list the landing
// tab refreshes, and the command bus every title/prompt send rides.
let machines: FleetMachine[] = [];
const sent: Array<{ tabId: string; cmd: Record<string, unknown> }> = [];
const backendMock = {
  fleetMachines: vi.fn(async () => machines),
  fleetDispatch: vi.fn(),
  listBranches: vi.fn(async (): Promise<BranchList> => branchFixture),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  spawnSession: vi.fn<(request: SpawnRequest) => Promise<{ tabId: string }>>(async () => ({
    tabId: "launch-1",
  })),
  rpcSend: vi.fn((tabId: string, cmd: Record<string, unknown>) => {
    sent.push({ tabId, cmd });
  }),
  setSessionAutoTitled: vi.fn(async () => {}),
  setSessionSnoozed: vi.fn(async () => {}),
  setSnoozedSectionEnabled: vi.fn(async () => {}),
  // The joined instance answers the same channels through the proxy (issue #416):
  // the here face's remote-machine spawn rides `session:spawn` here.
  remoteInstanceRequest: vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (instanceId: string, channel: string, args: unknown[]): Promise<unknown> => undefined,
  ),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { NewSessionDialog } = await import("./NewSessionDialog");
const { BackgroundSeedToast } = await import("./BackgroundSeedToast");

let root: Root | null = null;

/** Deterministic event-drain for promise chains (no wall-clock waiting). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function render(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<NewSessionDialog />);
    await flushMicrotasks();
  });
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );

const button = (text: string): HTMLButtonElement => {
  const found = buttonByText(text);
  expect(found, text).toBeDefined();
  return found!;
};

const click = async (target: HTMLElement): Promise<void> => {
  await act(async () => {
    target.click();
    await flushMicrotasks();
  });
};

const promptArea = (): HTMLTextAreaElement => {
  const area = document.body.querySelector<HTMLTextAreaElement>("#newsession-prompt");
  expect(area).not.toBeNull();
  return area!;
};

const titleInput = (): HTMLInputElement => {
  const input = document.body.querySelector<HTMLInputElement>("#newsession-title");
  expect(input).not.toBeNull();
  return input!;
};

const projectSelect = (): HTMLSelectElement => {
  const select = document.body.querySelector<HTMLSelectElement>("#newsession-project");
  expect(select).not.toBeNull();
  return select!;
};

const machineSelect = (): HTMLSelectElement => {
  const select = document.body.querySelector<HTMLSelectElement>("#newsession-machine");
  expect(select).not.toBeNull();
  return select!;
};

const optionTexts = (select: HTMLSelectElement): string[] =>
  [...select.options].map((option) => option.textContent ?? "");

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
  });
}

async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** Answers one recorded command successfully, exactly as a live omp would. */
function respondTo(entry: { tabId: string; cmd: Record<string, unknown> }): void {
  useStore.getState().handleRpcFrame(entry.tabId, {
    type: "response",
    id: entry.cmd.id,
    command: entry.cmd.type,
    success: true,
    data: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  machines = [];
  sent.length = 0;
  backendMock.spawnSession.mockResolvedValue({ tabId: "launch-1" });
  // clearAllMocks keeps implementations, so the proxy's silent default goes
  // back explicitly for each test (wireRemote overrides it per case).
  backendMock.remoteInstanceRequest.mockImplementation(async (): Promise<unknown> => undefined);
  backendMock.fleetDispatch.mockResolvedValue({ batchId: null, outcomes: [] });
  useStore.setState({
    state: localProjectState(),
    tabs: [],
    activeTabId: null,
    rpc: {},
    exited: {},
    branches: {},
    branchActivity: {},
    advisorDefaults: { "/p": { enabled: false, model: null } },
    errorNotices: [],
    fleet: null,
    fleetLastRequests: {},
    newSessionDialog: { projectCwd: null, instanceId: null, where: "here", workspace: "checkout" },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("NewSessionDialog (issue #900)", () => {
  it("spawns locally with no prompt and no Where row when nothing is joined", async () => {
    await render();
    // No joined instance: the dialog is local-only, capsule and all.
    expect(buttonByText("Multiple machines")).toBeUndefined();
    expect(buttonByText("This computer or one member")).toBeUndefined();
    expect(document.body.querySelector('[role="group"][aria-label="Where"]')).toBeNull();

    await click(button("Start session"));
    expect(backendMock.spawnSession).toHaveBeenCalledTimes(1);
    expect(backendMock.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "new", projectCwd: "/p" }),
    );
    // The quick-launch contract: an empty prompt is the tab alone.
    expect(sent).toEqual([]);
    expect(backendMock.rpcSend).not.toHaveBeenCalled();
    expect(useStore.getState().newSessionDialog).toBeNull();
  });

  it("refuses an empty prompt on the fleet face", async () => {
    useStore.setState({
      state: { ...localProjectState(), remoteInstances: [remoteInstance({ projects: [] })] },
    });
    machines = [machine("local", null, [project("/p", "aaa")])];
    await render();

    // The Where row appeared; switching to the fleet face loads machines.
    expect(buttonByText("Multiple machines")).toBeDefined();
    await click(button("Multiple machines"));
    expect(button("Multiple machines").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.querySelector("#newsession-project")).not.toBeNull();

    // A reference exists, but the fleet requires a prompt.
    expect(button("Start session").disabled).toBe(true);
    await typeInto(promptArea(), "try the thing");
    expect(button("Start session").disabled).toBe(false);
    expect(backendMock.fleetDispatch).not.toHaveBeenCalled();
  });

  it("sends a local prompt exactly once the tab reports ready", async () => {
    await render();
    await typeInto(promptArea(), "  do the thing  ");
    await click(button("Start session"));
    // Nothing goes to omp before the boot reports ready.
    expect(sent).toEqual([]);

    useStore.setState({ rpc: { "launch-1": rpcTabState() } });
    await act(async () => {
      await flushMicrotasks();
    });
    const prompts = sent.filter((s) => s.cmd.type === "prompt");
    expect(prompts.map((s) => String(s.cmd.message))).toEqual(["do the thing"]);
    expect(prompts[0]!.tabId).toBe("launch-1");

    for (const entry of sent.splice(0)) respondTo(entry);
    await act(async () => {
      await flushMicrotasks();
    });
    // Exactly once: the answer settled and no second frame followed.
    expect(sent).toEqual([]);
    expect(backendMock.rpcSend).toHaveBeenCalledTimes(1);
    expect(useStore.getState().newSessionDialog).toBeNull();
  });

  it("warns on the tab and sends nothing when the boot never reaches ready", async () => {
    // A starting boot owns neither the failure banner nor the exit notice.
    useStore.setState({ rpc: { "launch-1": rpcTabState({ status: "starting" }) } });
    await render();
    await typeInto(promptArea(), "do the thing");
    // Only the settle poll's 15 s deadline needs the clock: fake it after
    // mount so the overlay's focus plumbing stays on real timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await click(button("Start session"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(backendMock.spawnSession).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    const last = useStore.getState().rpc["launch-1"]!.items.at(-1);
    expect(last).toMatchObject({ kind: "notice", level: "warn" });
    const text = last !== undefined && last.kind === "notice" ? last.text : null;
    expect(text).toContain("draft was not sent");
  });

  it("applies the title strictly before the prompt", async () => {
    await render();
    await typeInto(titleInput(), "Nightly triage");
    await typeInto(promptArea(), "do the thing");
    await click(button("Start session"));
    useStore.setState({ rpc: { "launch-1": rpcTabState() } });
    await act(async () => {
      await flushMicrotasks();
    });

    // The launch awaits the rename before sending: only set_session_name is
    // on the wire until this test answers it.
    expect(sent.map((s) => s.cmd.type)).toEqual(["set_session_name"]);
    const rename = sent.shift()!;
    expect(rename.tabId).toBe("launch-1");
    expect(rename.cmd).toMatchObject({ type: "set_session_name", name: "Nightly triage" });
    respondTo(rename);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(sent.map((s) => s.cmd.type)).toEqual(["prompt"]);
    expect(String(sent[0]!.cmd.message)).toBe("do the thing");

    for (const entry of sent.splice(0)) respondTo(entry);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(useStore.getState().newSessionDialog).toBeNull();
  });

  it("sends a titleless prompt with no rename attempt at all", async () => {
    await render();
    await typeInto(titleInput(), "   ");
    await typeInto(promptArea(), "do the thing");
    await click(button("Start session"));
    useStore.setState({ rpc: { "launch-1": rpcTabState() } });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(sent.map((s) => s.cmd.type)).toEqual(["prompt"]);
    for (const entry of sent.splice(0)) respondTo(entry);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(backendMock.setSessionAutoTitled).not.toHaveBeenCalled();
  });

  it("builds the auto dispatch request and opens Fleet once every copy started", async () => {
    useStore.setState({
      state: { ...localProjectState(), remoteInstances: [remoteInstance({ projects: [] })] },
    });
    machines = [machine("local", null, [project("/p", "aaa")])];
    backendMock.fleetDispatch.mockResolvedValue({
      batchId: "b-1",
      outcomes: [{ dispatchId: "d-1", machineKey: "local", projectCwd: "/p", status: "started", tabId: "s-1", choice: null }],
    });
    await render();
    await click(button("Multiple machines"));
    await typeInto(promptArea(), "try the thing");
    await click(button("Start session"));

    expect(backendMock.fleetDispatch).toHaveBeenCalledTimes(1);
    const req = backendMock.fleetDispatch.mock.calls[0]![0] as FleetDispatchRequest;
    expect(req.targets).toEqual({
      kind: "auto",
      reference: { machineKey: "local", projectCwd: "/p" },
      count: 1,
    });
    expect(req.prompt).toBe("try the thing");
    expect(req.title).toBeNull();
    expect(req.workspace).toBe("checkout");
    expect(req.planMode).toBe(false);
    // All started: the dialog hands off to the Fleet view.
    expect(useStore.getState().newSessionDialog).toBeNull();
    expect(useStore.getState().fleet).not.toBeNull();
  });

  it("expands choose-mode picks per copy and forces worktrees at two copies", async () => {
    useStore.setState({
      state: { ...localProjectState(), remoteInstances: [remoteInstance({ projects: [] })] },
    });
    machines = [machine("local", null, [project("/p", "aaa")])];
    backendMock.fleetDispatch.mockResolvedValue({
      batchId: "b-1",
      outcomes: [{ dispatchId: "d-1", machineKey: "local", projectCwd: "/p", status: "started", tabId: "s-1", choice: null }],
    });
    await render();
    await click(button("Multiple machines"));
    await click(button("Choose machines"));
    await click(
      document.body.querySelector<HTMLButtonElement>('button[aria-label="One more copy on This computer"]')!,
    );

    // The checkout rule holds before the request is even built.
    expect(button("Project checkout").disabled).toBe(true);
    expect(button("New worktree").getAttribute("aria-pressed")).toBe("true");

    await typeInto(promptArea(), "spread across copies");
    await click(button("Start session"));

    expect(backendMock.fleetDispatch).toHaveBeenCalledTimes(1);
    const req = backendMock.fleetDispatch.mock.calls[0]![0] as FleetDispatchRequest;
    // Picks expand one entry per copy, grouped by the chosen machine.
    expect(req.targets).toEqual({
      kind: "explicit",
      picks: [
        { machineKey: "local", projectCwd: "/p" },
        { machineKey: "local", projectCwd: "/p" },
      ],
    });
    // Two copies on one machine: workspace "checkout" is unreachable and the
    // request carries "worktree" despite the seed's checkout default.
    expect(req.workspace).toBe("worktree");
  });

  it("disables Project checkout once one machine runs more than one copy", async () => {
    useStore.setState({
      state: { ...localProjectState(), remoteInstances: [remoteInstance({ projects: [] })] },
    });
    machines = [machine("local", null, [project("/p", "aaa")])];
    await render();
    await click(button("Multiple machines"));
    await click(button("Choose machines"));
    expect(button("Project checkout").disabled).toBe(false);

    await click(document.body.querySelector<HTMLButtonElement>('button[aria-label="One more copy on This computer"]')!);
    expect(button("Project checkout").disabled).toBe(true);
    expect(button("New worktree").getAttribute("aria-pressed")).toBe("true");
  });

  it("warns when the selected machines are on different commits", async () => {
    useStore.setState({
      state: { ...localProjectState(), remoteInstances: [remoteInstance({ projects: [] })] },
    });
    machines = [machine("local", null, [project("/p", "aaa")]), machine("inst-1", "box-a", [project("/remote/p", "bbb")])];
    await render();
    const notice = en["dialog.newsession.commitsDiffer"];
    await click(button("Multiple machines"));
    // Auto considers every machine with the repository.
    expect(document.body.textContent).toContain(notice);

    // Choose: only the reference machine starts checked — one commit, no notice.
    await click(button("Choose machines"));
    expect(document.body.textContent).not.toContain(notice);
    const boxA = [...document.body.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("box-a"));
    await click(boxA!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(document.body.textContent).toContain(notice);
  });

  it("keeps the dialog open and names the machine when part of a batch failed", async () => {
    useStore.setState({
      state: { ...localProjectState(), remoteInstances: [remoteInstance({ projects: [] })] },
    });
    machines = [machine("local", null, [project("/p", "aaa")]), machine("inst-1", "box-a", [project("/remote/p", "bbb")])];
    backendMock.fleetDispatch.mockResolvedValue({
      batchId: "b-1",
      outcomes: [
        { dispatchId: "d-1", machineKey: "local", projectCwd: "/p", status: "started", tabId: "s-1", choice: null },
        { dispatchId: "d-2", machineKey: "inst-1", projectCwd: "/remote/p", status: "failed", message: "boom" },
      ],
    });
    await render();
    await click(button("Multiple machines"));
    await typeInto(promptArea(), "try the thing");
    await click(button("Start session"));

    // The batch was partial: the dialog stays open and reports the failure.
    expect(useStore.getState().newSessionDialog).not.toBeNull();
    expect(useStore.getState().fleet).toBeNull();
    const failed = en["dialog.newsession.failed"]
      .replace("{machine}", "box-a")
      .replace("{message}", "boom");
    const li = [...document.body.querySelectorAll<HTMLLIElement>("li")].find((row) =>
      row.className.includes("text-rose"),
    );
    expect(li).toBeDefined();
    expect(li!.textContent).toContain(failed);
  });

  it("shows the no-projects copy for a seed project absent from every catalog", async () => {
    useStore.setState({
      state: backendState(),
      newSessionDialog: { projectCwd: "/gone", instanceId: null, where: "here", workspace: "checkout" },
    });
    await render();
    expect(document.body.textContent).toContain(en["dialog.newsession.noProjects"]);
    expect(button("Start session").disabled).toBe(true);
  });
});

describe("NewSessionDialog unified project view (issue #903)", () => {
  /** The joined box-a answers its proxy channels exactly like a live instance. */
  const wireRemote = (): void => {
    backendMock.remoteInstanceRequest.mockImplementation(
      async (_instanceId: string, channel: string): Promise<unknown> => {
        if (channel === "session:spawn") return { tabId: "remote-1" };
        if (channel === "advisor:defaults") return { enabled: false, model: null };
        if (channel === "branch:list") return branchFixture;
        return undefined;
      },
    );
  };

  const remoteMachineValue = "inst-1\u0000/srv/p";

  it("merges both checkouts into one project entry and defaults the machine to This computer", async () => {
    useStore.setState({ state: dualHostState() });
    await render();

    // One repository, one option — under its repository key's optgroup.
    const groups = [...projectSelect().querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual(["github.com/acme/repo"]);
    expect(optionTexts(projectSelect())).toEqual(["p"]);

    // Both hosts are selectable machines; the local checkout wins by default (Q3).
    expect(optionTexts(machineSelect())).toEqual(["This computer", "box-a"]);
    expect(machineSelect().selectedOptions[0]!.textContent).toBe("This computer");
  });

  it("routes a remote machine pick through the proxied spawn with the prompt riding the tab", async () => {
    useStore.setState({ state: dualHostState() });
    wireRemote();
    await render();

    await choose(machineSelect(), remoteMachineValue);
    await typeInto(promptArea(), "do the thing");
    await click(button("Start session"));

    // The spawn is proxied to box-a; nothing touches the local backend or the fleet.
    expect(backendMock.remoteInstanceRequest).toHaveBeenCalledWith(
      "inst-1",
      "session:spawn",
      [expect.objectContaining({ origin: "new", projectCwd: "/srv/p" })],
    );
    expect(backendMock.spawnSession).not.toHaveBeenCalled();
    expect(backendMock.fleetDispatch).not.toHaveBeenCalled();

    // The prompt still rides the command bus once the remote boot reports ready.
    useStore.setState({ rpc: { "remote-1": rpcTabState() } });
    await act(async () => {
      await flushMicrotasks();
    });
    const prompts = sent.filter((s) => s.cmd.type === "prompt");
    expect(prompts.map((s) => String(s.cmd.message))).toEqual(["do the thing"]);
    for (const entry of sent.splice(0)) respondTo(entry);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(useStore.getState().newSessionDialog).toBeNull();
  });

  it("lands an idle remote session for a remote machine pick with an empty prompt", async () => {
    useStore.setState({ state: dualHostState() });
    wireRemote();
    await render();

    await choose(machineSelect(), remoteMachineValue);
    await click(button("Start session"));

    expect(backendMock.remoteInstanceRequest).toHaveBeenCalledWith(
      "inst-1",
      "session:spawn",
      [expect.objectContaining({ projectCwd: "/srv/p" })],
    );
    // Empty prompt = the tab alone: no command bus traffic, no fleet spec.
    expect(sent).toEqual([]);
    expect(backendMock.rpcSend).not.toHaveBeenCalled();
    expect(backendMock.fleetDispatch).not.toHaveBeenCalled();
    expect(useStore.getState().newSessionDialog).toBeNull();
  });

  it("lists only the registered hosts of a keyless project in its machine select", async () => {
    useStore.setState({
      state: {
        ...localProjectState(),
        remoteInstances: [remoteInstance({ projects: [group("/srv/q", "q", null)] })],
      },
    });
    await render();

    // Keyless repositories never merge: each is its own entry, grouped under the no-key label.
    const groups = [...projectSelect().querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual([en["dialog.newsession.noRepositoryKey"]]);
    expect(optionTexts(projectSelect())).toEqual(["p", "q"]);

    // The local keyless project registers on one host only.
    expect(optionTexts(machineSelect())).toEqual(["This computer"]);

    // The remote keyless project lists its own host — the default Q3 order has no local pair.
    await choose(projectSelect(), "inst-1\u0000/srv/q");
    expect(optionTexts(machineSelect())).toEqual(["box-a"]);
    expect(machineSelect().selectedOptions[0]!.textContent).toBe("box-a");
  });

  it("never defaults to a remote machine even when seeded from one", async () => {
    useStore.setState({
      state: dualHostState(),
      // The sidebar opens the dialog seeded on box-a; the repo also has a
      // local checkout, so Q3 says the default machine stays This computer.
      newSessionDialog: { projectCwd: "/srv/p", instanceId: "inst-1", where: "here", workspace: "checkout" },
    });
    await render();

    expect(machineSelect().selectedOptions[0]!.textContent).toBe("This computer");
    // The seed still owns the repository choice: its repo is the picked entry.
    expect(projectSelect().value).toBe("github.com/acme/repo");

    await click(button("Start session"));
    expect(backendMock.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectCwd: "/p" }),
    );
    expect(backendMock.remoteInstanceRequest).not.toHaveBeenCalled();
  });
});

describe("NewSessionDialog start in background (issue #982)", () => {
  const chord = async (): Promise<void> => {
    await act(async () => {
      promptArea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
    });
  };

  /** The user is looking at another session when the dialog opens. */
  const seedFocused = (): void => {
    useStore.setState({
      tabs: [{ tabId: "other", mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null }],
      activeTabId: "other",
    });
  };

  it("lands the session without focus, keeps the dialog open and cleared, and sends the seed later", async () => {
    seedFocused();
    await render();
    await typeInto(titleInput(), "First ask");
    await typeInto(promptArea(), "do the first thing");
    await chord();

    const st = useStore.getState();
    expect(st.tabs.map((tab) => tab.tabId)).toEqual(["other", "launch-1"]);
    expect(st.activeTabId).toBe("other");
    expect(st.newSessionDialog).not.toBeNull();
    expect(promptArea().value).toBe("");
    expect(titleInput().value).toBe("");
    expect(document.activeElement).toBe(promptArea());

    // The seed follows once the background tab's boot reports ready.
    useStore.setState((s) => ({ rpc: { ...s.rpc, "launch-1": rpcTabState() } }));
    await act(async () => {
      await flushMicrotasks();
    });
    respondTo(sent.shift()!);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(sent.map((s) => [s.tabId, s.cmd.type, s.cmd.message])).toEqual([["launch-1", "prompt", "do the first thing"]]);
    expect(useStore.getState().activeTabId).toBe("other");
  });

  it("raises the toast when a background seed is not sent, and Open session focuses it", async () => {
    seedFocused();
    useStore.setState({ rpc: { "launch-1": rpcTabState({ status: "starting" }) }, backgroundSeedFailedTabId: null });
    await render();
    await typeInto(promptArea(), "do the thing");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await chord();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(sent).toEqual([]);
    expect(useStore.getState().backgroundSeedFailedTabId).toBe("launch-1");
    // The warn still lands on the new tab itself.
    expect(useStore.getState().rpc["launch-1"]!.items.at(-1)).toMatchObject({ kind: "notice", level: "warn" });

    vi.useRealTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const toastRoot = createRoot(host);
    await act(async () => toastRoot.render(<BackgroundSeedToast />));
    expect(host.textContent).toContain("its first prompt was not sent");
    await click(button(en["dialog.newsession.backgroundOpen"]));
    expect(useStore.getState().activeTabId).toBe("launch-1");
    expect(useStore.getState().backgroundSeedFailedTabId).toBeNull();
    act(() => toastRoot.unmount());
  });

  it("mints a fresh worktree branch for the next background launch and keeps Plan on it", async () => {
    useStore.setState({
      newSessionDialog: { projectCwd: null, instanceId: null, where: "here", workspace: "worktree" },
    });
    await render();
    await click(button(en["dialog.newsession.plan"]));
    const branchField = (): HTMLInputElement => document.body.querySelector<HTMLInputElement>("#newsession-branch")!;
    const first = branchField().value;
    await chord();
    backendMock.spawnSession.mockResolvedValue({ tabId: "launch-2" });
    const second = branchField().value;
    expect(second).not.toBe(first);
    // Same base segments, a new hash tail.
    expect(second.slice(0, second.lastIndexOf("/"))).toBe(first.slice(0, first.lastIndexOf("/")));
    await chord();

    const requests = backendMock.spawnSession.mock.calls.map(([request]) => request);
    expect(requests).toEqual([
      expect.objectContaining({ planMode: true, worktree: { mint: expect.objectContaining({ branch: first }) } }),
      expect.objectContaining({ planMode: true, worktree: { mint: expect.objectContaining({ branch: second }) } }),
    ]);
    expect(useStore.getState().tabs.map((tab) => tab.tabId)).toEqual(["launch-1", "launch-2"]);
    expect(useStore.getState().newSessionDialog).not.toBeNull();
  });
});
