import {
  CH,
  DEVICE_PANE_ACTING_MS,
  decodeDevicePaneFrame,
  encodeKeyInput,
  encodeTouchInput,
  resolveAndroidAvdHome,
  type AndroidSdkPaths,
  type DevicePaneInputEvent,
  type DevicePaneState,
  type EmulatorNotification,
  type EmulatorRotation,
} from "@omp-ui/core";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevicePaneHost, type DeviceRunResult, type DevicePaneHostDeps, type EmulatorGrpc } from "./device-pane-host";
import { GrpcStatusError } from "./emulator-grpc";

const SDK: AndroidSdkPaths = {
  sdkRoot: "/sdk", adb: "/sdk/platform-tools/adb", emulator: "/sdk/emulator/emulator",
  avdmanager: "/sdk/cmdline-tools/latest/bin/avdmanager",
};
const SERIAL = "emulator-5580";
const SECOND = "emulator-5582";
const ABI = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
const IMAGE = `system-images;android-35;google_apis;${ABI}`;
const CONFIG = [
  "hw.device.name=pixel_fold", "hw.accelerometer=yes", "hw.lcd.width=2208", "hw.lcd.height=1840",
  "hw.keyboard=no", "hw.sensor.hinge=yes", "hw.sensor.hinge.count=1", "hw.sensor.hinge.ranges=0-180",
  "hw.sensor.hinge_angles_posture_definitions=0-30,30-150,150-180", "hw.sensor.posture_list=1,2,3",
  "hw.sensor.hinge.resizable.config=1", "hw.sensor.hinge.fold_to_displayRegion.0.1_at_posture=1",
  "hw.displayRegion.0.1.width=1080", "hw.displayRegion.0.1.height=2092", "hw.displayRegion.0.1.xOffset=0",
  "hw.displayRegion.0.1.yOffset=0", "target=android-35", "",
].join("\n");
const SUPPORTED_GUEST_STATES = "DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=1, name='HALF_OPENED'}\nDeviceState{identifier=2, name='OPENED'}";
const ok = (stdout = ""): DeviceRunResult => ({ code: 0, stdout, stderr: "" });
function varint(n: number): number[] {
  const bytes: number[] = [];
  while (n >= 128) { bytes.push((n % 128) | 128); n = Math.floor(n / 128); }
  bytes.push(n);
  return bytes;
}
function uint(field: number, value: number): number[] { return [...varint(field * 8), ...varint(value)]; }
function message(field: number, bytes: readonly number[]): number[] { return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]; }
function image(opts: { q?: EmulatorRotation; width?: number; height?: number; display?: number; timestamp?: number; fill?: number; folded?: { width: number; height: number; xOffset: number; yOffset: number } } = {}): Uint8Array {
  const width = opts.width ?? 4;
  const height = opts.height ?? 8;
  const format = [...uint(1, 1), ...message(2, uint(1, opts.q ?? 0)), ...uint(3, width), ...uint(4, height), ...uint(5, opts.display ?? 0)];
  if (opts.folded) format.push(...message(7, [...uint(1, opts.folded.width), ...uint(2, opts.folded.height), ...uint(3, opts.folded.xOffset), ...uint(4, opts.folded.yOffset)]));
  const pixels: number[] = [];
  for (let i = 0; i < width * height; i++) pixels.push(opts.fill ?? 42, 3, 7, 255);
  return Uint8Array.from([...message(1, format), ...message(4, pixels), ...uint(6, opts.timestamp ?? 100)]);
}

type OwnerInput = { [Type in DevicePaneInputEvent["type"]]: Omit<Extract<DevicePaneInputEvent, { type: Type }>, "bindingId" | "geometryRevision"> }[DevicePaneInputEvent["type"]];
interface ConsumedTouch { x: number; y: number; id: number; pressure: number; display: number }
// Independent wire consumer: trajectory assertions must not merely echo the production encoder.
function inputFields(bytes: Uint8Array): Map<number, bigint | Uint8Array> {
  let offset = 0;
  const uint = () => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
      shift += 7n;
    }
  };
  const fields = new Map<number, bigint | Uint8Array>();
  while (offset < bytes.length) {
    const tag = Number(uint());
    if ((tag & 7) === 0) fields.set(tag >> 3, uint());
    else if ((tag & 7) === 2) {
      const size = Number(uint());
      fields.set(tag >> 3, bytes.subarray(offset, offset + size));
      offset += size;
    } else throw new Error(`Unexpected input wire type ${tag & 7}`);
  }
  return fields;
}
function consumedTouches(inputs: Uint8Array[]): ConsumedTouch[] {
  const touches: ConsumedTouch[] = [];
  for (const bytes of inputs) {
    const touchEvent = inputFields(bytes).get(2);
    if (!(touchEvent instanceof Uint8Array)) continue;
    const event = inputFields(touchEvent);
    const contactBytes = event.get(1);
    if (!(contactBytes instanceof Uint8Array)) throw new Error("Missing touch contact");
    const contact = inputFields(contactBytes);
    touches.push({ x: Number(contact.get(1) ?? 0n), y: Number(contact.get(2) ?? 0n), id: Number(contact.get(3) ?? 0n), pressure: Number(contact.get(4) ?? 0n), display: Number(event.get(2) ?? 0n) });
  }
  return touches;
}

const QEMU_WHEEL = [
  "Input Reader State:", "  Device 3: QEMU Virtio Dual Mode Mouse",
  "    Identifier: bus=0x0006, vendor=0x0627, product=0x0004, version=0x0001",
  "    Enabled: true", "    Sources: 0x00002002", "    AssociatedDisplayId: 0", "    Motion Ranges:",
  "      VSCROLL: source=0x00002002, min=-1.000, max=1.000", "      HSCROLL: source=0x00002002, min=-1.000, max=1.000",
  "    Cursor Input Mapper:", "      HaveVWheel: true", "      HaveHWheel: true", "",
].join("\n");

function harness(options: {
  config?: string;
  sdk?: AndroidSdkPaths | null;
  run?: (file: string, args: string[]) => Promise<DeviceRunResult | undefined>;
  endpoint?: DevicePaneHostDeps["ensureEndpoint"];
  read?: (file: string) => Promise<string | undefined>;
  write?: (file: string, text: string) => Promise<void>;
  stat?: DevicePaneHostDeps["statFile"];
  now?: DevicePaneHostDeps["now"];
  deferInput?: boolean;
} = {}) {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const streams: Array<{ onMessage(raw: Uint8Array): void; signal: AbortSignal }> = [];
  const notifications: Array<{ onMessage(event: EmulatorNotification): void; signal: AbortSignal }> = [];
  const inputs: Uint8Array[] = [];
  const inputWrites: Array<{ bytes: Uint8Array; isCurrent?: () => boolean }> = [];
  const pendingInputs: Array<() => void> = [];
  let deferInput = options.deferInput ?? false;
  const openInput = vi.fn<EmulatorGrpc["openInput"]>(() => {
    let closed = false;
    return {
      send: (bytes, isCurrent) => {
        inputWrites.push({ bytes, isCurrent });
        const consume = () => { if (!closed && (isCurrent?.() ?? true)) inputs.push(bytes); };
        if (deferInput) pendingInputs.push(consume);
        else consume();
      },
      close: () => { closed = true; },
    };
  });
  const encodes: Array<{ width: number; height: number; firstPixel: number[] }> = [];
  const files = new Map<string, string>();
  const avdHome = resolveAndroidAvdHome(process.env, "/home/test");
  const cfg = path.join(avdHome, "Fold.avd", "config.ini");
  files.set(cfg, options.config ?? CONFIG);
  files.set(path.join(avdHome, "Other.avd", "config.ini"), options.config ?? CONFIG);
  const models = new Map([[1, [0, 0, 0]], [10, [180]], [16, [3]]]);
  const getScreenshot = vi.fn<EmulatorGrpc["getScreenshot"]>(() => Promise.withResolvers<Uint8Array>().promise);
  const setClipboard = vi.fn<EmulatorGrpc["setClipboard"]>(async () => {});
  const setVmState = vi.fn<EmulatorGrpc["setVmState"]>(async () => {});
  const getPhysicalModel = vi.fn<EmulatorGrpc["getPhysicalModel"]>(async (target) => ({ target, status: 0, values: models.get(target) ?? [] }));
  const setPhysicalModel = vi.fn<EmulatorGrpc["setPhysicalModel"]>(async (target, values) => {
    models.set(target, [...values]);
    if (target === 10) models.set(16, [values[0] <= 30 ? 1 : values[0] < 150 ? 2 : 3]);
  });
  const getDisplayConfigurations = vi.fn<EmulatorGrpc["getDisplayConfigurations"]>(async () => [{ display: 0, width: 2208, height: 1840, dpi: 420, flags: 0 }]);
  const close = vi.fn();
  const connectionErrors = new Set<(err: Error) => void>();
  const client: EmulatorGrpc = {
    streamScreenshot: (_format, onMessage, signal) => {
      streams.push({ onMessage, signal });
      const { promise, resolve } = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => resolve(), { once: true });
      return promise;
    },
    streamNotification: (onMessage, signal) => {
      notifications.push({ onMessage, signal });
      const { promise, resolve } = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => resolve(), { once: true });
      return promise;
    },
    getScreenshot, openInput,
    setClipboard, setVmState, getPhysicalModel, setPhysicalModel, getDisplayConfigurations,
    onError: (listener) => { connectionErrors.add(listener); return () => { connectionErrors.delete(listener); }; }, close,
  };
  const run = vi.fn<NonNullable<DevicePaneHostDeps["run"]>>(async (file, args) => {
    const override = await options.run?.(file, args);
    if (override !== undefined) return override;
    const command = args.join(" ");
    if (command === "devices") return ok(`List of devices attached\n${SERIAL}\tdevice\n${SECOND}\tdevice\n`);
    if (command === "-list-avds") return ok("Fold\nOther\nStopped\n");
    if (command === "-accel-check") return ok("accel:\n0\nKVM is installed and usable.\naccel\n");
    if (command === "list device") return ok('id: 0 or "pixel_fold"\n    Name: Pixel Fold\nid: 1 or "small_phone"\n    Name: Small Phone\nid: 2 or "7.6in Foldable"\n    Name: 7.6in Foldable\n');
    if (command.endsWith("emu avd name")) return ok(`${args.includes(SECOND) ? "Other" : "Fold"}\nOK\n`);
    if (command.endsWith("cmd device_state print-states")) return ok(SUPPORTED_GUEST_STATES);
    if (command.endsWith("dumpsys device_state")) {
      const nativeId = models.get(16)?.[0] ?? 3;
      const name = ["UNKNOWN", "CLOSED", "HALF_OPENED", "OPENED", "FLIPPED", "TENT"][nativeId];
      return ok(`mCommittedState=Optional[DeviceState{identifier=${nativeId - 1}, name='${name}'}]\nmBaseState=Optional[DeviceState{identifier=${nativeId - 1}, name='${name}'}]`);
    }
    if (command.endsWith("dumpsys sensorservice")) return ok("Goldfish hinge sensor0 (in degrees) | type: android.sensor.hinge_angle(36)\nGoldfish 3-axis Accelerometer | type: android.sensor.accelerometer(1)");
    if (command.endsWith("dumpsys display")) return ok("mScreenState=ON");
    if (command.endsWith("sys.boot_completed")) return ok("1");
    if (file.endsWith("avdmanager") && args[0] === "create") return ok("Created");
    if (file === process.execPath) return ok("agent result");
    return { code: 1, stdout: "", stderr: "unexpected command" };
  });
  const writes = vi.fn(async (file: string, text: string) => {
    if (options.write) await options.write(file, text);
    files.set(file, text);
  });
  const spawnDetached = vi.fn<NonNullable<DevicePaneHostDeps["spawnDetached"]>>(() => 12345);
  const read = vi.fn(async (file: string) => {
    const override = await options.read?.(file);
    if (override !== undefined) return override;
    if (files.has(file)) return files.get(file)!;
    if (file.endsWith("source.properties")) return `AndroidVersion.ApiLevel=35\nAndroidVersion.CodeName=REL\nSystemImage.TagId=google_apis\nSystemImage.Abi=${ABI}\nPkg.Path=${IMAGE}\n`;
    return "";
  });
  const host = new DevicePaneHost({
    send: (channel, ...args) => sent.push({ channel, args }),
    encodeJpeg: (bgra, width, height) => {
      encodes.push({ width, height, firstPixel: [...bgra.subarray(0, 4)] });
      return Uint8Array.of(255, 216, encodes.length, 255, 217);
    },
    sdk: () => options.sdk === undefined ? SDK : options.sdk, run, spawnDetached, createGrpc: () => client,
    ensureEndpoint: options.endpoint ?? (async () => ({ port: 8554, token: "secret" })),
    discover: () => [], pidAlive: () => true,
    statFile: options.stat ?? (async () => ({ isFile: true, size: 4096 })),
    listDir: async (dir) => {
      if (dir === path.join(SDK.sdkRoot, "system-images")) return ["android-35"];
      if (dir.endsWith("android-35")) return ["google_apis"];
      if (dir.endsWith("google_apis")) return [ABI];
      if (dir.endsWith(ABI)) return ["system.img", "vendor.img", "ramdisk.img", "kernel-ranchu", "source.properties"];
      return [];
    },
    readFile: read, writeFile: writes, home: () => "/home/test", agentDeviceBin: () => "/app/agent-device.mjs",
    stateDir: () => "/state", tempDir: () => "/tmp", now: options.now ?? (() => Date.now()),
  });
  const states = (tab = "t") => sent.filter((s) => s.channel === CH.onDevicePaneState && s.args[0] === tab).map((s) => s.args[1] as DevicePaneState);
  const state = (tab = "t") => states(tab).at(-1)!;
  const frames = (tab = "t") => sent.filter((s) => s.channel === CH.onDevicePaneFrame && s.args[0] === tab).map((s) => s.args[1] as Uint8Array);
  const input = (event: OwnerInput, tab = "t") => {
    const current = state(tab);
    host.input(tab, { ...event, bindingId: current.bindingId!, geometryRevision: current.geometryRevision });
  };
  const capture = (tab = "t") => {
    // Inspect allocation state through the same in-process seam used for revision overflow below.
    const internals = host as unknown as { entries: Map<string, { observedTimestampUs: number; cached: Uint8Array | null; bgra: Uint8Array; slotTimer: NodeJS.Timeout | undefined }> };
    const entry = internals.entries.get(tab)!;
    return { timestampUs: entry.observedTimestampUs, cached: entry.cached, bgraBytes: entry.bgra.length, slotScheduled: entry.slotTimer !== undefined };
  };
  const bind = async (tab = "t", serial = SERIAL) => {
    await host.act(tab, { action: "bind", serial });
    host.setOpen(tab, true);
    host.subscribe(tab, "client", true);
    streams.at(-1)!.onMessage(image());
    return state(tab);
  };
  return { host, sent, streams, notifications, inputs, encodes, files, cfg, read, writes, models, run, spawnDetached, close,
    disconnect: (error: Error) => { for (const listener of connectionErrors) listener(error); },
    inputWrites, openInput, flushInputs: () => { deferInput = false; for (const consume of pendingInputs.splice(0)) consume(); },
    client, getScreenshot, getPhysicalModel, setPhysicalModel, getDisplayConfigurations, setClipboard, setVmState, states, state, frames, input, capture, bind };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

// These are owner behavior tests; recipe count/order and synthesized donor geometries are deliberately absent.
describe("device owner inventory and lifecycle", () => {
  it("lists real native profile/image offers and SDK setup readiness", async () => {
    const h = harness();
    const inventory = await h.host.inventory();
    expect(inventory.images.map((i) => i.packageId)).toEqual([IMAGE]);
    expect(inventory.profiles.find((p) => p.id === "pixel_fold")).toMatchObject({ available: true, defaultImagePackage: IMAGE });
    expect(inventory.creation).toMatchObject({ available: true, sdkRoot: "/sdk" });
    expect(inventory.targets).toEqual(expect.arrayContaining([expect.objectContaining({ avd: "Stopped", state: "stopped" })]));
    expect(inventory.targets.find((target) => target.avd === "Fold")).toMatchObject({ friendlyName: "Pixel Fold", api: 35 });
  });
  it.each([{ isFile: false, size: 4096 }, { isFile: true, size: 0 }])("excludes half-installed image file placeholders (%j)", async (info) => {
    const h = harness({ stat: async (file) => file.endsWith("system.img") ? info : { isFile: true, size: 4096 } });
    const inventory = await h.host.inventory();
    expect(inventory.images).toEqual([]);
    expect(inventory.creation.available).toBe(false);
  });

  it("does not mark the caller's own serial unavailable but exposes other tab ownership", async () => {
    const h = harness();
    await h.bind();
    expect((await h.host.inventory("t")).targets.find((target) => target.serial === SERIAL)?.availabilityReason).toBeUndefined();
    expect((await h.host.inventory("other")).targets.find((target) => target.serial === SERIAL)?.availabilityReason).toBe("in use by another session");
  });


  it("reports actual acceleration output and SDK location before tearing down a usable binding", async () => {
    const h = harness({ run: async (_file, args) => args[0] === "-accel-check" ? { code: 1, stdout: "accel:\n1\n/dev/kvm is not writable\n", stderr: "" } : undefined });
    const initial = await h.bind();
    await h.host.act("t", { action: "boot", avd: "Stopped" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({ bindingId: initial.bindingId, serial: SERIAL, phase: "streaming", inputReady: true });
    expect(h.state().actionError).toContain("/sdk/emulator/emulator");
    expect(h.state().actionError).toContain("/dev/kvm");
    expect(h.spawnDetached).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it("leaves a working binding intact when another tab owns the rejected target", async () => {
    const h = harness();
    const first = await h.bind();
    await h.bind("other", SECOND);
    const rejected = await h.host.act("t", { action: "bind", serial: SECOND });
    expect(rejected).toMatchObject({ bindingId: first.bindingId, serial: SERIAL, phase: "streaming", actionError: "in use by another session" });
    expect(rejected.inputReady).toBe(true);
  });

  it("rejects a nonexistent AVD without implicit creation or disturbing a working device", async () => {
    const h = harness();
    const first = await h.bind();
    await h.host.act("t", { action: "boot", avd: "pixel_fold" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({ bindingId: first.bindingId, serial: SERIAL, phase: "streaming" });
    expect(h.state().actionError).toContain("does not exist");
    expect(h.run.mock.calls.some(([, args]) => args[0] === "create")).toBe(false);
    expect(h.spawnDetached).not.toHaveBeenCalled();
  });

  it("accepts existing boot immediately and never modifies its config", async () => {
    const h = harness();
    const accepted = await h.host.act("t", { action: "boot", avd: "Stopped" });
    expect(accepted).toMatchObject({ phase: "booting", geometryRevision: 1, operation: { kind: "boot", stage: "starting" } });
    expect(accepted.bindingId).toMatch(/^[a-f0-9-]{36}$/);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawnDetached).toHaveBeenCalledWith(SDK.emulator, expect.arrayContaining(["-avd", "Stopped", "-no-window", "-gpu"]), expect.any(Object));
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.run.mock.calls.some(([, args]) => args[0] === "create")).toBe(false);
    h.host.dispose("t");
    await vi.advanceTimersByTimeAsync(500);
  });

  it("creates explicitly with the exact native device ID and installed image, patching only the real metadata keyboard path", async () => {
    const customDirectory = path.join(path.sep, "custom", "avds", "new.avd");
    const custom = path.join(customDirectory, "config.ini");
    let currentConfig = CONFIG;
    const h = harness({
      read: async (file) => file.endsWith("New.ini") ? `path=${customDirectory}\n` : file === custom ? currentConfig : undefined,
      write: async (file, text) => { if (file === custom) currentConfig = text; },
    });
    const accepted = await h.host.act("t", { action: "create", profileId: "pixel_fold", imagePackage: IMAGE, avd: "New" });
    expect(accepted).toMatchObject({ phase: "provisioning", operation: { kind: "create", stage: "creating" }, geometryRevision: 1 });
    expect(accepted.bindingId).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.run.mock.calls.find(([, args]) => args[0] === "create")?.[1]).toEqual(["create", "avd", "-n", "New", "-k", IMAGE, "-d", "pixel_fold"]);
    expect(h.writes).toHaveBeenCalledTimes(1);
    expect(h.writes.mock.calls[0]?.[0]).toBe(custom);
    expect(h.files.get(custom)).toBe(CONFIG.replace("hw.keyboard=no", "hw.keyboard=yes"));
    expect(h.read.mock.calls.filter(([file]) => file === custom)).toHaveLength(2);
    expect(h.spawnDetached).toHaveBeenCalledTimes(1);
    h.host.dispose("t");
    await vi.advanceTimersByTimeAsync(500);
  });

  it("retains the created AVD and reports repair instructions if keyboard readback fails", async () => {
    const h = harness({ read: async (file) => file.endsWith(path.join("New.avd", "config.ini")) ? CONFIG : undefined });
    await h.host.act("t", { action: "create", profileId: "pixel_fold", imagePackage: IMAGE, avd: "New" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({ phase: "error", operation: null });
    expect(h.state().error).toContain("left intact");
    expect(h.state().error).toContain("hw.keyboard=yes");
    expect(h.spawnDetached).not.toHaveBeenCalled();
  });

  it.each([".", "..", "-unsafe"])("rejects unsafe new name %s without invoking avdmanager", async (avd) => {
    const h = harness();
    await h.host.act("t", { action: "create", profileId: "pixel_fold", imagePackage: IMAGE, avd });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.run.mock.calls.some(([, args]) => args[0] === "create")).toBe(false);
  });

  it("rejects incompatible create image membership and leaves images and current AVD immutable", async () => {
    const h = harness();
    const current = await h.bind();
    const before = new Map(h.files);
    await h.host.act("t", { action: "create", profileId: "pixel_fold", imagePackage: "system-images;android-99;google_apis;wrong", avd: "New" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state().bindingId).toBe(current.bindingId);
    expect(h.files).toEqual(before);
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.spawnDetached).not.toHaveBeenCalled();
  });

  it("does not read back, spawn, or publish after a stale keyboard patch child settles", async () => {
    const write = Promise.withResolvers<void>();
    const h = harness({ write: async () => write.promise });
    await h.host.act("t", { action: "create", profileId: "pixel_fold", imagePackage: IMAGE, avd: "New" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.writes).toHaveBeenCalledTimes(1);
    h.host.dispose("t");
    const count = h.states().length;
    write.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawnDetached).not.toHaveBeenCalled();
    expect(h.states()).toHaveLength(count);
  });

  it("holds a create reservation and tab ownership through actual avdmanager settlement after detach", async () => {
    const child = Promise.withResolvers<DeviceRunResult>();
    const h = harness({ run: async (file, args) => file.endsWith("avdmanager") && args[0] === "create" ? child.promise : undefined });
    await h.host.act("t", { action: "create", profileId: "pixel_fold", imagePackage: IMAGE, avd: "New" });
    await vi.advanceTimersByTimeAsync(0);
    h.host.dispose("t");
    const sameTab = await h.host.act("t", { action: "bind", serial: SECOND });
    expect(sameTab.actionError).toContain("progress");
    await h.host.act("other", { action: "boot", avd: "New" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state("other").error).toBe("in use by another session");
    child.resolve(ok("Created"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.spawnDetached).not.toHaveBeenCalled();
    expect((await h.host.act("t", { action: "bind", serial: SECOND })).serial).toBe(SECOND);
  });

  it("never spawns after stale existing-AVD discovery completes", async () => {
    const listing = Promise.withResolvers<DeviceRunResult>();
    const h = harness({ run: async (_file, args) => args[0] === "-list-avds" ? listing.promise : undefined });
    const accepted = await h.host.act("t", { action: "boot", avd: "Stopped" });
    await h.host.act("t", { action: "unbind", bindingId: accepted.bindingId! });
    listing.resolve(ok("Stopped\n"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawnDetached).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ phase: "unbound", serial: null });
  });

  it("does not open a gRPC client after stale endpoint completion", async () => {
    const endpoint = Promise.withResolvers<{ port: number; token: string }>();
    const h = harness({ endpoint: () => endpoint.promise });
    const binding = h.host.act("t", { action: "bind", serial: SERIAL });
    await vi.advanceTimersByTimeAsync(0);
    const old = h.state().bindingId!;
    await h.host.act("t", { action: "unbind", bindingId: old });
    endpoint.resolve({ port: 8554, token: "secret" });
    await binding;
    expect(h.getPhysicalModel).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ phase: "unbound", bindingId: null });
  });

  it("fences power-off completion so it cannot disconnect a replacement binding", async () => {
    const shutdown = Promise.withResolvers<void>();
    const h = harness();
    const first = await h.bind();
    h.setVmState.mockImplementationOnce(() => shutdown.promise);
    const pending = h.host.act("t", { action: "power-off", bindingId: first.bindingId! });
    await h.host.act("t", { action: "unbind", bindingId: first.bindingId! });
    shutdown.resolve();
    await pending;
    await h.host.act("t", { action: "bind", serial: SECOND });
    expect(h.state()).toMatchObject({ serial: SECOND, phase: "streaming" });
    expect(h.run.mock.calls.some(([, args]) => args.join(" ").endsWith("emu kill"))).toBe(false);
  });

  it("remembers bindings without powering off when disposed and forgets only explicitly", async () => {
    const h = harness();
    await h.bind();
    h.host.dispose("t");
    expect(h.setVmState).not.toHaveBeenCalled();
    expect((await h.host.ensure("t")).state.serial).toBe(SERIAL);
    h.host.dispose("t", { forget: true });
    expect((await h.host.ensure("t")).state.bindingId).toBeNull();
  });
});

describe("observed device geometry and stream", () => {
  it("streams only with subscribers and retains newest-wins JPEG pacing with identity envelopes", async () => {
    const h = harness();
    await h.host.act("t", { action: "bind", serial: SERIAL });
    expect(h.streams).toHaveLength(0);
    h.host.subscribe("t", "a", true);
    h.host.subscribe("t", "b", true);
    expect(h.streams).toHaveLength(1);
    for (let i = 1; i <= 10; i++) h.streams[0].onMessage(image({ fill: i }));
    expect(h.encodes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(33);
    expect(h.encodes).toHaveLength(2);
    expect(h.encodes[1].firstPixel).toEqual([7, 3, 10, 255]);
    expect(decodeDevicePaneFrame(h.frames()[1])?.header).toMatchObject({ width: 4, height: 8, dsf: 1, bindingId: h.state().bindingId, geometryRevision: 1 });
    expect(h.host.diagnostics()[0]).toMatchObject({ framesEncoded: 2, framesCoalesced: 8 });
    h.host.subscribe("t", "a", false);
    expect(h.streams[0].signal.aborted).toBe(false);
    h.host.subscribe("t", "b", false);
    expect(h.streams[0].signal.aborted).toBe(true);
  });

  it("observes hidden bind, rotation and refresh without allocating a JPEG cache, then encodes the subscribed identity", async () => {
    const h = harness();
    const initial = await h.host.act("t", { action: "bind", serial: SERIAL });
    expect(initial).toMatchObject({ phase: "streaming", screen: "unknown", inputReady: false });
    expect(h.streams).toHaveLength(0);
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 100 }))
      .mockResolvedValueOnce(image({ q: 1, timestamp: 200 }))
      .mockResolvedValueOnce(image({ q: 1, timestamp: 300 }));
    const rotated = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    expect(rotated).toMatchObject({ rotation: 1, screen: "active", inputReady: true, actionError: null, operation: null });
    expect(h.capture()).toEqual({ timestampUs: 200, cached: null, bgraBytes: 0, slotScheduled: false });
    h.input({ type: "key", key: "Enter", phase: "down" });
    expect(h.openInput).not.toHaveBeenCalled();
    const refreshed = await h.host.act("t", { action: "refresh", bindingId: initial.bindingId! });
    expect(refreshed.geometryRevision).toBeGreaterThan(rotated.geometryRevision);
    expect(h.capture()).toEqual({ timestampUs: 300, cached: null, bgraBytes: 0, slotScheduled: false });
    expect(h.encodes).toHaveLength(0);
    expect(h.frames()).toHaveLength(0);
    expect(h.streams).toHaveLength(0);
    expect(h.host.diagnostics()[0]).toMatchObject({ subscribers: 0, framesEncoded: 0, framesCoalesced: 0 });

    h.getScreenshot.mockResolvedValueOnce(image({ q: 1, timestamp: 400, fill: 61 }));
    h.host.subscribe("t", "viewer", true);
    expect(h.frames()).toHaveLength(0);
    expect(h.streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.encodes).toEqual([{ width: 4, height: 8, firstPixel: [7, 3, 61, 255] }]);
    expect(decodeDevicePaneFrame(h.frames()[0])?.header).toMatchObject({ bindingId: refreshed.bindingId, geometryRevision: refreshed.geometryRevision, width: 4, height: 8 });
    expect(h.frames()[0].subarray(-5)).toEqual(Uint8Array.of(255, 216, 1, 255, 217));
    expect(h.capture().timestampUs).toBe(400);
    expect(h.streams.filter((stream) => !stream.signal.aborted)).toHaveLength(1);
    h.host.disposeAll();
    expect(h.streams[0].signal.aborted).toBe(true);
  });

  it("keeps one visible stream through rotation and resumes fresh pixels and input identity after a hidden posture", async () => {
    const h = harness();
    h.getScreenshot.mockResolvedValueOnce(image());
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockResolvedValueOnce(image({ q: 1, timestamp: 120 }));
    const rotated = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    expect(rotated).toMatchObject({ rotation: 1, inputReady: true, actionError: null });
    expect(h.streams).toHaveLength(1);
    expect(h.streams.filter((stream) => !stream.signal.aborted)).toHaveLength(1);
    expect(h.encodes).toHaveLength(2);
    const delivered = h.frames().length;
    h.host.subscribe("t", "client", false);
    expect(h.streams[0].signal.aborted).toBe(true);
    expect(h.capture().cached).toBeNull();
    const folded = { width: 1080, height: 2092, xOffset: 0, yOffset: 0 };
    h.getScreenshot.mockResolvedValueOnce(image({ q: 1, timestamp: 130 }))
      .mockResolvedValueOnce(image({ q: 1, width: 6, height: 12, timestamp: 140, folded, fill: 77 }));
    const hidden = await h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    expect(hidden).toMatchObject({ posture: "closed", screen: "active", inputReady: true, actionError: null, operation: null });
    expect(hidden.geometryRevision).toBeGreaterThan(rotated.geometryRevision);
    expect(h.capture()).toEqual({ timestampUs: 140, cached: null, bgraBytes: 4 * 8 * 4, slotScheduled: false });
    h.streams[0].onMessage(image({ q: 3, timestamp: 145 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.encodes).toHaveLength(2);
    expect(h.frames()).toHaveLength(delivered);
    expect(h.streams).toHaveLength(1);
    expect(h.streams.filter((stream) => !stream.signal.aborted)).toHaveLength(0);

    h.getScreenshot.mockResolvedValueOnce(image({ q: 1, width: 6, height: 12, timestamp: 150, folded, fill: 88 }));
    h.host.subscribe("t", "viewer", true);
    expect(h.frames()).toHaveLength(delivered);
    expect(h.streams).toHaveLength(2);
    expect(h.streams.filter((stream) => !stream.signal.aborted)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.encodes).toHaveLength(3);
    expect(h.encodes.at(-1)?.firstPixel).toEqual([7, 3, 88, 255]);
    expect(decodeDevicePaneFrame(h.frames().at(-1)!)?.header).toMatchObject({ bindingId: hidden.bindingId, geometryRevision: hidden.geometryRevision, width: 6, height: 12 });
    expect(h.frames().at(-1)!.subarray(-5)).toEqual(Uint8Array.of(255, 216, 3, 255, 217));
    h.host.input("t", { type: "key", key: "Enter", phase: "down", bindingId: rotated.bindingId!, geometryRevision: rotated.geometryRevision });
    expect(h.inputs).toHaveLength(0);
    h.input({ type: "key", key: "Enter", phase: "down" });
    expect(h.inputs).toEqual([encodeKeyInput({ eventType: 0, key: "Enter" })]);
    const resumedFrames = h.frames().length;
    h.host.disposeAll();
    expect(h.streams.every((stream) => stream.signal.aborted)).toBe(true);
    h.streams[1].onMessage(image({ q: 2, timestamp: 160 }));
    expect(h.encodes).toHaveLength(3);
    expect(h.frames()).toHaveLength(resumedFrames);
  });

  it("never mutates protobuf source pixels while converting RGBA into BGRA", async () => {
    const h = harness();
    await h.bind();
    const raw = image({ timestamp: 200 });
    const before = raw.slice();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(raw);
    expect(raw).toEqual(before);
    expect(h.encodes.at(-1)?.firstPixel).toEqual([7, 3, 42, 255]);
  });

  it.each([
    [0, 552, 736], [1, 1325, 460], [2, 1656, 1104], [3, 883, 1380],
  ] as const)("uses the proved inverse q%s on a natural-landscape primary", async (q, x, y) => {
    const h = harness();
    await h.bind();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ q, timestamp: 200 }));
    h.input({ type: "touch", phase: "down", x: 0.25, y: 0.4, pointer: 7 });
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x, y, id: 7, pressure: 1 }], 0));
  });

  it("distinguishes cover capture extent from primary alias input extent", async () => {
    const h = harness();
    await h.bind();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ folded: { width: 1080, height: 2092, xOffset: 0, yOffset: 0 }, timestamp: 200 }));
    h.input({ type: "touch", phase: "down", x: 600 / 1080, y: 1046 / 2092, pointer: 0 });
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 1227, y: 920, id: 0, pressure: 1 }], 0));
  });

  it("maps offset folded crops without inventing a cover display ID", async () => {
    const h = harness({ config: CONFIG.replace("hw.device.name=pixel_fold", "hw.device.name=8in Foldable").replace("hw.sensor.hinge.resizable.config=1", "hw.sensor.hinge.resizable.config=0") });
    await h.bind();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ folded: { width: 1000, height: 1500, xOffset: 200, yOffset: 100 }, timestamp: 200 }));
    h.input({ type: "touch", phase: "down", x: 0.25, y: 0.5, pointer: 2 });
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 450, y: 850, id: 2, pressure: 1 }], 0));
  });

  it("uses the observed secondary display extent and display ID, not the primary or hardcoded cover ID", async () => {
    const h = harness();
    h.getDisplayConfigurations.mockResolvedValue([{ display: 0, width: 2208, height: 1840, dpi: 420, flags: 0 }, { display: 6, width: 800, height: 1200, dpi: 320, flags: 0 }]);
    await h.bind();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ display: 6, timestamp: 200 }));
    h.input({ type: "touch", phase: "down", x: 0.5, y: 0.25, pointer: 1 });
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 400, y: 300, id: 1, pressure: 1 }], 6));
  });

  it("invalidates new metadata before the paced JPEG slot and rejects an old-revision touch immediately", async () => {
    const h = harness();
    const before = await h.bind();
    h.input({ type: "touch", phase: "down", x: 0.25, y: 0.4, pointer: 9 });
    const encodes = h.encodes.length;
    h.streams[0].onMessage(image({ q: 2, timestamp: 200 }));
    expect(h.state()).toMatchObject({ inputReady: false, geometryRevision: before.geometryRevision + 1, rotation: 2 });
    expect(h.encodes).toHaveLength(encodes);
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 552, y: 736, id: 9, pressure: 0 }]));
    const count = h.inputs.length;
    h.host.input("t", { type: "touch", phase: "down", x: 0.3, y: 0.4, pointer: 3, bindingId: before.bindingId!, geometryRevision: before.geometryRevision });
    expect(h.inputs).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(33);
    expect(h.encodes).toHaveLength(encodes + 1);
    expect(h.state().inputReady).toBe(true);
  });

  it("releases original pointer coordinates and rejects old identity on a same-size 180-degree transition", async () => {
    const h = harness();
    const before = await h.bind();
    h.input({ type: "touch", phase: "down", x: 0.25, y: 0.4, pointer: 9 });
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ q: 2, timestamp: 200 }));
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 552, y: 736, id: 9, pressure: 0 }]));
    expect(h.state().geometryRevision).toBe(before.geometryRevision + 1);
    const length = h.inputs.length;
    h.host.input("t", { type: "key", key: "Enter", phase: "down", bindingId: before.bindingId!, geometryRevision: before.geometryRevision });
    expect(h.inputs).toHaveLength(length);
  });

  it("screen-off immediately releases pointers and drops cached/pending frames and readiness", async () => {
    const h = harness();
    await h.bind();
    h.input({ type: "touch", phase: "down", x: 0.5, y: 0.5, pointer: 4 });
    h.streams[0].onMessage(image({ timestamp: 200 }));
    const frames = h.frames().length;
    h.streams[0].onMessage(new Uint8Array());
    expect(h.state()).toMatchObject({ screen: "inactive", inputReady: false });
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 1104, y: 920, id: 4, pressure: 0 }]));
    h.host.subscribe("t", "joining", true);
    await vi.advanceTimersByTimeAsync(33);
    expect(h.frames()).toHaveLength(frames);
    h.input({ type: "touch", phase: "down", x: 0.1, y: 0.1, pointer: 4 });
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 1104, y: 920, id: 4, pressure: 0 }]));
  });

  it("ignores power notifications for an unrelated display but invalidates observed active-display power-off", async () => {
    const h = harness();
    await h.bind();
    h.notifications[0].onMessage({ type: "display-power", display: 6, powerMode: 0 });
    expect(h.state().screen).toBe("active");
    h.notifications[0].onMessage({ type: "display-power", display: 0, powerMode: 0 });
    expect(h.state()).toMatchObject({ screen: "inactive", inputReady: false });
  });

  it("never grants readiness to malformed metadata and discards old stream callbacks", async () => {
    const h = harness();
    const before = await h.bind();
    await h.host.act("t", { action: "unbind", bindingId: before.bindingId! });
    await h.host.act("t", { action: "bind", serial: SECOND });
    h.streams[0].onMessage(image({ q: 2, timestamp: 300 }));
    expect(h.state()).toMatchObject({ serial: SECOND, screen: "unknown", inputReady: false });
    h.host.subscribe("t", "client", true);
    h.streams.at(-1)!.onMessage(Uint8Array.of(10, 4, 24, 255));
    expect(h.state().inputReady).toBe(false);
  });

  it("mints a fresh binding on revision overflow instead of wrapping u32 identity", async () => {
    const h = harness();
    const before = await h.bind();
    // Reach the otherwise impractical u32 rollover through the in-process test seam.
    const internals = h.host as unknown as { entries: Map<string, { geometryRevision: number }> };
    const entry = internals.entries.get("t")!;
    entry.geometryRevision = 0xffff_ffff;
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ q: 2, timestamp: 200 }));
    expect(h.state().bindingId).not.toBe(before.bindingId);
    expect(h.state().geometryRevision).toBe(1);
    expect(decodeDevicePaneFrame(h.frames().at(-1)!)?.header.geometryRevision).toBe(1);
  });

  it("fences Unicode clipboard completion across geometry and binding changes", async () => {
    const clipboard = Promise.withResolvers<void>();
    const h = harness();
    const before = await h.bind();
    h.setClipboard.mockReturnValueOnce(clipboard.promise);
    h.host.input("t", { type: "text", text: "안녕", bindingId: before.bindingId!, geometryRevision: before.geometryRevision });
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ q: 2, timestamp: 200 }));
    clipboard.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.inputs).toHaveLength(0);
  });

  it("types ASCII directly and fences a pending Unicode paste across replacement bindings", async () => {
    const paste = Promise.withResolvers<void>();
    const h = harness();
    const before = await h.bind();
    h.host.input("t", { type: "text", text: "hello", bindingId: before.bindingId!, geometryRevision: before.geometryRevision });
    expect(h.inputs).toEqual([encodeKeyInput({ eventType: 2, text: "hello" })]);
    h.inputs.length = 0;
    h.setClipboard.mockReturnValueOnce(paste.promise);
    h.host.input("t", { type: "text", text: "안녕", bindingId: before.bindingId!, geometryRevision: before.geometryRevision });
    await h.host.act("t", { action: "unbind", bindingId: before.bindingId! });
    await h.host.act("t", { action: "bind", serial: SECOND });
    paste.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.inputs).toEqual([]);
  });

  it("keeps arbitrary unknown special covers visible without guessing unsafe input geometry", async () => {
    const h = harness({ config: CONFIG.replace("hw.device.name=pixel_fold", "hw.device.name=custom_fold") });
    await h.bind();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ folded: { width: 1080, height: 2092, xOffset: 0, yOffset: 0 }, timestamp: 200 }));
    expect(h.state()).toMatchObject({ phase: "streaming", screen: "active", inputReady: false });
    expect(h.state().actionError).toContain("geometry");
    expect(h.frames()).toHaveLength(2);
  });

  it("guest OFF defeats fresh nonempty black screenshots and a misleading native ON notification", async () => {
    let power = "ON";
    const h = harness({ run: async (_file, args) => args.join(" ").endsWith("dumpsys display") ? ok(`mScreenState=${power}`) : undefined });
    await h.bind();
    h.input({ type: "touch", phase: "down", x: 0.5, y: 0.5, pointer: 4 });
    power = "OFF";
    await vi.advanceTimersByTimeAsync(1_000);
    const count = h.frames().length;
    h.notifications[0].onMessage({ type: "display-power", display: 0, powerMode: 2 });
    h.streams[0].onMessage(image({ fill: 0, timestamp: 200 }));
    expect(h.state()).toMatchObject({ screen: "inactive", inputReady: false });
    expect(h.frames()).toHaveLength(count);
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 1104, y: 920, id: 4, pressure: 0 }]));
    power = "ON";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.state().inputReady).toBe(false);
    h.streams[0].onMessage(image({ fill: 0, timestamp: 300 }));
    expect(h.state()).toMatchObject({ screen: "active", inputReady: true });
  });

  it("does not infer power-off from a black app or from a closed coverless hinge", async () => {
    const h = harness({ config: CONFIG.replace("hw.device.name=pixel_fold", "hw.device.name=6.7in Foldable") });
    await h.bind();
    h.notifications[0].onMessage({ type: "posture", posture: 1 });
    h.streams[0].onMessage(image({ fill: 0, timestamp: 200 }));
    expect(h.state()).toMatchObject({ posture: "closed", screen: "active", inputReady: true });
  });

  it("replays cached identity and preserves it when the pane closes", async () => {
    const h = harness();
    await h.bind();
    const original = h.frames()[0];
    h.host.setOpen("t", false);
    h.host.subscribe("t", "second", true);
    expect(h.frames().at(-1)).toBe(original);
    expect(h.streams[0].signal.aborted).toBe(false);
    expect(h.setVmState).not.toHaveBeenCalled();
  });
});

describe("finite owner wheel input", () => {
  it.each([
    [0, 0, -120, 1104, 736], [1, 0, -120, 1325, 920], [2, 0, -120, 1104, 1104], [3, 0, -120, 883, 920],
    [0, 120, 0, 1325, 920], [1, 120, 0, 1104, 1104], [2, 120, 0, 883, 920], [3, 120, 0, 1104, 736],
    [0, 0, 120, 1104, 1104], [0, -120, 0, 883, 920],
  ] as const)("consumes a finite q%s stroke for (%s,%s) in painted-space direction", async (q, dx, dy, x, y) => {
    const h = harness();
    await h.bind();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ q, timestamp: 200 }));
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx, dy });
    expect(h.inputs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    const touches = consumedTouches(h.inputs);
    expect(touches.length).toBeGreaterThan(4);
    expect(touches[0]).toEqual({ x: 1104, y: 920, id: 0, pressure: 1, display: 0 });
    expect(touches.at(-1)).toEqual({ x, y, id: 0, pressure: 0, display: 0 });
    for (let i = 1; i < touches.length; i++) {
      expect((touches[i].x - touches[i - 1].x) * (x - 1104)).toBeGreaterThanOrEqual(0);
      expect((touches[i].y - touches[i - 1].y) * (y - 920)).toBeGreaterThanOrEqual(0);
      expect(touches[i]).toMatchObject({ id: 0, display: 0 });
    }
    expect(h.inputs.every((bytes) => inputFields(bytes).has(2))).toBe(true);
    expect(h.openInput).toHaveBeenCalledTimes(1);
    h.host.disposeAll();
  });

  it.each(["cover", "offset", "secondary"] as const)("keeps the whole %s trajectory on its proved native route", async (route) => {
    const h = harness({ config: route === "offset" ? CONFIG.replace("hw.device.name=pixel_fold", "hw.device.name=8in Foldable") : CONFIG });
    if (route === "secondary") h.getDisplayConfigurations.mockResolvedValue([{ display: 6, width: 800, height: 1200, dpi: 320, flags: 0 }]);
    await h.bind();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ timestamp: 200,
      ...(route === "cover" ? { folded: { width: 1080, height: 2092, xOffset: 0, yOffset: 0 } }
        : route === "offset" ? { folded: { width: 1000, height: 1500, xOffset: 200, yOffset: 100 } } : { display: 6, q: 3 as const }),
    }));
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(400);
    const touches = consumedTouches(h.inputs);
    const first = route === "offset" ? { x: 700, y: 850 } : route === "secondary" ? { x: 400, y: 600 } : { x: 1104, y: 920 };
    const last = route === "offset" ? { x: 700, y: 700 } : route === "secondary" ? { x: 320, y: 600 } : { x: 1104, y: 736 };
    expect(touches[0]).toMatchObject({ ...first, pressure: 1, display: route === "secondary" ? 6 : 0 });
    expect(touches.at(-1)).toMatchObject({ ...last, pressure: 0, display: route === "secondary" ? 6 : 0 });
    for (const touch of touches) {
      expect(touch.x).toBeGreaterThanOrEqual(route === "offset" ? 200 : 0);
      expect(touch.x).toBeLessThan(route === "offset" ? 1200 : route === "secondary" ? 800 : 2208);
      expect(touch.y).toBeGreaterThanOrEqual(route === "offset" ? 100 : 0);
      expect(touch.y).toBeLessThan(route === "offset" ? 1600 : route === "secondary" ? 1200 : 1840);
    }
    h.host.disposeAll();
  });

  it("bounds burst state to an active stroke and one latest anchored pending vector", async () => {
    const h = harness();
    await h.bind();
    for (let i = 0; i < 100; i++) h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 120, dy: -120 });
    await vi.advanceTimersByTimeAsync(16);
    for (let i = 0; i < 100; i++) h.input({ type: "wheel", x: 0.6, y: 0.55, dx: 120, dy: -120 });
    await vi.advanceTimersByTimeAsync(500);
    const touches = consumedTouches(h.inputs);
    const releases = touches.flatMap((touch, index) => touch.pressure === 0 ? [index] : []);
    expect(releases).toHaveLength(2);
    expect(touches.length).toBeLessThanOrEqual(24);
    expect(touches[releases[0] + 1]).toMatchObject({ x: 1325, y: 1012, pressure: 1 });
    let start = 0;
    for (const end of releases) {
      expect(Math.hypot((touches[end].x - touches[start].x) / 2208, (touches[end].y - touches[start].y) / 1840)).toBeLessThanOrEqual(0.351);
      start = end + 1;
    }
    const count = h.inputs.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(h.inputs).toHaveLength(count);
    h.host.disposeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips obsolete samples when the event loop misses the active deadline", async () => {
    let now = 0;
    const h = harness({ now: () => now });
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(16);
    now = 1000;
    await vi.advanceTimersByTimeAsync(16);
    expect(consumedTouches(h.inputs)).toEqual([
      { x: 1104, y: 920, id: 0, pressure: 1, display: 0 },
      { x: 1104, y: 736, id: 0, pressure: 1, display: 0 },
      { x: 1104, y: 736, id: 0, pressure: 0, display: 0 },
    ]);
    h.host.disposeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { x: 0.5, y: 0.5, dx: 0, dy: 0 }, { x: 0.5, y: 0.5, dx: 0.000001, dy: -0.000001 },
    { x: 0, y: 0, dx: -120, dy: -120 }, { x: 1, y: 1, dx: 120, dy: 120 },
  ])("does not synthesize a tap for zero, quantized or clipped motion (%j)", async (event) => {
    const h = harness();
    await h.bind();
    h.input({ type: "wheel", ...event });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inputs).toHaveLength(0);
    h.host.disposeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("collects fine motion only until it becomes native movement, without extending an active stroke", async () => {
    const h = harness();
    await h.bind();
    for (let i = 0; i < 2; i++) {
      h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0.1, dy: 0 });
      await vi.advanceTimersByTimeAsync(16);
      expect(h.inputs).toHaveLength(0);
    }
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0.1, dy: 0 });
    await vi.advanceTimersByTimeAsync(176);
    expect(consumedTouches(h.inputs).at(-1)).toMatchObject({ x: 1105, y: 920, pressure: 0 });
    expect(consumedTouches(h.inputs).filter((touch) => touch.pressure === 0)).toHaveLength(1);
    h.host.disposeAll();
  });

  it("releases wheel pointer zero before manual pointer zero and discards wheel during manual contact", async () => {
    const h = harness();
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(32);
    const original = consumedTouches(h.inputs).at(-1)!;
    h.input({ type: "touch", phase: "down", pointer: 0, x: 0.1, y: 0.2 });
    expect(consumedTouches(h.inputs).slice(-2)).toEqual([
      { ...original, pressure: 0 }, { x: 221, y: 368, id: 0, pressure: 1, display: 0 },
    ]);
    const count = h.inputs.length;
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.inputs).toHaveLength(count);
    h.input({ type: "touch", phase: "up", pointer: 0, x: 0.1, y: 0.2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inputs).toHaveLength(count + 1);
    h.host.disposeAll();
  });

  it("keeps an active stroke through ordinary new geometry objects with the same key", async () => {
    const h = harness();
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(64);
    h.streams[0].onMessage(image({ timestamp: 200 }));
    await vi.advanceTimersByTimeAsync(112);
    const touches = consumedTouches(h.inputs);
    expect(touches.at(-1)).toMatchObject({ y: 736, pressure: 0 });
    expect(touches.filter((touch) => touch.pressure === 0)).toHaveLength(1);
    expect(h.openInput).toHaveBeenCalledTimes(1);
    h.host.disposeAll();
  });

  it.each(["geometry", "screen-off", "pane-close", "last-subscriber", "stream-loss", "dispose", "lease", "binding-overflow"] as const)("cancels and releases the original contact on %s without reviving pending work", async (boundary) => {
    const child = Promise.withResolvers<DeviceRunResult>();
    const h = harness({ run: async (file) => file === process.execPath ? child.promise : undefined });
    await h.bind();
    h.input({ type: "key", phase: "down", key: "Alt" });
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(32);
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 120, dy: 0 });
    const original = consumedTouches(h.inputs).at(-1)!;
    const internals = h.host as unknown as { entries: Map<string, { geometryRevision: number; wheel: { timer: NodeJS.Timeout | undefined } | null }> };
    const entry = internals.entries.get("t")!;
    const wheel = entry.wheel!;
    let answer: Promise<unknown> | undefined;
    switch (boundary) {
      case "geometry": h.streams[0].onMessage(image({ q: 2, timestamp: 200 })); break;
      case "screen-off": h.streams[0].onMessage(new Uint8Array()); break;
      case "pane-close": h.host.setOpen("t", false); break;
      case "last-subscriber": h.host.subscribe("t", "client", false); break;
      case "stream-loss": h.disconnect(new Error("input stream failed")); break;
      case "dispose": h.host.dispose("t"); break;
      case "lease": answer = h.host.runAgentCommand("t", "/project", { args: ["snapshot", "-i"] }); await vi.advanceTimersByTimeAsync(0); break;
      case "binding-overflow": entry.geometryRevision = 0xffff_ffff; h.streams[0].onMessage(image({ q: 2, timestamp: 200 })); break;
    }
    expect(entry.wheel).toBeNull();
    expect(wheel.timer).toBeUndefined();
    expect(consumedTouches(h.inputs).at(-1)).toEqual({ ...original, pressure: 0 });
    expect(h.inputs.at(-1)).toEqual(encodeKeyInput({ eventType: 1, key: "Alt" }));
    const count = h.inputs.length;
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.inputs).toHaveLength(count);
    child.resolve(ok());
    if (answer !== undefined) await answer;
    h.host.disposeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels at accepted-operation entry before async validation, including held keys", async () => {
    const validation = Promise.withResolvers<DeviceRunResult>();
    let block = false;
    const h = harness({ run: async (_file, args) => block && args[0] === "-list-avds" ? validation.promise : undefined });
    const before = await h.bind();
    h.input({ type: "key", phase: "down", key: "Shift" });
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(32);
    block = true;
    const operation = h.host.act("t", { action: "boot", avd: "Missing" });
    expect(h.state().operation).not.toBeNull();
    expect(h.state().inputReady).toBe(false);
    expect(h.inputs.at(-1)).toEqual(encodeKeyInput({ eventType: 1, key: "Shift" }));
    expect(consumedTouches(h.inputs).at(-1)?.pressure).toBe(0);
    const count = h.inputs.length;
    h.host.input("t", { type: "key", phase: "up", key: "Shift", bindingId: before.bindingId!, geometryRevision: before.geometryRevision });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.inputs).toHaveLength(count);
    validation.resolve(ok("Fold\nOther\n"));
    await operation;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state().inputReady).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.inputs).toHaveLength(count);
    h.host.disposeAll();
  });

  it.each(["client", "sender", "binding", "revision", "generation", "geometry-key"] as const)("drops deferred stale %s samples but preserves original unguarded release", async (identity) => {
    const h = harness({ deferInput: true });
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(32);
    const internals = h.host as unknown as { entries: Map<string, { client: EmulatorGrpc; inputSender: { send(bytes: Uint8Array, isCurrent?: () => boolean): void; close(): void }; bindingId: string; geometryRevision: number; generation: number; geometry: { key: string }; wheel: unknown }> };
    const entry = internals.entries.get("t")!;
    switch (identity) {
      case "client": entry.client = { ...h.client }; break;
      case "sender": entry.inputSender = { send: () => {}, close: () => {} }; break;
      case "binding": entry.bindingId = "replacement-binding"; break;
      case "revision": entry.geometryRevision += 1; break;
      case "generation": entry.generation += 1; break;
      case "geometry-key": entry.geometry = { ...entry.geometry, key: "replacement-geometry" }; break;
    }
    await vi.advanceTimersByTimeAsync(16);
    expect(entry.wheel).toBeNull();
    expect(h.inputWrites.filter((write) => write.isCurrent !== undefined).every((write) => !write.isCurrent!())).toBe(true);
    h.flushInputs();
    expect(consumedTouches(h.inputs)).toEqual([{ x: 1104, y: 902, id: 0, pressure: 0, display: 0 }]);
    h.host.disposeAll();
  });

  it("drops queued synthetic contact before a manual down while preserving original release order", async () => {
    const h = harness({ deferInput: true });
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(32);
    h.input({ type: "touch", phase: "down", pointer: 0, x: 0.1, y: 0.2 });
    h.flushInputs();
    expect(consumedTouches(h.inputs)).toEqual([
      { x: 1104, y: 902, id: 0, pressure: 0, display: 0 },
      { x: 221, y: 368, id: 0, pressure: 1, display: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(400);
    expect(consumedTouches(h.inputs)).toHaveLength(2);
    h.host.disposeAll();
  });

  it("fences pending queue and clipboard completions across cancel followed by readiness recovery", async () => {
    const clipboard = Promise.withResolvers<void>();
    const h = harness({ deferInput: true });
    await h.bind();
    h.setClipboard.mockReturnValueOnce(clipboard.promise);
    h.input({ type: "key", key: "Control", phase: "down" });
    h.input({ type: "text", text: "한글" });
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(32);
    const previous = h.state();
    h.streams[0].onMessage(image({ q: 2, timestamp: 200 }));
    await vi.advanceTimersByTimeAsync(33);
    expect(h.state().inputReady).toBe(true);
    h.host.input("t", { type: "key", key: "Control", phase: "up", bindingId: previous.bindingId!, geometryRevision: previous.geometryRevision });
    clipboard.resolve();
    await vi.advanceTimersByTimeAsync(0);
    h.flushInputs();
    expect(consumedTouches(h.inputs)).toEqual([{ x: 1104, y: 902, id: 0, pressure: 0, display: 0 }]);
    expect(h.inputs.at(-1)).toEqual(encodeKeyInput({ eventType: 1, key: "Control" }));
    expect(h.openInput).toHaveBeenCalledTimes(1);
    h.host.disposeAll();
  });

  it.each([false, true])("preserves a queued native burst unless manual ownership cancels it (%s)", async (interrupt) => {
    const h = harness({ deferInput: true, run: async (_file, args) => args.at(-1) === "input" ? ok(QEMU_WHEEL) : undefined });
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 120, dy: 0 });
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    if (interrupt) h.input({ type: "touch", phase: "down", pointer: 0, x: 0.1, y: 0.2 });
    h.flushInputs();
    if (interrupt) expect(consumedTouches(h.inputs)).toEqual([{ x: 221, y: 368, id: 0, pressure: 1, display: 0 }]);
    expect(h.inputs.map((bytes) => [...inputFields(bytes).keys()])).toEqual(interrupt ? [[2]] : [[3], [6], [3], [6]]);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inputs).toHaveLength(interrupt ? 1 : 4);
    h.host.disposeAll();
  });

  it("uses only positively observed axes on an established primary route, never also touching", async () => {
    const h = harness({ run: async (_file, args) => args.at(-1) === "input" ? ok(QEMU_WHEEL) : undefined });
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 120, dy: -120 });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inputs.map((bytes) => [...inputFields(bytes).keys()])).toEqual([[3], [6]]);
    const wheelBytes = inputFields(h.inputs[1]).get(6) as Uint8Array;
    const wheel = inputFields(wheelBytes);
    expect(Number(BigInt.asIntN(32, wheel.get(1) as bigint))).toBe(120);
    expect(Number(BigInt.asIntN(32, wheel.get(2) as bigint))).toBe(-120);
    expect(consumedTouches(h.inputs)).toEqual([]);
    expect(h.run.mock.calls.filter(([, args]) => args.join(" ").endsWith("dumpsys input"))).toHaveLength(1);
    expect(h.run).toHaveBeenCalledWith(SDK.adb, ["-s", SERIAL, "shell", "dumpsys", "input"], expect.objectContaining({ timeoutMs: 15_000, maxOutputBytes: 64 * 1024 }));
    h.host.disposeAll();
  });

  it.each([
    QEMU_WHEEL.replace("QEMU Virtio Dual Mode Mouse", "USB Mouse"),
    QEMU_WHEEL.replace("vendor=0x0627", "vendor=0x1234"),
    QEMU_WHEEL.replace("product=0x0004", "product=0x0002"),
    QEMU_WHEEL.replace("Enabled: true", "Enabled: false"),
    QEMU_WHEEL.replace("Enabled: true", "IsEnabled: false"),
    QEMU_WHEEL.replace("AssociatedDisplayId: 0", "AssociatedDisplayId: 6"),
    QEMU_WHEEL.replace("    Sources: 0x00002002", "    Sources: 0x00400000"),
    QEMU_WHEEL.replace("      HSCROLL:", "      SCROLL:"),
    QEMU_WHEEL.replace("HaveHWheel: true", "HaveHWheel: false"),
    QEMU_WHEEL.replace("Input Reader State:", "Event Hub State:"),
    QEMU_WHEEL + " ".repeat(64 * 1024),
    QEMU_WHEEL.replace("      HSCROLL:", "      SCROLL:") + "  Device 4: USB Mouse\n    Sources: 0x00002002\n    HSCROLL: source=0x00002002\n    HaveHWheel: true\n",
  ])("does not infer native wheel from incomplete, foreign or cross-device evidence %#", async (dump) => {
    const h = harness({ run: async (_file, args) => args.at(-1) === "input" ? ok(dump) : undefined });
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 120, dy: -120 });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inputs.every((bytes) => inputFields(bytes).has(2))).toBe(true);
    expect(consumedTouches(h.inputs).at(-1)?.pressure).toBe(0);
    h.host.disposeAll();
  });

  it("allows a proved vertical-only device for vertical input but not a mixed-axis event", async () => {
    const dump = QEMU_WHEEL.replace("      HSCROLL:", "      SCROLL:").replace("HaveHWheel: true", "HaveHWheel: false");
    const h = harness({ run: async (_file, args) => args.at(-1) === "input" ? ok(dump) : undefined });
    await h.bind();
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    expect(h.inputs.map((bytes) => [...inputFields(bytes).keys()])).toEqual([[3], [6]]);
    h.inputs.length = 0;
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 120, dy: -120 });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inputs.every((bytes) => inputFields(bytes).has(2))).toBe(true);
    h.host.disposeAll();
  });

  it.each(["cover", "secondary"] as const)("does not claim native routing on a %s capture despite positive guest axes", async (route) => {
    const h = harness({ run: async (_file, args) => args.at(-1) === "input" ? ok(QEMU_WHEEL) : undefined });
    if (route === "secondary") h.getDisplayConfigurations.mockResolvedValue([{ display: 6, width: 800, height: 1200, dpi: 320, flags: 0 }]);
    await h.bind();
    await vi.advanceTimersByTimeAsync(33);
    h.streams[0].onMessage(image({ timestamp: 200, ...(route === "cover" ? { folded: { width: 1080, height: 2092, xOffset: 0, yOffset: 0 } } : { display: 6 }) }));
    h.input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inputs.every((bytes) => inputFields(bytes).has(2))).toBe(true);
    expect(consumedTouches(h.inputs).at(-1)).toMatchObject({ pressure: 0, display: route === "secondary" ? 6 : 0 });
    h.host.disposeAll();
  });
});

describe("observed native controls", () => {
  it("combines hardware, native model and read-only guest evidence", async () => {
    const h = harness();
    const state = await h.bind();
    expect(state.capabilities.rotation.available).toBe(true);
    expect(state.capabilities.postures.supported).toEqual([
      { posture: "closed", nativeId: 1, minAngle: 0, maxAngle: 30, targetAngle: 0 },
      { posture: "half-open", nativeId: 2, minAngle: 30, maxAngle: 150, targetAngle: 90 },
      { posture: "open", nativeId: 3, minAngle: 150, maxAngle: 180, targetAngle: 180 },
    ]);
    expect(h.run.mock.calls.some(([, args]) => args.includes("settings") || args.includes("set-state") || args.includes("fold"))).toBe(false);
  });

  it("recovers a failed hidden rotation from fresh validated native observations without a JPEG", async () => {
    const h = harness();
    const initial = await h.host.act("t", { action: "bind", serial: SERIAL });
    const failure = new Error("Native screenshot readback failed");
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 100 })).mockRejectedValueOnce(failure);
    const failed = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 2 });
    expect(failed).toMatchObject({ phase: "streaming", actionError: failure.message, inputReady: false, operation: null });
    for (const raw of [image({ q: 2, timestamp: 100 }), Uint8Array.of(10, 4, 24, 255), image({ q: 0, timestamp: 110 })]) {
      h.getScreenshot.mockResolvedValueOnce(raw);
      h.notifications[0].onMessage({ type: "display-power", display: 0, powerMode: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.state().inputReady).toBe(false);
    }
    h.getScreenshot.mockResolvedValueOnce(image({ q: 2, timestamp: 120 }));
    h.notifications[0].onMessage({ type: "display-power", display: 0, powerMode: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({ bindingId: initial.bindingId, rotation: 2, screen: "active", inputReady: true, actionError: failure.message });
    expect(h.capture()).toEqual({ timestampUs: 120, cached: null, bgraBytes: 0, slotScheduled: false });
    expect(h.encodes).toHaveLength(0);
    expect(h.frames()).toHaveLength(0);
    expect(h.streams).toHaveLength(0);
    h.input({ type: "key", key: "Enter", phase: "down" });
    expect(h.openInput).not.toHaveBeenCalled();
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
    h.host.disposeAll();
  });

  it.each(["stale", "wrong-rotation"] as const)("never confirms a hidden rotation from %s native frames", async (evidence) => {
    const h = harness();
    const initial = await h.host.act("t", { action: "bind", serial: SERIAL });
    h.getScreenshot.mockResolvedValue(image(evidence === "stale" ? { q: 1, timestamp: 100 } : { q: 0, timestamp: 200 }))
      .mockResolvedValueOnce(image({ timestamp: 100 }));
    const pending = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    const state = await pending;
    expect(state).toMatchObject({ phase: "streaming", inputReady: false, operation: null, rotation: null });
    expect(state.actionError).toContain("15 seconds");
    expect(h.encodes).toHaveLength(0);
    expect(h.frames()).toHaveLength(0);
    expect(h.streams).toHaveLength(0);
    expect(h.capture()).toEqual({ timestampUs: 0, cached: null, bgraBytes: 0, slotScheduled: false });
    expect(h.close).not.toHaveBeenCalled();
    h.host.disposeAll();
  });

  it("keeps hidden native posture evidence blocked until the guest independently commits", async () => {
    const h = harness({ run: async (_file, args) => args.join(" ").endsWith("dumpsys device_state")
      ? ok("mCommittedState=Optional[DeviceState{identifier=2, name='OPENED'}]") : undefined });
    const initial = await h.host.act("t", { action: "bind", serial: SERIAL });
    h.getScreenshot.mockResolvedValue(image({ timestamp: 200 })).mockResolvedValueOnce(image({ timestamp: 100 }));
    const pending = h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    await vi.advanceTimersByTimeAsync(15_000);
    const state = await pending;
    expect(state).toMatchObject({ phase: "streaming", posture: "closed", inputReady: false, operation: null });
    expect(state.actionError).toContain("15 seconds");
    expect(h.capture()).toEqual({ timestampUs: 200, cached: null, bgraBytes: 0, slotScheduled: false });
    expect(h.encodes).toHaveLength(0);
    expect(h.frames()).toHaveLength(0);
    expect(h.streams).toHaveLength(0);
    h.host.disposeAll();
  });

  it.each(["guest-off", "native-off", "empty"] as const)("confirms a hidden inactive posture honestly with %s evidence and no encoding", async (evidence) => {
    const h = harness({ run: async (_file, args) => evidence === "guest-off" && args.join(" ").endsWith("dumpsys display") ? ok("mScreenState=OFF") : undefined });
    const initial = await h.host.act("t", { action: "bind", serial: SERIAL });
    if (evidence === "native-off") h.notifications[0].onMessage({ type: "display-power", display: 0, powerMode: 0 });
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 100 }))
      .mockResolvedValueOnce(evidence === "empty" ? new Uint8Array() : image({ timestamp: 200, fill: 0 }));
    const state = await h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    expect(state).toMatchObject({ phase: "streaming", posture: "closed", screen: "inactive", inputReady: false, operation: null, actionError: null });
    expect(h.capture()).toEqual({ timestampUs: 0, cached: null, bgraBytes: 0, slotScheduled: false });
    expect(h.encodes).toHaveLength(0);
    expect(h.frames()).toHaveLength(0);
    expect(h.streams).toHaveLength(0);
    h.host.disposeAll();
  });

  it("discards a hidden control's late native frame after unbind and permits a clean new binding", async () => {
    const h = harness();
    const initial = await h.host.act("t", { action: "bind", serial: SERIAL });
    const late = Promise.withResolvers<Uint8Array>();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 100 })).mockReturnValueOnce(late.promise);
    const pending = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const signal = h.getScreenshot.mock.calls.at(-1)![1]!;
    await h.host.act("t", { action: "unbind", bindingId: initial.bindingId! });
    expect(signal.aborted).toBe(true);
    late.resolve(image({ q: 1, timestamp: 200 }));
    await pending;
    expect(h.state()).toMatchObject({ bindingId: null, serial: null, screen: "unknown", inputReady: false, operation: null });
    const rebound = await h.host.act("t", { action: "bind", serial: SECOND });
    expect(h.state()).toMatchObject({ bindingId: rebound.bindingId, serial: SECOND, screen: "unknown", inputReady: false, operation: null });
    expect(h.capture()).toEqual({ timestampUs: 0, cached: null, bgraBytes: 0, slotScheduled: false });
    expect(h.encodes).toHaveLength(0);
    expect(h.frames()).toHaveLength(0);
    expect(h.streams).toHaveLength(0);
    h.host.disposeAll();
  });

  it("streams multi-hinge devices normally while explaining unsupported fold controls", async () => {
    const h = harness({ config: CONFIG.replace("hinge.count=1", "hinge.count=2") });
    const state = await h.bind();
    expect(state).toMatchObject({ phase: "streaming", inputReady: true, capabilities: { postures: { available: false } } });
    expect(state.capabilities.postures.reason).toContain("multiple");
  });

  it("keeps a working connection for optional native UNIMPLEMENTED and FAILED_PRECONDITION", async () => {
    const h = harness();
    h.getPhysicalModel.mockRejectedValue(Object.assign(new Error("not supported"), { status: 12 }));
    h.getDisplayConfigurations.mockRejectedValue(Object.assign(new Error("not ready"), { status: 9 }));
    const state = await h.bind();
    expect(state).toMatchObject({ phase: "streaming", inputReady: true });
    expect(state.capabilities.rotation.available).toBe(false);
    expect(state.capabilities.postures.available).toBe(false);
  });

  it("uses physical target1 and only completes after fresh exact q plus tolerant three-axis model readback", async () => {
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockResolvedValueOnce(image({ q: 0, timestamp: 120 })).mockResolvedValueOnce(image({ q: 1, timestamp: 130 }));
    const pending = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({ operation: { kind: "rotate" }, inputReady: false, rotation: 0 });
    await vi.advanceTimersByTimeAsync(250);
    const state = await pending;
    expect(h.setPhysicalModel).toHaveBeenCalledWith(1, [0, 0, 90], expect.any(AbortSignal));
    expect(state).toMatchObject({ rotation: 1, operation: null, phase: "streaming", actionError: null, inputReady: true });
  });

  it.each(["closed", "half-open", "open"] as const)("waits through guest frame preconditions before confirming native %s", async (posture) => {
    const h = harness({ config: CONFIG.replace("pixel_fold", "pixel_9_pro_fold") });
    const initial = await h.bind();
    const gap = new GrpcStatusError("getScreenshot", 9, "The guest has not posted new frame yet");
    const folded = posture === "closed" ? { width: 1080, height: 2092, xOffset: 0, yOffset: 0 } : undefined;
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockRejectedValueOnce(gap).mockRejectedValueOnce(gap)
      .mockResolvedValueOnce(image({ timestamp: 120, folded }));
    const pending = h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({ phase: "streaming", inputReady: false, actionError: null, operation: { kind: "set-posture" } });
    expect(h.frames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.state().operation?.kind).toBe("set-posture");
    await vi.advanceTimersByTimeAsync(250);
    const state = await pending;
    const offer = initial.capabilities.postures.supported.find((supported) => supported.posture === posture)!;
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
    expect(h.setPhysicalModel).toHaveBeenCalledWith(10, [offer.targetAngle], expect.any(AbortSignal));
    expect(state).toMatchObject({ posture, hingeAngle: offer.targetAngle, phase: "streaming", operation: null, actionError: null, inputReady: true });
    expect(state.capabilities).toEqual(initial.capabilities);
    expect(state.geometryRevision).toBeGreaterThan(initial.geometryRevision);
    expect(decodeDevicePaneFrame(h.frames().at(-1)!)?.header).toMatchObject({ bindingId: state.bindingId, geometryRevision: state.geometryRevision });
    h.host.input("t", { type: "key", key: "Enter", phase: "down", bindingId: initial.bindingId!, geometryRevision: initial.geometryRevision });
    expect(h.inputs).toHaveLength(0);
    h.input({ type: "touch", phase: "down", x: 0.5, y: 0.5, pointer: 1 });
    expect(h.inputs).toHaveLength(1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it("tolerates a missing baseline and only confirms fresh exact-q metadata for a same-size rotation", async () => {
    const h = harness();
    const initial = await h.bind();
    const gap = new GrpcStatusError("getScreenshot", 9, "The guest has not posted new frame yet");
    h.getScreenshot.mockRejectedValueOnce(gap).mockRejectedValueOnce(gap)
      .mockResolvedValueOnce(image({ q: 2, timestamp: 100 })).mockResolvedValueOnce(image({ q: 0, timestamp: 110 }))
      .mockResolvedValueOnce(image({ q: 2, timestamp: 120 }));
    const pending = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 2 });
    await vi.advanceTimersByTimeAsync(250);
    expect(h.state()).toMatchObject({ rotation: 0, inputReady: false, actionError: null, operation: { kind: "rotate" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(h.frames()).toHaveLength(1);
    expect(h.state().rotation).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    const state = await pending;
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
    expect(h.setPhysicalModel).toHaveBeenCalledWith(1, [0, 0, -180], expect.any(AbortSignal));
    expect(state).toMatchObject({ rotation: 2, operation: null, actionError: null, inputReady: true });
    expect(decodeDevicePaneFrame(h.frames().at(-1)!)?.header).toMatchObject({ width: 4, height: 8, bindingId: initial.bindingId, geometryRevision: state.geometryRevision });
    expect(state.geometryRevision).toBeGreaterThan(initial.geometryRevision);
    expect(state.capabilities).toEqual(initial.capabilities);
  });

  it("keeps the original deadline through perpetual frame preconditions and restores only a later fresh native cover", async () => {
    const h = harness();
    const initial = await h.bind();
    const gap = new GrpcStatusError("getScreenshot", 9, "The guest has not posted new frame yet");
    h.getScreenshot.mockRejectedValue(gap).mockResolvedValueOnce(image({ timestamp: 110 }));
    const pending = h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    await vi.advanceTimersByTimeAsync(14_750);
    expect(h.state()).toMatchObject({ operation: { kind: "set-posture" }, actionError: null, inputReady: false, screen: "active" });
    const signal = h.getScreenshot.mock.calls.at(-1)![1]!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    const state = await pending;
    expect(state).toMatchObject({ posture: "closed", hingeAngle: 0, phase: "streaming", inputReady: false, operation: null, screen: "active" });
    expect(state.actionError).toContain("15 seconds");
    expect(signal.aborted).toBe(true);
    expect(state.capabilities).toEqual(initial.capabilities);
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
    const screenshotReads = h.getScreenshot.mock.calls.length;
    const modelReads = h.getPhysicalModel.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(h.getScreenshot).toHaveBeenCalledTimes(screenshotReads);
    expect(h.getPhysicalModel).toHaveBeenCalledTimes(modelReads);
    h.streams[0].onMessage(image({ timestamp: 110 }));
    await vi.advanceTimersByTimeAsync(33);
    expect(h.state().inputReady).toBe(false);
    h.streams[0].onMessage(image({ timestamp: 120, folded: { width: 1080, height: 2092, xOffset: 0, yOffset: 0 } }));
    await vi.advanceTimersByTimeAsync(33);
    const recovered = h.state();
    expect(recovered).toMatchObject({ bindingId: initial.bindingId, phase: "streaming", operation: null, screen: "active", inputReady: true, actionError: state.actionError });
    expect(decodeDevicePaneFrame(h.frames().at(-1)!)?.header).toMatchObject({ bindingId: recovered.bindingId, geometryRevision: recovered.geometryRevision });
    h.host.input("t", { type: "key", key: "Enter", phase: "down", bindingId: initial.bindingId!, geometryRevision: initial.geometryRevision });
    expect(h.inputs).toHaveLength(0);
    h.input({ type: "touch", phase: "down", x: 0.5, y: 0.5, pointer: 1 });
    expect(h.inputs).toHaveLength(1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it("retains fresh native cover evidence that arrived before guest confirmation without claiming control success", async () => {
    const h = harness();
    const initial = await h.bind();
    const guest = Promise.withResolvers<DeviceRunResult>();
    const run = h.run.getMockImplementation()!;
    let guestReads = 0;
    h.run.mockImplementation(async (file, args, opts) => {
      if (args.at(-1) === "device_state" && guestReads++ === 0) return guest.promise;
      return run(file, args, opts);
    });
    h.getScreenshot.mockRejectedValue(new GrpcStatusError("getScreenshot", 9, "The guest has not posted new frame yet"))
      .mockResolvedValueOnce(image({ timestamp: 110 }));
    const pending = h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    await vi.advanceTimersByTimeAsync(0);
    h.streams[0].onMessage(image({ timestamp: 120, folded: { width: 1080, height: 2092, xOffset: 0, yOffset: 0 } }));
    expect(h.state()).toMatchObject({ inputReady: false, operation: { kind: "set-posture" } });
    expect(h.encodes).toHaveLength(2);
    guest.resolve(ok("mCommittedState=Optional[DeviceState{identifier=0, name='CLOSED'}]"));
    await vi.advanceTimersByTimeAsync(15_000);
    const state = await pending;
    expect(state).toMatchObject({ posture: "closed", phase: "streaming", screen: "active", inputReady: true, operation: null });
    expect(state.actionError).toContain("15 seconds");
    expect(h.encodes).toHaveLength(2);
    expect(decodeDevicePaneFrame(h.frames().at(-1)!)?.header).toMatchObject({ bindingId: state.bindingId, geometryRevision: state.geometryRevision });
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it("preserves a failed rotation error while recovering input only from a fresh native exact-q identity", async () => {
    const h = harness();
    const initial = await h.bind();
    const failure = new Error("Unexpected screenshot failure");
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockRejectedValueOnce(failure);
    const state = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 2 });
    expect(state).toMatchObject({ actionError: failure.message, phase: "streaming", inputReady: false, operation: null });
    h.streams[0].onMessage(image({ q: 2, timestamp: 110 }));
    await vi.advanceTimersByTimeAsync(33);
    expect(h.state().inputReady).toBe(false);
    h.streams[0].onMessage(image({ q: 0, timestamp: 120 }));
    await vi.advanceTimersByTimeAsync(33);
    expect(h.state().inputReady).toBe(false);
    h.streams[0].onMessage(image({ q: 2, timestamp: 130 }));
    await vi.advanceTimersByTimeAsync(33);
    const recovered = h.state();
    expect(recovered).toMatchObject({ bindingId: initial.bindingId, rotation: 2, actionError: failure.message, inputReady: true });
    expect(decodeDevicePaneFrame(h.frames().at(-1)!)?.header).toMatchObject({ width: 4, height: 8, geometryRevision: recovered.geometryRevision });
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it.each([9, 12])("does not retry optional physical RPC failures with status %s", async (status) => {
    for (const rpc of ["setPhysicalModel", "getPhysicalModel"] as const) {
      const h = harness();
      const initial = await h.bind();
      const failure = new GrpcStatusError(rpc, status, "native model is unavailable");
      h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 }));
      h[rpc].mockRejectedValueOnce(failure);
      const state = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
      expect(state).toMatchObject({ phase: "streaming", inputReady: false, actionError: failure.message, operation: null });
      expect(state.capabilities).toEqual(initial.capabilities);
      expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
      const reads = h.getPhysicalModel.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(h.getPhysicalModel).toHaveBeenCalledTimes(reads);
      expect(h.close).not.toHaveBeenCalled();
      h.host.disposeAll();
    }
  });

  it.each([new Error("Unknown screenshot error"), new GrpcStatusError("getScreenshot", 12, "not implemented")])("does not turn an unrelated screenshot error into a frame wait: %s", async (failure) => {
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockRejectedValueOnce(failure);
    const state = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    expect(state).toMatchObject({ phase: "streaming", screen: "active", inputReady: false, actionError: failure.message, operation: null });
    const reads = h.getScreenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(h.getScreenshot).toHaveBeenCalledTimes(reads);
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it.each(["unbind", "power-off"] as const)("stops frame-gap polling after %s cancels native control", async (action) => {
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockRejectedValue(new GrpcStatusError("getScreenshot", 9, "The guest has not posted new frame yet"))
      .mockResolvedValueOnce(image({ timestamp: 110 }));
    const pending = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const screenshotReads = h.getScreenshot.mock.calls.length;
    const modelReads = h.getPhysicalModel.mock.calls.length;
    const stop = h.host.act("t", { action, bindingId: initial.bindingId! });
    expect(h.setPhysicalModel.mock.calls.at(-1)![2]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(await stop).toMatchObject({ phase: "unbound", bindingId: null, inputReady: false });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.getScreenshot).toHaveBeenCalledTimes(screenshotReads);
    expect(h.getPhysicalModel).toHaveBeenCalledTimes(modelReads);
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
    expect(h.setVmState).toHaveBeenCalledTimes(action === "power-off" ? 1 : 0);
  });

  it("fences a late frame precondition from an obsolete binding generation", async () => {
    const h = harness();
    const initial = await h.bind();
    const screenshot = Promise.withResolvers<Uint8Array>();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockReturnValueOnce(screenshot.promise);
    const pending = h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    await vi.advanceTimersByTimeAsync(0);
    await h.host.act("t", { action: "unbind", bindingId: initial.bindingId! });
    const modelReads = h.getPhysicalModel.mock.calls.length;
    screenshot.reject(new GrpcStatusError("getScreenshot", 9, "The guest has not posted new frame yet"));
    await pending;
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state()).toMatchObject({ phase: "unbound", bindingId: null, posture: null, inputReady: false, actionError: null });
    expect(h.getPhysicalModel).toHaveBeenCalledTimes(modelReads);
    expect(h.setPhysicalModel).toHaveBeenCalledTimes(1);
  });

  it("keeps actual connection loss fatal during a transient frame gap", async () => {
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockRejectedValue(new GrpcStatusError("getScreenshot", 9, "The guest has not posted new frame yet"))
      .mockResolvedValueOnce(image({ timestamp: 110 }));
    const pending = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const reads = h.getScreenshot.mock.calls.length;
    h.disconnect(new Error("connection closed"));
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    h.streams[0].onMessage(image({ q: 1, timestamp: 120 }));
    expect(h.state()).toMatchObject({ phase: "error", inputReady: false, operation: null, error: "emulator connection lost: connection closed" });
    expect(h.getScreenshot).toHaveBeenCalledTimes(reads);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("executes guest readbacks with an integer deadline timeout from a fractional monotonic clock", async () => {
    vi.useRealTimers();
    let now = 100.125;
    const h = harness({ now: () => now });
    try {
      const initial = await h.bind();
      const run = h.run.getMockImplementation()!;
      const executedTimeouts: number[] = [];
      h.run.mockImplementation(async (file, args, opts) => {
        const result = await run(file, args, opts);
        const { promise, resolve, reject } = Promise.withResolvers<DeviceRunResult>();
        // Exercise Node's actual timeout validation, not a mock that accepts fractional milliseconds.
        execFile(process.execPath, ["-e", "process.stdout.write(process.argv[1])", result.stdout], {
          env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, encoding: "utf8",
        }, (error, stdout, stderr) => {
          if (error !== null) { reject(error); return; }
          executedTimeouts.push(opts.timeoutMs);
          resolve({ code: 0, stdout, stderr });
        });
        return promise;
      });
      h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockImplementationOnce(async () => {
        now += 542.208335;
        return image({ q: 1, timestamp: 120 });
      });
      const state = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
      expect(executedTimeouts).toEqual([14_457, 14_457, 14_457]);
      expect(h.setPhysicalModel).toHaveBeenCalledWith(1, [0, 0, 90], expect.any(AbortSignal));
      expect(state).toMatchObject({ bindingId: initial.bindingId, serial: SERIAL, rotation: 1, phase: "streaming", operation: null, actionError: null, inputReady: true });
      h.input({ type: "touch", phase: "down", x: 0.5, y: 0.5, pointer: 1 });
      expect(h.inputs).toHaveLength(1);
      expect(h.close).not.toHaveBeenCalled();
    } finally { h.host.disposeAll(); }
  });

  it.each([false, true])("retains confirmed rotation after guest readback failure without overriding screen-off=%s", async (screenOff) => {
    const h = harness();
    const initial = await h.bind();
    const run = h.run.getMockImplementation()!;
    h.run.mockImplementation(async (file, args, opts) => {
      if (args.at(-1) === "device_state") {
        if (screenOff) h.notifications[0].onMessage({ type: "display-power", display: 0, powerMode: 0 });
        throw new Error("Guest readback failed.");
      }
      return run(file, args, opts);
    });
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockResolvedValueOnce(image({ q: 1, timestamp: 120 }));
    const state = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    expect(state).toMatchObject({ bindingId: initial.bindingId, serial: SERIAL, rotation: 1, phase: "streaming", operation: null, actionError: "Guest readback failed.", screen: screenOff ? "inactive" : "active", inputReady: !screenOff });
    h.input({ type: "touch", phase: "down", x: 0.5, y: 0.5, pointer: 1 });
    expect(h.inputs).toHaveLength(screenOff ? 0 : 1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it("sets hinge target10 and independently reads native posture target16", async () => {
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockResolvedValueOnce(image({ timestamp: 120, folded: { width: 1080, height: 2092, xOffset: 0, yOffset: 0 } }));
    const state = await h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    expect(h.setPhysicalModel).toHaveBeenCalledWith(10, [0], expect.any(AbortSignal));
    expect(h.getPhysicalModel).toHaveBeenCalledWith(16, expect.any(AbortSignal));
    expect(state).toMatchObject({ posture: "closed", hingeAngle: 0, operation: null, inputReady: true });
  });

  it("retains all supported postures from print-states and waits for a separately committed guest name", async () => {
    let guestReads = 0;
    const h = harness({ run: async (_file, args) => {
      if (!args.join(" ").endsWith("dumpsys device_state")) return undefined;
      guestReads += 1;
      return ok(`mCommittedState=Optional[DeviceState{identifier=${guestReads < 3 ? 2 : 0}, name='${guestReads < 3 ? "OPENED" : "CLOSED"}'}]`);
    } });
    const initial = await h.bind();
    expect(initial.capabilities.postures.supported.map((p) => p.posture)).toEqual(["closed", "half-open", "open"]);
    h.getScreenshot.mockResolvedValue(image({ timestamp: 120 })).mockResolvedValueOnce(image({ timestamp: 110 }));
    const pending = h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({ posture: "closed", inputReady: false, operation: { kind: "set-posture" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ posture: "closed", inputReady: true, operation: null, actionError: null });
    expect(h.state().capabilities.postures.supported).toHaveLength(3);
  });

  it("times out persistent guest/native disagreement without granting input or dropping the connection", async () => {
    const h = harness({ run: async (_file, args) => args.join(" ").endsWith("dumpsys device_state") ? ok("mCommittedState=Optional[DeviceState{identifier=2, name='OPENED'}]") : undefined });
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValue(image({ timestamp: 120 })).mockResolvedValueOnce(image({ timestamp: 110 }));
    const pending = h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    await vi.advanceTimersByTimeAsync(15_000);
    const state = await pending;
    expect(state).toMatchObject({ phase: "streaming", posture: "closed", inputReady: false, operation: null });
    expect(state.actionError).toContain("15 seconds");
    expect(h.close).not.toHaveBeenCalled();
  });

  it("completes a confirmed closed posture as inactive when the actual screenshot is empty", async () => {
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 })).mockResolvedValueOnce(new Uint8Array());
    const state = await h.host.act("t", { action: "set-posture", bindingId: initial.bindingId!, posture: "closed" });
    expect(state).toMatchObject({ phase: "streaming", posture: "closed", hingeAngle: 0, screen: "inactive", inputReady: false, operation: null, actionError: null });
  });

  it("rejects malformed model arity as actionError without losing the connection", async () => {
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 }));
    h.getPhysicalModel.mockResolvedValueOnce({ target: 1, status: 0, values: [90] });
    const state = await h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    expect(state.phase).toBe("streaming");
    expect(state.actionError).toContain("malformed");
    expect(h.close).not.toHaveBeenCalled();
    expect(state.rotation).toBe(0);
  });

  it("does not optimistically publish a requested rotation when only the model changed", async () => {
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValue(image({ q: 0, timestamp: 100 }));
    const pending = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 2 });
    await vi.advanceTimersByTimeAsync(15_000);
    const state = await pending;
    expect(state).toMatchObject({ rotation: 0, phase: "streaming", operation: null, inputReady: false });
    expect(state.actionError).toContain("15 seconds");
    expect(h.close).not.toHaveBeenCalled();
  });

  it("aborts native control on unbind and cannot publish its late readback", async () => {
    const setter = Promise.withResolvers<void>();
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 }));
    h.setPhysicalModel.mockReturnValueOnce(setter.promise);
    const pending = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await h.host.act("t", { action: "unbind", bindingId: initial.bindingId! });
    const signal = h.setPhysicalModel.mock.calls.at(-1)?.[2];
    expect(signal?.aborted).toBe(true);
    setter.resolve();
    await pending;
    expect(h.state()).toMatchObject({ phase: "unbound", rotation: null, bindingId: null });
  });
  it("power-off cancels a pending native control, waits for it to settle, then stops only the captured binding", async () => {
    const setter = Promise.withResolvers<void>();
    const h = harness();
    const initial = await h.bind();
    h.getScreenshot.mockResolvedValueOnce(image({ timestamp: 110 }));
    h.setPhysicalModel.mockReturnValueOnce(setter.promise);
    const rotate = h.host.act("t", { action: "rotate", bindingId: initial.bindingId!, rotation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const off = h.host.act("t", { action: "power-off", bindingId: initial.bindingId! });
    expect(h.setPhysicalModel.mock.calls.at(-1)?.[2]?.aborted).toBe(true);
    expect(h.setVmState).not.toHaveBeenCalled();
    setter.resolve();
    await rotate;
    expect((await off).phase).toBe("unbound");
    expect(h.setVmState).toHaveBeenCalledTimes(1);
  });

});

describe("agent child ownership", () => {
  it("holds tab and serial leases through child settlement after detach and fences stale output", async () => {
    const child = Promise.withResolvers<DeviceRunResult>();
    const h = harness({ run: async (file) => file === process.execPath ? child.promise : undefined });
    const initial = await h.bind();
    const answer = h.host.runAgentCommand("t", "/project", { args: ["snapshot", "-i"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({ agent: "acting", open: true, inputReady: false });
    const refused = await h.host.act("t", { action: "unbind", bindingId: initial.bindingId! });
    expect(refused).toMatchObject({ bindingId: initial.bindingId, serial: SERIAL, phase: "streaming" });
    expect(refused.actionError).toContain("still running");
    h.host.dispose("t");
    expect((await h.host.act("t", { action: "bind", serial: SECOND })).actionError).toContain("still running");
    expect((await h.host.act("other", { action: "bind", serial: SERIAL })).error).toBe("in use by another session");
    child.resolve(ok("old agent result"));
    expect((await answer).isError).toBe(true);
    expect((await h.host.act("t", { action: "bind", serial: SECOND })).serial).toBe(SECOND);
  });

  it("forwards orientation guest policy, releases pointers, blocks input and reconciles a fresh geometry", async () => {
    const child = Promise.withResolvers<DeviceRunResult>();
    const h = harness({ run: async (file) => file === process.execPath ? child.promise : undefined });
    await h.bind();
    h.input({ type: "touch", phase: "down", x: 0.25, y: 0.4, pointer: 6 });
    const revision = h.state().geometryRevision;
    h.getScreenshot.mockResolvedValueOnce(image({ q: 1, timestamp: 200 }));
    const answer = h.host.runAgentCommand("t", "/project", { args: ["orientation", "landscape"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 552, y: 736, id: 6, pressure: 0 }]));
    expect(h.state()).toMatchObject({ inputReady: false });
    expect(h.state().geometryRevision).toBeGreaterThan(revision);
    child.resolve(ok("locked landscape"));
    expect((await answer).isError).toBe(false);
    expect(h.state()).toMatchObject({ inputReady: true, rotation: 1 });
    expect(h.setPhysicalModel).not.toHaveBeenCalled();
    expect(h.run.mock.calls.find(([file]) => file === process.execPath)?.[1]).toEqual(expect.arrayContaining(["orientation", "landscape", "--serial", SERIAL]));
  });

  it("reconciles hidden agent orientation from a fresh native frame without starting or encoding a viewer stream", async () => {
    const h = harness();
    const initial = await h.host.act("t", { action: "bind", serial: SERIAL });
    h.getScreenshot.mockResolvedValueOnce(image({ q: 1, timestamp: 200 }));
    const answer = await h.host.runAgentCommand("t", "/project", { args: ["orientation", "landscape"] });
    expect(answer.isError).toBe(false);
    expect(h.state()).toMatchObject({ bindingId: initial.bindingId, phase: "streaming", rotation: 1, inputReady: true });
    expect(h.state().geometryRevision).toBeGreaterThan(initial.geometryRevision);
    expect(h.capture()).toEqual({ timestampUs: 200, cached: null, bgraBytes: 0, slotScheduled: false });
    expect(h.encodes).toHaveLength(0);
    expect(h.frames()).toHaveLength(0);
    expect(h.streams).toHaveLength(0);
    expect(h.setPhysicalModel).not.toHaveBeenCalled();
    h.host.disposeAll();
  });

  it("preserves screenshot cache for other forwarded commands and the attached watchdog", async () => {
    const h = harness();
    await h.bind();
    const frame = h.frames()[0];
    const answer = await h.host.runAgentCommand("t", "/project", { args: ["snapshot", "-i"] });
    expect(answer.isError).toBe(false);
    h.host.subscribe("t", "replay", true);
    expect(h.frames().at(-1)).toBe(frame);
    expect(h.state().agent).toBe("acting");
    await vi.advanceTimersByTimeAsync(DEVICE_PANE_ACTING_MS);
    expect(h.state().agent).toBe("attached");
    expect(h.run.mock.calls.find(([file]) => file === process.execPath)?.[2]).toMatchObject({ cwd: "/project", env: { ELECTRON_RUN_AS_NODE: "1", AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST: SERIAL } });
  });

  it("refuses forwarding during native control and answers setup failures without running children", async () => {
    const h = harness({ sdk: null });
    const answer = await h.host.runAgentCommand("t", "/project", { args: ["targets"] });
    expect(answer.isError).toBe(true);
    expect(h.run).not.toHaveBeenCalled();
    expect((await h.host.inventory()).creation.available).toBe(false);
  });
});
