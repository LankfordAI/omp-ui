// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellDrawer } from "./ShellDrawer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Handoff = { line: string; key: number; phase: "running" | "exited" };

// ConsoleDrawer.test.tsx's store mock hands the selector a frozen object; these
// tests restage a handoff between renders, so the state lives in a mutable
// module-level record that tests mutate inside `act`.
const mocks = vi.hoisted(() => ({
  TAB: "tab-shell",
  CWD: "/tmp/project",
  shellSpawn: vi.fn(async (): Promise<void> => {}),
  shellResize: vi.fn(),
  shellWrite: vi.fn(),
  shellKill: vi.fn(),
  clearShellExited: vi.fn(),
  sendTuiHandoff: vi.fn(),
  dismissTuiHandoff: vi.fn(),
  restartSession: vi.fn(async (): Promise<boolean> => true),
  tuiHandoff: {} as Record<string, Handoff>,
  shellExited: {} as Record<string, number>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class TerminalMock {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    open() {}
    loadAddon() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddonMock {
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class WebLinksAddonMock {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddonMock {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../backend", () => ({
  backend: {
    shellSpawn: mocks.shellSpawn,
    shellResize: mocks.shellResize,
    shellWrite: mocks.shellWrite,
    shellKill: mocks.shellKill,
  },
}));
vi.mock("../lib/themes", () => ({ useTheme: () => ({ term: {} }) }));
vi.mock("../store", () => ({
  findRecord: () => undefined,
  registerShellWriter: () => vi.fn(),
  // A defined cwd is what lets the spawn effect past its guard.
  sessionCwd: () => mocks.CWD,
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      state: {},
      tabs: [],
      shellExited: mocks.shellExited,
      clearShellExited: mocks.clearShellExited,
      tuiHandoff: mocks.tuiHandoff,
      sendTuiHandoff: mocks.sendTuiHandoff,
      dismissTuiHandoff: mocks.dismissTuiHandoff,
      restartSession: mocks.restartSession,
    }),
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

let root: Root | null = null;

/** Mounts on first call, re-renders into the same root afterwards — the drawer
 *  must stay mounted across a `visible` flip for handoffKeyRef to matter. */
async function render(visible: boolean): Promise<void> {
  if (!root) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<ShellDrawer tabId={mocks.TAB} visible={visible} />);
  });
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

const spawnPrograms = (): unknown[] => mocks.shellSpawn.mock.calls.map((c) => (c as unknown[])[4]);

beforeEach(() => {
  mocks.tuiHandoff = {};
  mocks.shellExited = {};
  mocks.shellSpawn.mockResolvedValue(undefined);
  mocks.restartSession.mockResolvedValue(true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("ShellDrawer handoff respawn", () => {
  it("respawns omp-tui when a dismissed handoff restages under a recycled key", async () => {
    mocks.tuiHandoff = { [mocks.TAB]: { line: "/mcp reauth ctx", key: 1, phase: "running" } };
    await render(true);

    expect(mocks.shellSpawn).toHaveBeenCalledTimes(1);
    expect(mocks.shellSpawn).toHaveBeenLastCalledWith(mocks.TAB, mocks.CWD, 80, 24, "omp-tui");

    // Drawer closed, handoff dismissed: the record goes, so the store's next
    // `key` restarts numbering at 1.
    mocks.tuiHandoff = {};
    await render(false);

    // Restaged at the recycled key while the drawer reopens.
    mocks.tuiHandoff = { [mocks.TAB]: { line: "/mcp reauth ctx", key: 1, phase: "running" } };
    await render(true);

    expect(mocks.shellSpawn).toHaveBeenCalledTimes(2);
    expect(spawnPrograms()).toEqual(["omp-tui", "omp-tui"]);
  });
});

describe("ShellDrawer restart-session banner", () => {
  beforeEach(() => {
    mocks.tuiHandoff = { [mocks.TAB]: { line: "/mcp reauth ctx", key: 1, phase: "exited" } };
  });

  it("keeps the banner when restartSession resolves false", async () => {
    mocks.restartSession.mockResolvedValue(false);
    await render(true);

    await act(async () => buttonByText("restart session")!.click());

    expect(mocks.restartSession).toHaveBeenCalledWith(mocks.TAB);
    expect(mocks.dismissTuiHandoff).not.toHaveBeenCalled();
  });

  it("retires the banner when restartSession resolves true", async () => {
    mocks.restartSession.mockResolvedValue(true);
    await render(true);

    await act(async () => buttonByText("restart session")!.click());

    expect(mocks.dismissTuiHandoff).toHaveBeenCalledWith(mocks.TAB);
  });
});
