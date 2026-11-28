// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetMachine, FleetHostReport } from "@omp-ui/core/fleet";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  getState: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onRpcFrame: vi.fn(),
  fleetMachines: vi.fn(async (): Promise<FleetMachine[]> => []),
  fleetProjectCopyPreview: vi.fn(async () => ({
    remote: "https" as const,
    files: [],
    skipped: [],
  })),
};
Object.assign(window, { ompBackend: backendMock });

// store.ts → ./backend captures the preload bridge at module load, so the
// mock must be installed before either module loads — a static import cannot
// express this ordering.
const { useStore } = await import("../../store");
const { CopyProjectDialog } = await import("./CopyProjectDialog");

let root: Root | null = null;

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
    ompVersion: null,
    ompPath: null,
    ompPinned: false,
    ompBelowMinimum: false,
    packageFormat: null,
    appLatestVersion: null,
    appUpdateStaged: false,
    modelFavorites: [],
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
    grantCeiling: null,
    memberExecEnabled: null,
    address: null,
    sshReachable: null,
    maintenance: null,
    ...patch,
  };
}

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <CopyProjectDialog projectCwd="/work/app" name="App" />,
    ),
  );
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (found === undefined) throw new Error(`button not found: ${text}`);
  return found;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("CopyProjectDialog rung refusal affordance (issue #1398)", () => {
  it("shows Request access… on a member that holds a rung below Manage, and opens the shared ceremony without closing the dialog", async () => {
    backendMock.fleetMachines.mockResolvedValue([
      machine({ key: "inst-a", nickname: "box-a", grantRung: "dispatch", grantCeiling: "full", memberExecEnabled: true }),
    ]);
    useStore.setState({ state: backendState(), copyProjectDialog: { projectCwd: "/work/app", name: "App" } });
    render();
    await act(async () => {});
    const row = document.body.querySelector('[data-machine="inst-a"]')!.closest("li")!;
    expect(row.textContent).toContain("needs the Manage projects rung on that machine");

    await act(async () => button("Request access…").click());
    expect(useStore.getState().grantCeremony).toEqual({
      instanceId: "inst-a",
      machineName: "box-a",
      neededRung: "manage",
    });
    // The picker stays open behind the ceremony.
    expect(useStore.getState().copyProjectDialog).toEqual({ projectCwd: "/work/app", name: "App" });
  });

  it("reloads the member list when the ceremony closes after a grant", async () => {
    backendMock.fleetMachines
      .mockResolvedValueOnce([
        machine({ key: "inst-a", nickname: "box-a", grantRung: "dispatch", grantCeiling: "full", memberExecEnabled: true }),
      ])
      .mockResolvedValue([
        machine({ key: "inst-a", nickname: "box-a", grantRung: "manage", grantCeiling: "full", memberExecEnabled: true, report: report({ projectRoots: ["/srv/repos"] }) }),
      ]);
    useStore.setState({ state: backendState(), copyProjectDialog: { projectCwd: "/work/app", name: "App" } });
    render();
    await act(async () => {
      useStore.setState({
        grantCeremony: { instanceId: "inst-a", machineName: "box-a", neededRung: "manage" },
      });
    });
    await act(async () => {
      useStore.setState({ grantCeremony: null });
    });
    // Two loads: the dialog's first read plus the reload after the ceremony closed.
    expect(backendMock.fleetMachines).toHaveBeenCalledTimes(2);
    const row = document.body.querySelector('[data-machine="inst-a"]')!.closest("li")!;
    expect(row.textContent).toContain("into /srv/repos");
  });

  it("reads a null-rung member as access unknown, not as a rung refusal", async () => {
    backendMock.fleetMachines.mockResolvedValue([
      machine({ key: "inst-a", nickname: "box-a", grantRung: null, grantCeiling: null, memberExecEnabled: null }),
    ]);
    useStore.setState({ state: backendState(), copyProjectDialog: { projectCwd: "/work/app", name: "App" } });
    render();
    await act(async () => {});
    const row = document.body.querySelector('[data-machine="inst-a"]')!.closest("li")!;
    expect(row.textContent).toContain("access unknown");
    expect(row.textContent).not.toContain("needs the Manage projects rung");
    expect(row.querySelector("[data-request-access]")).toBeNull();
  });
});
