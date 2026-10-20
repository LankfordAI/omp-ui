// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetHostProject, FleetMachine } from "@omp-ui/core/fleet";
import { backendState } from "../../test/fixtures";

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
    },
  };
}

let machines: FleetMachine[] = [];
const backendMock = {
  fleetMachines: vi.fn(async () => machines),
  fleetDispatch: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports: store.ts → ./backend reads window.ompBackend at module load.
const { useStore } = await import("../../store");
const { FleetDispatchDialog } = await import("./FleetDispatchDialog");

let root: Root | null = null;

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function render(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<FleetDispatchDialog />);
    await flushMicrotasks();
  });
}

const button = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  expect(found, text).toBeDefined();
  return found!;
};

const click = async (target: HTMLElement): Promise<void> => {
  await act(async () => {
    target.click();
    await flushMicrotasks();
  });
};

beforeEach(() => {
  useStore.setState({
    state: backendState(),
    tabs: [],
    activeTabId: null,
    fleetDispatchOpen: true,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("FleetDispatchDialog", () => {
  it("disables Project checkout once one machine runs more than one copy", async () => {
    machines = [machine("local", null, [project("/p", "aaa")])];
    await render();
    await click(button("Choose machines"));
    expect(button("Project checkout").disabled).toBe(false);

    await click(document.body.querySelector<HTMLButtonElement>('button[aria-label="One more copy on This computer"]')!);
    expect(button("Project checkout").disabled).toBe(true);
    expect(button("New worktree").getAttribute("aria-pressed")).toBe("true");
  });

  it("warns when the selected machines are on different commits", async () => {
    machines = [machine("local", null, [project("/p", "aaa")]), machine("inst-1", "box-a", [project("/remote/p", "bbb")])];
    await render();
    const notice = "Machines are on different commits; each worktree starts from its own checkout.";
    // Auto considers every machine with the repository.
    expect(document.body.textContent).toContain(notice);

    // Choose: only the reference machine starts checked — one commit, no notice.
    await click(button("Choose machines"));
    expect(document.body.textContent).not.toContain(notice);
    const boxA = [...document.body.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("box-a"));
    await click(boxA!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(document.body.textContent).toContain(notice);
  });
});
