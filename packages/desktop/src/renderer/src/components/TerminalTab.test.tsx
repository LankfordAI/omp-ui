// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTab } from "./TerminalTab";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const resumeDead = vi.fn();
  return {
    clearActiveDecoration: vi.fn(),
    clearDecorations: vi.fn(),
    clearSelection: vi.fn(),
    fit: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    focus: vi.fn(),
    hasClipboardImage: vi.fn(() => false),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    ptyPasteImage: vi.fn(),
    ptyResize: vi.fn(),
    ptyWrite: vi.fn(),
    readClipboardImages: vi.fn(),
    readImageFiles: vi.fn(),
    registerTermWriter: vi.fn(() => vi.fn()),
    resumeDead,
    // Mutable stub state: tests flip `searchOpen` and re-render.
    store: {
      exited: {} as Record<string, number>,
      searchOpen: {} as Record<string, boolean>,
      closeSearch: vi.fn(),
      resumeDead,
    },
  };
});

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
    refresh() {}
    dispose() {}
    focus() {
      mocks.focus();
    }
    clearSelection() {
      mocks.clearSelection();
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddonMock {
    fit = mocks.fit;
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class SearchAddonMock {
    findNext = mocks.findNext;
    findPrevious = mocks.findPrevious;
    clearDecorations = mocks.clearDecorations;
    clearActiveDecoration = mocks.clearActiveDecoration;
    onDidChangeResults = mocks.onDidChangeResults;
    dispose() {}
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
    ptyPasteImage: mocks.ptyPasteImage,
    ptyResize: mocks.ptyResize,
    ptyWrite: mocks.ptyWrite,
  },
}));
vi.mock("../lib/clipboard-image", () => ({
  hasClipboardImage: mocks.hasClipboardImage,
  readClipboardImages: mocks.readClipboardImages,
  readImageFiles: mocks.readImageFiles,
}));
const themeMock = vi.hoisted(() => ({
  id: "graphite",
  tokens: {
    "--color-copper": "#8a5a2b",
    "--color-copper-dim": "#6d4620",
    "--color-copper-wash": "#2a1d10",
  },
  term: {},
}));
vi.mock("../lib/themes", () => ({ useTheme: () => themeMock }));
vi.mock("../store", () => ({
  registerTermWriter: mocks.registerTermWriter,
  useStore: (
    selector: (state: {
      exited: Record<string, number>;
      searchOpen: Record<string, boolean>;
      closeSearch: (tabId: string) => void;
      resumeDead: () => void;
    }) => unknown,
  ) => selector(mocks.store),
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;


const TAB = "tab-terminal";
const IMAGE_ONE = { type: "image" as const, data: "one", mimeType: "image/png" };
const IMAGE_TWO = { type: "image" as const, data: "two", mimeType: "image/jpeg" };
let root: Root | null = null;

function renderTerminal(): HTMLInputElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<TerminalTab tabId={TAB} active />));
  return document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
}

function choose(input: HTMLInputElement, files: File[], value: string): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  Object.defineProperty(input, "value", { configurable: true, writable: true, value });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasClipboardImage.mockReturnValue(false);
  mocks.ptyPasteImage.mockResolvedValue(undefined);
  mocks.store.exited = {};
  mocks.store.searchOpen = {};
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("TerminalTab focus", () => {
  it("focuses the terminal when it is or becomes the active tab (issue #126)", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    // Mounted inactive: nothing steals focus from the currently active surface.
    act(() => root!.render(<TerminalTab tabId={TAB} active={false} />));
    expect(mocks.focus).not.toHaveBeenCalled();

    // A fresh spawn is active in the same commit; the post-mount refit focuses
    // once the xterm instance exists, so the first keystrokes land in it.
    act(() => root!.render(<TerminalTab tabId={TAB} active />));
    expect(mocks.focus).toHaveBeenCalledTimes(1);

    // Re-surfacing a hidden terminal focuses again; the effect only refires on
    // the false→true flip, so a same-instance re-render adds no stale focus.
    act(() => root!.render(<TerminalTab tabId={TAB} active={false} />));
    act(() => root!.render(<TerminalTab tabId={TAB} active />));
    expect(mocks.focus).toHaveBeenCalledTimes(2);
  });
});

describe("TerminalTab attachment picker", () => {
  it("delivers selected images serially in order and accepts the same file again", async () => {
    let releaseFirst!: () => void;
    const firstTransport = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.ptyPasteImage.mockImplementationOnce(() => firstTransport);
    mocks.readImageFiles
      .mockResolvedValueOnce({ images: [IMAGE_ONE, IMAGE_TWO], rejected: [] })
      .mockResolvedValueOnce({ images: [IMAGE_ONE], rejected: [] });

    const input = renderTerminal();
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    const openPicker = vi.spyOn(input, "click");
    act(() => {
      const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "attach images",
      )!;
      button.click();
    });
    expect(openPicker).toHaveBeenCalledOnce();

    const first = new File(["one"], "one.png", { type: "image/png" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });
    await act(async () => {
      choose(input, [first, second], "first-selection");
      await Promise.resolve();
    });

    expect(input.value).toBe("");
    expect(mocks.readImageFiles).toHaveBeenNthCalledWith(1, [first, second]);
    expect(mocks.ptyPasteImage).toHaveBeenCalledTimes(1);
    expect(mocks.ptyPasteImage).toHaveBeenNthCalledWith(1, TAB, IMAGE_ONE);

    await act(async () => {
      releaseFirst();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.ptyPasteImage).toHaveBeenCalledTimes(2);
    expect(mocks.ptyPasteImage).toHaveBeenNthCalledWith(2, TAB, IMAGE_TWO);

    await act(async () => {
      choose(input, [first], "same-file-selection");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input.value).toBe("");
    expect(mocks.readImageFiles).toHaveBeenNthCalledWith(2, [first]);
    expect(mocks.ptyPasteImage).toHaveBeenNthCalledWith(3, TAB, IMAGE_ONE);
  });

  it("surfaces a picker rejection without invoking image transport", async () => {
    mocks.readImageFiles.mockResolvedValueOnce({
      images: [],
      rejected: ["broken.png could not be read"],
    });
    const input = renderTerminal();
    const broken = new File(["broken"], "broken.png", { type: "image/png" });

    await act(async () => {
      choose(input, [broken], "rejected-selection");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(input.value).toBe("");
    expect(document.body.textContent).toContain("broken.png could not be read");
    expect(mocks.ptyPasteImage).not.toHaveBeenCalled();
  });
});

describe("TerminalTab find (issue #270)", () => {
  function typeFindQuery(text: string): void {
    const input = document.body.querySelector<HTMLInputElement>(".find-bar-input")!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setValue.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("shows the find bar only while the store flag is set", () => {
    renderTerminal();
    expect(document.body.querySelector(".find-bar")).toBeNull();

    act(() => {
      mocks.store.searchOpen[TAB] = true;
      root!.render(<TerminalTab tabId={TAB} active />);
    });
    const bar = document.body.querySelector(".find-bar");
    expect(bar).not.toBeNull();
    expect(bar!.querySelector(".find-bar-input")).not.toBeNull();
  });

  it("searches the terminal with theme-drawn decorations as the query is typed", () => {
    renderTerminal();
    act(() => {
      mocks.store.searchOpen[TAB] = true;
      root!.render(<TerminalTab tabId={TAB} active />);
    });
    expect(mocks.findNext).not.toHaveBeenCalled();

    typeFindQuery("hello");
    expect(mocks.findNext).toHaveBeenCalledTimes(1);
    expect(mocks.findNext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        caseSensitive: false,
        decorations: {
          matchBackground: "#2a1d10",
          matchBorder: "#6d4620",
          matchOverviewRuler: "#8a5a2b",
          activeMatchBackground: "#6d4620",
          activeMatchBorder: "#8a5a2b",
          activeMatchColorOverviewRuler: "#6d4620",
        },
      }),
    );
  });

  it("clears the search and refocuses the terminal when the bar closes", () => {
    renderTerminal();
    act(() => {
      mocks.store.searchOpen[TAB] = true;
      root!.render(<TerminalTab tabId={TAB} active />);
    });
    typeFindQuery("abc");
    expect(mocks.findNext).toHaveBeenCalled();

    mocks.clearDecorations.mockClear();
    mocks.clearActiveDecoration.mockClear();
    mocks.clearSelection.mockClear();
    mocks.focus.mockClear();
    act(() => {
      mocks.store.searchOpen[TAB] = false;
      root!.render(<TerminalTab tabId={TAB} active />);
    });
    expect(mocks.clearDecorations).toHaveBeenCalled();
    expect(mocks.clearActiveDecoration).toHaveBeenCalled();
    expect(mocks.clearSelection).toHaveBeenCalled();
    expect(mocks.focus).toHaveBeenCalled();
    expect(document.body.querySelector(".find-bar")).toBeNull();
  });
});
