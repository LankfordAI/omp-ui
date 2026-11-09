// Device pane domain (issue #1006): the renderer's posture on each tab's
// Android emulator, the ensure handshake with main, bind/boot actions, and the
// state pushes that carry the agent auto-open. The device pane and the browser
// pane share the split slot, so opening one closes the other.
import type {
  DevicePaneEnsureResult,
  DevicePaneFrameHeader,
  DevicePaneState,
} from "@omp-ui/core/device-pane";
import { backend } from "../../backend";
import { isCompactShell } from "../../lib/responsive";
import {
  peekTabRuntime,
  type GetState,
  type SetState,
  type StoreMachinery,
  type TabRuntime,
} from "./shared";
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
    streamGeneration: 0,
    ensure: "idle",
    state: null,
    inventory: null,
    frame: null,
  };
}

/** Ensures and actions share a fence: neither can roll back a newer request. */
let nextRequestGeneration = 0;
let nextInventoryGeneration = 0;

// Input/control locks do not invalidate already-current pixels. The pane gates
// input separately against its painted identity and the owner's input readiness.
function isCurrentFrame(state: DevicePaneState | null, header: DevicePaneFrameHeader): boolean {
  return state !== null && state.phase === "streaming" && state.screen === "active" &&
    state.bindingId === header.bindingId && state.geometryRevision === header.geometryRevision;
}

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

  const isCurrentRequest = (tabId: string, runtime: TabRuntime, generation: number): boolean =>
    get().rpc[tabId] !== undefined && peekTabRuntime(tabId) === runtime &&
    runtime.devicePaneRequestGeneration === generation;

  const reconcileInventory = async (tabId: string, bindingId: string): Promise<void> => {
    const runtime = peekTabRuntime(tabId);
    const pane = get().rpc[tabId]?.devicePane;
    if (runtime?.devicePaneProtocolVersion !== 2 || pane === undefined ||
      (pane.ensure !== "available" && pane.ensure !== "pending")) return;
    const generation = ++nextInventoryGeneration;
    runtime.devicePaneInventoryGeneration = generation;
    let result: DevicePaneEnsureResult;
    try {
      result = await backend.devicePaneEnsure(tabId);
    } catch {
      // Inventory details must not take a usable owner connection offline.
      return;
    }
    const current = get().rpc[tabId]?.devicePane;
    if (peekTabRuntime(tabId) !== runtime || runtime.devicePaneProtocolVersion !== 2 ||
      runtime.devicePaneInventoryGeneration !== generation || current === undefined ||
      (current.ensure !== "available" && current.ensure !== "pending") ||
      current.state?.bindingId !== bindingId || result.status !== "available") return;
    if (result.protocolVersion !== 2) {
      runtime.devicePaneProtocolVersion = undefined;
      runtime.devicePaneRequestGeneration = undefined;
      patchPane(tabId, {
        ensure: "update-required", state: null, inventory: null, frame: null,
      });
      return;
    }
    // This is an inventory read, never a state/stream handshake. In particular,
    // its returned snapshot cannot replace newer binding, geometry or input state.
    patchPane(tabId, { inventory: result.inventory });
  };

  const applyState = (tabId: string, state: DevicePaneState, selectionCompleted = false): void => {
    const pane = get().rpc[tabId]?.devicePane;
    if (pane === undefined) return;
    const invalidatesStream = pane.state?.bindingId !== state.bindingId ||
      pane.state?.geometryRevision !== state.geometryRevision ||
      pane.state?.phase !== state.phase || pane.state?.screen !== state.screen;
    patchPane(tabId, {
      state,
      streamGeneration: pane.streamGeneration + Number(invalidatesStream),
      frame: pane.ensure === "available" && pane.frame && isCurrentFrame(state, pane.frame)
        ? pane.frame : null,
    });
    const operation = pane.state?.operation?.kind;
    if ((selectionCompleted || operation === "create" || operation === "boot" || operation === "bind") &&
      state.phase === "streaming" && state.operation === null && state.actionError === null &&
      state.bindingId !== null) void reconcileInventory(tabId, state.bindingId);
  };

  const ensureDevicePane = async (tabId: string): Promise<void> => {
    const pane = get().rpc[tabId]?.devicePane;
    if (pane === undefined) return;
    const runtime = m.runtime(tabId);
    if (pane.ensure === "available") runtime.devicePaneProtocolVersion = 2;
    const generation = ++nextRequestGeneration;
    const inventoryGeneration = ++nextInventoryGeneration;
    const stateGeneration = runtime.devicePaneStateGeneration;
    m.patchRuntime(tabId, {
      devicePaneRequestGeneration: generation, devicePaneInventoryGeneration: inventoryGeneration,
    });
    // A reconnect must paint again, even if the owner reports the same geometry.
    patchPane(tabId, {
      ensure: "pending", frame: null, streamGeneration: pane.streamGeneration + 1,
    });
    let result: DevicePaneEnsureResult;
    try {
      result = await backend.devicePaneEnsure(tabId);
    } catch (err) {
      if (!isCurrentRequest(tabId, runtime, generation)) return;
      if (runtime.devicePaneStateGeneration !== stateGeneration &&
        runtime.devicePaneProtocolVersion === 2) {
        patchPane(tabId, { ensure: "available" });
        return;
      }
      runtime.devicePaneProtocolVersion = undefined;
      console.warn("[device-pane] devicePaneEnsure failed:", err);
      patchPane(tabId, { ensure: "not-live", frame: null });
      return;
    }
    if (!isCurrentRequest(tabId, runtime, generation)) return;
    switch (result.status) {
      case "available":
        if (result.protocolVersion !== 2) {
          runtime.devicePaneProtocolVersion = undefined;
          patchPane(tabId, {
            ensure: "update-required", state: null, inventory: null, frame: null,
          });
          return;
        }
        runtime.devicePaneProtocolVersion = 2;
        // Protocol/inventory are the handshake, not a state snapshot. A push
        // that won the race remains authoritative while the handshake settles.
        patchPane(tabId, {
          ensure: "available",
          ...(runtime.devicePaneInventoryGeneration === inventoryGeneration
            ? { inventory: result.inventory } : {}),
        });
        if (runtime.devicePaneStateGeneration === stateGeneration)
          applyState(tabId, result.state);
        return;
      case "missing-session":
      case "not-live":
      case "terminal":
        if (runtime.devicePaneStateGeneration !== stateGeneration &&
          runtime.devicePaneProtocolVersion === 2) {
          patchPane(tabId, { ensure: "available" });
          return;
        }
        runtime.devicePaneProtocolVersion = undefined;
        patchPane(tabId, { ensure: "not-live", frame: null });
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
      const pane = get().rpc[tabId]?.devicePane;
      if (pane === undefined || (pane.ensure !== "available" && pane.ensure !== "pending")) return;
      const runtime = m.runtime(tabId);
      if (pane.ensure === "available") runtime.devicePaneProtocolVersion = 2;
      if (runtime.devicePaneProtocolVersion !== 2) return;
      const generation = ++nextRequestGeneration;
      const stateGeneration = runtime.devicePaneStateGeneration;
      m.patchRuntime(tabId, { devicePaneRequestGeneration: generation });
      // Any owner action may reconnect or change geometry; the next paint,
      // rather than an old same-size bitmap, must re-establish input readiness.
      patchPane(tabId, {
        ensure: "available", frame: null, streamGeneration: pane.streamGeneration + 1,
      });
      let state: DevicePaneState;
      try {
        state = await backend.devicePaneAct(tabId, action);
      } catch (err) {
        if (isCurrentRequest(tabId, runtime, generation) &&
          runtime.devicePaneStateGeneration === stateGeneration)
          get().reportError(err);
        return;
      }
      if (!isCurrentRequest(tabId, runtime, generation) ||
        runtime.devicePaneStateGeneration !== stateGeneration) return;
      applyState(tabId, state, action.action === "create" || action.action === "boot" || action.action === "bind");
    },
    handleDevicePaneState(tabId, state) {
      const previous = get().rpc[tabId]?.devicePane;
      if (previous === undefined) return;
      const runtime = peekTabRuntime(tabId);
      if (runtime !== undefined)
        m.patchRuntime(tabId, {
          devicePaneStateGeneration: (runtime.devicePaneStateGeneration ?? 0) + 1,
        });
      if (previous.ensure !== "update-required") applyState(tabId, state);
      patchPane(tabId, { open: state.open });
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
      const pane = get().rpc[tabId]?.devicePane;
      if (pane?.ensure !== "available" || !isCurrentFrame(pane.state, header)) return;
      const frame = pane.frame;
      if (
        frame && frame.bindingId === header.bindingId &&
        frame.geometryRevision === header.geometryRevision &&
        frame.width === header.width && frame.height === header.height &&
        frame.dsf === header.dsf
      )
        return;
      patchPane(tabId, { frame: header });
    },
  };
}
