// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpSettingEntry, OmpSettingsSnapshot } from "@omp-ui/core/types";
import { backendState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const emptyOmpSettings: OmpSettingsSnapshot = {
  entries: [],
  agentDir: null,
  projectConfigPath: null,
  error: null,
};

const backendMock = {
  readOmpSettings: vi.fn(async (): Promise<OmpSettingsSnapshot> => emptyOmpSettings),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ShareSessionDialog } = await import("./ShareSessionDialog");

const TAB = "tab-share";

function entry(
  key: string,
  value: OmpSettingEntry["value"],
  type: OmpSettingEntry["type"],
): OmpSettingEntry {
  return {
    key,
    type,
    description: "",
    value,
    globalValue: undefined,
    options: null,
    layer: "default",
  };
}

let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.readOmpSettings.mockResolvedValue(emptyOmpSettings);
  useStore.setState({
    state: backendState({
      projects: [
        {
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
          },
          sessions: [
            {
              tabId: TAB,
              sessionId: "s",
              lineageDir: "omp-ui--p--s",
              projectCwd: "/p",
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
              cachedTitle: null,
              cachedModified: null,
              title: "T",
              status: null,
              live: "live",
              pendingPlan: null,
              planSettle: null,
              streamStalled: false,
            },
          ],
        },
      ],
    }),
    tabs: [
      { tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null },
    ],
    shareConfirmTab: TAB,
    confirmSharePrivacy: vi.fn(async () => {}),
    cancelSharePrivacy: vi.fn(),
  });
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

async function render(): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // Async act flushes the mount-time readOmpSettings promise.
  await act(async () => {
    root!.render(<ShareSessionDialog tabId={TAB} />);
  });
}

describe("ShareSessionDialog", () => {
  it("reads the share settings at the session's working tree", async () => {
    await render();
    expect(backendMock.readOmpSettings).toHaveBeenCalledWith("/p");
    expect(document.body.textContent).toContain("Share this session?");
    expect(document.body.textContent).toContain(
      "the snapshot is sealed with a fresh key before upload",
    );
  });

  it("renders the gist wording when share.store resolves to gist", async () => {
    backendMock.readOmpSettings.mockResolvedValue({
      ...emptyOmpSettings,
      entries: [entry("share.store", "gist", "enum")],
    });
    await render();
    expect(document.body.textContent).toContain(
      "upload goes to a secret GitHub gist when gh is authenticated, else the share server",
    );
  });

  it("renders the server wording with the effective URL for the blob store", async () => {
    backendMock.readOmpSettings.mockResolvedValue({
      ...emptyOmpSettings,
      entries: [
        entry("share.store", "blob", "enum"),
        entry("share.serverUrl", "https://share.example/s", "string"),
        entry("share.redactSecrets", false, "boolean"),
      ],
    });
    await render();
    expect(document.body.textContent).toContain(
      "upload goes to the share server at https://share.example/s",
    );
    expect(document.body.textContent).toContain(
      "secrets are NOT redacted (share.redactSecrets: off)",
    );
  });

  it("shows redaction on when the effective flag is on", async () => {
    backendMock.readOmpSettings.mockResolvedValue({
      ...emptyOmpSettings,
      entries: [entry("share.redactSecrets", true, "boolean")],
    });
    await render();
    expect(document.body.textContent).toContain(
      "secrets are redacted before upload (share.redactSecrets: on)",
    );
  });

  it("falls back to the static wording when the read errors", async () => {
    backendMock.readOmpSettings.mockResolvedValue({
      ...emptyOmpSettings,
      error: "omp binary not found",
    });
    await render();
    expect(document.body.textContent).toContain(
      "secrets are redacted by default",
    );
    expect(document.body.textContent).toContain(
      "upload goes to the share server, or a secret GitHub gist when gh is authenticated",
    );
  });

  it("confirms through the store action and cancels through it too", async () => {
    await render();
    const confirm = vi.mocked(useStore.getState().confirmSharePrivacy);
    const cancel = vi.mocked(useStore.getState().cancelSharePrivacy);
    const shareButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "share",
    )!;
    act(() => shareButton.click());
    expect(confirm).toHaveBeenCalledWith(TAB);
    const cancelButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "cancel",
    )!;
    act(() => cancelButton.click());
    expect(cancel).toHaveBeenCalled();
  });

  it("reads nothing for a remote-instance tab", async () => {
    useStore.setState((s) => ({
      tabs: s.tabs.map((tab) => ({ ...tab, instanceId: "inst-1" })),
    }));
    await render();
    expect(backendMock.readOmpSettings).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "upload goes to the share server, or a secret GitHub gist when gh is authenticated",
    );
  });
});
