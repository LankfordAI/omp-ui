// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FleetHostReport,
  FleetMachine,
  FleetMaintenanceRecord,
  FleetPendingDispatch,
  FleetProvenance,
  FleetUpdateAck,
} from "@omp-ui/core/fleet";
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
  fleetUpdateMachine: vi.fn(
    async (_machineKey: string, req: { target: "omp" | "app" }): Promise<FleetUpdateAck> =>
      req.target === "omp"
        ? {
            status: "accepted",
            check: {
              target: "omp",
              installedVersion: "18.9.0",
              installPath: "/opt/omp/bin/omp",
              latestVersion: "18.13.1",
              updateAvailable: true,
              belowMinimum: true,
              pinned: true,
            },
          }
        : {
            status: "accepted",
            check: {
              target: "app",
              currentVersion: "1.0.0",
              latestVersion: "1.1.0",
              format: "appimage",
              staged: true,
              installOnQuit: false,
              liveSessions: 2,
            },
          },
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
    snoozed: false,
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
    // ADR-0066: a member predating remote updates reports every fact null.
    ompVersion: null,
    ompPath: null,
    ompPinned: false,
    ompBelowMinimum: false,
    packageFormat: null,
    appLatestVersion: null,
    appUpdateStaged: false,
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
    maintenance: null,
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
  // Predates #905: no os, no package managers, no version facts.
  machine({ key: "inst-dispatch", nickname: "box-a", grantRung: "dispatch" }),
  // ADR-0066: omp below the harness floor, and an omp-ui release it could take.
  machine({
    key: "inst-below",
    nickname: "old-box",
    grantRung: "manage",
    report: report({
      version: "1.0.0",
      ompVersion: "18.9.0",
      ompPath: "/opt/omp/bin/omp",
      ompBelowMinimum: true,
      appLatestVersion: "1.1.0",
    }),
  }),
  // ADR-0066: an update is downloaded and waits for this member's next quit.
  machine({
    key: "inst-staged",
    nickname: "stage-box",
    grantRung: "full",
    report: report({
      version: "1.0.0",
      ompVersion: "18.13.1",
      ompPath: "/home/me/.local/bin/omp",
      appLatestVersion: "1.1.0",
      appUpdateStaged: true,
    }),
  }),
  machine({ key: "inst-down", nickname: "dark", status: "unreachable", report: null }),
];

function maintenance(patch: Partial<FleetMaintenanceRecord> & { state: FleetMaintenanceRecord["state"] }): FleetMaintenanceRecord {
  return {
    jobId: "job-1",
    target: "omp",
    progress: null,
    detail: null,
    at: 0,
    ...patch,
  };
}
function seedWith(machines: FleetMachine[]): void {
  backendMock.fleetMachines.mockResolvedValue(machines);
  useStore.setState({
    fleet: { machines, audit: null, loading: false, error: null },
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

function seedMachines(): void {
  seedWith(MACHINES);
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

  it("badges version facts on the row: omp chip with its path, below-floor rose, staged over available", () => {
    seedMachines();
    render();
    const chips = (key: string): HTMLElement[] => [...row(key).querySelectorAll<HTMLElement>("span")];
    const chipText = (key: string, title: (el: HTMLElement) => boolean): HTMLElement | undefined =>
      chips(key).find((el) => el.hasAttribute("title") && title(el));

    // The app chip reads as the app version; the omp chip beside it names its version.
    expect(row("inst-below").textContent).toContain("omp-ui 1.0.0");
    const omp = chipText("inst-below", (el) => el.getAttribute("title") === "/opt/omp/bin/omp")!;
    expect(omp.textContent).toBe("omp 18.9.0");

    // Below the harness floor: same rose tone the ssh-closed chip uses.
    const floor = chips("inst-below").find((el) => el.textContent === "below the floor")!;
    expect(floor.className).toContain("text-rose");

    // A newer release alone badges "available"; a downloaded one badges "staged" instead.
    const available = chips("inst-below").find((el) => el.textContent === "omp-ui update available")!;
    expect(available.getAttribute("title")).toContain("1.1.0");
    const staged = chips("inst-staged").find((el) => el.textContent === "update staged")!;
    expect(staged.getAttribute("title")).toContain("stage-box");
    expect(row("inst-staged").textContent).not.toContain("omp-ui update available");

    // Both omp facts null (predates ADR-0066 or truly missing): the chip says so plainly.
    const old = row("inst-dispatch").textContent!;
    expect(old).toContain("omp not installed");
    expect(old).not.toContain("below the floor");
    expect(old).not.toContain("update available");
    expect(old).not.toContain("update staged");
  });

  it("hides Update versions… on this computer and members that are not ready, and gates it on Full control", () => {
    seedMachines();
    render();

    expect(buttons(row("local"), "Update versions…")).toHaveLength(0);
    expect(buttons(row("inst-down"), "Update versions…")).toHaveLength(0);
    const [full] = buttons(row("inst-full"), "Update versions…");
    expect(full!.disabled).toBe(false);
    const [manage] = buttons(row("inst-below"), "Update versions…");
    expect(manage!.disabled).toBe(true);
    expect(manage!.title).toBe("Needs Full control on this machine");
  });

  it("shows the last maintenance we started as a status chip", () => {
    seedWith([
      machine({
        key: "inst-run",
        nickname: "runner",
        grantRung: "full",
        maintenance: maintenance({ state: "running", progress: 42 }),
      }),
      machine({
        key: "inst-ok",
        maintenance: maintenance({ state: "succeeded", detail: "omp 18.12.0 → 18.13.1 at /home/me/.local/bin/omp" }),
      }),
      machine({ key: "inst-bad", maintenance: maintenance({ state: "failed", detail: "timed out after 600 s" }) }),
    ]);
    render();

    const running = row("inst-run").querySelector("[data-maintenance]")!;
    expect(running.textContent).toBe("updating omp… 42%");
    const ok = row("inst-ok").querySelector("[data-maintenance]")!;
    expect(ok.textContent).toBe("omp → 18.13.1 at /home/me/.local/bin/omp");
    expect(ok.querySelector<HTMLElement>("[title]")!.getAttribute("title")).toBe(
      "omp 18.12.0 → 18.13.1 at /home/me/.local/bin/omp",
    );
    const bad = row("inst-bad").querySelector("[data-maintenance]")!;
    expect(bad.textContent).toContain("failed: timed out after 600 s");
    expect(bad.querySelector('[class*="text-rose"]')).not.toBeNull();
  });

  it("opens Update versions… answered by both member checks and asks through the callback", async () => {
    seedMachines();
    backendMock.fleetUpdateMachine.mockClear();
    render();

    await act(async () => {
      buttons(row("inst-full"), "Update versions…")[0]!.click();
    });
    expect(backendMock.fleetUpdateMachine.mock.calls.map(([key, req]) => [key, JSON.stringify(req)])).toEqual([
      ["inst-full", JSON.stringify({ target: "omp", action: "check", version: null, allowLiveSessions: false })],
      ["inst-full", JSON.stringify({ target: "app", action: "check", version: null, allowLiveSessions: false })],
    ]);
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Update versions on studio");

    const ompSection = dialog.querySelector('[data-update-section="omp"]')!;
    expect(ompSection.textContent).toContain("18.9.0 → 18.13.1");
    expect(ompSection.textContent).toContain("Below the minimum omp-ui requires on this machine.");
    expect(ompSection.textContent).toContain("pinned by OMP_UI_OMP_PATH");

    const appSection = dialog.querySelector('[data-update-section="app"]')!;
    expect(appSection.textContent).toContain("1.0.0 → 1.1.0");
    expect(appSection.textContent).toContain("appimage");
    expect(appSection.textContent).toContain("An update is staged and waits for this machine's next quit.");
    // Apply names the live sessions before arming them.
    expect(appSection.textContent).toContain("2 live session(s) run there; arm the install anyway.");

    // The dialog only asks: Update omp closes it; the confirmation gate owns the run.
    act(() => buttons(dialog, "Update omp")[0]!.click());
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("renders a member's refusal inline where its section would answer", async () => {
    seedMachines();
    backendMock.fleetUpdateMachine.mockImplementationOnce(async () => ({
      status: "refused" as const,
      reason: "studio runs an omp-ui without fleet updates; update omp-ui there",
    }));
    render();

    await act(async () => {
      buttons(row("inst-full"), "Update versions…")[0]!.click();
    });
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.querySelector('[data-update-section="omp"]')!.textContent).toContain(
      "studio runs an omp-ui without fleet updates; update omp-ui there",
    );
    expect(buttons(dialog, "Update omp")).toHaveLength(0);
    // The app leg answered normally: its section still renders.
    expect(dialog.querySelector('[data-update-section="app"]')!.textContent).toContain("1.0.0 → 1.1.0");
  });
});
