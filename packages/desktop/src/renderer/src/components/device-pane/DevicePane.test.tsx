// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { encodeDevicePaneFrameHeader, type DeviceInventory, type DevicePaneFrameHeader, type DevicePaneState } from "@omp-ui/core/device-pane";
import { backend } from "../../backend";
import { applyLocale, resolveLocale, t } from "../../lib/i18n";
import { useStore } from "../../store";
import { devicePaneWriters } from "../../store/slices/shared";
import { backendState, remoteOwnedState, rpcTabState } from "../../test/fixtures";
import { DevicePane } from "./DevicePane";

vi.mock("../../backend", () => ({ backend: { devicePaneSubscribe: vi.fn(), devicePaneInput: vi.fn() } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const tabId = "device-consumer";
const firstBinding = "11111111-1111-4111-8111-111111111111";
const secondBinding = "22222222-2222-4222-8222-222222222222";
function deviceState(bindingId: string, avd: string): DevicePaneState {
  return {
    bindingId, avd, serial: "emulator-5580", geometryRevision: 1,
    phase: "streaming", agent: "detached", error: null, open: true,
    display: { width: 1080, height: 1920 }, rotation: 0, posture: "open", hingeAngle: 180,
    screen: "active", inputReady: true, operation: null, actionError: null,
    capabilities: { rotation: { available: true, reason: null }, postures: { available: false, reason: null, supported: [] } },
  };
}
const initialStore = useStore.getState();
const actDevicePane = vi.fn(async () => {});
const ensureDevicePane = vi.fn(async () => {});
const queueComposerAttachment = vi.fn();
const drawImage = vi.fn();
let imageDecodes: Array<{ promise: Promise<ImageBitmap>; resolve: (bitmap: ImageBitmap) => void }>;
let decodeImage: Mock<() => Promise<ImageBitmap>>;
let host: HTMLDivElement;
let root: Root;
let resizePane: (width: number) => void;
function publish(state: DevicePaneState, inventory: DeviceInventory | null = null) {
  act(() => {
    useStore.setState({ rpc: { [tabId]: rpcTabState({ devicePane: { open: true, fullscreen: false, ensure: "available", state, inventory, frame: null, streamGeneration: 0 } }) } });
  });
}
function pushState(state: DevicePaneState) {
  act(() => useStore.getState().handleDevicePaneState(tabId, state));
}
function activate() {
  act(() => useStore.setState({ activeTabId: tabId }));
  resizePane(900);
}
function frameHeader(state: DevicePaneState): DevicePaneFrameHeader {
  if (state.bindingId === null) throw new Error("Test frame requires a binding");
  return { bindingId: state.bindingId, geometryRevision: state.geometryRevision, width: 1080, height: 1920, dsf: 1 };
}
function frameBytes(header: DevicePaneFrameHeader): Uint8Array {
  const encoded = encodeDevicePaneFrameHeader(header);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);
  bytes[encoded.length] = 1;
  return bytes;
}
function deliverFrame(header: DevicePaneFrameHeader): Promise<void> {
  const write = devicePaneWriters.get(tabId);
  if (!write) throw new Error("Active capture has no frame painter");
  let delivery: void | Promise<void>;
  act(() => { delivery = write(frameBytes(header)); });
  return Promise.resolve(delivery!);
}
async function finishFrame(delivery: Promise<void>, index = 0) {
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  const pending = imageDecodes[index];
  if (!pending) throw new Error("Expected a frame awaiting JPEG decode");
  await act(async () => {
    pending.resolve(bitmap);
    await delivery;
  });
  return bitmap;
}
function canvas(): HTMLCanvasElement {
  const element = host.querySelector("canvas");
  if (!element) throw new Error("Device canvas is missing");
  return element;
}
function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const found = Array.from(within.querySelectorAll("button")).find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function click(element: Element) {
  act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
beforeEach(() => {
  applyLocale(resolveLocale("en"));
  actDevicePane.mockClear();
  ensureDevicePane.mockClear();
  queueComposerAttachment.mockClear();
  vi.mocked(backend.devicePaneSubscribe).mockReset();
  vi.mocked(backend.devicePaneInput).mockClear();
  drawImage.mockClear();
  imageDecodes = [];
  decodeImage = vi.fn(() => {
    const pending = Promise.withResolvers<ImageBitmap>();
    imageDecodes.push(pending);
    return pending.promise;
  });
  vi.stubGlobal("createImageBitmap", decodeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect: vi.fn(), drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,c2NyZWVu");
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizePane = (width) => act(() => callback([{ contentRect: { width, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver));
    }
    observe() {} unobserve() {} disconnect() {}
  });
  useStore.setState({ state: backendState(), activeTabId: null, actDevicePane, ensureDevicePane, queueComposerAttachment });
  publish(deviceState(firstBinding, "first_phone"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<DevicePane tabId={tabId} placement="split" />); });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initialStore, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("DevicePane power confirmation", () => {
  it("powers off only the binding captured by an explicit confirmation", () => {
    click(button("More device controls"));
    click(button("power off emulator"));
    expect(actDevicePane).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    if (!dialog) throw new Error("Power confirmation did not open");
    click(button("Power off", dialog));
    expect(actDevicePane).toHaveBeenCalledExactlyOnceWith(tabId, { action: "power-off", bindingId: firstBinding });
  });
  it("cannot power off a replacement binding through an already open confirmation", () => {
    click(button("More device controls"));
    click(button("power off emulator"));
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    if (!dialog) throw new Error("Power confirmation did not open");
    expect(button("Power off", dialog).disabled).toBe(false);
    publish(deviceState(secondBinding, "second_phone"));
    const confirm = button("Power off", dialog);
    expect(confirm.disabled).toBe(true);
    click(confirm);
    expect(actDevicePane).not.toHaveBeenCalled();
  });
});

describe("DevicePane capability-backed postures", () => {
  it("moves secondary header actions into More based on pane width while retaining Close", () => {
    resizePane(900);
    expect(button("attach screen to prompt")).toBeTruthy();
    expect(button("fill the column")).toBeTruthy();
    resizePane(300);
    expect(host.querySelector('button[aria-label="attach screen to prompt"]')).toBeNull();
    expect(host.querySelector('button[aria-label="fill the column"]')).toBeNull();
    expect(button("close device pane")).toBeTruthy();
    click(button("More device controls"));
    const menu = host.querySelector('[role="menu"]');
    if (!menu) throw new Error("Device controls menu is missing");
    expect(button("attach screen to prompt", menu)).toBeTruthy();
    expect(button("fill the column", menu)).toBeTruthy();
  });
  function foldState(posture: "open" | "closed" | "flipped", folded: "closed" | "flipped"): DevicePaneState {
    const state = deviceState(firstBinding, "native_fold");
    state.posture = posture;
    state.capabilities.postures = { available: true, reason: null, supported: [folded, "half-open", "open"].map((entry, index) => ({
      posture: entry as "closed" | "flipped" | "half-open" | "open", nativeId: index + 1, minAngle: 0, maxAngle: 180, targetAngle: 90,
    })) };
    return state;
  }
  it("hides fake fold controls on ordinary phones, retaining the reason in More", () => {
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector('button[aria-label="Fold"]')).toBeNull();
    click(button("More device controls"));
    const menu = host.querySelector('[role="menu"]');
    expect(menu?.textContent).not.toContain("Half-open");
  });
  it.each(["closed", "flipped"] as const)("toggles the native %s endpoint and displays observed posture", (endpoint) => {
    publish(foldState("open", endpoint));
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Fold"]');
    if (!toggle) throw new Error("Fold toggle is missing");
    expect(toggle.textContent).toContain("Open");
    click(toggle);
    expect(actDevicePane).toHaveBeenLastCalledWith(tabId, { action: "set-posture", bindingId: firstBinding, posture: endpoint });
    publish(foldState(endpoint, endpoint));
    click(button("Unfold"));
    expect(actDevicePane).toHaveBeenLastCalledWith(tabId, { action: "set-posture", bindingId: firstBinding, posture: "open" });
  });
  it("offers only supported postures in the adjacent selector", () => {
    publish(foldState("open", "closed"));
    const select = host.querySelector("select");
    if (!select) throw new Error("Posture selector is missing");
    expect(Array.from(select.options, (option) => option.value)).toEqual(["closed", "half-open", "open"]);
    act(() => {
      select.value = "half-open";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(actDevicePane).toHaveBeenLastCalledWith(tabId, { action: "set-posture", bindingId: firstBinding, posture: "half-open" });
  });
});

describe("DevicePane capture and input readiness", () => {
  const operations: NonNullable<DevicePaneState["operation"]>[] = [
    { kind: "bind", stage: "connecting" },
    { kind: "rotate", stage: "rotating", rotation: 1 },
    { kind: "set-posture", stage: "changing-posture", posture: "closed" },
  ];
  it.each(operations)("paints a static frame during $kind and unlocks it on a ready-only push", async (operation) => {
    const locked = { ...deviceState(firstBinding, "static_phone"), operation, inputReady: false };
    publish(locked);
    activate();
    const header = frameHeader(locked);
    const delivery = deliverFrame(header);
    expect(decodeImage).toHaveBeenCalledTimes(1);
    expect(drawImage).not.toHaveBeenCalled();
    expect(button(t("device.toolbar.home")).disabled).toBe(true);
    expect(button(t("device.toolbar.attach")).disabled).toBe(true);

    await finishFrame(delivery);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(canvas().style.visibility).toBe("visible");
    const captured = useStore.getState().rpc[tabId]!.devicePane;
    expect(captured.frame).toEqual(header);
    expect(button(t("device.toolbar.home")).disabled).toBe(true);
    expect(button(t("device.toolbar.attach")).disabled).toBe(true);
    click(button(t("device.toolbar.home")));
    click(button(t("device.toolbar.attach")));
    const proxy = host.querySelector("input");
    if (!proxy) throw new Error("Device text input is missing");
    act(() => proxy.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "locked" })));
    expect(backend.devicePaneInput).not.toHaveBeenCalled();
    expect(queueComposerAttachment).not.toHaveBeenCalled();

    pushState({ ...locked, inputReady: true, operation: null });
    expect(useStore.getState().rpc[tabId]!.devicePane.frame).toBe(captured.frame);
    expect(useStore.getState().rpc[tabId]!.devicePane.streamGeneration).toBe(captured.streamGeneration);
    expect(canvas().style.visibility).toBe("visible");
    expect(button(t("device.toolbar.home")).disabled).toBe(false);
    expect(button(t("device.toolbar.attach")).disabled).toBe(false);
    click(button(t("device.toolbar.home")));
    expect(backend.devicePaneInput).toHaveBeenCalledExactlyOnceWith(tabId, { type: "button", button: "home", bindingId: firstBinding, geometryRevision: 1 });
    click(button(t("device.toolbar.attach")));
    expect(queueComposerAttachment).toHaveBeenCalledExactlyOnceWith(tabId, { type: "image", data: "c2NyZWVu", mimeType: "image/jpeg" }, expect.any(String));
    expect(decodeImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("retains a painted image across a later input lock without enabling input or attachment", async () => {
    const state = deviceState(firstBinding, "current_phone");
    activate();
    await finishFrame(deliverFrame(frameHeader(state)));
    const captured = useStore.getState().rpc[tabId]!.devicePane.frame;
    const home = button(t("device.toolbar.home"));
    const attach = button(t("device.toolbar.attach"));
    const proxy = host.querySelector("input");
    if (!proxy) throw new Error("Device text input is missing");
    act(() => {
      useStore.getState().handleDevicePaneState(tabId, { ...state, inputReady: false, operation: { kind: "rotate", stage: "rotating", rotation: 2 } });
      // Handlers retained from the ready render must consult the new host state.
      home.click();
      attach.click();
      proxy.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "locked" }));
    });
    expect(canvas().style.visibility).toBe("visible");
    expect(useStore.getState().rpc[tabId]!.devicePane.frame).toBe(captured);
    expect(button(t("device.toolbar.home")).disabled).toBe(true);
    expect(button(t("device.toolbar.attach")).disabled).toBe(true);
    click(button(t("device.toolbar.home")));
    click(button(t("device.toolbar.attach")));
    expect(backend.devicePaneInput).not.toHaveBeenCalled();
    expect(queueComposerAttachment).not.toHaveBeenCalled();
    pushState(state);
    expect(button(t("device.toolbar.home")).disabled).toBe(false);
    expect(button(t("device.toolbar.attach")).disabled).toBe(false);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("rejects old geometry before JPEG decode even while input is locked", async () => {
    const state = { ...deviceState(firstBinding, "current_phone"), geometryRevision: 2, inputReady: false };
    publish(state);
    activate();
    await act(async () => { await deliverFrame({ ...frameHeader(state), geometryRevision: 1 }); });
    expect(decodeImage).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
    expect(useStore.getState().rpc[tabId]!.devicePane.frame).toBeNull();
  });

  it("discards an in-flight old geometry and paints the current geometry before host readiness", async () => {
    const state = deviceState(firstBinding, "current_phone");
    activate();
    const staleDelivery = deliverFrame(frameHeader(state));
    const current = { ...state, geometryRevision: 2, inputReady: false, operation: operations[1]! };
    pushState(current);
    const staleBitmap = await finishFrame(staleDelivery);
    expect(staleBitmap.close).toHaveBeenCalledTimes(1);
    expect(drawImage).not.toHaveBeenCalled();
    expect(canvas().style.visibility).toBe("hidden");
    expect(useStore.getState().rpc[tabId]!.devicePane.frame).toBeNull();
    await finishFrame(deliverFrame(frameHeader(current)), 1);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(canvas().style.visibility).toBe("visible");
    expect(button(t("device.toolbar.attach")).disabled).toBe(true);
    pushState({ ...current, inputReady: true, operation: null });
    click(button(t("device.toolbar.home")));
    expect(backend.devicePaneInput).toHaveBeenCalledExactlyOnceWith(tabId, { type: "button", button: "home", bindingId: firstBinding, geometryRevision: 2 });
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("replays a static frame that arrived before its geometry state without restarting capture", async () => {
    const state = deviceState(firstBinding, "static_phone");
    activate();
    const current = { ...state, geometryRevision: 2, inputReady: false, operation: operations[1]! };
    const header = frameHeader(current);
    await act(async () => { await deliverFrame(header); });
    expect(decodeImage).not.toHaveBeenCalled();
    const subscribe = vi.mocked(backend.devicePaneSubscribe);
    const clientId = subscribe.mock.calls.find(([id, , on]) => id === tabId && on)?.[1];
    if (clientId === undefined) throw new Error("Active device has no subscription identity");
    subscribe.mockClear();
    let replay: Promise<void> | undefined;
    subscribe.mockImplementation((id, _clientId, on) => {
      if (!on) return;
      const write = devicePaneWriters.get(id);
      if (!write) throw new Error("Cached frame replay preceded painter registration");
      replay = Promise.resolve(write(frameBytes(header)));
    });
    pushState(current);
    expect(subscribe).toHaveBeenCalledExactlyOnceWith(tabId, clientId, true);
    if (replay === undefined) throw new Error("Current geometry did not request its cached frame");
    await finishFrame(replay);
    expect(canvas().style.visibility).toBe("visible");
    expect(button(t("device.toolbar.attach")).disabled).toBe(true);
    pushState({ ...current, inputReady: true, operation: null });
    expect(button(t("device.toolbar.attach")).disabled).toBe(false);
    expect(decodeImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it.each(["binding", "stream generation", "owner", "hidden tab"] as const)("does not draw after the %s changes during decode", async (transition) => {
    const state = deviceState(firstBinding, "current_phone");
    activate();
    const delivery = deliverFrame(frameHeader(state));
    act(() => {
      if (transition === "binding") useStore.getState().handleDevicePaneState(tabId, deviceState(secondBinding, "replacement_phone"));
      else if (transition === "owner") useStore.setState({ state: remoteOwnedState(tabId, "replacement-owner") });
      else if (transition === "hidden tab") useStore.setState({ activeTabId: null });
      else useStore.setState((store) => {
        const rpc = store.rpc[tabId]!;
        return { rpc: { ...store.rpc, [tabId]: { ...rpc, devicePane: { ...rpc.devicePane, streamGeneration: rpc.devicePane.streamGeneration + 1, frame: null } } } };
      });
    });
    const bitmap = await finishFrame(delivery);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(drawImage).not.toHaveBeenCalled();
    expect(useStore.getState().rpc[tabId]!.devicePane.frame).toBeNull();
    expect(button(t("device.toolbar.attach")).disabled).toBe(true);
  });
});

describe("DevicePane owner status and recovery", () => {
  it.each(["en", "ko"] as const)("shows the joined owner, known API and localized readiness in %s", async (locale) => {
    const state = deviceState(firstBinding, "native_phone");
    const inventory: DeviceInventory = {
      sdk: { status: "ready", sdkRoot: "/opt/android-sdk" },
      targets: [{ serial: state.serial, avd: state.avd!, state: "running", friendlyName: "Native phone", api: 35 }],
      profiles: [], images: [], creation: { available: false, reason: null, sdkRoot: "/opt/android-sdk", installCommand: null },
    };
    const ownerState = remoteOwnedState(tabId, "device-owner");
    const owner = ownerState.remoteInstances[0]!;
    owner.nickname = "Android workstation";
    act(() => {
      applyLocale(resolveLocale(locale));
      useStore.setState({ state: ownerState });
    });
    publish(state, inventory);
    activate();
    await finishFrame(deliverFrame(frameHeader(state)));
    const header = button(t("device.toolbar.target"));
    expect(header.textContent).toContain(owner.nickname);
    expect(header.textContent).toContain("Native phone");
    expect(header.textContent).toContain(t("device.picker.api", { api: 35 }));
    expect(header.textContent).toContain(t("hud.status.ready"));
    expect(header.textContent).not.toContain(state.serial);

    pushState({ ...state, inputReady: false, agent: "acting", operation: { kind: "rotate", stage: "rotating", rotation: 1 } });
    const statuses = Array.from(header.querySelectorAll('[role="status"]'));
    expect(statuses.some((entry) => entry.textContent?.includes(t("device.state.rotating")))).toBe(true);
    expect(statuses.some((entry) => entry.textContent === t("device.agent.acting"))).toBe(true);
    expect(header.textContent).toContain(owner.nickname);
    expect(header.textContent).toContain(t("device.picker.api", { api: 35 }));
  });

  it("offers refresh and device selection after a failed control without hiding the usable screen", async () => {
    const state = deviceState(firstBinding, "current_phone");
    activate();
    await finishFrame(deliverFrame(frameHeader(state)));
    pushState({ ...state, actionError: "Rotation request was rejected" });
    const alert = host.querySelector('[role="alert"]');
    if (!alert) throw new Error("Failed control has no recovery banner");
    expect(alert.textContent).toContain("Rotation request was rejected");
    expect(canvas().style.visibility).toBe("visible");
    expect(button(t("device.toolbar.attach")).disabled).toBe(false);
    expect(button(t("device.toolbar.refresh"), alert).disabled).toBe(false);
    await act(async () => { button(t("device.toolbar.refresh"), alert).click(); });
    expect(actDevicePane).toHaveBeenCalledExactlyOnceWith(tabId, { action: "refresh", bindingId: firstBinding });
    expect(ensureDevicePane).toHaveBeenCalledExactlyOnceWith(tabId);
    click(button(t("device.toolbar.choose"), alert));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(t("device.picker.title"));
    expect(canvas().style.visibility).toBe("visible");
    expect(actDevicePane).toHaveBeenCalledTimes(1);
  });
});
