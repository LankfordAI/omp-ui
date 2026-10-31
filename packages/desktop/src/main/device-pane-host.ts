import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CH,
  DEVICE_PANE_ACTING_MS,
  DEVICE_PANE_FPS,
  DEVICE_PANE_JPEG_QUALITY,
  DEVICE_PANE_MAX_EDGE,
  DEVICE_SERIAL_PATTERN,
  DEVICE_AVD_PATTERN,
  DEVICE_TOOL_TIMEOUT_MS,
  androidChildEnv,
  androidSdkStatus,
  avdConfigPath,
  decodeImage,
  encodeBrowserPaneFrameHeader,
  encodeKeyInput,
  encodeMouseInput,
  encodeTouchInput,
  encodeWheelInput,
  findDeviceProfileByAvd,
  parseAdbDevices,
  parseAvdList,
  parseInstalledImages,
  parseWmSize,
  patchAvdConfig,
  pickSystemImagePackage,
  planDeviceCommand,
  resolveAndroidSdk,
  type AndroidSdkPaths,
  type DeviceButton,
  type DeviceInventory,
  type DevicePaneAction,
  type DevicePaneAgentState,
  type DevicePaneDiagnostics,
  type DevicePaneInputEvent,
  type DevicePaneState,
  type DeviceProfile,
  type DeviceSdkStatus,
  type DeviceTarget,
  type HostToolContent,
} from "@omp-ui/core";
import {
  EmulatorGrpcClient,
  discoveryForAvd,
  discoveryForSerial,
  ensureEmulatorGrpcEndpoint,
  isPidAlive,
  readEmulatorDiscovery,
  type EmulatorDiscoveryRecord,
  type GrpcEndpoint,
} from "./emulator-grpc";

/**
 * One device pane per rpc tab (issue #1006, ADR-0086): the tab's Android
 * Emulator binding, its gRPC screen stream JPEG-encoded onto the lossy frame
 * transport, the user's input mapped back onto the emulator, and the agent's
 * `omp-ui_device` commands run through a bound agent-device child. Endpoints,
 * tokens and the serial-to-port mapping never leave this module.
 */

export type DeviceRunResult = { code: number | null; stdout: string; stderr: string };
/** The gRPC surface this host uses; the real {@link EmulatorGrpcClient} satisfies it. */
export type EmulatorGrpc = Pick<
  EmulatorGrpcClient,
  "streamScreenshot" | "getScreenshot" | "openInput" | "setClipboard" | "setVmState" | "onError" | "close"
>;

export interface DevicePaneHostDeps {
  send(channel: string, ...args: unknown[]): void;
  /** BGRA in, JPEG out. backend.ts passes nativeImage.createFromBitmap(buf,{width,height}).toJPEG(q). */
  encodeJpeg(bgra: Buffer, width: number, height: number, quality: number): Uint8Array;
  /** Default: resolveAndroidSdk() per call. */
  sdk?(): AndroidSdkPaths | null;
  /** execFile, never rejects (runGh shape). */
  run?(
    file: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
  ): Promise<DeviceRunResult>;
  /** Detached, unref'd, stdio ignored; returns the pid. */
  spawnDetached?(file: string, args: string[], env: NodeJS.ProcessEnv): number | null;
  createGrpc?(endpoint: GrpcEndpoint): EmulatorGrpc;
  ensureEndpoint?: typeof ensureEmulatorGrpcEndpoint;
  /** Every live emulator discovery file. Default: readEmulatorDiscovery(). */
  discover?(): EmulatorDiscoveryRecord[];
  /** Default: isPidAlive (process.kill(pid, 0)). */
  pidAlive?(pid: number): boolean;
  /** Directory entry names, for the system-images scan. Default: readdir from node:fs/promises. */
  listDir?(dir: string): Promise<string[]>;
  /** AVD config.ini read/write during provisioning. Default: node:fs/promises. */
  readFile?(file: string): Promise<string>;
  writeFile?(file: string, text: string): Promise<void>;
  /** AVD home (~/.android lives here). Default: os.homedir(). */
  home?(): string;
  /** §8.2 resolveAgentDeviceBin. */
  agentDeviceBin(): string | null;
  /** <userData>/agent-device */
  stateDir(): string;
  /** Default: os.tmpdir(). */
  tempDir?(): string;
  now?(): number;
}

interface DeviceEntry {
  tabId: string;
  serial: string | null;
  avd: string | null;
  phase: DevicePaneState["phase"];
  agent: DevicePaneAgentState;
  open: boolean;
  error: string | null;
  /** Native display size in device pixels. */
  display: { width: number; height: number } | null;
  sinks: Set<string>;
  cached: Uint8Array | null;
  client: EmulatorGrpc | null;
  offClientError: (() => void) | null;
  streamAbort: AbortController | null;
  inputSender: { send(inputEvent: Uint8Array): void; close(): void } | null;
  activePointers: Map<number, { x: number; y: number }>;
  actingTimer: NodeJS.Timeout | undefined;
  agentInflight: number;
  pending: Uint8Array | null;
  slotTimer: NodeJS.Timeout | undefined;
  /** Size of the last encoded frame; drives the rotation axis swap. */
  lastFrame: { width: number; height: number } | null;
  screenshotInFlight: boolean;
  /** Bumped by every teardown; async bind/boot steps of an older generation stop. */
  generation: number;
  bindAbort: AbortController | null;
  framesEncoded: number;
  framesCoalesced: number;
  lastEncodeMs: number | null;
  maxEncodeMs: number | null;
}

function newEntry(tabId: string): DeviceEntry {
  return {
    tabId,
    serial: null,
    avd: null,
    phase: "unbound",
    agent: "detached",
    open: false,
    error: null,
    display: null,
    sinks: new Set(),
    cached: null,
    client: null,
    offClientError: null,
    streamAbort: null,
    inputSender: null,
    activePointers: new Map(),
    actingTimer: undefined,
    agentInflight: 0,
    pending: null,
    slotTimer: undefined,
    lastFrame: null,
    screenshotInFlight: false,
    generation: 0,
    bindAbort: null,
    framesEncoded: 0,
    framesCoalesced: 0,
    lastEncodeMs: null,
    maxEncodeMs: null,
  };
}

const FRAME_INTERVAL_MS = Math.round(1000 / DEVICE_PANE_FPS);
const STREAM_FORMAT = { width: DEVICE_PANE_MAX_EDGE, height: DEVICE_PANE_MAX_EDGE };
const ADB_TIMEOUT_MS = 15_000;
// avdmanager is a cold JVM start; it can take well over a minute on a busy disk.
const PROVISION_TIMEOUT_MS = 120_000;
const DISCOVERY_POLL_MS = 500;
const DISCOVERY_POLLS = 120; // 60 s
const BOOT_POLL_MS = 1_000;
const BOOT_POLLS = 180; // 180 s
const VM_SHUTDOWN = 5;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const SOFTWARE_GPU = "swangle_indirect";
const SERIAL_RE = new RegExp(DEVICE_SERIAL_PATTERN);
const AVD_RE = new RegExp(DEVICE_AVD_PATTERN);
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const BUTTON_KEYS: Record<DeviceButton, string> = { back: "GoBack", home: "GoHome", recents: "AppSwitch", power: "Power" };
const CONFLICT_ERROR = "in use by another session";

/** execFile that never rejects (the runGh shape). */
function defaultRun(
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
): Promise<DeviceRunResult> {
  const { promise, resolve } = Promise.withResolvers<DeviceRunResult>();
  execFile(
    file,
    args,
    { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
    (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      // A numeric code is the exit status; ENOENT and kills carry none.
      const code = "code" in error && typeof error.code === "number" ? error.code : null;
      resolve({ code, stdout: stdout ?? "", stderr: stderr || error.message });
    },
  );
  return promise;
}

function defaultSpawnDetached(file: string, args: string[], env: NodeJS.ProcessEnv): number | null {
  try {
    const child = spawn(file, args, { env, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serialPort(serial: string): number {
  return Number(serial.slice(serial.lastIndexOf("-") + 1));
}

function missingSdkText(sdk: DeviceSdkStatus): string {
  const missing = sdk.status === "missing" ? sdk.missing.join(", ") : "";
  return `The Android SDK is not usable (missing: ${missing}). Install platform-tools and the emulator, or set ANDROID_HOME to an SDK that has them.`;
}

/** RGBA → BGRA in place, one 32-bit word per pixel (little-endian host). */
function swapRedBlue(pixels: Uint8Array): Uint8Array {
  const aligned = pixels.byteOffset % 4 === 0 ? pixels : pixels.slice();
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  for (let i = 0; i < words.length; i++) {
    const v = words[i] as number;
    words[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff);
  }
  return aligned;
}

function truncateOutput(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= OUTPUT_LIMIT_BYTES) return text;
  return `${bytes.subarray(0, OUTPUT_LIMIT_BYTES).toString("utf8")}\n[output truncated at 64 KiB]`;
}

export class DevicePaneHost {
  private readonly entries = new Map<string, DeviceEntry>();
  /** serial → the tab bound to it. */
  private readonly boundBy = new Map<string, string>();
  /** Disposed (hibernated, switched, quit) tabs' last binding; the next ensure rebinds it. */
  private readonly remembered = new Map<string, { serial: string; avd: string | null }>();
  /** AVDs this host is booting → the booting tab. */
  private readonly booting = new Map<string, string>();
  private readonly send: DevicePaneHostDeps["send"];
  private readonly encodeJpeg: DevicePaneHostDeps["encodeJpeg"];
  private readonly sdk: () => AndroidSdkPaths | null;
  private readonly run: NonNullable<DevicePaneHostDeps["run"]>;
  private readonly spawnDetached: NonNullable<DevicePaneHostDeps["spawnDetached"]>;
  private readonly createGrpc: (endpoint: GrpcEndpoint) => EmulatorGrpc;
  private readonly ensureEndpoint: typeof ensureEmulatorGrpcEndpoint;
  private readonly discover: () => EmulatorDiscoveryRecord[];
  private readonly pidAlive: (pid: number) => boolean;
  private readonly listDir: (dir: string) => Promise<string[]>;
  private readonly readFile: (file: string) => Promise<string>;
  private readonly writeFile: (file: string, text: string) => Promise<void>;
  private readonly home: () => string;
  private readonly agentDeviceBin: () => string | null;
  private readonly stateDir: () => string;
  private readonly tempDir: () => string;
  private readonly now: () => number;

  constructor(deps: DevicePaneHostDeps) {
    this.send = deps.send;
    this.encodeJpeg = deps.encodeJpeg;
    this.sdk = deps.sdk ?? (() => resolveAndroidSdk());
    this.run = deps.run ?? defaultRun;
    this.spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
    this.createGrpc = deps.createGrpc ?? ((endpoint) => new EmulatorGrpcClient(endpoint));
    this.ensureEndpoint = deps.ensureEndpoint ?? ensureEmulatorGrpcEndpoint;
    this.discover = deps.discover ?? (() => readEmulatorDiscovery());
    this.pidAlive = deps.pidAlive ?? isPidAlive;
    this.listDir = deps.listDir ?? ((dir) => readdir(dir));
    this.readFile = deps.readFile ?? ((file) => readFile(file, "utf8"));
    this.writeFile = deps.writeFile ?? ((file, text) => writeFile(file, text, "utf8"));
    this.home = deps.home ?? (() => os.homedir());
    this.agentDeviceBin = deps.agentDeviceBin;
    this.stateDir = deps.stateDir;
    this.tempDir = deps.tempDir ?? (() => os.tmpdir());
    this.now = deps.now ?? (() => performance.now());
  }

  async inventory(): Promise<DeviceInventory> {
    const sdk = this.sdk();
    const status = androidSdkStatus(sdk);
    if (sdk === null) return { sdk: status, targets: [] };
    const env = androidChildEnv(sdk);
    const [running, avdsOut] = await Promise.all([
      this.runningEmulators(sdk),
      sdk.emulator === null ? null : this.run(sdk.emulator, ["-list-avds"], { env, timeoutMs: ADB_TIMEOUT_MS }),
    ]);
    const bootingSerials = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.phase === "booting" && entry.serial !== null) bootingSerials.add(entry.serial);
    }
    const live: DeviceTarget[] = running.map((r) => ({
      serial: r.serial,
      avd: r.avd,
      state: r.online && !bootingSerials.has(r.serial) ? "running" : "booting",
    }));
    const liveAvds = new Set(live.map((t) => t.avd));
    for (const avd of this.booting.keys()) {
      if (!liveAvds.has(avd)) {
        live.push({ serial: null, avd, state: "booting" });
        liveAvds.add(avd);
      }
    }
    // Serial order; AVDs booting here without a serial yet follow, by name.
    live.sort((a, b) => {
      if (a.serial !== null && b.serial !== null) return serialPort(a.serial) - serialPort(b.serial);
      if (a.serial !== null || b.serial !== null) return a.serial === null ? 1 : -1;
      return a.avd.localeCompare(b.avd);
    });
    const stopped: DeviceTarget[] = (avdsOut === null ? [] : parseAvdList(avdsOut.stdout))
      .filter((avd) => !liveAvds.has(avd))
      .sort((a, b) => a.localeCompare(b))
      .map((avd) => ({ serial: null, avd, state: "stopped" }));
    return { sdk: status, targets: [...live, ...stopped] };
  }

  async ensure(tabId: string): Promise<{ state: DevicePaneState; inventory: DeviceInventory }> {
    const entry = this.entry(tabId);
    let inventory = await this.inventory();
    const remembered = this.remembered.get(tabId);
    if (remembered !== undefined && this.entries.get(tabId) === entry && entry.serial === null && entry.phase === "unbound") {
      this.remembered.delete(tabId);
      const target = inventory.targets.find((t) => t.serial === remembered.serial && t.state === "running");
      if (target !== undefined) {
        await this.bind(entry, remembered.serial, target.avd);
        inventory = await this.inventory();
      }
    }
    return { state: this.currentState(entry), inventory };
  }

  async act(tabId: string, action: DevicePaneAction): Promise<DevicePaneState> {
    const entry = this.entry(tabId);
    switch (action.action) {
      case "bind":
        await this.bind(entry, action.serial, null);
        break;
      case "boot":
        await this.boot(entry, action.avd);
        break;
      case "unbind":
        this.remembered.delete(tabId);
        this.unbind(entry);
        break;
      case "power-off":
        await this.powerOff(entry);
        break;
      case "refresh":
        if (entry.serial !== null && entry.phase === "error") await this.bind(entry, entry.serial, entry.avd);
        break;
    }
    return this.currentState(entry);
  }

  subscribe(tabId: string, clientId: string, on: boolean): void {
    if (!on) {
      const entry = this.entries.get(tabId);
      if (entry !== undefined && entry.sinks.delete(clientId)) this.syncStream(entry);
      return;
    }
    const entry = this.entry(tabId);
    entry.sinks.add(clientId);
    const started = this.syncStream(entry);
    if (entry.cached !== null) this.send(CH.onDevicePaneFrame, tabId, entry.cached);
    else if (!started) this.kickScreenshot(entry);
  }

  input(tabId: string, ev: DevicePaneInputEvent): void {
    const entry = this.entries.get(tabId);
    const client = entry?.client ?? null;
    if (entry === undefined || client === null || entry.phase !== "streaming") return;
    entry.inputSender ??= client.openInput();
    const sender = entry.inputSender;
    switch (ev.type) {
      case "touch": {
        const point = this.mapPoint(entry, ev.x, ev.y);
        if (point === null) return;
        if (ev.phase === "up") {
          entry.activePointers.delete(ev.pointer);
          sender.send(encodeTouchInput([{ ...point, id: ev.pointer, pressure: 0 }]));
        } else {
          entry.activePointers.set(ev.pointer, point);
          sender.send(encodeTouchInput([{ ...point, id: ev.pointer, pressure: 1 }]));
        }
        return;
      }
      case "wheel": {
        const point = this.mapPoint(entry, ev.x, ev.y);
        if (point === null) return;
        sender.send(encodeMouseInput(point.x, point.y, 0));
        sender.send(encodeWheelInput(ev.dx, ev.dy));
        return;
      }
      case "key":
        sender.send(encodeKeyInput({ eventType: ev.phase === "down" ? 0 : 1, key: ev.key }));
        return;
      case "text":
        if (ev.text === "") return;
        if (PRINTABLE_ASCII_RE.test(ev.text)) {
          sender.send(encodeKeyInput({ eventType: 2, text: ev.text }));
          return;
        }
        // Only ASCII types reliably (proto); everything else is pasted.
        void client.setClipboard(ev.text).then(
          () => {
            if (entry.inputSender !== sender) return;
            sender.send(encodeKeyInput({ eventType: 0, key: "Control" }));
            sender.send(encodeKeyInput({ eventType: 2, key: "v" }));
            sender.send(encodeKeyInput({ eventType: 1, key: "Control" }));
          },
          () => {},
        );
        return;
      case "button":
        sender.send(encodeKeyInput({ eventType: 2, key: BUTTON_KEYS[ev.button] }));
    }
  }

  /** Session-level posture (#556); the stream stays bound to `subscribe`. */
  setOpen(tabId: string, open: boolean): void {
    const entry = this.entry(tabId);
    if (entry.open === open) return;
    entry.open = open;
    this.emitState(entry);
  }

  /** The host tool's answer; never throws. */
  async runAgentCommand(
    tabId: string,
    cwd: string,
    args: unknown,
  ): Promise<{ content: HostToolContent[]; isError: boolean }> {
    const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
    try {
      const entry = this.entry(tabId);
      const serial = entry.serial !== null && this.boundBy.get(entry.serial) === tabId ? entry.serial : null;
      const session = `omp-ui-${createHash("sha256").update(tabId).digest("hex").slice(0, 12)}`;
      const outPath = path.join(this.tempDir(), `omp-ui-device-${randomUUID()}.png`);
      const plan = planDeviceCommand(args, serial === null ? null : { serial, session }, outPath);
      if (plan.kind === "refused") return text(plan.reason, true);
      const sdk = this.sdk();
      if (sdk === null) return text(missingSdkText(androidSdkStatus(sdk)), true);
      switch (plan.kind) {
        case "targets": {
          const inventory = await this.inventory();
          const lines = inventory.targets.map((t) => `${t.serial ?? "-"}\t${t.avd}\t${t.state}`);
          return text(lines.length === 0 ? "No emulators or AVDs found." : `serial\tavd\tstate\n${lines.join("\n")}`);
        }
        case "use": {
          const state =
            "serial" in plan.target
              ? await this.act(tabId, { action: "bind", serial: plan.target.serial })
              : await this.act(tabId, { action: "boot", avd: plan.target.avd });
          if (!entry.open) this.setOpen(tabId, true);
          return text(this.describeState(this.currentState(entry)), state.phase === "error");
        }
        case "forward": {
          const bin = this.agentDeviceBin();
          if (bin === null) return text("agent-device is not available: its bin/agent-device.mjs was not found in this install.", true);
          return await this.forward(entry, sdk, bin, cwd, plan.argv, plan.screenshotOut ? outPath : null, serial ?? "");
        }
      }
    } catch (err) {
      return text(`device command failed: ${errorText(err)}`, true);
    }
  }

  diagnostics(): DevicePaneDiagnostics[] {
    return [...this.entries.values()].map((entry) => ({
      tabId: entry.tabId,
      serial: entry.serial,
      phase: entry.phase,
      subscribers: entry.sinks.size,
      framesEncoded: entry.framesEncoded,
      framesCoalesced: entry.framesCoalesced,
      lastEncodeMs: entry.lastEncodeMs,
      maxEncodeMs: entry.maxEncodeMs,
    }));
  }

  /** Stops the stream and drops the binding; the emulator keeps running. `forget` drops the remembered serial (delete). */
  dispose(tabId: string, opts?: { forget?: boolean }): void {
    const entry = this.entries.get(tabId);
    if (opts?.forget === true) this.remembered.delete(tabId);
    if (entry === undefined) return;
    clearTimeout(entry.actingTimer);
    entry.actingTimer = undefined;
    this.release(entry);
    if (entry.serial !== null && opts?.forget !== true) this.remembered.set(tabId, { serial: entry.serial, avd: entry.avd });
    this.entries.delete(tabId);
    this.send(CH.onDevicePaneState, tabId, this.currentState(newEntry(tabId)));
  }

  disposeAll(): void {
    for (const tabId of [...this.entries.keys()]) this.dispose(tabId);
  }

  private entry(tabId: string): DeviceEntry {
    let entry = this.entries.get(tabId);
    if (entry === undefined) {
      entry = newEntry(tabId);
      this.entries.set(tabId, entry);
    }
    return entry;
  }

  private stale(entry: DeviceEntry, generation: number): boolean {
    return entry.generation !== generation || this.entries.get(entry.tabId) !== entry;
  }

  private currentState(entry: DeviceEntry): DevicePaneState {
    return {
      serial: entry.serial,
      avd: entry.avd,
      phase: entry.phase,
      agent: entry.agent,
      error: entry.error,
      open: entry.open,
      display: entry.display,
    };
  }

  private emitState(entry: DeviceEntry): void {
    if (this.entries.get(entry.tabId) !== entry) return;
    this.send(CH.onDevicePaneState, entry.tabId, this.currentState(entry));
  }

  private setPhase(entry: DeviceEntry, phase: DevicePaneState["phase"], error: string | null = null): void {
    entry.phase = phase;
    entry.error = error;
    this.emitState(entry);
  }

  private describeState(state: DevicePaneState): string {
    const target = state.serial === null ? (state.avd ?? "no emulator") : `${state.avd ?? "emulator"} (${state.serial})`;
    const tail = state.error === null ? "" : `: ${state.error}`;
    return `${target} is ${state.phase}${tail}. The device pane is ${state.open ? "open" : "closed"}.`;
  }

  /** Running emulators per `adb devices`, with their AVD names (discovery file, else `adb emu avd name`). */
  private async runningEmulators(sdk: AndroidSdkPaths): Promise<Array<{ serial: string; avd: string; online: boolean }>> {
    const env = androidChildEnv(sdk);
    const devices = await this.run(sdk.adb, ["devices"], { env, timeoutMs: ADB_TIMEOUT_MS });
    const rows = parseAdbDevices(devices.stdout).filter((r) => SERIAL_RE.test(r.serial));
    if (rows.length === 0) return [];
    const records = this.discover();
    return Promise.all(
      rows.map(async (r) => {
        const fromFile = discoveryForSerial(records, r.serial)?.values.get("avd.name");
        const avd = fromFile !== undefined && AVD_RE.test(fromFile) ? fromFile : await this.adbAvdName(sdk, env, r.serial);
        return { serial: r.serial, avd: avd ?? r.serial, online: r.state === "device" };
      }),
    );
  }

  private async adbAvdName(sdk: AndroidSdkPaths, env: NodeJS.ProcessEnv, serial: string): Promise<string | null> {
    const out = await this.run(sdk.adb, ["-s", serial, "emu", "avd", "name"], { env, timeoutMs: ADB_TIMEOUT_MS });
    if (out.code !== 0) return null;
    for (const raw of out.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (line !== "" && line !== "OK" && AVD_RE.test(line)) return line;
    }
    return null;
  }

  /** Stream, input, client and pending async steps go; boundBy stays (the tab still claims the serial). */
  private teardown(entry: DeviceEntry): void {
    entry.generation += 1;
    this.releasePointers(entry);
    entry.inputSender?.close();
    entry.inputSender = null;
    this.stopStream(entry);
    entry.bindAbort?.abort();
    entry.bindAbort = null;
    entry.offClientError?.();
    entry.offClientError = null;
    entry.client?.close();
    entry.client = null;
    entry.screenshotInFlight = false;
  }

  private release(entry: DeviceEntry): void {
    this.teardown(entry);
    if (entry.serial !== null && this.boundBy.get(entry.serial) === entry.tabId) this.boundBy.delete(entry.serial);
    for (const [avd, tabId] of this.booting) if (tabId === entry.tabId) this.booting.delete(avd);
  }

  /** Pressure 0 for every active pointer, so a NEVER_EXPIRE touch cannot stick. */
  private releasePointers(entry: DeviceEntry): void {
    const sender = entry.inputSender;
    if (sender !== null) {
      for (const [id, point] of entry.activePointers) sender.send(encodeTouchInput([{ ...point, id, pressure: 0 }]));
    }
    entry.activePointers.clear();
  }

  private unbind(entry: DeviceEntry): void {
    this.release(entry);
    entry.serial = null;
    entry.avd = null;
    entry.display = null;
    entry.cached = null;
    entry.lastFrame = null;
    this.setPhase(entry, "unbound");
  }

  private async bind(entry: DeviceEntry, serial: string, avd: string | null): Promise<void> {
    const owner = this.boundBy.get(serial);
    if (owner !== undefined && owner !== entry.tabId) {
      this.release(entry);
      entry.serial = serial;
      entry.avd = avd;
      entry.display = null;
      entry.cached = null;
      this.setPhase(entry, "error", CONFLICT_ERROR);
      return;
    }
    this.release(entry);
    const generation = entry.generation;
    entry.serial = serial;
    entry.avd = avd;
    entry.display = null;
    entry.cached = null;
    entry.lastFrame = null;
    this.boundBy.set(serial, entry.tabId);
    this.setPhase(entry, "connecting");
    const sdk = this.sdk();
    if (sdk === null) {
      this.setPhase(entry, "error", missingSdkText(androidSdkStatus(sdk)));
      return;
    }
    const abort = new AbortController();
    entry.bindAbort = abort;
    try {
      const env = androidChildEnv(sdk);
      const endpoint = await this.ensureEndpoint(serial, sdk, abort.signal);
      if (this.stale(entry, generation)) return;
      const client = this.createGrpc(endpoint);
      entry.client = client;
      entry.offClientError = client.onError((err) => {
        if (entry.client === client) this.streamFailed(entry, `emulator connection lost: ${err.message}`);
      });
      const fromFile = discoveryForSerial(this.discover(), serial)?.values.get("avd.name");
      const [wm, name] = await Promise.all([
        this.run(sdk.adb, ["-s", serial, "shell", "wm", "size"], { env, timeoutMs: ADB_TIMEOUT_MS }),
        entry.avd ?? (fromFile !== undefined && AVD_RE.test(fromFile) ? fromFile : this.adbAvdName(sdk, env, serial)),
      ]);
      if (this.stale(entry, generation)) return;
      entry.display = parseWmSize(wm.stdout);
      entry.avd = name;
      entry.bindAbort = null;
      this.setPhase(entry, "streaming");
      this.syncStream(entry);
    } catch (err) {
      if (this.stale(entry, generation)) return;
      this.teardown(entry);
      this.setPhase(entry, "error", errorText(err));
    }
  }

  /** Provision an AVD for a bundled device profile; returns an error message or null. */
  private async provision(sdk: AndroidSdkPaths, profile: DeviceProfile): Promise<string | null> {
    if (sdk.avdmanager === null) return "provisioning needs Android command-line tools (avdmanager)";
    const rows: Array<readonly [string, string, string]> = [];
    const imagesRoot = path.join(sdk.sdkRoot, "system-images");
    // listDir failures read as empty: a half-installed SDK dir simply yields no rows.
    const ls = async (dir: string): Promise<string[]> => {
      try {
        return await this.listDir(dir);
      } catch {
        return [];
      }
    };
    for (const api of await ls(imagesRoot)) {
      for (const tag of await ls(path.join(imagesRoot, api))) {
        for (const abi of await ls(path.join(imagesRoot, api, tag))) rows.push([api, tag, abi]);
      }
    }
    const pkg = pickSystemImagePackage(parseInstalledImages(rows), process.arch);
    if (pkg === null) {
      const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
      return `no Android system image is installed; install one first (e.g. sdkmanager "system-images;android-36;google_apis;${abi}")`;
    }
    const created = await this.run(
      sdk.avdmanager,
      ["create", "avd", "-n", profile.avd, "-k", pkg, "-d", profile.donor],
      { env: androidChildEnv(sdk), timeoutMs: PROVISION_TIMEOUT_MS },
    );
    if (created.code !== 0) {
      return `avdmanager could not create ${profile.avd}: ${(created.stderr.trim() || "avdmanager create avd failed").slice(0, 500)}`;
    }
    const cfg = avdConfigPath(this.home(), profile.avd);
    try {
      const text = await this.readFile(cfg);
      await this.writeFile(cfg, patchAvdConfig(text, profile));
    } catch (err) {
      // The AVD exists; booting unpatched beats deleting user-visible state.
      console.error(`device pane: provisioned ${profile.avd} but could not patch its config.ini: ${errorText(err)}`);
    }
    return null;
  }

  /** Resolves once the emulator is spawned (phase booting); discovery, boot wait and bind continue in the background. */
  private async boot(entry: DeviceEntry, avd: string): Promise<void> {
    const sdk = this.sdk();
    const status = androidSdkStatus(sdk);
    if (sdk === null || sdk.emulator === null) {
      this.release(entry);
      entry.serial = null;
      entry.avd = avd;
      this.setPhase(entry, "error", missingSdkText(status));
      return;
    }
    const running = (await this.runningEmulators(sdk)).find((r) => r.avd === avd);
    if (running !== undefined) {
      await this.bind(entry, running.serial, avd);
      return;
    }
    const bootingTab = this.booting.get(avd);
    if (bootingTab !== undefined && bootingTab !== entry.tabId) {
      this.release(entry);
      entry.serial = null;
      entry.avd = avd;
      this.setPhase(entry, "error", CONFLICT_ERROR);
      return;
    }
    if (bootingTab === entry.tabId) return;
    this.release(entry);
    entry.serial = null;
    entry.avd = avd;
    entry.display = null;
    entry.cached = null;
    entry.lastFrame = null;
    const generation = entry.generation;
    this.booting.set(avd, entry.tabId);
    const env = androidChildEnv(sdk);
    // Bundled-profile AVDs are provisioned on demand. Idempotent: an AVD that
    // already exists (even one a shell made under the same name) boots unchanged.
    const avdsOut = await this.run(sdk.emulator, ["-list-avds"], { env, timeoutMs: ADB_TIMEOUT_MS });
    if (!parseAvdList(avdsOut.stdout).includes(avd)) {
      const profile = findDeviceProfileByAvd(avd);
      if (profile !== null) {
        const message = await this.provision(sdk, profile);
        if (message !== null) {
          this.booting.delete(avd);
          this.setPhase(entry, "error", message);
          return;
        }
      }
    }
    const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
    const gpu = display || process.platform === "darwin" || process.platform === "win32" ? "host" : SOFTWARE_GPU;
    const emulator = sdk.emulator;
    const spawnEmulator = (flag: string) =>
      this.spawnDetached(emulator, ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-gpu", flag], env);
    const pid = spawnEmulator(gpu);
    this.setPhase(entry, "booting");
    void this.awaitBoot(entry, generation, sdk, avd, pid, gpu, spawnEmulator).finally(() => {
      if (this.booting.get(avd) === entry.tabId) this.booting.delete(avd);
    });
  }

  private async awaitBoot(
    entry: DeviceEntry,
    generation: number,
    sdk: AndroidSdkPaths,
    avd: string,
    firstPid: number | null,
    firstGpu: string,
    spawnEmulator: (gpu: string) => number | null,
  ): Promise<void> {
    const fail = (message: string) => {
      if (this.stale(entry, generation)) return;
      this.booting.delete(avd);
      this.setPhase(entry, "error", message);
    };
    let pid = firstPid;
    let retried = firstGpu !== "host";
    let serial: string | null = null;
    for (let poll = 0; poll < DISCOVERY_POLLS && serial === null; poll++) {
      if (pid === null) return fail(`could not start the emulator for ${avd}`);
      await delay(DISCOVERY_POLL_MS);
      if (this.stale(entry, generation)) return;
      const record = discoveryForAvd(this.discover(), avd);
      if (record !== null) {
        serial = `emulator-${record.values.get("port.serial")}`;
      } else if (!this.pidAlive(pid)) {
        if (retried) return fail(`the emulator for ${avd} exited before it started`);
        // A host-GPU start can die on a headless or driverless session: one software retry.
        retried = true;
        pid = spawnEmulator(SOFTWARE_GPU);
      }
    }
    if (serial === null) return fail(`the emulator for ${avd} did not start within 60 s`);
    const owner = this.boundBy.get(serial);
    if (owner !== undefined && owner !== entry.tabId) {
      entry.serial = serial;
      return fail(CONFLICT_ERROR);
    }
    entry.serial = serial;
    this.boundBy.set(serial, entry.tabId);
    this.emitState(entry);
    const env = androidChildEnv(sdk);
    for (let poll = 0; poll < BOOT_POLLS; poll++) {
      const out = await this.run(sdk.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { env, timeoutMs: ADB_TIMEOUT_MS });
      if (this.stale(entry, generation)) return;
      if (out.stdout.trim() === "1") {
        this.booting.delete(avd);
        await this.bind(entry, serial, avd);
        return;
      }
      await delay(BOOT_POLL_MS);
      if (this.stale(entry, generation)) return;
    }
    fail(`${avd} did not finish booting within 180 s`);
  }

  private async powerOff(entry: DeviceEntry): Promise<void> {
    const serial = entry.serial;
    if (serial === null) return;
    this.remembered.delete(entry.tabId);
    let stopped = false;
    if (entry.client !== null) {
      try {
        await entry.client.setVmState(VM_SHUTDOWN);
        stopped = true;
      } catch {
        // Fall back to the console below.
      }
    }
    const sdk = this.sdk();
    if (!stopped && sdk !== null) {
      await this.run(sdk.adb, ["-s", serial, "emu", "kill"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS });
    }
    if (entry.serial === serial) this.unbind(entry);
  }

  /** Starts or stops the screen stream to match `sinks.size > 0 && phase === streaming`; true when it just started. */
  private syncStream(entry: DeviceEntry): boolean {
    const client = entry.client;
    const want = entry.sinks.size > 0 && entry.phase === "streaming" && client !== null;
    if (!want) {
      this.stopStream(entry);
      return false;
    }
    if (entry.streamAbort !== null) return false;
    const abort = new AbortController();
    entry.streamAbort = abort;
    client.streamScreenshot(STREAM_FORMAT, (raw) => this.onRaw(entry, raw), abort.signal).then(
      () => {
        if (entry.streamAbort === abort && !abort.signal.aborted) this.streamFailed(entry, "emulator stream ended: closed by the emulator");
      },
      (err: unknown) => {
        if (entry.streamAbort === abort && !abort.signal.aborted) this.streamFailed(entry, `emulator stream ended: ${errorText(err)}`);
      },
    );
    if (entry.cached === null) this.kickScreenshot(entry);
    return true;
  }

  private stopStream(entry: DeviceEntry): void {
    entry.streamAbort?.abort();
    entry.streamAbort = null;
    entry.pending = null;
    clearTimeout(entry.slotTimer);
    entry.slotTimer = undefined;
  }

  /** One getScreenshot: a static screen may produce no stream message. */
  private kickScreenshot(entry: DeviceEntry): void {
    const client = entry.client;
    if (client === null || entry.phase !== "streaming" || entry.screenshotInFlight) return;
    entry.screenshotInFlight = true;
    client.getScreenshot(STREAM_FORMAT).then(
      (raw) => {
        if (entry.client !== client) return;
        entry.screenshotInFlight = false;
        if (entry.cached === null && entry.sinks.size > 0) this.onRaw(entry, raw);
      },
      () => {
        if (entry.client === client) entry.screenshotInFlight = false;
      },
    );
  }

  private streamFailed(entry: DeviceEntry, message: string): void {
    this.teardown(entry);
    this.setPhase(entry, "error", message);
  }

  /** Newest message wins; at most one encode per frame slot. */
  private onRaw(entry: DeviceEntry, raw: Uint8Array): void {
    if (entry.pending !== null) entry.framesCoalesced += 1;
    entry.pending = raw;
    if (entry.slotTimer === undefined) this.fireSlot(entry);
  }

  private fireSlot(entry: DeviceEntry): void {
    const raw = entry.pending;
    if (raw === null) {
      entry.slotTimer = undefined;
      return;
    }
    entry.pending = null;
    this.encode(entry, raw);
    entry.slotTimer = setTimeout(() => this.fireSlot(entry), FRAME_INTERVAL_MS);
  }

  private encode(entry: DeviceEntry, raw: Uint8Array): void {
    const started = this.now();
    let frame: Uint8Array;
    let size: { width: number; height: number };
    try {
      const image = decodeImage(raw);
      // An empty image (display off) keeps the last frame.
      if (image === null) return;
      const bgra = swapRedBlue(image.pixels);
      const jpeg = this.encodeJpeg(
        Buffer.from(bgra.buffer, bgra.byteOffset, bgra.byteLength),
        image.width,
        image.height,
        DEVICE_PANE_JPEG_QUALITY,
      );
      const header = encodeBrowserPaneFrameHeader({ width: image.width, height: image.height, dsf: 1 });
      frame = new Uint8Array(header.length + jpeg.length);
      frame.set(header);
      frame.set(jpeg, header.length);
      size = { width: image.width, height: image.height };
    } catch {
      // A malformed image is skipped; the stream keeps going.
      return;
    }
    const elapsed = this.now() - started;
    entry.framesEncoded += 1;
    entry.lastEncodeMs = elapsed;
    entry.maxEncodeMs = Math.max(entry.maxEncodeMs ?? 0, elapsed);
    entry.lastFrame = size;
    entry.cached = frame;
    this.send(CH.onDevicePaneFrame, entry.tabId, frame);
  }

  /** Unit coordinates → native display pixels; the axes swap while the frame is landscape on a portrait display. */
  private mapPoint(entry: DeviceEntry, ux: number, uy: number): { x: number; y: number } | null {
    const base = entry.display ?? entry.lastFrame;
    if (base === null) return null;
    let { width, height } = base;
    const frame = entry.lastFrame;
    if (entry.display !== null && frame !== null && frame.width > frame.height && height > width) {
      [width, height] = [height, width];
    }
    const clamp = (v: number, max: number) => Math.min(max - 1, Math.max(0, v));
    return { x: clamp(Math.round(ux * width), width), y: clamp(Math.round(uy * height), height) };
  }

  private async forward(
    entry: DeviceEntry,
    sdk: AndroidSdkPaths,
    bin: string,
    cwd: string,
    argv: string[],
    screenshotPath: string | null,
    serial: string,
  ): Promise<{ content: HostToolContent[]; isError: boolean }> {
    this.beginActing(entry);
    let result: DeviceRunResult;
    try {
      result = await this.run(process.execPath, [bin, ...argv], {
        env: {
          ...androidChildEnv(sdk),
          ELECTRON_RUN_AS_NODE: "1",
          AGENT_DEVICE_STATE_DIR: this.stateDir(),
          AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST: serial,
          AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
        },
        cwd,
        timeoutMs: DEVICE_TOOL_TIMEOUT_MS,
      });
    } finally {
      this.endActing(entry);
    }
    const output = [result.stdout, result.stderr].filter((s) => s.trim() !== "").join("\n");
    const failed = result.code !== 0;
    const prefix = failed ? `agent-device exited with ${result.code === null ? "no exit code (killed or not started)" : `code ${result.code}`}\n` : "";
    const content: HostToolContent[] = [{ type: "text", text: truncateOutput(`${prefix}${output || (failed ? "" : "(no output)")}`.trimEnd()) }];
    if (screenshotPath !== null) {
      try {
        const png = await readFile(screenshotPath);
        content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
      } catch {
        // No file: the command failed before writing it; the text says why.
      }
      await rm(screenshotPath, { force: true }).catch(() => {});
    }
    return { content, isError: failed };
  }

  private beginActing(entry: DeviceEntry): void {
    entry.agentInflight += 1;
    clearTimeout(entry.actingTimer);
    entry.actingTimer = undefined;
    if (entry.agent !== "acting") {
      entry.agent = "acting";
      this.emitState(entry);
    }
    if (!entry.open) this.setOpen(entry.tabId, true);
  }

  private endActing(entry: DeviceEntry): void {
    entry.agentInflight = Math.max(0, entry.agentInflight - 1);
    if (entry.agentInflight > 0) return;
    clearTimeout(entry.actingTimer);
    entry.actingTimer = setTimeout(() => {
      entry.actingTimer = undefined;
      if (entry.agent !== "acting" || entry.agentInflight > 0) return;
      entry.agent = "attached";
      this.emitState(entry);
    }, DEVICE_PANE_ACTING_MS);
  }
}
