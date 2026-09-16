// Browser pane domain (issue #519, ADR-0029): the renderer's posture on each
// tab's shared page, the ensure handshake with main, the state pushes that
// drive the agent badge and the #530 auto-open, and the hand-back queue that
// feeds a page screenshot and URL into the composer.
import type { BrowserPaneEnsureResult } from "@omp-ui/core/browser-pane";
import { backend } from "../../backend";
import { isCompactShell } from "../../lib/responsive";
import type { GetState, SetState, StoreMachinery } from "./shared";
import type { BrowserPaneView, UiStore } from "../types";

export type BrowserPaneSlice = Pick<
  UiStore,
  | "openBrowserPane"
  | "closeBrowserPane"
  | "toggleBrowserPane"
  | "setBrowserPaneFullscreen"
  | "ensureBrowserPane"
  | "handleBrowserPaneState"
  | "noteBrowserPaneFrame"
  | "queueComposerAttachment"
  | "drainComposerQueue"
  | "acceptBrowserPaneOffer"
  | "declineBrowserPaneOffer"
>;

/** A tab that has never shown its pane: closed, split, nothing asked of main. */
export function freshBrowserPaneView(): BrowserPaneView {
  return {
    open: false,
    fullscreen: false,
    ensure: "idle",
    unavailableReason: null,
    state: null,
    frame: null,
    offers: [],
    offeredThisTurn: [],
    declinedOffers: [],
  };
}

/**
 * Ensure generations are global and monotonic — the `nextCompactionUsageGeneration`
 * idiom. The captured value lives in the tab runtime, so a reboot that discards
 * the runtime, or a later ensure for the same tab, makes an in-flight answer
 * fail its comparison and land nowhere.
 */
let nextEnsureGeneration = 0;

export function createBrowserPaneSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
): BrowserPaneSlice {
  const patchPane = (tabId: string, patch: Partial<BrowserPaneView>): void => {
    set((s) => {
      const tab = s.rpc[tabId];
      if (!tab) return s;
      return {
        rpc: { ...s.rpc, [tabId]: { ...tab, browserPane: { ...tab.browserPane, ...patch } } },
      };
    });
  };

  const ensureBrowserPane = async (tabId: string): Promise<void> => {
    if (get().rpc[tabId] === undefined) return;
    const generation = ++nextEnsureGeneration;
    // Take the runtime slot first: `patchRuntime` never invents an owner.
    m.runtime(tabId);
    m.patchRuntime(tabId, { browserPaneEnsureGeneration: generation });
    patchPane(tabId, { ensure: "pending" });
    let result: BrowserPaneEnsureResult;
    try {
      result = await backend.browserPaneEnsure(tabId);
    } catch (err) {
      // The transport failed (an unreachable instance, most likely): nothing
      // can be served for this session right now, which is what the not-live
      // face tells the user. The last frame stays on screen.
      console.warn("[browser-pane] browserPaneEnsure failed:", err);
      if (m.runtime(tabId).browserPaneEnsureGeneration === generation)
        patchPane(tabId, { ensure: "not-live" });
      return;
    }
    if (
      get().rpc[tabId] === undefined ||
      m.runtime(tabId).browserPaneEnsureGeneration !== generation
    )
      return;
    switch (result.status) {
      case "available":
        patchPane(tabId, {
          ensure: "available",
          unavailableReason: null,
          state: result.state,
          frame: result.frame,
        });
        return;
      case "unavailable":
        patchPane(tabId, { ensure: "unavailable", unavailableReason: result.reason });
        return;
      case "missing-session":
      case "not-live":
      case "terminal":
        patchPane(tabId, { ensure: "not-live", unavailableReason: null });
        return;
    }
  };

  const openBrowserPane = (tabId: string): void => {
    if (get().rpc[tabId] === undefined) return;
    patchPane(tabId, { open: true });
    if (isCompactShell()) get().showCompactSurface("browser-pane");
    void ensureBrowserPane(tabId);
  };

  const closeBrowserPane = (tabId: string): void => {
    patchPane(tabId, { open: false, fullscreen: false });
    if (isCompactShell()) get().closeCompactSurface();
  };

  return {
    openBrowserPane,
    closeBrowserPane,
    ensureBrowserPane,
    toggleBrowserPane(tabId) {
      if (get().rpc[tabId]?.browserPane.open) closeBrowserPane(tabId);
      else openBrowserPane(tabId);
    },
    setBrowserPaneFullscreen(tabId, on) {
      patchPane(tabId, { fullscreen: on });
    },
    handleBrowserPaneState(tabId, state) {
      const previous = get().rpc[tabId]?.browserPane;
      if (previous === undefined) return;
      patchPane(tabId, { state });
      // The #530 auto-open: the agent just connected to a pane the user is not
      // looking at. A tab with no observed state has, by definition, had no
      // agent attached yet. Any later push — a page load, acting ↔ attached —
      // leaves a deliberately closed pane closed.
      const wasDetached = (previous.state?.agent ?? "detached") === "detached";
      if (wasDetached && state.agent !== "detached" && !previous.open) {
        openBrowserPane(tabId);
      }
    },
    noteBrowserPaneFrame(tabId, header) {
      const frame = get().rpc[tabId]?.browserPane.frame;
      if (
        frame &&
        frame.width === header.width &&
        frame.height === header.height &&
        frame.dsf === header.dsf
      )
        return;
      patchPane(tabId, { frame: header });
    },
    queueComposerAttachment(tabId, image, text) {
      set((s) => {
        const tab = s.rpc[tabId];
        if (!tab) return s;
        const queue = tab.composerQueue ?? { images: [], text: [] };
        return {
          rpc: {
            ...s.rpc,
            [tabId]: {
              ...tab,
              composerQueue: {
                images: [...queue.images, image],
                text: text === "" ? queue.text : [...queue.text, text],
              },
            },
          },
        };
      });
    },
    drainComposerQueue(tabId) {
      const tab = get().rpc[tabId];
      const queue = tab?.composerQueue;
      if (tab === undefined || queue === undefined) return null;
      set((s) => {
        const current = s.rpc[tabId];
        if (!current) return s;
        return { rpc: { ...s.rpc, [tabId]: { ...current, composerQueue: undefined } } };
      });
      return queue;
    },
    acceptBrowserPaneOffer(tabId, url) {
      const pane = get().rpc[tabId]?.browserPane;
      if (pane === undefined) return;
      patchPane(tabId, { offers: pane.offers.filter((offer) => offer !== url) });
      openBrowserPane(tabId);
      backend.browserPaneNavigate(tabId, { action: "goto", url });
    },
    declineBrowserPaneOffer(tabId, url) {
      const pane = get().rpc[tabId]?.browserPane;
      if (pane === undefined) return;
      patchPane(tabId, {
        offers: pane.offers.filter((offer) => offer !== url),
        declinedOffers: pane.declinedOffers.includes(url)
          ? pane.declinedOffers
          : [...pane.declinedOffers, url],
      });
    },
  };
}
