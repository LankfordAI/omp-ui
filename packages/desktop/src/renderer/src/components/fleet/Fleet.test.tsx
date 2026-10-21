// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetHostReport, FleetMachine, FleetPendingDispatch, FleetProvenance } from "@omp-ui/core/fleet";
import type { ProjectGroup, ProviderKeysSnapshot, ProviderKeyStatus, SessionSummary } from "@omp-ui/core/types";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  fleetMachines: vi.fn(async (): Promise<FleetMachine[]> => []),
  fleetAudit: vi.fn(async () => []),
  fleetDispatch: vi.fn(),
  fleetDismissPending: vi.fn(async () => {}),
  readProviderKeys: vi.fn(
    async (): Promise<ProviderKeysSnapshot> => ({
      providers: [],
      encryptionAvailable: true,
      backend: "test",
      configFileProviders: [],
    }),
  ),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports: store.ts → ./backend reads window.ompBackend at module load.
const { useStore } = await import("../../store");
const { Fleet } = await import("./Fleet");

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function provenance(dispatchId: string, batchId: string | null, dispatchedAt: string): FleetProvenance {
  return {
    dispatchId,
    batchId,
    dispatchedAt,
    requestedBy: { instanceId: "inst-me", label: "desk", kind: "user", sourceTabId: null },
  };
}

function session(tabId: string, title: string, fleet: FleetProvenance | null): SessionSummary {
  return {
    tabId,
    sessionId: null,
    lineageDir: `lineage-${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    fleet,
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    autoTitled: false,
    private: false,
    chat: false,
    askSource: null,
    cachedTitle: title,
    cachedModified: "t",
    title,
    status: "complete",
    live: "dormant",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

function group(sessions: SessionSummary[]): ProjectGroup {
  return {
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
      browserClock: false,
      reviewRoster: null,
      knowledgeHome: null,
      repositoryKey: null,
    },
    sessions,
  };
}

function pending(dispatchId: string, title: string): FleetPendingDispatch {
  return {
    dispatchId,
    batchId: null,
    machineKey: "inst-1",
    nickname: "box-a",
    projectCwd: "/remote/p",
    title,
    since: "2026-10-20T00:00:00.000Z",
    message: "remote connection lost",
  };
}

function report(patch: Partial<FleetHostReport> = {}): FleetHostReport {
  return {
    instanceId: "inst",
    label: "host",
    version: "1.0.0",
    platform: "linux",
    arch: "x64",
    cpuCount: 8,
    cpuUtilization: 0.25,
    totalMemoryBytes: 16,
    availableMemoryBytes: 8,
    liveSessions: 0,
    runningTurns: 0,
    sampledAt: 0,
    projects: [],
    user: null,
    projectRoots: null,
    os: null,
    packageManagers: null,
    ...patch,
  };
}

function machine(patch: Partial<FleetMachine> & { key: string }): FleetMachine {
  return {
    nickname: null,
    status: "ready",
    error: null,
    preference: "normal",
    report: report(),
    receivedAt: 0,
    grantRung: null,
    address: null,
    sshReachable: null,
    ...patch,
  };
}

function keyRow(patch: Partial<ProviderKeyStatus> & { activeEnv: string }): ProviderKeyStatus {
  return {
    id: patch.activeEnv.toLowerCase(),
    label: patch.activeEnv,
    group: "models",
    env: patch.activeEnv,
    source: "stored",
    masked: "••••abcd",
    hint: null,
    shadowsEnvironment: false,
    unreadableStoredEnvs: [],
    ...patch,
  };
}

const MACHINES: FleetMachine[] = [
  machine({
    key: "local",
    report: report({
      os: { name: "Fedora Linux 44 (Workstation Edition)", version: "44" },
      packageManagers: [
        { name: "dnf", path: "/usr/bin/dnf", onPath: true },
        { name: "brew", path: "/home/linuxbrew/.linuxbrew/bin/brew", onPath: false },
      ],
    }),
  }),
  machine({
    key: "inst-full",
    nickname: "studio",
    grantRung: "full",
    report: report({ os: { name: "macOS", version: "15.1" }, packageManagers: [] }),
  }),
  // Predates #905: no os, no package managers.
  machine({ key: "inst-dispatch", nickname: "box-a", grantRung: "dispatch" }),
];

function seedMachines(): void {
  backendMock.fleetMachines.mockResolvedValue(MACHINES);
  useStore.setState({
    fleet: { machines: MACHINES, audit: null, loading: false, error: null },
    fleetLastRequests: {},
    lifecycleConfirmation: null,
    rpc: {},
    state: backendState({
      remoteInstances: [
        {
          id: "inst-full",
          nickname: "studio",
          url: "https://studio.tailnet:4677",
          status: "joined",
          error: null,
          version: "1.0.0",
          projects: [],
          modelFavorites: [],
        },
      ],
    }),
  });
}

const row = (key: string): Element => document.body.querySelector(`[data-machine-key="${key}"]`)!;

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Fleet />));
}

const buttons = (scope: Element, text: string): HTMLButtonElement[] =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === text);

describe("Fleet view", () => {
  it("groups dispatched sessions by batch and offers Retry only for requests this renderer still holds", () => {
    useStore.setState({
      fleet: { machines: [], audit: null, loading: false, error: null },
      fleetLastRequests: {
        "d-live": {
          req: { targets: { kind: "auto", reference: { machineKey: "local", projectCwd: "/p" }, count: 1 }, prompt: "go", title: null, workspace: "worktree", planMode: false },
          pick: { machineKey: "inst-1", projectCwd: "/remote/p" },
        },
      },
      rpc: {},
      state: backendState({
        projects: [
          group([
            session("t-a", "Batch work", provenance("d-a", "b-1", "2026-10-20T00:00:01.000Z")),
            session("t-b", "Batch work", provenance("d-b", "b-1", "2026-10-20T00:00:02.000Z")),
            session("t-solo", "Solo work", provenance("d-solo", null, "2026-10-20T00:00:03.000Z")),
            session("t-plain", "Not dispatched", null),
          ]),
        ],
        fleetPending: [pending("d-live", "Still held"), pending("d-reloaded", "Lost on reload")],
      }),
    });
    render();

    const batch = document.body.querySelector('[data-batch-id="b-1"]');
    expect(batch).not.toBeNull();
    expect([...batch!.querySelectorAll("[data-tab-id]")].map((row) => row.getAttribute("data-tab-id"))).toEqual(["t-b", "t-a"]);
    expect(document.body.querySelectorAll("[data-tab-id]")).toHaveLength(3);
    expect(document.body.querySelector('[data-tab-id="t-plain"]')).toBeNull();

    const held = document.body.querySelector('[data-dispatch-id="d-live"]')!;
    expect(buttons(held, "Retry")).toHaveLength(1);
    expect(buttons(held, "Dismiss")).toHaveLength(1);
    const reloaded = document.body.querySelector('[data-dispatch-id="d-reloaded"]')!;
    expect(buttons(reloaded, "Retry")).toHaveLength(0);
    expect(buttons(reloaded, "Dismiss")).toHaveLength(1);
    expect(reloaded.textContent).toContain("Retry unavailable after reload");
    expect(reloaded.textContent).toContain("Outcome unknown — resolves when box-a reconnects");
  });

  it("shows each machine's OS with its package managers on hover, and none for a member predating #905", () => {
    seedMachines();
    render();

    const local = row("local").querySelector<HTMLElement>("[data-machine-os] [title]")!;
    expect(local.textContent).toBe("Fedora Linux 44 (Workstation Edition)");
    expect(local.title).toBe("Package managers: dnf, brew (/home/linuxbrew/.linuxbrew/bin/brew)");
    const studio = row("inst-full").querySelector<HTMLElement>("[data-machine-os] [title]")!;
    expect(studio.textContent).toBe("macOS 15.1");
    expect(studio.title).toBe("No package manager found");
    expect(row("inst-dispatch").querySelector("[data-machine-os]")).toBeNull();
  });

  it("offers Roll out keys on joined members only, enabled at Full control", () => {
    seedMachines();
    render();

    expect(buttons(row("local"), "Roll out keys")).toHaveLength(0);
    const [full] = buttons(row("inst-full"), "Roll out keys");
    expect(full!.disabled).toBe(false);
    const [dispatch] = buttons(row("inst-dispatch"), "Roll out keys");
    expect(dispatch!.disabled).toBe(true);
    expect(dispatch!.title).toBe("Needs Full control on this machine");
  });

  it("stages the rollout confirmation with only the checked, injectable env names", async () => {
    seedMachines();
    backendMock.readProviderKeys.mockResolvedValueOnce({
      providers: [
        keyRow({ activeEnv: "ANTHROPIC_API_KEY", source: "stored" }),
        keyRow({ activeEnv: "OPENAI_API_KEY", source: "environment" }),
        keyRow({ activeEnv: "GROQ_API_KEY", source: "login-shell" }),
        keyRow({ activeEnv: "MISTRAL_API_KEY", source: "dotenv" }),
        keyRow({ activeEnv: "XAI_API_KEY", source: "none", masked: null }),
      ],
      encryptionAvailable: true,
      backend: "test",
      configFileProviders: [],
    });
    render();

    await act(async () => {
      buttons(row("inst-full"), "Roll out keys")[0]!.click();
    });
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Roll out Provider keys to studio");
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.dataset.env)).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY"]);
    expect(boxes.every((box) => box.checked)).toBe(true);
    act(() => boxes[1]!.click());

    act(() => buttons(dialog, "Continue")[0]!.click());
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(useStore.getState().lifecycleConfirmation).toMatchObject({
      kind: "rollout-keys",
      instanceId: "inst-full",
      targetLabel: "studio",
      envNames: ["ANTHROPIC_API_KEY", "GROQ_API_KEY"],
      encrypted: true,
    });
  });
});
