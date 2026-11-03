import {
  CH,
  DEVICE_PANE_ACTING_MS,
  avdConfigPath,
  decodeBrowserPaneFrame,
  encodeKeyInput,
  encodeTouchInput,
  type AndroidSdkPaths,
  type DevicePaneState,
} from "@omp-ui/core";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DevicePaneHost, type DeviceRunResult, type DevicePaneHostDeps, type EmulatorGrpc } from "./device-pane-host";

const SDK: AndroidSdkPaths = {
  sdkRoot: "/sdk",
  adb: "/sdk/platform-tools/adb",
  emulator: "/sdk/emulator/emulator",
  avdmanager: "/sdk/cmdline-tools/latest/bin/avdmanager",
};
const SERIAL = "emulator-5554";

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** A raw emulator Image message whose every pixel is RGBA (fill, 0, 0, 255). */
function imageMessage(width: number, height: number, fill: number): Uint8Array {
  const format = [0x08, 1, 0x18, ...varint(width), 0x20, ...varint(height)];
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = fill;
    pixels[i + 3] = 255;
  }
  return Uint8Array.from([0x0a, format.length, ...format, 0x22, ...varint(pixels.length), ...pixels]);
}

interface FakeStream {
  onMessage: (raw: Uint8Array) => void;
  signal: AbortSignal;
}

interface Harness {
  host: DevicePaneHost;
  sent: Array<{ channel: string; args: unknown[] }>;
  streams: FakeStream[];
  inputs: Uint8Array[];
  clipboard: string[];
  encodes: Array<{ width: number; height: number; firstPixel: number[] }>;
  spawns: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>;
  getScreenshot: Mock<EmulatorGrpc["getScreenshot"]>;
  run: Mock<NonNullable<DevicePaneHostDeps["run"]>>;
  states(tabId: string): DevicePaneState[];
  frames(tabId: string): Uint8Array[];
}

function harness(
  opts: {
    sdk?: AndroidSdkPaths | null;
    agentRun?: () => Promise<DeviceRunResult>;
    /** `adb devices` stdout; the default lists one online emulator. */
    devices?: string;
    listDir?: (dir: string) => Promise<string[]>;
    readFile?: (file: string) => Promise<string>;
    writeFile?: (file: string, text: string) => Promise<void>;
    home?: () => string;
  } = {},
): Harness {
  const sent: Harness["sent"] = [];
  const streams: FakeStream[] = [];
  const inputs: Uint8Array[] = [];
  const clipboard: string[] = [];
  const encodes: Harness["encodes"] = [];
  const getScreenshot = vi.fn<EmulatorGrpc["getScreenshot"]>(() => new Promise<Uint8Array>(() => {}));
  const client: EmulatorGrpc = {
    streamScreenshot: (_format, onMessage, signal) => {
      streams.push({ onMessage, signal });
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
    getScreenshot,
    openInput: () => ({ send: (ev) => inputs.push(ev), close: () => {} }),
    setClipboard: async (text) => {
      clipboard.push(text);
    },
    setVmState: async () => {},
    onError: () => () => {},
    close: () => {},
  };
  const run = vi.fn<NonNullable<DevicePaneHostDeps["run"]>>(async (file, args) => {
    if (file === process.execPath) return opts.agentRun ? opts.agentRun() : { code: 0, stdout: "ok", stderr: "" };
    const joined = args.join(" ");
    if (joined === "devices")
      return { code: 0, stdout: opts.devices ?? `List of devices attached\n${SERIAL}\tdevice\n`, stderr: "" };
    if (joined === "-list-avds") return { code: 0, stdout: "INFO | something\nPixel_7\nTablet\n", stderr: "" };
    if (file.endsWith("avdmanager")) return { code: 0, stdout: `Created Android Virtual Device (AVD) ${args[3]}.`, stderr: "" };
    if (joined.endsWith("wm size")) return { code: 0, stdout: "Physical size: 1080x2400\n", stderr: "" };
    if (joined.endsWith("emu avd name")) return { code: 0, stdout: "Pixel_7\nOK\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  });
  const spawns: Harness["spawns"] = [];
  const host = new DevicePaneHost({
    send: (channel, ...args) => sent.push({ channel, args }),
    encodeJpeg: (bgra, width, height) => {
      encodes.push({ width, height, firstPixel: [...bgra.subarray(0, 4)] });
      return Uint8Array.from([0xff, 0xd8, encodes.length, 0xff, 0xd9]);
    },
    sdk: () => (opts.sdk === undefined ? SDK : opts.sdk),
    run,
    spawnDetached: (file, args, env) => {
      spawns.push({ file, args, env });
      return 4242;
    },
    createGrpc: () => client,
    ensureEndpoint: async () => ({ port: 8554, token: "t" }),
    discover: () => [],
    pidAlive: () => true,
    listDir: opts.listDir ?? (async () => []),
    readFile: opts.readFile ?? (async () => ""),
    writeFile: opts.writeFile ?? (async () => {}),
    home: opts.home ?? (() => "/home/test"),
    agentDeviceBin: () => "/app/node_modules/agent-device/bin/agent-device.mjs",
    stateDir: () => "/user/agent-device",
    tempDir: () => "/tmp",
  });
  return {
    host,
    sent,
    streams,
    inputs,
    clipboard,
    encodes,
    spawns,
    getScreenshot,
    run,
    states: (tabId) =>
      sent.filter((s) => s.channel === CH.onDevicePaneState && s.args[0] === tabId).map((s) => s.args[1] as DevicePaneState),
    frames: (tabId) =>
      sent.filter((s) => s.channel === CH.onDevicePaneFrame && s.args[0] === tabId).map((s) => s.args[1] as Uint8Array),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DevicePaneHost", () => {
  it("refuses a serial bound to another tab until that tab lets go", async () => {
    const h = harness();
    expect((await h.host.act("a", { action: "bind", serial: SERIAL })).phase).toBe("streaming");
    const refused = await h.host.act("b", { action: "bind", serial: SERIAL });
    expect(refused.phase).toBe("error");
    expect(refused.error).toBe("in use by another session");

    await h.host.act("a", { action: "unbind" });
    expect((await h.host.act("b", { action: "bind", serial: SERIAL })).phase).toBe("streaming");
  });

  it("streams only while subscribed and aborts on the last unsubscribe", async () => {
    const h = harness();
    await h.host.act("t", { action: "bind", serial: SERIAL });
    expect(h.streams).toHaveLength(0);

    h.host.subscribe("t", "c1", true);
    h.host.subscribe("t", "c2", true);
    expect(h.streams).toHaveLength(1);
    h.host.subscribe("t", "c1", false);
    expect(h.streams[0]?.signal.aborted).toBe(false);
    h.host.subscribe("t", "c2", false);
    expect(h.streams[0]?.signal.aborted).toBe(true);
  });

  it("encodes the newest message once per 33 ms slot", async () => {
    const h = harness();
    await h.host.act("t", { action: "bind", serial: SERIAL });
    h.host.subscribe("t", "c", true);
    const stream = h.streams[0];
    for (let i = 1; i <= 10; i++) stream?.onMessage(imageMessage(4, 8, i));
    expect(h.encodes).toHaveLength(1);
    vi.advanceTimersByTime(33);
    expect(h.encodes).toHaveLength(2);
    // R/B swapped to BGRA; the encoded one is the newest message.
    expect(h.encodes[1]?.firstPixel).toEqual([0, 0, 10, 255]);
    vi.advanceTimersByTime(100);
    expect(h.encodes).toHaveLength(2);
    expect(decodeBrowserPaneFrame(h.frames("t")[1] as Uint8Array)?.header).toEqual({ width: 4, height: 8, dsf: 1 });
    expect(h.host.diagnostics()[0]).toMatchObject({ framesEncoded: 2, framesCoalesced: 8, subscribers: 1 });
  });

  it("replays the cached frame to a joining subscriber and screenshots when nothing is cached", async () => {
    const h = harness();
    await h.host.act("t", { action: "bind", serial: SERIAL });
    h.host.subscribe("t", "c1", true);
    expect(h.getScreenshot).toHaveBeenCalledTimes(1);
    h.streams[0]?.onMessage(imageMessage(4, 8, 1));
    const first = h.frames("t");
    expect(first).toHaveLength(1);

    h.host.subscribe("t", "c2", true);
    const after = h.frames("t");
    expect(after).toHaveLength(2);
    expect(after[1]).toBe(first[0]);
    expect(h.getScreenshot).toHaveBeenCalledTimes(1);
  });

  it("maps unit touches to native pixels and swaps axes for a landscape frame", async () => {
    const h = harness();
    await h.host.act("t", { action: "bind", serial: SERIAL });
    h.host.subscribe("t", "c", true);
    h.streams[0]?.onMessage(imageMessage(9, 20, 1));
    h.host.input("t", { type: "touch", phase: "down", x: 0.5, y: 0.25, pointer: 0 });
    h.host.input("t", { type: "touch", phase: "up", x: 1, y: 1, pointer: 0 });
    expect(h.inputs).toEqual([
      encodeTouchInput([{ x: 540, y: 600, id: 0, pressure: 1 }]),
      encodeTouchInput([{ x: 1079, y: 2399, id: 0, pressure: 0 }]),
    ]);

    vi.advanceTimersByTime(33);
    h.streams[0]?.onMessage(imageMessage(20, 9, 2));
    h.host.input("t", { type: "touch", phase: "down", x: 0.5, y: 0.5, pointer: 1 });
    expect(h.inputs.at(-1)).toEqual(encodeTouchInput([{ x: 1200, y: 540, id: 1, pressure: 1 }]));
  });

  it("drops input unless streaming", async () => {
    const h = harness();
    h.host.input("t", { type: "touch", phase: "down", x: 0.5, y: 0.5, pointer: 0 });
    expect(h.inputs).toHaveLength(0);
  });

  it("releases every active pointer with pressure 0 on unbind", async () => {
    const h = harness();
    await h.host.act("t", { action: "bind", serial: SERIAL });
    h.host.input("t", { type: "touch", phase: "down", x: 0.1, y: 0.1, pointer: 3 });
    h.host.input("t", { type: "touch", phase: "move", x: 0.2, y: 0.2, pointer: 3 });
    h.inputs.length = 0;
    await h.host.act("t", { action: "unbind" });
    expect(h.inputs).toEqual([encodeTouchInput([{ x: 216, y: 480, id: 3, pressure: 0 }])]);
  });

  it("types printable ASCII and pastes anything else through the clipboard", async () => {
    const h = harness();
    await h.host.act("t", { action: "bind", serial: SERIAL });
    h.host.input("t", { type: "text", text: "hi" });
    expect(h.inputs).toEqual([encodeKeyInput({ eventType: 2, text: "hi" })]);
    expect(h.clipboard).toEqual([]);

    h.inputs.length = 0;
    h.host.input("t", { type: "text", text: "héllo 안녕" });
    await vi.waitFor(() => expect(h.inputs).toHaveLength(3));
    expect(h.clipboard).toEqual(["héllo 안녕"]);
    expect(h.inputs).toEqual([
      encodeKeyInput({ eventType: 0, key: "Control" }),
      encodeKeyInput({ eventType: 2, key: "v" }),
      encodeKeyInput({ eventType: 1, key: "Control" }),
    ]);
  });

  it("remembers the serial across dispose and forgets it with forget", async () => {
    const h = harness();
    await h.host.act("t", { action: "bind", serial: SERIAL });
    h.host.dispose("t");
    // The serial is released for other tabs while remembered for this one.
    expect((await h.host.act("other", { action: "bind", serial: SERIAL })).phase).toBe("streaming");
    await h.host.act("other", { action: "unbind" });

    const resumed = await h.host.ensure("t");
    expect(resumed.state).toMatchObject({ serial: SERIAL, phase: "streaming" });

    h.host.dispose("t", { forget: true });
    const fresh = await h.host.ensure("t");
    expect(fresh.state).toMatchObject({ serial: null, phase: "unbound" });
  });

  it("runs an agent forward as acting, auto-opens the pane, then returns to attached", async () => {
    const agent = Promise.withResolvers<DeviceRunResult>();
    const h = harness({ agentRun: () => agent.promise });
    await h.host.act("t", { action: "bind", serial: SERIAL });
    const answer = h.host.runAgentCommand("t", "/proj", { args: ["snapshot", "-i"] });
    await vi.waitFor(() => expect(h.run.mock.calls.some(([file]) => file === process.execPath)).toBe(true));
    expect(h.states("t").at(-1)).toMatchObject({ agent: "acting", open: true });

    const call = h.run.mock.calls.find(([file]) => file === process.execPath);
    expect(call?.[1]).toEqual(expect.arrayContaining(["--serial", SERIAL, "--platform", "android"]));
    expect(call?.[2]).toMatchObject({
      cwd: "/proj",
      env: { ELECTRON_RUN_AS_NODE: "1", AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST: SERIAL },
    });

    agent.resolve({ code: 0, stdout: "@e1 Settings", stderr: "" });
    expect((await answer).isError).toBe(false);
    expect(h.states("t").at(-1)?.agent).toBe("acting");
    vi.advanceTimersByTime(DEVICE_PANE_ACTING_MS);
    expect(h.states("t").at(-1)?.agent).toBe("attached");
  });

  it("answers an error without running anything when the SDK is missing", async () => {
    const h = harness({ sdk: null });
    const answer = await h.host.runAgentCommand("t", "/proj", { args: ["targets"] });
    expect(answer.isError).toBe(true);
    expect(h.run).not.toHaveBeenCalled();
    expect((await h.host.inventory()).sdk).toEqual({ status: "missing", missing: ["sdk", "adb", "emulator"] });
  });

  /** /sdk/system-images with android-36/google_apis/x86_64 and android-35/default/x86_64 installed. */
  // Keys built with the platform's join: provision() asks for path.join(sdkRoot,
  // "system-images", ...), which is backslashed on win32 (issue #1011).
  const images = (...parts: string[]): string => path.join(SDK.sdkRoot, "system-images", ...parts);
  const listImages = async (dir: string): Promise<string[]> => {
    if (dir === images()) return ["android-36", "android-35"];
    if (dir === images("android-36")) return ["google_apis"];
    if (dir === images("android-36", "google_apis")) return ["x86_64"];
    if (dir === images("android-35")) return ["default"];
    if (dir === images("android-35", "default")) return ["x86_64"];
    return [];
  };

  it("provisions a bundled-profile AVD before spawning the emulator", async () => {
    const writes: Array<{ file: string; text: string }> = [];
    const stubConfig = [
      "avd.id=pixel_11_pro_xl",
      "avd.name=pixel_11_pro_xl",
      "hw.keyboard=no",
      "hw.lcd.width=1080",
      "hw.lcd.height=1920",
      "hw.lcd.density=420",
      "hw.lcd.size=8.0",
      "hw.cpu.arch=x86_64",
      "",
    ].join("\n");
    const h = harness({
      devices: "List of devices attached\n",
      listDir: listImages,
      readFile: async () => stubConfig,
      writeFile: async (file, text) => {
        writes.push({ file, text });
      },
      home: () => "/home/test",
    });
    const state = await h.host.act("t", { action: "boot", avd: "pixel_11_pro_xl" });
    expect(state.phase).toBe("booting");

    const create = h.run.mock.calls.find(([file]) => file.endsWith("avdmanager"));
    expect(create?.[1]).toEqual([
      "create",
      "avd",
      "-n",
      "pixel_11_pro_xl",
      "-k",
      "system-images;android-36;google_apis;x86_64",
      "-d",
      "pixel_10_pro",
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.file).toBe(avdConfigPath("/home/test", "pixel_11_pro_xl"));
    const cfg = writes[0]?.text ?? "";
    expect(cfg).toContain("hw.lcd.width=1344");
    expect(cfg).toContain("hw.lcd.height=2992");
    expect(cfg).toContain("hw.lcd.density=480");
    expect(cfg).toContain("hw.keyboard=yes");
    expect(cfg).not.toContain("hw.keyboard=no");
    expect(cfg).not.toContain("hw.lcd.size");

    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]?.file).toBe("/sdk/emulator/emulator");
    expect(h.spawns[0]?.args).toEqual(expect.arrayContaining(["-avd", "pixel_11_pro_xl", "-no-window"]));
  });

  it("boots an existing AVD without any avdmanager call", async () => {
    const h = harness({ devices: "List of devices attached\n", listDir: listImages });
    const state = await h.host.act("t", { action: "boot", avd: "Pixel_7" });
    expect(state.phase).toBe("booting");
    expect(h.run.mock.calls.some(([file]) => file.endsWith("avdmanager"))).toBe(false);
    expect(h.spawns).toHaveLength(1);
  });

  it("errors a profile boot when avdmanager is missing", async () => {
    const h = harness({ devices: "List of devices attached\n", sdk: { ...SDK, avdmanager: null } });
    const state = await h.host.act("t", { action: "boot", avd: "pixel_11_pro_xl" });
    expect(state.phase).toBe("error");
    expect(state.error).toContain("avdmanager");
    expect(h.spawns).toHaveLength(0);
  });

  it("names sdkmanager when no installed system image fits", async () => {
    const h = harness({ devices: "List of devices attached\n", listDir: async () => [] });
    const state = await h.host.act("t", { action: "boot", avd: "pixel_11_pro_xl" });
    expect(state.phase).toBe("error");
    expect(state.error).toContain("system-images");
    expect(state.error).toContain("sdkmanager");
    expect(h.run.mock.calls.some(([file]) => file.endsWith("avdmanager"))).toBe(false);
    expect(h.spawns).toHaveLength(0);
  });
});
