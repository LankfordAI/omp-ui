// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RendererBackend from "../backend";
import { t } from "../lib/i18n";
import { backendState, remoteOwnedState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ electron: false, webTransport: false }));

vi.mock("../lib/platform", () => ({
  get IS_ELECTRON() {
    return mocks.electron;
  },
  IS_MAC: false,
  IS_WINDOWS: false,
}));

vi.mock("../backend", async (importOriginal) => {
  const actual = await importOriginal<typeof RendererBackend>();
  return {
    ...actual,
    get desktopPaneMedia() {
      return mocks.webTransport ? null : actual.desktopPaneMedia;
    },
  };
});

Object.assign(window, { ompBackend: {} });
// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { OpenInObsidianButton } = await import("./OpenInObsidianButton");

const realOpenVault = useStore.getState().openVault;
const openVault = vi.fn<(name: string, file: string | null) => Promise<void>>(async () => {});
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});

const TAB = "vault-remote-tab";
const INSTANCE = "inst-remote";

let root: Root | null = null;

function render(props: { tabId?: string; uriHandler?: boolean; iconOnly?: boolean } = {}): HTMLButtonElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<OpenInObsidianButton vaultName="Notes" file="omp-ui/Foo.md" {...props} />));
  return document.body.querySelector("button")!;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.click());
}

beforeEach(() => {
  mocks.electron = false;
  mocks.webTransport = false;
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useStore.setState({ state: backendState(), openVault });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  useStore.setState({ openVault: realOpenVault });
  vi.useRealTimers();
});

describe("OpenInObsidianButton", () => {
  it("opens through main in Electron with a local owner", async () => {
    mocks.electron = true;
    const button = render();
    expect(button.title).toBe("");

    await click(button);

    expect(openVault).toHaveBeenCalledWith("Notes", "omp-ui/Foo.md");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies in an Electron-hosted browser pane: web transport, no preload (#782)", async () => {
    mocks.electron = true;
    mocks.webTransport = true;
    const button = render();
    expect(button.title).toBe(t("transcript.vault.copyTitle"));

    await click(button);

    expect(openVault).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("obsidian://open?vault=Notes&file=omp-ui%2FFoo");
  });

  it("copies when no obsidian:// handler is registered", async () => {
    mocks.electron = true;
    const button = render({ uriHandler: false });
    expect(button.title).toBe(t("transcript.vault.copyTitle"));

    await click(button);

    expect(openVault).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("obsidian://open?vault=Notes&file=omp-ui%2FFoo");
  });

  it("copies the basename-keyed link outside Electron and reverts the label after 2 s", async () => {
    vi.useFakeTimers();
    const button = render();
    expect(button.textContent).toBe(t("transcript.vault.openInObsidian"));

    await click(button);

    expect(openVault).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("obsidian://open?vault=Notes&file=omp-ui%2FFoo");
    expect(button.textContent).toBe(t("transcript.vault.linkCopied"));

    act(() => vi.advanceTimersByTime(1999));
    expect(button.textContent).toBe(t("transcript.vault.linkCopied"));
    act(() => vi.advanceTimersByTime(1));
    expect(button.textContent).toBe(t("transcript.vault.openInObsidian"));
  });

  it("copies for a tab owned by a joined remote instance", async () => {
    mocks.electron = true;
    useStore.setState({ state: remoteOwnedState(TAB, INSTANCE) });
    const button = render({ tabId: TAB });

    await click(button);

    expect(openVault).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("obsidian://open?vault=Notes&file=omp-ui%2FFoo");
  });

  it("the icon-only face copies and relabels to Link copied", async () => {
    const button = render({ iconOnly: true });

    await click(button);

    expect(writeText).toHaveBeenCalledWith("obsidian://open?vault=Notes&file=omp-ui%2FFoo");
    expect(button.getAttribute("aria-label")).toBe(t("transcript.vault.linkCopied"));
  });
});
