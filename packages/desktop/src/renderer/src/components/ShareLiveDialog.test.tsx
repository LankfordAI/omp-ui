// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabTabState } from "@omp-ui/core/collab";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  collabList: vi.fn(async () => []),
  collabShare: vi.fn(async () => {}),
  collabStop: vi.fn(async () => {}),
  collabLink: vi.fn<(tabId: string, view: boolean) => Promise<string>>(async () =>
    "https://my.omp.sh/room#key",
  ),
  onCollabChanged: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ShareLiveDialog } = await import("./ShareLiveDialog");

const TAB = "tab-live";

function state(patch: Partial<CollabTabState> = {}): CollabTabState {
  return {
    status: "full",
    generation: 3,
    participants: 1,
    relayConnected: true,
    inputRequired: false,
    ...patch,
  };
}

let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.collabLink.mockResolvedValue("https://my.omp.sh/room#key");
  window.localStorage.setItem("omp-ui.sharePrivacySeen", "1");
  useStore.setState({
    tabs: [{ tabId: TAB, mode: "pty", projectCwd: "/p", hidden: false, instanceId: null }],
    collab: {},
    shareLiveTab: TAB,
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
  // Async act flushes the mount-time link fetches.
  await act(async () => {
    root!.render(<ShareLiveDialog tabId={TAB} />);
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

describe("ShareLiveDialog", () => {
  it("a native tab reads as unavailable with no switch", async () => {
    useStore.setState({
      tabs: [{ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null }],
    });
    await render();
    expect(text()).toContain("native sessions");
    expect(text()).not.toContain("start sharing");
  });

  it("an off terminal tab starts full access by default", async () => {
    await render();
    const start = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("start sharing"),
    )!;
    await act(async () => start.click());
    expect(backendMock.collabShare).toHaveBeenCalledWith(TAB, "full");
  });

  it("a view-only choice writes /collab view through the backend", async () => {
    await render();
    const viewOption = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "view-only",
    )!;
    await act(async () => viewOption.click());
    const start = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("start sharing"),
    )!;
    await act(async () => start.click());
    expect(backendMock.collabShare).toHaveBeenCalledWith(TAB, "view");
  });

  it("a full host shows both links and the stop control", async () => {
    useStore.setState({ collab: { [TAB]: { kind: "sharing", state: state() } } });
    await render();
    await act(async () => {});
    expect(text()).toContain("control link");
    expect(text()).toContain("view-only link");
    expect(backendMock.collabLink).toHaveBeenCalledWith(TAB, false);
    expect(backendMock.collabLink).toHaveBeenCalledWith(TAB, true);
    expect(text()).toContain("1 guest(s)");
    const stop = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("stop sharing"),
    )!;
    await act(async () => stop.click());
    expect(backendMock.collabStop).toHaveBeenCalledWith(TAB);
  });

  it("a view-only host fetches its one read-only link and flags the offline relay", async () => {
    useStore.setState({
      collab: {
        [TAB]: { kind: "sharing", state: state({ status: "view", relayConnected: false }) },
      },
    });
    // omp refuses a control link for a view-only host; mirror that so a
    // wrong flag cannot hide behind an all-success mock.
    backendMock.collabLink.mockImplementation((_tabId: string, view: boolean) =>
      view
        ? Promise.resolve("https://my.omp.sh/room#key")
        : Promise.reject(new Error("host does not publish control access")),
    );
    await render();
    await act(async () => {});
    expect(backendMock.collabLink).toHaveBeenCalledTimes(1);
    expect(backendMock.collabLink).toHaveBeenCalledWith(TAB, true);
    expect(text()).toContain("view-only link");
    expect(text()).not.toContain("control link");
    expect(text()).toContain("relay offline");
  });

  it("a refused link fetch degrades to no link, not an error dialog", async () => {
    useStore.setState({ collab: { [TAB]: { kind: "sharing", state: state() } } });
    backendMock.collabLink.mockRejectedValue(new Error("no active Collab host matches 7"));
    await render();
    await act(async () => {});
    expect(text()).not.toContain("control link");
  });

  it("a generation rotation re-fetches the links", async () => {
    useStore.setState({ collab: { [TAB]: { kind: "sharing", state: state() } } });
    await render();
    await act(async () => {});
    expect(backendMock.collabLink).toHaveBeenCalledTimes(2);
    useStore.setState({
      collab: { [TAB]: { kind: "sharing", state: state({ generation: 4 }) } },
    });
    await act(async () => {});
    expect(backendMock.collabLink).toHaveBeenCalledTimes(4);
  });
});
