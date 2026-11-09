// Device pane slice tests (issue #1006): one split slot, two panes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DeviceInventory,
  DevicePaneEnsureResult,
  DevicePaneFrameHeader,
  DevicePaneState,
} from "@omp-ui/core/device-pane";
import type { BackendState } from "@omp-ui/core/types";
import { remoteOwnedState, rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";
import {
  createMachinery,
  devicePaneWriters,
  peekTabRuntime,
  registerDevicePaneWriter,
} from "./shared";

const tab = () => h.useStore.getState().rpc[h.TAB]!;
const BINDING = "11111111-1111-4111-8111-111111111111";
const NEXT_BINDING = "22222222-2222-4222-8222-222222222222";
const inventory: DeviceInventory = {
  sdk: { status: "ready", sdkRoot: "/sdk" },
  targets: [],
  profiles: [],
  images: [],
  creation: { available: true, reason: null, sdkRoot: "/sdk", installCommand: null },
};

function deviceState(patch: Partial<DevicePaneState> = {}): DevicePaneState {
  return {
    serial: "emulator-5554",
    avd: "Pixel_8",
    phase: "streaming",
    agent: "detached",
    error: null,
    open: false,
    display: { width: 1080, height: 2400 },
    bindingId: BINDING,
    geometryRevision: 1,
    rotation: 0,
    posture: "open",
    hingeAngle: 180,
    screen: "active",
    inputReady: true,
    capabilities: {
      rotation: { available: true, reason: null },
      postures: { available: false, reason: "No hinge", supported: [] },
    },
    operation: null,
    actionError: null,
    ...patch,
  };
}

function frame(patch: Partial<DevicePaneFrameHeader> = {}): DevicePaneFrameHeader {
  return { width: 576, height: 1280, dsf: 1, bindingId: BINDING, geometryRevision: 1, ...patch };
}

function available(state = deviceState()): Extract<DevicePaneEnsureResult, { status: "available" }> {
  return { status: "available", protocolVersion: 2, state, inventory };
}

function seedReady(state = deviceState()): void {
  h.useStore.setState({
    rpc: {
      [h.TAB]: rpcTabState({
        devicePane: {
          ...rpcTabState().devicePane,
          ensure: "available",
          open: state.open,
          state,
          inventory,
        },
      }),
    },
  });
}

// The renderer targets ES2022, which has no Promise.withResolvers declaration.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("device pane mutual exclusion", () => {
  it("opening the device pane closes the browser pane", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({ browserPane: { ...rpcTabState().browserPane, open: true } }),
      },
    });
    h.useStore.getState().openDevicePane(h.TAB);
    expect(tab().devicePane.open).toBe(true);
    expect(tab().browserPane.open).toBe(false);
  });

  it("opening the browser pane closes the device pane", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().openDevicePane(h.TAB);
    h.useStore.getState().openBrowserPane(h.TAB);
    expect(tab().browserPane.open).toBe(true);
    expect(tab().devicePane.open).toBe(false);
  });

  it("an agent-driven open state push closes the browser pane", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({ browserPane: { ...rpcTabState().browserPane, open: true } }),
      },
    });
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ open: true, agent: "acting" }));
    expect(tab().devicePane.open).toBe(true);
    expect(tab().devicePane.state?.agent).toBe("acting");
    expect(tab().browserPane.open).toBe(false);
  });
});

describe("device protocol handshake and request ordering", () => {
  it("keeps optimistic open when ensure returns a closed owner snapshot", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    h.useStore.getState().openDevicePane(h.TAB);
    expect(tab().devicePane).toMatchObject({ open: true, ensure: "pending", frame: null });
    response.resolve(available());
    await h.flushMicrotasks();
    expect(tab().devicePane).toMatchObject({ open: true, ensure: "available" });
  });

  it.each([undefined, 1, 3])("requires an update for protocol %s and refuses controls", async (protocolVersion) => {
    seedReady();
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    h.mockBackend.devicePaneEnsure.mockResolvedValueOnce({
      status: "available", protocolVersion, state: deviceState(), inventory,
    } as unknown as DevicePaneEnsureResult);
    await h.useStore.getState().ensureDevicePane(h.TAB);
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ open: true }));
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    await h.useStore.getState().actDevicePane(h.TAB, { action: "bind", serial: "emulator-5580" });
    expect(tab().devicePane).toMatchObject({
      ensure: "update-required", state: null, inventory: null, frame: null, open: true,
    });
    expect(peekTabRuntime(h.TAB)?.devicePaneProtocolVersion).toBeUndefined();
    expect(h.mockBackend.devicePaneAct).not.toHaveBeenCalled();
  });

  it("blocks actions during a first unverified handshake", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    const pending = h.useStore.getState().ensureDevicePane(h.TAB);
    await h.useStore.getState().actDevicePane(h.TAB, { action: "bind", serial: "emulator-5580" });
    expect(h.mockBackend.devicePaneAct).not.toHaveBeenCalled();
    response.resolve(available());
    await pending;
  });

  it("drops an older ensure after a newer handshake resolves", async () => {
    seedReady();
    const old = deferred<DevicePaneEnsureResult>();
    const newer = deviceState({ bindingId: NEXT_BINDING, geometryRevision: 5 });
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(old.promise).mockResolvedValueOnce(available(newer));
    const pending = h.useStore.getState().ensureDevicePane(h.TAB);
    await h.useStore.getState().ensureDevicePane(h.TAB);
    old.resolve(available());
    await pending;
    expect(tab().devicePane.state).toBe(newer);
  });

  it("settles the first handshake without overwriting a newer state push", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    const pending = h.useStore.getState().ensureDevicePane(h.TAB);
    const pushed = deviceState({ bindingId: NEXT_BINDING, geometryRevision: 9, open: true });
    h.useStore.getState().handleDevicePaneState(h.TAB, pushed);
    response.resolve(available());
    await pending;
    expect(tab().devicePane.state).toBe(pushed);
    expect(tab().devicePane).toMatchObject({ ensure: "available", inventory, open: true, frame: null });
  });

  it.each(["not-live", "error"] as const)("does not let stale ensure %s mask a newer push after verification", async (outcome) => {
    seedReady();
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    const pending = h.useStore.getState().ensureDevicePane(h.TAB);
    const pushed = deviceState({ geometryRevision: 2 });
    h.useStore.getState().handleDevicePaneState(h.TAB, pushed);
    if (outcome === "error") response.reject(new Error("obsolete disconnect"));
    else response.resolve({ status: "not-live" });
    await pending;
    expect(tab().devicePane.ensure).toBe("available");
    expect(tab().devicePane.state).toBe(pushed);
    expect(h.errorMessages()).toEqual([]);
  });

  it("allows an action to supersede a refresh only after a verified handshake", async () => {
    seedReady();
    const response = deferred<DevicePaneEnsureResult>();
    const changed = deviceState({ rotation: 2, geometryRevision: 2 });
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    h.mockBackend.devicePaneAct.mockResolvedValueOnce(changed);
    const pending = h.useStore.getState().ensureDevicePane(h.TAB);
    await h.useStore.getState().actDevicePane(h.TAB, { action: "rotate", bindingId: BINDING, rotation: 2 });
    response.resolve(available());
    await pending;
    expect(tab().devicePane.ensure).toBe("available");
    expect(tab().devicePane.state).toBe(changed);
  });

  it("lets a new ensure supersede an action snapshot", async () => {
    seedReady();
    const response = deferred<DevicePaneState>();
    const newer = deviceState({ bindingId: NEXT_BINDING });
    h.mockBackend.devicePaneAct.mockReturnValueOnce(response.promise);
    h.mockBackend.devicePaneEnsure.mockResolvedValueOnce(available(newer));
    const pending = h.useStore.getState().actDevicePane(h.TAB, { action: "bind", serial: "emulator-5580" });
    await h.useStore.getState().ensureDevicePane(h.TAB);
    response.resolve(deviceState());
    await pending;
    expect(tab().devicePane.state).toBe(newer);
  });
});

describe("device action state fences", () => {
  it.each(["resolve", "reject"] as const)("drops an action %s after a newer action", async (outcome) => {
    seedReady();
    const response = deferred<DevicePaneState>();
    const newer = deviceState({ bindingId: NEXT_BINDING, avd: "New_Device" });
    h.mockBackend.devicePaneAct.mockReturnValueOnce(response.promise).mockResolvedValueOnce(newer);
    const pending = h.useStore.getState().actDevicePane(h.TAB, { action: "bind", serial: "emulator-5580" });
    await h.useStore.getState().actDevicePane(h.TAB, { action: "bind", serial: "emulator-5582" });
    if (outcome === "reject") response.reject(new Error("old action failure"));
    else response.resolve(deviceState());
    await pending;
    expect(tab().devicePane.state).toBe(newer);
    expect(h.errorMessages()).toEqual([]);
  });

  it.each(["resolve", "reject"] as const)("drops an action %s after a newer state push", async (outcome) => {
    seedReady();
    const response = deferred<DevicePaneState>();
    h.mockBackend.devicePaneAct.mockReturnValueOnce(response.promise);
    const pending = h.useStore.getState().actDevicePane(h.TAB, { action: "rotate", bindingId: BINDING, rotation: 2 });
    const pushed = deviceState({ geometryRevision: 2, rotation: 2 });
    h.useStore.getState().handleDevicePaneState(h.TAB, pushed);
    if (outcome === "reject") response.reject(new Error("superseded rotation"));
    else response.resolve(deviceState());
    await pending;
    expect(tab().devicePane.state).toBe(pushed);
    expect(h.errorMessages()).toEqual([]);
  });

  it("reports the current action failure rather than swallowing it", async () => {
    seedReady();
    h.mockBackend.devicePaneAct.mockRejectedValueOnce(new Error("device is busy"));
    await h.useStore.getState().actDevicePane(h.TAB, { action: "rotate", bindingId: BINDING, rotation: 1 });
    expect(h.errorMessages()).toEqual(["device is busy"]);
  });
});

describe("device selection completion inventory", () => {
  const createdInventory: DeviceInventory = {
    ...inventory,
    targets: [{
      serial: "emulator-5556", avd: "omp_ui_proof_phone", state: "running",
      friendlyName: "Small Phone", api: 35,
    }],
  };

  async function completeCreation() {
    seedReady(deviceState({
      serial: null, avd: null, bindingId: null, phase: "unbound",
      display: null, screen: "unknown", inputReady: false,
    }));
    const operation = { kind: "create", stage: "creating", avd: "omp_ui_proof_phone" } as const;
    h.mockBackend.devicePaneAct.mockResolvedValueOnce(deviceState({
      serial: null, avd: operation.avd, phase: "provisioning", operation,
      display: null, screen: "unknown", inputReady: false,
    }));
    await h.useStore.getState().actDevicePane(h.TAB, {
      action: "create", profileId: "small_phone",
      imagePackage: "system-images;android-35;google_apis;x86_64", avd: operation.avd,
    });
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({
      serial: "emulator-5556", avd: operation.avd, operation, inputReady: false,
    }));
    const painted = frame();
    h.useStore.getState().noteDevicePaneFrame(h.TAB, painted);
    const generation = tab().devicePane.streamGeneration;
    const ready = deviceState({ serial: "emulator-5556", avd: operation.avd });
    h.useStore.getState().handleDevicePaneState(h.TAB, ready);
    return { ready, painted, generation };
  }

  it("fills in a completed creation's friendly target and API without interrupting ready paint or input", async () => {
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    const { ready, painted, generation } = await completeCreation();
    expect(h.mockBackend.devicePaneEnsure).toHaveBeenCalledExactlyOnceWith(h.TAB);
    expect(tab().devicePane).toMatchObject({
      ensure: "available", inventory, state: { phase: "streaming", inputReady: true },
      streamGeneration: generation,
    });
    expect(tab().devicePane.state).toBe(ready);
    expect(tab().devicePane.frame).toBe(painted);

    // Ordinary state/input/rotation traffic is not a new selection completion.
    const latest = deviceState({ ...ready, agent: "acting", rotation: 1 });
    h.useStore.getState().handleDevicePaneState(h.TAB, {
      ...latest, operation: { kind: "rotate", stage: "rotating", rotation: 1 }, inputReady: false,
    });
    h.useStore.getState().handleDevicePaneState(h.TAB, latest);
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    response.resolve({
      ...available(deviceState({ bindingId: NEXT_BINDING, phase: "provisioning", inputReady: false })),
      inventory: createdInventory,
    });
    await h.flushMicrotasks();
    expect(tab().devicePane.inventory?.targets[0]).toMatchObject({ friendlyName: "Small Phone", api: 35 });
    expect(tab().devicePane.state).toBe(latest);
    expect(tab().devicePane.frame).toBe(painted);
    expect(tab().devicePane.streamGeneration).toBe(generation);
    expect(tab().devicePane.ensure).toBe("available");
    expect(h.mockBackend.devicePaneEnsure).toHaveBeenCalledTimes(1);
  });

  it.each(["boot", "bind"] as const)("also reconciles a completed %s action with no intermediate push", async (action) => {
    seedReady();
    const response = deferred<DevicePaneEnsureResult>();
    const ready = deviceState({ bindingId: NEXT_BINDING, serial: "emulator-5556", avd: "omp_ui_proof_phone" });
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    h.mockBackend.devicePaneAct.mockResolvedValueOnce(ready);
    await h.useStore.getState().actDevicePane(h.TAB, action === "boot"
      ? { action, avd: ready.avd! } : { action, serial: ready.serial! });
    const painted = frame({ bindingId: NEXT_BINDING });
    h.useStore.getState().noteDevicePaneFrame(h.TAB, painted);
    const generation = tab().devicePane.streamGeneration;
    expect(h.mockBackend.devicePaneEnsure).toHaveBeenCalledExactlyOnceWith(h.TAB);
    response.resolve({ ...available(), inventory: createdInventory });
    await h.flushMicrotasks();
    expect(tab().devicePane.inventory).toBe(createdInventory);
    expect(tab().devicePane.state).toBe(ready);
    expect(tab().devicePane.frame).toBe(painted);
    expect(tab().devicePane.streamGeneration).toBe(generation);
  });

  it.each(["error", "missing-session", "not-live", "terminal"] as const)("preserves the usable connection when the inventory query returns %s", async (outcome) => {
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    await completeCreation();
    const ready = tab().devicePane;
    if (outcome === "error") response.reject(new Error("inventory details unavailable"));
    else response.resolve({ status: outcome });
    await h.flushMicrotasks();
    expect(tab().devicePane).toBe(ready);
    expect(h.errorMessages()).toEqual([]);
    expect(h.mockBackend.devicePaneEnsure).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 1, 3])("requires an update and blocks controls for inventory protocol %s", async (protocolVersion) => {
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    await completeCreation();
    response.resolve({
      status: "available", protocolVersion, state: deviceState(), inventory: createdInventory,
    } as unknown as DevicePaneEnsureResult);
    await h.flushMicrotasks();
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState());
    await h.useStore.getState().actDevicePane(h.TAB, { action: "rotate", bindingId: BINDING, rotation: 1 });
    expect(tab().devicePane).toMatchObject({
      ensure: "update-required", state: null, inventory: null, frame: null,
    });
    expect(peekTabRuntime(h.TAB)?.devicePaneProtocolVersion).toBeUndefined();
    expect(h.mockBackend.devicePaneAct).toHaveBeenCalledTimes(1);
  });

  it.each(["rebind", "reconnect", "replace", "teardown", "remove"] as const)("drops late inventory after %s without creating or patching a successor runtime", async (lifecycle) => {
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    const { ready } = await completeCreation();
    const machinery = createMachinery(h.useStore.setState, h.useStore.getState, h.useStore);
    if (lifecycle === "rebind") {
      h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ bindingId: NEXT_BINDING, avd: "Another_Device" }));
      h.useStore.getState().noteDevicePaneFrame(h.TAB, frame({ bindingId: NEXT_BINDING }));
    } else if (lifecycle === "replace" || lifecycle === "reconnect") {
      if (lifecycle === "replace") machinery.createTabRuntime(h.TAB);
      else machinery.invalidateDevicePane(h.TAB);
      const currentInventory: DeviceInventory = { ...inventory, sdk: { status: "ready", sdkRoot: "/current-sdk" } };
      h.mockBackend.devicePaneEnsure.mockResolvedValueOnce({ ...available(ready), inventory: currentInventory });
      await h.useStore.getState().ensureDevicePane(h.TAB);
      h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    } else {
      machinery.discardTabRuntime(h.TAB);
      if (lifecycle === "remove") h.useStore.setState({ rpc: {} });
    }
    const currentRuntime = peekTabRuntime(h.TAB);
    const currentPane = h.useStore.getState().rpc[h.TAB]?.devicePane;
    response.resolve({ ...available(), inventory: createdInventory });
    await h.flushMicrotasks();
    expect(peekTabRuntime(h.TAB)).toBe(currentRuntime);
    expect(h.useStore.getState().rpc[h.TAB]?.devicePane).toBe(currentPane);
  });

  it("lets a newer explicit Refresh own inventory even for the same binding", async () => {
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    const { ready } = await completeCreation();
    const refreshedInventory: DeviceInventory = {
      ...createdInventory, targets: [{ ...createdInventory.targets[0]!, friendlyName: "Refreshed Phone" }],
    };
    h.mockBackend.devicePaneEnsure.mockResolvedValueOnce({ ...available(ready), inventory: refreshedInventory });
    await h.useStore.getState().ensureDevicePane(h.TAB);
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    const refreshed = tab().devicePane;
    response.resolve({ ...available(), inventory: createdInventory });
    await h.flushMicrotasks();
    expect(tab().devicePane).toBe(refreshed);
    expect(tab().devicePane.inventory).toBe(refreshedInventory);
    expect(h.mockBackend.devicePaneEnsure).toHaveBeenCalledTimes(2);
  });

  it("does not let an earlier pending handshake overwrite completion inventory", async () => {
    seedReady(deviceState({ operation: { kind: "create", stage: "creating", avd: "omp_ui_proof_phone" } }));
    const handshake = deferred<DevicePaneEnsureResult>();
    const details = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(handshake.promise).mockReturnValueOnce(details.promise);
    const pending = h.useStore.getState().ensureDevicePane(h.TAB);
    const ready = deviceState({ serial: "emulator-5556", avd: "omp_ui_proof_phone" });
    h.useStore.getState().handleDevicePaneState(h.TAB, ready);
    details.resolve({ ...available(), inventory: createdInventory });
    await h.flushMicrotasks();
    expect(tab().devicePane.ensure).toBe("pending");
    expect(tab().devicePane.inventory).toBe(createdInventory);
    handshake.resolve(available());
    await pending;
    expect(tab().devicePane.ensure).toBe("available");
    expect(tab().devicePane.inventory).toBe(createdInventory);
    expect(tab().devicePane.state).toBe(ready);
    expect(h.mockBackend.devicePaneEnsure).toHaveBeenCalledTimes(2);
  });

  it("lets only the newest completion inventory read update a retained binding", async () => {
    const old = deferred<DevicePaneEnsureResult>();
    const current = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await completeCreation();
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({
      serial: "emulator-5556", avd: "omp_ui_proof_phone",
      operation: { kind: "bind", stage: "connecting" }, inputReady: false,
    }));
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ serial: "emulator-5556", avd: "omp_ui_proof_phone" }));
    const currentInventory: DeviceInventory = {
      ...createdInventory, targets: [{ ...createdInventory.targets[0]!, friendlyName: "Current Phone" }],
    };
    current.resolve({ ...available(), inventory: currentInventory });
    await h.flushMicrotasks();
    const pane = tab().devicePane;
    old.resolve({ ...available(), inventory: createdInventory });
    await h.flushMicrotasks();
    expect(tab().devicePane).toBe(pane);
    expect(tab().devicePane.inventory).toBe(currentInventory);
    expect(h.mockBackend.devicePaneEnsure).toHaveBeenCalledTimes(2);
  });

  it("cannot restore controls from an older handshake after the completion read finds a protocol mismatch", async () => {
    seedReady(deviceState({ operation: { kind: "create", stage: "creating", avd: "omp_ui_proof_phone" } }));
    const handshake = deferred<DevicePaneEnsureResult>();
    const details = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(handshake.promise).mockReturnValueOnce(details.promise);
    const pending = h.useStore.getState().ensureDevicePane(h.TAB);
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ serial: "emulator-5556", avd: "omp_ui_proof_phone" }));
    details.resolve({ ...available(), protocolVersion: 1 } as unknown as DevicePaneEnsureResult);
    await h.flushMicrotasks();
    const incompatible = tab().devicePane;
    handshake.resolve(available());
    await pending;
    await h.useStore.getState().actDevicePane(h.TAB, { action: "bind", serial: "emulator-5556" });
    expect(tab().devicePane).toBe(incompatible);
    expect(tab().devicePane).toMatchObject({ ensure: "update-required", state: null, inventory: null, frame: null });
    expect(peekTabRuntime(h.TAB)?.devicePaneProtocolVersion).toBeUndefined();
    expect(h.mockBackend.devicePaneAct).not.toHaveBeenCalled();
  });
});

describe("device runtime lifetime fences", () => {
  const cases = (["ensure", "action"] as const).flatMap((request) =>
    (["resolve", "reject"] as const).flatMap((outcome) =>
      (["teardown", "replace", "remove"] as const).map((lifecycle) => ({ request, outcome, lifecycle }))));

  it.each(cases)("ignores $request $outcome after $lifecycle without inventing a runtime", async ({ request, outcome, lifecycle }) => {
    seedReady();
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    const ensureResponse = deferred<DevicePaneEnsureResult>();
    const actionResponse = deferred<DevicePaneState>();
    if (request === "ensure") h.mockBackend.devicePaneEnsure.mockReturnValueOnce(ensureResponse.promise);
    else h.mockBackend.devicePaneAct.mockReturnValueOnce(actionResponse.promise);
    const pending = request === "ensure"
      ? h.useStore.getState().ensureDevicePane(h.TAB)
      : h.useStore.getState().actDevicePane(h.TAB, { action: "bind", serial: "emulator-5580" });
    const machinery = createMachinery(h.useStore.setState, h.useStore.getState, h.useStore);
    const previous = peekTabRuntime(h.TAB);
    if (lifecycle === "replace") machinery.createTabRuntime(h.TAB);
    else machinery.discardTabRuntime(h.TAB);
    if (lifecycle === "remove") h.useStore.setState({ rpc: {} });
    const current = peekTabRuntime(h.TAB);
    expect(current).not.toBe(previous);
    if (request === "ensure") {
      if (outcome === "reject") ensureResponse.reject(new Error("dead owner"));
      else ensureResponse.resolve(available());
    } else {
      if (outcome === "reject") actionResponse.reject(new Error("dead owner"));
      else actionResponse.resolve(deviceState());
    }
    await pending;
    expect(peekTabRuntime(h.TAB)).toBe(current);
    expect(h.errorMessages()).toEqual([]);
    if (lifecycle === "remove") expect(h.useStore.getState().rpc[h.TAB]).toBeUndefined();
    else expect(tab().devicePane).toMatchObject({ ensure: "idle", state: null, inventory: null, frame: null });
  });

  it.each(["ensure", "action"] as const)("keeps %s from the pre-reboot runtime out of the successor", async (request) => {
    seedReady(deviceState({ open: true }));
    h.useStore.setState({ state: h.stateWithRecord("session-1") });
    h.useStore.getState().setDevicePaneFullscreen(h.TAB, true);
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    const ensureResponse = deferred<DevicePaneEnsureResult>();
    const actionResponse = deferred<DevicePaneState>();
    if (request === "ensure") h.mockBackend.devicePaneEnsure.mockReturnValueOnce(ensureResponse.promise);
    else h.mockBackend.devicePaneAct.mockReturnValueOnce(actionResponse.promise);
    const pending = request === "ensure"
      ? h.useStore.getState().ensureDevicePane(h.TAB)
      : h.useStore.getState().actDevicePane(h.TAB, { action: "bind", serial: "emulator-5580" });
    const streamGeneration = tab().devicePane.streamGeneration;
    await h.driveBoot(h.TAB);
    expect(tab().devicePane).toMatchObject({
      open: true, fullscreen: true, ensure: "idle", state: null, inventory: null, frame: null,
    });
    expect(tab().devicePane.streamGeneration).toBeGreaterThan(streamGeneration);
    const newer = deviceState({ bindingId: NEXT_BINDING, geometryRevision: 2 });
    h.mockBackend.devicePaneEnsure.mockResolvedValueOnce(available(newer));
    await h.useStore.getState().ensureDevicePane(h.TAB);
    if (request === "ensure") ensureResponse.resolve(available());
    else actionResponse.resolve(deviceState());
    await pending;
    expect(tab().devicePane.state).toBe(newer);
  });
});

describe("painted device identity", () => {
  it("requires a fresh same-size paint after a 180-degree revision and after rebinding", () => {
    seedReady();
    const first = frame();
    h.useStore.getState().noteDevicePaneFrame(h.TAB, first);
    expect(tab().devicePane.frame).toBe(first);
    const generation = tab().devicePane.streamGeneration;
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ rotation: 2, geometryRevision: 2 }));
    expect(tab().devicePane.frame).toBeNull();
    expect(tab().devicePane.streamGeneration).toBeGreaterThan(generation);
    h.useStore.getState().noteDevicePaneFrame(h.TAB, first);
    expect(tab().devicePane.frame).toBeNull();
    const rotated = frame({ geometryRevision: 2 });
    h.useStore.getState().noteDevicePaneFrame(h.TAB, rotated);
    expect(tab().devicePane.frame).toBe(rotated);
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ bindingId: NEXT_BINDING, geometryRevision: 2 }));
    h.useStore.getState().noteDevicePaneFrame(h.TAB, rotated);
    expect(tab().devicePane.frame).toBeNull();
    const rebound = frame({ bindingId: NEXT_BINDING, geometryRevision: 2 });
    h.useStore.getState().noteDevicePaneFrame(h.TAB, rebound);
    expect(tab().devicePane.frame).toBe(rebound);
  });

  it.each<Partial<DevicePaneState>>([
    { phase: "connecting" }, { screen: "inactive" }, { screen: "unknown" },
  ])("rejects paint outside an active capture state: %j", (patch) => {
    seedReady();
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    const generation = tab().devicePane.streamGeneration;
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState(patch));
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    expect(tab().devicePane.frame).toBeNull();
    expect(tab().devicePane.streamGeneration).toBeGreaterThan(generation);
  });

  it.each<Partial<DevicePaneState>>([
    { inputReady: false },
    { operation: { kind: "rotate", stage: "rotating", rotation: 1 } },
    { inputReady: false, operation: { kind: "rotate", stage: "rotating", rotation: 1 } },
  ])("retains initial/control pixels across input-only lock transitions: %j", (patch) => {
    seedReady(deviceState(patch));
    const painted = frame();
    const generation = tab().devicePane.streamGeneration;
    h.useStore.getState().noteDevicePaneFrame(h.TAB, painted);
    expect(tab().devicePane.frame).toBe(painted);

    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState());
    expect(tab().devicePane.frame).toBe(painted);
    expect(tab().devicePane.streamGeneration).toBe(generation);

    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState(patch));
    expect(tab().devicePane.frame).toBe(painted);
    expect(tab().devicePane.streamGeneration).toBe(generation);
  });

  it("retains painted identity for same-geometry agent/visibility pushes and ignores duplicate notes", () => {
    seedReady();
    const painted = frame();
    h.useStore.getState().noteDevicePaneFrame(h.TAB, painted);
    const generation = tab().devicePane.streamGeneration;
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ agent: "acting", open: true }));
    const pane = tab().devicePane;
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    expect(tab().devicePane).toBe(pane);
    expect(tab().devicePane.frame).toBe(painted);
    expect(tab().devicePane.streamGeneration).toBe(generation);
  });

  it("clears readiness immediately on a same-binding reconnect", async () => {
    seedReady();
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    const generation = tab().devicePane.streamGeneration;
    const response = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(response.promise);
    const pending = h.useStore.getState().ensureDevicePane(h.TAB);
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    expect(tab().devicePane.frame).toBeNull();
    expect(tab().devicePane.streamGeneration).toBeGreaterThan(generation);
    response.resolve(available());
    await pending;
    expect(tab().devicePane.frame).toBeNull();
    h.useStore.getState().noteDevicePaneFrame(h.TAB, frame());
    expect(tab().devicePane.frame).not.toBeNull();
  });

  it("does not let a stale writer cleanup remove its mounted successor", () => {
    const old = registerDevicePaneWriter(h.TAB, vi.fn());
    const writer = vi.fn();
    const current = registerDevicePaneWriter(h.TAB, writer);
    old();
    expect(devicePaneWriters.get(h.TAB)).toBe(writer);
    current();
    expect(devicePaneWriters.has(h.TAB)).toBe(false);
  });
});

describe("compact device pane visibility", () => {
  afterEach(() => { Reflect.deleteProperty(window, "matchMedia"); });

  it.each([true, false])("adopts hidden-tab pushes but only the active tab claims the sheet (active=%s)", (active) => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: true, media: query }),
    });
    h.useStore.setState({
      activeTabId: active ? h.TAB : "other",
      tabs: [tabInfo({ tabId: h.TAB }), tabInfo({ tabId: "other" })],
      rpc: { [h.TAB]: rpcTabState(), other: rpcTabState() },
    });
    const pushed = deviceState({ open: true, agent: "acting" });
    h.useStore.getState().handleDevicePaneState(h.TAB, pushed);
    expect(tab().devicePane.state).toBe(pushed);
    expect(tab().devicePane.open).toBe(true);
    expect(h.useStore.getState().compactSurface).toBe(active ? "device-pane" : null);
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ open: false }));
    expect(h.useStore.getState().compactSurface).toBeNull();
  });
});

describe("remote device owner disconnect", () => {
  it("invalidates control proof and pending work synchronously before a same-binding rejoin", async () => {
    // init() latches listeners per module; this case needs its own authoritative-state bus.
    vi.resetModules();
    const { useStore: fresh } = await import("../../store");
    const joined = remoteOwnedState(h.TAB, "remote-device");
    h.backendState = joined;
    fresh.setState({
      state: joined,
      tabs: [tabInfo({ tabId: h.TAB, instanceId: "remote-device", projectCwd: "/remote/p" })],
      rpc: { [h.TAB]: rpcTabState() },
    });
    await fresh.getState().init();
    const onState = h.mockBackend.onStateChanged.mock.calls[0]![0] as (state: BackendState) => void;
    h.mockBackend.devicePaneEnsure.mockResolvedValueOnce(available());
    await fresh.getState().ensureDevicePane(h.TAB);
    fresh.getState().noteDevicePaneFrame(h.TAB, frame());
    const before = fresh.getState().rpc[h.TAB]!.devicePane;
    const response = deferred<DevicePaneState>();
    h.mockBackend.devicePaneAct.mockReturnValueOnce(response.promise);
    const pending = fresh.getState().actDevicePane(h.TAB, { action: "rotate", bindingId: BINDING, rotation: 2 });
    onState({ ...joined, remoteInstances: joined.remoteInstances.map((instance) => ({ ...instance, status: "unreachable" })) });
    const down = fresh.getState().rpc[h.TAB]!.devicePane;
    expect(down).toMatchObject({ ensure: "idle", state: null, inventory: null, frame: null });
    expect(down.streamGeneration).toBeGreaterThan(before.streamGeneration);
    await fresh.getState().actDevicePane(h.TAB, { action: "rotate", bindingId: BINDING, rotation: 1 });
    expect(h.mockBackend.devicePaneAct).toHaveBeenCalledTimes(1);
    response.resolve(deviceState({ rotation: 2, geometryRevision: 2 }));
    await pending;
    expect(fresh.getState().rpc[h.TAB]!.devicePane).toBe(down);
    // Keep this test focused on synchronous device invalidation: normal rejoin
    // boot is covered above; a fresh handshake is still required before control.
    fresh.setState({ bootRpcTab: vi.fn(async () => {}) });
    onState(joined);
    expect(fresh.getState().rpc[h.TAB]!.devicePane.ensure).toBe("idle");
    const handshake = deferred<DevicePaneEnsureResult>();
    h.mockBackend.devicePaneEnsure.mockReturnValueOnce(handshake.promise);
    const ensuring = fresh.getState().ensureDevicePane(h.TAB);
    await fresh.getState().actDevicePane(h.TAB, { action: "rotate", bindingId: BINDING, rotation: 1 });
    expect(h.mockBackend.devicePaneAct).toHaveBeenCalledTimes(1);
    handshake.resolve(available());
    await ensuring;
    expect(fresh.getState().rpc[h.TAB]!.devicePane).toMatchObject({ ensure: "available", frame: null });
  });
});
