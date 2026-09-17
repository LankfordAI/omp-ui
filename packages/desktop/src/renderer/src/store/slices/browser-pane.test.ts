// Browser pane slice tests (issue #519, U10 store rows).
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserPaneState } from "@omp-ui/core/browser-pane";
import type { ImageAttachment } from "@omp-ui/core/types";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

const pane = () => h.useStore.getState().rpc[h.TAB]!.browserPane;

function paneState(agent: BrowserPaneState["agent"], patch: Partial<BrowserPaneState> = {}): BrowserPaneState {
  return {
    url: "https://example.test/",
    title: "Example",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    alive: true,
    agent,
    ...patch,
  };
}

const image: ImageAttachment = { type: "image", data: "AAAA", mimeType: "image/jpeg" };

describe("handleBrowserPaneState (#530 auto-open)", () => {
  it("opens a closed pane when the agent first attaches, and only then", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });

    // No state observed yet: the first push already carries an attached agent.
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("attached"));
    expect(pane().open).toBe(true);
    expect(pane().state?.agent).toBe("attached");
    await h.flushMicrotasks();
    expect(h.mockBackend.browserPaneEnsure).toHaveBeenCalledWith(h.TAB);

    // The user closes it; the agent going from attached to acting is not an edge.
    h.useStore.getState().closeBrowserPane(h.TAB);
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("acting"));
    expect(pane().open).toBe(false);
    expect(pane().state?.agent).toBe("acting");

    // Neither is a page load while the agent stays attached.
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("attached", { loading: true }));
    expect(pane().open).toBe(false);

    // Detach, then reattach: a fresh edge reopens it.
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("detached"));
    expect(pane().open).toBe(false);
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("attached"));
    expect(pane().open).toBe(true);
  });

  it("leaves an already open pane alone and never touches fullscreen", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          browserPane: { ...rpcTabState().browserPane, open: true, fullscreen: true },
        }),
      },
    });
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("attached"));
    expect(pane()).toMatchObject({ open: true, fullscreen: true, state: { agent: "attached" } });
    expect(h.mockBackend.browserPaneEnsure).not.toHaveBeenCalled();
  });

  it("drops availability when the page is destroyed so a mounted pane re-asks main", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          browserPane: { ...rpcTabState().browserPane, open: true, ensure: "available" },
        }),
      },
    });
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("detached", { alive: false }));
    expect(pane()).toMatchObject({ ensure: "idle", state: { alive: false } });

    // An answer still in flight, or one that already said no, is left to settle on its own.
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("detached"));
    expect(pane().ensure).toBe("idle");
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ browserPane: { ...rpcTabState().browserPane, ensure: "pending" } }) },
    });
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("detached", { alive: false }));
    expect(pane().ensure).toBe("pending");
  });
});

describe("session-scoped pane visibility (#556)", () => {
  /** Drives isCompactShell(): the stub window has no matchMedia otherwise. */
  const withCompactShell = (compact: boolean): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: compact,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  };
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });
  it("closes the pane when another view's close arrives on the state push", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          browserPane: { ...rpcTabState().browserPane, open: true },
        }),
      },
    });
    h.useStore.getState().handleBrowserPaneState(
      h.TAB,
      paneState("detached", { open: false }),
    );
    expect(pane().open).toBe(false);
  });

  it("keeps the local posture when the host sends no open field (version skew)", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          browserPane: { ...rpcTabState().browserPane, open: true },
        }),
      },
    });
    h.useStore.getState().handleBrowserPaneState(h.TAB, paneState("attached"));
    expect(pane().open).toBe(true);
  });

  it("surfaces the sheet when the open arrives on the tab in view", () => {
    withCompactShell(true);
    h.useStore.setState({
      activeTabId: h.TAB,
      compactSurface: null,
      rpc: { [h.TAB]: rpcTabState() },
    });
    h.useStore.getState().handleBrowserPaneState(
      h.TAB,
      paneState("detached", { open: true }),
    );
    expect(h.useStore.getState().compactSurface).toBe("browser-pane");
  });

  it("takes the sheet down when a close arrives on the tab in view", () => {
    withCompactShell(true);
    h.useStore.setState({
      activeTabId: h.TAB,
      compactSurface: "browser-pane",
      rpc: {
        [h.TAB]: rpcTabState({
          browserPane: { ...rpcTabState().browserPane, open: true },
        }),
      },
    });
    h.useStore.getState().handleBrowserPaneState(
      h.TAB,
      paneState("detached", { open: false }),
    );
    expect(h.useStore.getState().compactSurface).toBeNull();
  });

  it("publishes the posture on local open and close", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().openBrowserPane(h.TAB);
    expect(h.mockBackend.browserPaneSetOpen).toHaveBeenLastCalledWith(h.TAB, true);
    h.useStore.getState().closeBrowserPane(h.TAB);
    expect(h.mockBackend.browserPaneSetOpen).toHaveBeenLastCalledWith(h.TAB, false);
  });

  it("never lets a background tab claim the compact surface (#549)", () => {
    withCompactShell(true);
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB }), tabInfo({ tabId: "tab-other" })],
      activeTabId: "tab-other",
      compactSurface: null,
      rpc: {
        [h.TAB]: rpcTabState(),
        "tab-other": rpcTabState(),
      },
    });
    h.useStore.getState().handleBrowserPaneState(
      h.TAB,
      paneState("detached", { open: true }),
    );
    // The posture is adopted; the sheet does not pop over the active tab.
    expect(pane().open).toBe(true);
    expect(h.useStore.getState().compactSurface).toBeNull();
  });
});


describe("bootRpcTab carry-over (#528)", () => {
  it("keeps open and fullscreen across a reboot but forgets the dead process's answer", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [h.TAB]: rpcTabState({
          browserPane: {
            open: true,
            fullscreen: true,
            ensure: "available",
            unavailableReason: null,
            state: paneState("attached"),
            frame: { width: 1280, height: 800, dsf: 1 },
          },
        }),
      },
    });

    await h.driveBoot(h.TAB);

    expect(pane()).toEqual({
      open: true,
      fullscreen: true,
      ensure: "idle",
      unavailableReason: null,
      state: null,
      frame: { width: 1280, height: 800, dsf: 1 },
    });
  });
});

describe("composer queue", () => {
  it("accumulates attachments and drains exactly once", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    const s = h.useStore.getState();
    expect(s.drainComposerQueue(h.TAB)).toBeNull();

    s.queueComposerAttachment(h.TAB, image, "https://a.test/");
    s.queueComposerAttachment(h.TAB, { ...image, data: "BBBB" }, "");
    expect(h.useStore.getState().drainComposerQueue(h.TAB)).toEqual({
      images: [image, { ...image, data: "BBBB" }],
      text: ["https://a.test/"],
    });
    expect(h.useStore.getState().rpc[h.TAB]!.composerQueue).toBeUndefined();
    expect(h.useStore.getState().drainComposerQueue(h.TAB)).toBeNull();
  });
});

describe("ensureBrowserPane", () => {
  it("maps the ensure answers onto the pane's face", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    const ensure = h.useStore.getState().ensureBrowserPane;

    for (const status of ["missing-session", "not-live", "terminal"] as const) {
      h.mockBackend.browserPaneEnsure.mockResolvedValueOnce({ status });
      await ensure(h.TAB);
      expect(pane()).toMatchObject({ ensure: "not-live", unavailableReason: null });
    }

    h.mockBackend.browserPaneEnsure.mockResolvedValueOnce({
      status: "unavailable",
      reason: "create-failed",
    });
    await ensure(h.TAB);
    expect(pane()).toMatchObject({ ensure: "unavailable", unavailableReason: "create-failed" });

    h.mockBackend.browserPaneEnsure.mockResolvedValueOnce({
      status: "available",
      state: paneState("detached"),
      frame: { width: 1280, height: 800, dsf: 2 },
    });
    await ensure(h.TAB);
    expect(pane()).toMatchObject({
      ensure: "available",
      unavailableReason: null,
      state: { agent: "detached", url: "https://example.test/" },
      frame: { width: 1280, height: 800, dsf: 2 },
    });
  });

  it("drops the answer of an ensure a newer one has superseded", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    const first = h.deferred<{ status: "available"; state: BrowserPaneState; frame: null }>();
    h.mockBackend.browserPaneEnsure
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ status: "unavailable", reason: "no-frames" });

    const stale = h.useStore.getState().ensureBrowserPane(h.TAB);
    expect(pane().ensure).toBe("pending");
    await h.useStore.getState().ensureBrowserPane(h.TAB);
    expect(pane()).toMatchObject({ ensure: "unavailable", unavailableReason: "no-frames" });

    first.resolve({ status: "available", state: paneState("attached"), frame: null });
    await stale;
    expect(pane()).toMatchObject({ ensure: "unavailable", unavailableReason: "no-frames" });
  });
});
