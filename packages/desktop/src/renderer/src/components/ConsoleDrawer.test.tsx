// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleDrawer } from "./ConsoleDrawer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  TAB: "tab-console",
  clearShellExited: vi.fn(),
  consoleOpen: true,
  IS_WINDOWS: false,
  shellWrite: vi.fn(),
  toggleConsole: vi.fn(),
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
vi.mock("../lib/platform", () => ({
  IS_MAC: false,
  IS_ELECTRON: false,
  // Getter so a test can flip the platform between renders/clicks.
  get IS_WINDOWS() {
    return mocks.IS_WINDOWS;
  },
}));
vi.mock("../backend", () => ({
  backend: {
    shellKill: vi.fn(),
    shellWrite: mocks.shellWrite,
  },
}));
vi.mock("../lib/themes", () => ({ useTheme: () => ({ term: {} }) }));
vi.mock("../store", () => ({
  registerShellWriter: () => vi.fn(),
  useStore: (
    selector: (state: {
      consoleOpen: Record<string, boolean>;
      tabs: unknown[];
      shellExited: Record<string, number>;
      clearShellExited: () => void;
      toggleConsole: (tabId: string) => void;
    }) => unknown,
  ) =>
    selector({
      consoleOpen: { [mocks.TAB]: mocks.consoleOpen },
      tabs: [],
      shellExited: {},
      clearShellExited: mocks.clearShellExited,
      toggleConsole: mocks.toggleConsole,
    }),
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

let root: Root | null = null;

function renderDrawer(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ConsoleDrawer tabId={mocks.TAB} />));
}

const clearButton = () => document.querySelector<HTMLButtonElement>('button[title="clear the terminal"]');

beforeEach(() => {
  mocks.consoleOpen = true;
  mocks.IS_WINDOWS = false;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("ConsoleDrawer clear control", () => {
  it("sends `clear` to the shell on Unix", () => {
    renderDrawer();
    act(() => clearButton()!.click());
    expect(mocks.shellWrite).toHaveBeenCalledWith(mocks.TAB, "clear\n");
  });

  it("sends `cls` to the shell on Windows, where `clear` is unsupported", () => {
    mocks.IS_WINDOWS = true;
    renderDrawer();
    act(() => clearButton()!.click());
    expect(mocks.shellWrite).toHaveBeenCalledWith(mocks.TAB, "cls\n");
  });
});