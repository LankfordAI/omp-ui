// Device pane domain (issue #1006): the renderer's posture on each tab's
// Android emulator, the ensure handshake with main, bind/boot actions, and the
// state pushes that carry the agent auto-open. The device pane and the browser
// pane share the split slot, so opening one closes the other.
import type { DevicePaneEnsureResult, DevicePaneState } from "@omp-ui/core/device-pane";
import { backend } from "../../backend";
import { isCompactShell } from "../../lib/responsive";
import type { GetState, SetState, StoreMachinery } from "./shared";
import type { DevicePaneView, UiStore } from "../types";

export type DevicePaneSlice = Pick<
  UiStore,
  | "openDevicePane"
  | "closeDevicePane"
  | "toggleDevicePane"
  | "setDevicePaneFullscreen"
  | "ensureDevicePane"
  | "actDevicePane"
  | "handleDevicePaneState"
  | "noteDevicePaneFrame"
>;

/** A tab that has never shown its device pane: closed, nothing asked of main. */
export function freshDevicePaneView(): DevicePaneView {
  return {
    open: false,
    fullscreen: false,
    ensure: "idle",
    state: null,
    inventory: null,
    frame: null,
  };
}

/** Global monotonic ensure generations, as in the browser pane slice. */
let nextEnsureGeneration = 0;

export function createDevicePaneSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
): DevicePaneSlice {
  const patchPane = (tabId: string, patch: Partial<DevicePaneView>): void => {
    set((s) => {
      const tab = s.rpc[tabId];
      if (!tab) return s;
      return {
        rpc: { ...s.rpc, [tabId]: { ...tab, devicePane: { ...tab.devicePane, ...patch } } },
      };
    });
  };

  const ensureDevicePane = async (tabId: string): Promise<void> => {
    if (get().rpc[tabId] === undefined) return;
    const generation = ++nextEnsureGeneration;
    m.runtime(tabId);
    m.patchRuntime(tabId, { devicePaneEnsureGeneration: generation });
    patchPane(tabId, { ensure: "pending" });
    let result: DevicePaneEnsureResult;
    try {
      result = await backend.devicePaneEnsure(tabId);
    } catch (err) {
      console.warn("[device-pane] devicePaneEnsure failed:", err);
      if (m.runtime(tabId).devicePaneEnsureGeneration === generation)
        patchPane(tabId, { ensure: "not-live" });
      return;
    }
    if (
      get().rpc[tabId] === undefined ||
      m.runtime(tabId).devicePaneEnsureGeneration !== generation
    )
      return;
    switch (result.status) {
      case "available":
        patchPane(tabId, {
          ensure: "available",
          state: result.state,
          inventory: result.inventory,
        });
        return;
      case "missing-session":
      case "not-live":
      case "terminal":
        patchPane(tabId, { ensure: "not-live" });
        return;
    }
  };

  const openDevicePane = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (tab === undefined) return;
    if (tab.browserPane.open) get().closeBrowserPane(tabId);
    patchPane(tabId, { open: true });
    if (isCompactShell()) get().showCompactSurface("device-pane");
    backend.devicePaneSetOpen(tabId, true);
    void ensureDevicePane(tabId);
  };

  const closeDevicePane = (tabId: string): void => {
    patchPane(tabId, { open: false, fullscreen: false });
    if (isCompactShell()) get().closeCompactSurface();
    backend.devicePaneSetOpen(tabId, false);
  };

  return {
    openDevicePane,
    closeDevicePane,
    ensureDevicePane,
    toggleDevicePane(tabId) {
      if (get().rpc[tabId]?.devicePane.open) closeDevicePane(tabId);
      else openDevicePane(tabId);
    },
    setDevicePaneFullscreen(tabId, on) {
      patchPane(tabId, { fullscreen: on });
    },
    async actDevicePane(tabId, action) {
      let state: DevicePaneState;
      try {
        state = await backend.devicePaneAct(tabId, action);
      } catch (err) {
        get().reportError(err);
        return;
      }
      patchPane(tabId, { state });
    },
    handleDevicePaneState(tabId, state) {
      const previous = get().rpc[tabId]?.devicePane;
      if (previous === undefined) return;
      patchPane(tabId, { state, open: state.open });
      const visible = get().activeTabId === tabId && isCompactShell();
      if (state.open && !previous.open) {
        // The agent auto-open (or another viewer's open): the split slot holds
        // one pane, and only the tab in view may claim the compact sheet.
        if (get().rpc[tabId]?.browserPane.open) get().closeBrowserPane(tabId);
        if (visible) get().showCompactSurface("device-pane");
      } else if (!state.open && previous.open && visible) {
        get().closeCompactSurface();
      }
    },
    noteDevicePaneFrame(tabId, header) {
      const frame = get().rpc[tabId]?.devicePane.frame;
      if (
        frame &&
        frame.width === header.width &&
        frame.height === header.height &&
        frame.dsf === header.dsf
      )
        return;
      patchPane(tabId, { frame: header });
    },
  };
}
