// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState } from "@omp-ui/core/types";
import { t } from "../lib/i18n";
import { backendState, remoteInstance } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ electron: false }));

vi.mock("../lib/platform", () => ({
  get IS_ELECTRON() {
    return mocks.electron;
  },
  IS_MAC: false,
  IS_WINDOWS: false,
}));

Object.assign(window, { ompBackend: {} });
// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { OpenInObsidianButton } = await import("./OpenInObsidianButton");

const realOpenVault = useStore.getState().openVault;
const openVault = vi.fn<(name: string, file: string | null) => Promise<void>>(async () => {});
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});

const TAB = "vault-remote-tab";
const INSTANCE = "inst-remote";

/** BackendState where TAB's session is owned by a joined remote instance (issue #416). */
function remoteOwnedState(): BackendState {
  return backendState({
    remoteInstances: [
      remoteInstance({
        id: INSTANCE,
        status: "joined",
        projects: [
          {
            project: {
              path: "/remote/p",
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
            },
            sessions: [
              {
                tabId: TAB,
                sessionId: "s",
                lineageDir: "lineage",
                projectCwd: "/remote/p",
                launchedAt: "t",
                mode: "rpc-ui",
                worktree: null,
                planImplementationSource: null,
                experiment: null,
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
                cachedTitle: "Remote session",
                cachedModified: "t",
                title: "Remote session",
                status: "complete",
                live: "live",
                pendingPlan: null,
                planSettle: null,
                streamStalled: false,
              },
            ],
          },
        ],
      }),
    ],
  });
}

let root: Root | null = null;

function render(props: { tabId?: string; uriHandler?: boolean } = {}): HTMLButtonElement {
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
    useStore.setState({ state: remoteOwnedState() });
    const button = render({ tabId: TAB });

    await click(button);

    expect(openVault).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("obsidian://open?vault=Notes&file=omp-ui%2FFoo");
  });
});
