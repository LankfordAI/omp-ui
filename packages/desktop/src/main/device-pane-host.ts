import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  androidCreationReadiness,
  androidSdkStatus,
  createProfileOffers,
  decodeImage,
  encodeDevicePaneFrameHeader,
  encodeKeyInput,
  encodeMouseInput,
  encodeTouchInput,
  encodeWheelInput,
  legacyDevicePresentation,
  parseAdbDevices,
  parseAvdList,
  parseDeviceSystemImagePackage,
  parseInstalledSystemImage,
  parseSdkDevices,
  patchAvdKeyboard,
  planDeviceCommand,
  resolveAndroidAvdHome,
  resolveAndroidSdk,
  resolveAvdConfigPath,
  type AndroidSdkPaths,
  type DeviceButton,
  type DeviceInventory,
  type DevicePaneAction,
  type DevicePaneAgentState,
  type DevicePaneDiagnostics,
  type DevicePaneInputEvent,
  type DevicePaneState,
  type DeviceSdkStatus,
  type DeviceSystemImage,
  type DeviceTarget,
  type EmulatorDisplayConfiguration,
  type EmulatorImage,
  type EmulatorNotification,
  type EmulatorPhysicalModel,
  type EmulatorPosture,
  type EmulatorRotation,
  type HostToolContent,
} from "@omp-ui/core";
import {
  EmulatorGrpcClient,
  GrpcStatusError,
  discoveryForAvd,
  discoveryForSerial,
  ensureEmulatorGrpcEndpoint,
  isPidAlive,
  readEmulatorDiscovery,
  type EmulatorDiscoveryRecord,
  type GrpcEndpoint,
} from "./emulator-grpc";

export type DeviceRunResult = { code: number | null; stdout: string; stderr: string };
export type EmulatorGrpc = Pick<
  EmulatorGrpcClient,
  | "streamScreenshot" | "getScreenshot" | "openInput" | "setClipboard" | "setVmState"
  | "getPhysicalModel" | "setPhysicalModel" | "streamNotification" | "getDisplayConfigurations"
  | "onError" | "close"
>;

export interface DevicePaneHostDeps {
  send(channel: string, ...args: unknown[]): void;
  encodeJpeg(bgra: Buffer, width: number, height: number, quality: number): Uint8Array;
  sdk?(): AndroidSdkPaths | null;
  run?(file: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; maxOutputBytes?: number }): Promise<DeviceRunResult>;
  spawnDetached?(file: string, args: string[], env: NodeJS.ProcessEnv): number | null;
  createGrpc?(endpoint: GrpcEndpoint): EmulatorGrpc;
  ensureEndpoint?: typeof ensureEmulatorGrpcEndpoint;
  discover?(): EmulatorDiscoveryRecord[];
  pidAlive?(pid: number): boolean;
  listDir?(dir: string): Promise<string[]>;
  statFile?(file: string): Promise<{ isFile: boolean; size: number }>;
  readFile?(file: string): Promise<string>;
  writeFile?(file: string, text: string): Promise<void>;
  home?(): string;
  agentDeviceBin(): string | null;
  stateDir(): string;
  tempDir?(): string;
  now?(): number;
}

type PublicOperation = NonNullable<DevicePaneState["operation"]>;
type PostureOffer = DevicePaneState["capabilities"]["postures"]["supported"][number];
interface Operation {
  entry: DeviceEntry;
  bindingId: string;
  expectedBindingId: string | null;
  generation: number;
  abort: AbortController;
  state: PublicOperation;
  settled: Promise<void> | null;
}
interface Geometry {
  key: string;
  rotation: EmulatorRotation;
  display: number;
  inputWidth: number;
  inputHeight: number;
  captureWidth: number;
  captureHeight: number;
  regionWidth: number;
  regionHeight: number;
  xOffset: number;
  yOffset: number;
  folded: boolean;
}
interface Pointer { x: number; y: number; display: number }
type InputSender = { send(inputEvent: Uint8Array, isCurrent?: () => boolean): void; close(): void };
interface InputGuard {
  generation: number;
  bindingId: string | null;
  revision: number;
  geometryKey: string | undefined;
  epoch: number;
  client: EmulatorGrpc;
  sender: InputSender;
  isCurrent(): boolean;
}
interface WheelState {
  sender: InputSender;
  isCurrent(): boolean;
  timer: NodeJS.Timeout | undefined;
  active: boolean;
  start: number;
  deadline: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  pendingX: number;
  pendingY: number;
  anchorX: number;
  anchorY: number;
  collectedAt: number;
}
interface NativeWheelAxes { horizontal: boolean; vertical: boolean }
interface Hardware {
  values: Map<string, string>;
  width: number;
  height: number;
  postures: PostureOffer[];
  postureReason: string | null;
}
interface GuestEvidence {
  states: Set<EmulatorPosture>;
  hingeSensor: boolean;
  accelerometer: boolean;
  current: EmulatorPosture | null;
}
interface DeviceEntry {
  tabId: string;
  serial: string | null;
  avd: string | null;
  bindingId: string | null;
  geometryRevision: number;
  phase: DevicePaneState["phase"];
  agent: DevicePaneAgentState;
  open: boolean;
  error: string | null;
  actionError: string | null;
  display: DevicePaneState["display"];
  rotation: EmulatorRotation | null;
  posture: EmulatorPosture | null;
  hingeAngle: number | null;
  screen: DevicePaneState["screen"];
  guestScreen: DevicePaneState["screen"];
  nativeScreen: DevicePaneState["screen"];
  powerPoll: NodeJS.Timeout | undefined;
  powerPollInFlight: boolean;
  inputReady: boolean;
  inputBlocked: boolean;
  inputRecovery: { timestampUs: number; rotation: EmulatorRotation | null; posture: EmulatorPosture | null } | null;
  capabilities: DevicePaneState["capabilities"];
  operation: PublicOperation | null;
  hardware: Hardware | null;
  guest: GuestEvidence | null;
  displays: EmulatorDisplayConfiguration[];
  nativePosture: number | null;
  geometry: Geometry | null;
  frameKey: string | null;
  lastTimestampUs: number;
  requiredTimestampUs: number;
  frameNumber: number;
  sinks: Set<string>;
  cached: Uint8Array | null;
  observedTimestampUs: number;
  bgra: Uint8Array;
  client: EmulatorGrpc | null;
  offClientError: (() => void) | null;
  streamAbort: AbortController | null;
  notificationAbort: AbortController | null;
  inputSender: InputSender | null;
  inputGuard: InputGuard | null;
  inputEpoch: number;
  activePointers: Map<number, Pointer>;
  heldKeys: Set<string>;
  wheel: WheelState | null;
  wheelEpoch: number;
  nativeWheel: NativeWheelAxes | null;
  actingTimer: NodeJS.Timeout | undefined;
  pending: EmulatorImage | null;
  slotTimer: NodeJS.Timeout | undefined;
  screenshotInFlight: boolean;
  generation: number;
  bindAbort: AbortController | null;
  framesEncoded: number;
  framesCoalesced: number;
  lastEncodeMs: number | null;
  maxEncodeMs: number | null;
}

const FRAME_INTERVAL_MS = Math.round(1000 / DEVICE_PANE_FPS);
const STREAM_FORMAT = { width: DEVICE_PANE_MAX_EDGE, height: DEVICE_PANE_MAX_EDGE };
const ADB_TIMEOUT_MS = 15_000;
const PROVISION_TIMEOUT_MS = 120_000;
const CONTROL_TIMEOUT_MS = 15_000;
const CONTROL_POLL_MS = 250;
const DISCOVERY_POLL_MS = 500;
const DISCOVERY_POLLS = 120;
const BOOT_POLL_MS = 1_000;
const BOOT_POLLS = 180;
const VM_SHUTDOWN = 5;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const SOFTWARE_GPU = "swangle_indirect";
const WHEEL_TICK_MS = 16;
const WHEEL_STROKE_MS = 160;
const WHEEL_UNIT_DISTANCE = 0.1 / 120;
const WHEEL_MAX_DISTANCE = 0.35;
const SERIAL_RE = new RegExp(DEVICE_SERIAL_PATTERN);
const AVD_RE = new RegExp(DEVICE_AVD_PATTERN);
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const BUTTON_KEYS: Record<DeviceButton, string> = { back: "GoBack", home: "GoHome", recents: "AppSwitch", power: "Power" };
const CONFLICT_ERROR = "in use by another session";
const GEOMETRY_ERROR = "Input is unavailable because this display's native capture-to-input geometry has not been established.";
const NATIVE_POSTURES: Record<number, EmulatorPosture> = { 1: "closed", 2: "half-open", 3: "open", 4: "flipped", 5: "tent" };

function capabilities(): DevicePaneState["capabilities"] {
  return {
    rotation: { available: false, reason: "Physical rotation has not been observed." },
    postures: { available: false, reason: "Foldable capabilities have not been observed.", supported: [] },
  };
}
function newEntry(tabId: string): DeviceEntry {
  return {
    tabId, serial: null, avd: null, bindingId: null, geometryRevision: 0, phase: "unbound", agent: "detached",
    open: false, error: null, actionError: null, display: null, rotation: null, posture: null, hingeAngle: null,
    screen: "unknown", guestScreen: "unknown", nativeScreen: "unknown", powerPoll: undefined, powerPollInFlight: false,
    inputReady: false, inputBlocked: false, inputRecovery: null, capabilities: capabilities(), operation: null, hardware: null, guest: null,
    displays: [], nativePosture: null, geometry: null, frameKey: null, lastTimestampUs: 0, requiredTimestampUs: 0, frameNumber: 0,
    sinks: new Set(), cached: null, observedTimestampUs: 0, bgra: new Uint8Array(0), client: null, offClientError: null, streamAbort: null, notificationAbort: null,
    inputSender: null, inputGuard: null, inputEpoch: 0, activePointers: new Map(), heldKeys: new Set(), wheel: null, wheelEpoch: 0, nativeWheel: null,
    actingTimer: undefined, pending: null, slotTimer: undefined,
    screenshotInFlight: false, generation: 0, bindAbort: null, framesEncoded: 0, framesCoalesced: 0,
    lastEncodeMs: null, maxEncodeMs: null,
  };
}
function defaultRun(file: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; maxOutputBytes?: number }): Promise<DeviceRunResult> {
  const { promise, resolve } = Promise.withResolvers<DeviceRunResult>();
  execFile(file, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxOutputBytes ?? 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    const code = error === null ? 0 : "code" in error && typeof error.code === "number" ? error.code : null;
    resolve({ code, stdout: stdout ?? "", stderr: stderr || error?.message || "" });
  });
  return promise;
}
function defaultSpawnDetached(file: string, args: string[], env: NodeJS.ProcessEnv): number | null {
  try {
    const child = spawn(file, args, { env, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return child.pid ?? null;
  } catch { return null; }
}
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
function errorText(err: unknown): string { return err instanceof Error ? err.message : String(err); }
function serialPort(serial: string): number { return Number(serial.slice(serial.lastIndexOf("-") + 1)); }
function missingSdkText(sdk: DeviceSdkStatus): string {
  return `The Android SDK is not usable (missing: ${sdk.status === "missing" ? sdk.missing.join(", ") : ""}). Install platform-tools and the emulator, or set ANDROID_HOME to an SDK that has them.`;
}
function truncateOutput(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= OUTPUT_LIMIT_BYTES ? text : `${bytes.subarray(0, OUTPUT_LIMIT_BYTES).toString("utf8")}\n[output truncated]`;
}
function ini(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#;=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}
function positive(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 16384 ? n : 0;
}
function hardware(text: string): Hardware {
  const values = ini(text);
  const width = positive(values.get("hw.lcd.width"));
  const height = positive(values.get("hw.lcd.height"));
  const out: Hardware = { values, width, height, postures: [], postureReason: null };
  if (values.get("hw.sensor.hinge") !== "yes") out.postureReason = "This AVD has no native hinge sensor.";
  else if (values.get("hw.sensor.hinge.count") !== "1") out.postureReason = "Only a single native hinge is supported; this AVD has multiple or unknown hinges.";
  else {
    const nativeIds = (values.get("hw.sensor.posture_list") ?? "").split(",").map((v) => Number(v.trim()));
    const ranges = (values.get("hw.sensor.hinge_angles_posture_definitions") ?? "").split(",");
    const limits = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(values.get("hw.sensor.hinge.ranges") ?? "");
    const min = limits ? Number(limits[1]) : NaN;
    const max = limits ? Number(limits[2]) : NaN;
    if (nativeIds.length !== ranges.length || !Number.isFinite(min) || min >= max) out.postureReason = "Native hinge posture ranges are unavailable or malformed.";
    else {
      for (let i = 0; i < ranges.length; i++) {
        const range = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(ranges[i]);
        const nativeId = nativeIds[i];
        const posture = NATIVE_POSTURES[nativeId];
        const lo = range ? Number(range[1]) : NaN;
        const hi = range ? Number(range[2]) : NaN;
        if (!posture || !Number.isFinite(lo) || lo < min || hi > max || lo >= hi || out.postures.some((p) => p.nativeId === nativeId)) {
          out.postures = [];
          out.postureReason = "Native hinge posture ranges are unavailable or malformed.";
          break;
        }
        const targetAngle = posture === "closed" && lo === min ? lo : posture === "open" && hi === max ? hi : (lo + hi) / 2;
        out.postures.push({ posture, nativeId, minAngle: lo, maxAngle: hi, targetAngle });
      }
    }
  }
  return out;
}
function guestEvidence(supportedStates: string | ReadonlySet<EmulatorPosture>, states: string, sensors: string): GuestEvidence {
  const names: Array<[RegExp, EmulatorPosture]> = [
    [/\bCLOSED\b/i, "closed"], [/\bHALF[_ -]OPEN(?:ED)?\b/i, "half-open"],
    [/\bOPEN(?:ED)?\b/i, "open"], [/\bFLIPPED\b/i, "flipped"], [/\bTENT\b/i, "tent"],
  ];
  const supported = typeof supportedStates === "string" ? new Set<EmulatorPosture>() : new Set(supportedStates);
  if (typeof supportedStates === "string") for (const [pattern, posture] of names) if (pattern.test(supportedStates)) supported.add(posture);
  const currentLine = states.split(/\r?\n/).find((line) => /(?:committed|current)\s*(?:device\s*)?state\s*[:=]/i.test(line));
  const current = currentLine === undefined ? null : names.find(([pattern]) => pattern.test(currentLine))?.[1] ?? null;
  return { states: supported, hingeSensor: /hinge[ _-]*angle|android\.sensor\.hinge_angle/i.test(sensors), accelerometer: /accelerometer|android\.sensor\.accelerometer/i.test(sensors), current };
}
// Only a reader record for the emulator-controller's own QEMU cursor can establish axes.
// Event Hub names, unrelated mice and rotary SCROLL ranges are not native-wheel evidence.
function nativeWheelAxes(text: string): NativeWheelAxes | null {
  if (Buffer.byteLength(text) > OUTPUT_LIMIT_BYTES) return null;
  const reader = /(?:^|\n)Input Reader State:\r?\n([\s\S]*?)(?=\n\S|$)/.exec(text)?.[1];
  if (reader === undefined) return null;
  const devices = [...reader.matchAll(/^([ \t]+)Device \d+: ([^\r\n]+)\r?$/gm)];
  const products: Record<string, string> = { "QEMU Virtio Mouse": "0002", "QEMU Virtio Tablet": "0003", "QEMU Virtio Dual Mode Mouse": "0004" };
  for (const [index, device] of devices.entries()) {
    const product = products[device[2]];
    if (product === undefined) continue;
    const block = reader.slice(device.index! + device[0].length, devices[index + 1]?.index ?? reader.length);
    if (/^\s*(?:(?:Is)?Enabled:\s*false|(?:Is)?(?:Disabled|Ignored):\s*true)\s*$/m.test(block)) continue;
    const identifier = /^\s*Identifier:.*\bvendor=0x([\da-f]+),\s*product=0x([\da-f]+)\b/im.exec(block);
    if (identifier === null || parseInt(identifier[1], 16) !== 0x0627 || parseInt(identifier[2], 16) !== parseInt(product, 16)) continue;
    const source = /^\s*Sources:\s*0x([\da-f]+)\b/im.exec(block);
    if (source === null || (parseInt(source[1], 16) & 0x2002) !== 0x2002) continue;
    const association = /^\s*AssociatedDisplayId:\s*(-?\d+)\s*$/m.exec(block);
    if (association !== null && association[1] !== "0") continue;
    const axis = (name: string) => {
      const range = new RegExp(`^\\s*${name}:\\s*source=0x([\\da-f]+)\\b`, "im").exec(block);
      return range !== null && (parseInt(range[1], 16) & 0x2002) === 0x2002;
    };
    const horizontal = axis("HSCROLL") && /^\s*HaveHWheel:\s*true\s*$/m.test(block);
    const vertical = axis("VSCROLL") && /^\s*HaveVWheel:\s*true\s*$/m.test(block);
    if (horizontal || vertical) return { horizontal, vertical };
  }
  return null;
}
function modelValues(model: EmulatorPhysicalModel | null, target: number, arity: number): number[] | null {
  return model?.target === target && model.status === 0 && model.values.length === arity && model.values.every(Number.isFinite) ? model.values : null;
}
function rotationDistance(a: number, b: number): number { return Math.abs((((a - b) % 360 + 540) % 360) - 180); }
function isOptionalError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err.status === 12 || err.status === 9);
}

/** Tab-routed owner. All child work retains its reservation until its actual promise settles. */
export class DevicePaneHost {
  private readonly entries = new Map<string, DeviceEntry>();
  private readonly boundBy = new Map<string, DeviceEntry>();
  private readonly remembered = new Map<string, { serial: string; avd: string | null }>();
  private readonly operations = new Map<string, Operation>();
  private readonly reservations = new Map<string, Operation>();
  private readonly tabLeases = new Map<string, number>();
  private readonly serialLeases = new Map<string, number>();
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
  private readonly statFile: NonNullable<DevicePaneHostDeps["statFile"]>;
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
    this.statFile = deps.statFile ?? (async (file) => {
      const info = await stat(file);
      return { isFile: info.isFile(), size: info.size };
    });
    this.readFile = deps.readFile ?? ((file) => readFile(file, "utf8"));
    this.writeFile = deps.writeFile ?? ((file, text) => writeFile(file, text, "utf8"));
    this.home = deps.home ?? (() => os.homedir());
    this.agentDeviceBin = deps.agentDeviceBin;
    this.stateDir = deps.stateDir;
    this.tempDir = deps.tempDir ?? (() => os.tmpdir());
    this.now = deps.now ?? (() => performance.now());
  }

  async inventory(tabId?: string): Promise<DeviceInventory> {
    const sdk = this.sdk();
    const status = androidSdkStatus(sdk);
    if (sdk === null) return { sdk: status, targets: [], profiles: [], images: [], creation: androidCreationReadiness(sdk, process.arch, []) };
    const env = androidChildEnv(sdk);
    const [running, avdsOut, devicesOut, images] = await Promise.all([
      this.runningEmulators(sdk),
      sdk.emulator === null ? null : this.run(sdk.emulator, ["-list-avds"], { env, timeoutMs: ADB_TIMEOUT_MS }),
      sdk.avdmanager === null ? null : this.run(sdk.avdmanager, ["list", "device"], { env, timeoutMs: PROVISION_TIMEOUT_MS }),
      this.installedImages(sdk),
    ]);
    const avds = avdsOut?.code === 0 ? parseAvdList(avdsOut.stdout) : [];
    const creation = androidCreationReadiness(sdk, process.arch, images);
    if (devicesOut !== null && devicesOut.code !== 0) {
      creation.available = false;
      creation.reason = "avdmanager could not list native device profiles.";
    }
    const profiles = createProfileOffers(parseSdkDevices(devicesOut?.stdout ?? ""), images, avds, creation.reason);
    const profileNames = new Map(profiles.map((profile) => [profile.id, profile.name]));
    const targets: DeviceTarget[] = running.map((r) => ({ serial: r.serial, avd: r.avd, state: r.online ? "running" : "booting" }));
    const liveAvds = new Set(targets.map((t) => t.avd));
    const existingAvds = new Set([...avds, ...liveAvds]);
    for (const [avd] of this.reservations) {
      if (!liveAvds.has(avd)) targets.push({ serial: null, avd, state: "booting" });
      liveAvds.add(avd);
    }
    targets.sort((a, b) => a.serial !== null && b.serial !== null ? serialPort(a.serial) - serialPort(b.serial) : a.serial !== null ? -1 : b.serial !== null ? 1 : a.avd.localeCompare(b.avd));
    for (const avd of avds.filter((name) => !liveAvds.has(name)).sort()) targets.push({ serial: null, avd, state: "stopped" });
    for (const target of targets) {
      if (existingAvds.has(target.avd) && AVD_RE.test(target.avd)) {
        try {
          const cfg = await this.configPath(target.avd);
          const config = ini(await this.readFile(cfg));
          const friendlyName = profileNames.get(config.get("hw.device.name") ?? "");
          if (friendlyName !== undefined) target.friendlyName = friendlyName;
          if (config.get("hw.sensor.hinge") !== "yes") Object.assign(target, legacyDevicePresentation(target.avd) ?? {});
          const api = /^android-([1-9]\d*)(?:-ext[1-9]\d*)?$/.exec(config.get("target") ?? "");
          const imagePath = /(?:^|[\\/])(system-images[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+)[\\/]?$/.exec(config.get("image.sysdir.1") ?? "")?.[1];
          const configuredImage = imagePath === undefined ? null : parseDeviceSystemImagePackage(imagePath.replaceAll("\\", "/").replaceAll("/", ";"));
          if (api) target.api = Number(api[1]);
          else if (configuredImage !== null) target.api = configuredImage.api;
        } catch { /* Unknown existing AVDs remain usable without invented presentation metadata. */ }
      }
      const owner = target.serial === null ? undefined : this.boundBy.get(target.serial);
      const reservation = this.reservations.get(target.avd);
      const claimed = target.serial !== null && (owner !== undefined && owner.tabId !== tabId || this.serialLeases.has(target.serial) && owner?.tabId !== tabId);
      if (claimed || reservation !== undefined && reservation.entry.tabId !== tabId) target.availabilityReason = CONFLICT_ERROR;
    }
    return { sdk: status, targets, images, creation, profiles };
  }

  async ensure(tabId: string): Promise<{ state: DevicePaneState; inventory: DeviceInventory }> {
    const entry = this.entry(tabId);
    const generation = entry.generation;
    let inventory = await this.inventory(tabId);
    if (this.stale(entry, generation)) return { state: this.currentState(this.entries.get(tabId) ?? newEntry(tabId)), inventory };
    const remembered = this.remembered.get(tabId);
    if (remembered !== undefined && entry.serial === null && entry.phase === "unbound" && !this.operations.has(tabId) && !this.tabLeases.has(tabId)) {
      this.remembered.delete(tabId);
      const target = inventory.targets.find((t) => t.serial === remembered.serial && t.state === "running");
      if (target !== undefined) {
        await this.act(tabId, { action: "bind", serial: remembered.serial });
        if (this.entries.get(tabId) !== entry) return { state: this.currentState(this.entries.get(tabId) ?? newEntry(tabId)), inventory };
        inventory = await this.inventory(tabId);
        if (this.entries.get(tabId) !== entry) return { state: this.currentState(this.entries.get(tabId) ?? newEntry(tabId)), inventory };
      }
    }
    return { state: this.currentState(entry), inventory };
  }

  async act(tabId: string, action: DevicePaneAction): Promise<DevicePaneState> {
    const entry = this.entry(tabId);
    if ("bindingId" in action && action.bindingId !== entry.bindingId) return this.reject(entry, "The device binding has changed; select the current device again.");
    if (this.tabLeases.has(tabId)) return this.reject(entry, "An agent-device command is still running; wait for it to finish before changing the binding.");
    const pending = this.operations.get(tabId);
    if (action.action === "power-off" && pending !== undefined && (pending.state.kind === "rotate" || pending.state.kind === "set-posture") && pending.settled !== null) {
      const generation = entry.generation;
      pending.abort.abort();
      await pending.settled;
      if (this.stale(entry, generation)) return this.currentState(this.entries.get(tabId) ?? newEntry(tabId));
      return this.act(tabId, action);
    }
    if (action.action === "unbind") {
      this.remembered.delete(tabId);
      this.operations.get(tabId)?.abort.abort();
      this.unbind(entry);
      return this.currentState(entry);
    }
    if (this.operations.has(tabId) || this.tabLeases.has(tabId)) return this.reject(entry, "A device operation is still in progress.");
    const state: PublicOperation = action.action === "create" ? { kind: "create", stage: "creating", avd: action.avd }
      : action.action === "boot" ? { kind: "boot", stage: "starting", avd: action.avd }
      : action.action === "rotate" ? { kind: "rotate", stage: "rotating", rotation: action.rotation }
      : action.action === "set-posture" ? { kind: "set-posture", stage: "changing-posture", posture: action.posture }
      : { kind: action.action, stage: "connecting" };
    const op: Operation = { entry, bindingId: randomUUID(), expectedBindingId: entry.bindingId, generation: entry.generation, abort: new AbortController(), state, settled: null };
    this.releaseInput(entry);
    entry.inputReady = false;
    this.operations.set(tabId, op);
    entry.operation = state;
    entry.actionError = null;
    if (entry.serial === null && entry.client === null && (action.action === "boot" || action.action === "create" || action.action === "bind")) {
      entry.bindingId = op.bindingId;
      op.expectedBindingId = op.bindingId;
      entry.geometryRevision = 1;
      entry.error = null;
      if (action.action === "boot" || action.action === "create") entry.avd = action.avd;
      entry.phase = action.action === "create" ? "provisioning" : action.action === "boot" ? "booting" : "connecting";
    }
    this.emitState(entry);
    const work = this.perform(op, action).catch((err: unknown) => {
      if (!this.current(op)) return;
      if (entry.serial === null && entry.phase !== "streaming") this.setPhase(entry, "error", errorText(err));
      else this.reject(entry, errorText(err));
    }).finally(() => {
      if (this.operations.get(tabId) === op) this.operations.delete(tabId);
      for (const [avd, owner] of this.reservations) if (owner === op) this.reservations.delete(avd);
      if (this.entries.get(tabId) === entry && entry.operation === state) {
        entry.operation = null;
        entry.inputReady = !entry.inputBlocked && entry.screen === "active" && entry.geometry !== null && entry.phase === "streaming" && !this.tabLeases.has(tabId);
        this.emitState(entry);
        if (entry.inputReady && entry.cached !== null && entry.sinks.size > 0) this.send(CH.onDevicePaneFrame, tabId, entry.cached);
      }
    });
    op.settled = work;
    if (action.action !== "boot" && action.action !== "create") await work;
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
    const client = entry?.client;
    if (!entry || !client || !entry.inputReady || entry.sinks.size === 0 || entry.phase !== "streaming" || entry.operation !== null || entry.bindingId !== ev.bindingId || entry.geometryRevision !== ev.geometryRevision || this.tabLeases.has(tabId)) return;
    entry.inputSender ??= client.openInput();
    const sender = entry.inputSender;
    const guard = this.inputGuard(entry, client, sender);
    const display = entry.geometry?.display ?? 0;
    switch (ev.type) {
      case "touch": {
        this.cancelWheel(entry);
        const point = this.mapPoint(entry, ev.x, ev.y);
        if (point === null) return;
        if (ev.phase === "up") entry.activePointers.delete(ev.pointer);
        else entry.activePointers.set(ev.pointer, { ...point, display });
        sender.send(encodeTouchInput([{ ...point, id: ev.pointer, pressure: ev.phase === "up" ? 0 : 1 }], display), guard.isCurrent);
        return;
      }
      case "wheel": this.enqueueWheel(entry, ev, guard); return;
      case "key":
        if (ev.phase === "down") entry.heldKeys.add(ev.key);
        else entry.heldKeys.delete(ev.key);
        sender.send(encodeKeyInput({ eventType: ev.phase === "down" ? 0 : 1, key: ev.key }), guard.isCurrent);
        return;
      case "text":
        if (ev.text === "") return;
        if (PRINTABLE_ASCII_RE.test(ev.text)) sender.send(encodeKeyInput({ eventType: 2, text: ev.text }), guard.isCurrent);
        else void client.setClipboard(ev.text).then(() => {
          if (!guard.isCurrent()) return;
          const controlHeld = entry.heldKeys.has("Control");
          if (!controlHeld) sender.send(encodeKeyInput({ eventType: 0, key: "Control" }), guard.isCurrent);
          sender.send(encodeKeyInput({ eventType: 2, key: "v" }), guard.isCurrent);
          if (!controlHeld) sender.send(encodeKeyInput({ eventType: 1, key: "Control" }), guard.isCurrent);
        }, () => {});
        return;
      case "button": sender.send(encodeKeyInput({ eventType: 2, key: BUTTON_KEYS[ev.button] }), guard.isCurrent);
    }
  }

  private inputGuard(entry: DeviceEntry, client: EmulatorGrpc, sender: InputSender): InputGuard {
    const previous = entry.inputGuard;
    if (previous !== null && previous.generation === entry.generation && previous.bindingId === entry.bindingId
      && previous.revision === entry.geometryRevision && previous.geometryKey === entry.geometry?.key
      && previous.epoch === entry.inputEpoch && previous.client === client && previous.sender === sender) return previous;
    const guard: InputGuard = {
      generation: entry.generation, bindingId: entry.bindingId, revision: entry.geometryRevision, geometryKey: entry.geometry?.key,
      epoch: entry.inputEpoch, client, sender,
      isCurrent: () => !this.stale(entry, guard.generation) && entry.bindingId === guard.bindingId && entry.geometryRevision === guard.revision
        && entry.geometry?.key === guard.geometryKey && entry.inputEpoch === guard.epoch && entry.client === client && entry.inputSender === sender
        && entry.inputReady && entry.sinks.size > 0 && entry.phase === "streaming" && entry.operation === null && !this.tabLeases.has(entry.tabId),
    };
    entry.inputGuard = guard;
    return guard;
  }

  private enqueueWheel(entry: DeviceEntry, ev: Extract<DevicePaneInputEvent, { type: "wheel" }>, guard: InputGuard): void {
    if (!entry.open || ![ev.x, ev.y, ev.dx, ev.dy].every(Number.isFinite) || ev.dx === 0 && ev.dy === 0) return;
    if (entry.activePointers.size > (entry.wheel?.active ? 1 : 0)) return;
    const geometry = entry.geometry;
    if (geometry === null) return;
    const axes = entry.nativeWheel;
    const primary = entry.displays.find((display) => display.display === 0);
    if (axes !== null && (ev.dx === 0 || axes.horizontal) && (ev.dy === 0 || axes.vertical)
      && geometry.display === 0 && !geometry.folded && primary?.width === geometry.inputWidth && primary.height === geometry.inputHeight) {
      if (entry.wheel !== null) this.cancelWheel(entry);
      const point = this.mapPoint(entry, ev.x, ev.y);
      if (point === null) return;
      const epoch = entry.wheelEpoch;
      const isCurrent = () => entry.open && entry.wheelEpoch === epoch && guard.isCurrent();
      guard.sender.send(encodeMouseInput(point.x, point.y, 0, 0), isCurrent);
      guard.sender.send(encodeWheelInput(ev.dx, ev.dy, 0), isCurrent);
      return;
    }
    let wheel = entry.wheel;
    if (wheel !== null && !wheel.isCurrent()) { this.cancelWheel(entry); wheel = null; }
    if (wheel === null) {
      const epoch = entry.wheelEpoch;
      wheel = {
        sender: guard.sender, isCurrent: () => entry.open && entry.wheelEpoch === epoch && guard.isCurrent(), timer: undefined,
        active: false, start: 0, deadline: 0, x: 0, y: 0, targetX: 0, targetY: 0,
        pendingX: 0, pendingY: 0, anchorX: 0, anchorY: 0, collectedAt: this.now(),
      };
      entry.wheel = wheel;
    }
    wheel.pendingX += ev.dx * WHEEL_UNIT_DISTANCE;
    wheel.pendingY += ev.dy * WHEEL_UNIT_DISTANCE;
    const distance = Math.hypot(wheel.pendingX, wheel.pendingY);
    if (distance > WHEEL_MAX_DISTANCE) {
      wheel.pendingX *= WHEEL_MAX_DISTANCE / distance;
      wheel.pendingY *= WHEEL_MAX_DISTANCE / distance;
    }
    wheel.anchorX = Math.max(0, Math.min(1, ev.x));
    wheel.anchorY = Math.max(0, Math.min(1, ev.y));
    if (wheel.timer === undefined) {
      const pending = wheel;
      wheel.timer = setTimeout(() => this.advanceWheel(entry, pending), WHEEL_TICK_MS);
    }
  }

  private advanceWheel(entry: DeviceEntry, wheel: WheelState): void {
    if (entry.wheel !== wheel) return;
    wheel.timer = undefined;
    if (!wheel.isCurrent()) { this.cancelWheel(entry); return; }
    const now = this.now();
    if (!wheel.active) {
      wheel.x = wheel.anchorX;
      wheel.y = wheel.anchorY;
      wheel.targetX = Math.max(0, Math.min(1, wheel.x + wheel.pendingX));
      wheel.targetY = Math.max(0, Math.min(1, wheel.y + wheel.pendingY));
      const first = this.mapPoint(entry, wheel.x, wheel.y);
      const last = this.mapPoint(entry, wheel.targetX, wheel.targetY);
      if (first === null || last === null) { this.cancelWheel(entry); return; }
      if (first.x === last.x && first.y === last.y) {
        // Fine deltas get one bounded collection window, never a stationary down/up tap.
        if (now - wheel.collectedAt >= WHEEL_STROKE_MS) { this.cancelWheel(entry); return; }
        wheel.timer = setTimeout(() => this.advanceWheel(entry, wheel), WHEEL_TICK_MS);
        return;
      }
      wheel.pendingX = 0;
      wheel.pendingY = 0;
      wheel.start = now;
      wheel.deadline = now + WHEEL_STROKE_MS;
      wheel.active = true;
      const display = entry.geometry!.display;
      entry.activePointers.set(0, { ...first, display });
      wheel.sender.send(encodeTouchInput([{ ...first, id: 0, pressure: 1 }], display), wheel.isCurrent);
    } else {
      const progress = Math.min(1, Math.max(0, (now - wheel.start) / WHEEL_STROKE_MS));
      const point = this.mapPoint(entry, wheel.x + (wheel.targetX - wheel.x) * progress, wheel.y + (wheel.targetY - wheel.y) * progress);
      const previous = entry.activePointers.get(0);
      if (point === null || previous === undefined) { this.cancelWheel(entry); return; }
      if (point.x !== previous.x || point.y !== previous.y) {
        previous.x = point.x;
        previous.y = point.y;
        wheel.sender.send(encodeTouchInput([{ ...point, id: 0, pressure: 1 }], previous.display), wheel.isCurrent);
      }
      if (now >= wheel.deadline) {
        wheel.sender.send(encodeTouchInput([{ x: previous.x, y: previous.y, id: 0, pressure: 0 }], previous.display));
        entry.activePointers.delete(0);
        wheel.active = false;
        if (wheel.pendingX === 0 && wheel.pendingY === 0) { entry.wheel = null; return; }
        wheel.collectedAt = now;
      }
    }
    wheel.timer = setTimeout(() => this.advanceWheel(entry, wheel), WHEEL_TICK_MS);
  }

  private cancelWheel(entry: DeviceEntry): void {
    entry.wheelEpoch += 1;
    const wheel = entry.wheel;
    if (wheel === null) return;
    entry.wheel = null;
    clearTimeout(wheel.timer);
    wheel.timer = undefined;
    if (wheel.active) {
      const point = entry.activePointers.get(0);
      if (point !== undefined) wheel.sender.send(encodeTouchInput([{ x: point.x, y: point.y, id: 0, pressure: 0 }], point.display));
      entry.activePointers.delete(0);
    }
  }

  setOpen(tabId: string, open: boolean): void {
    const entry = this.entry(tabId);
    if (!open) this.releaseInput(entry);
    if (entry.open === open) return;
    entry.open = open;
    this.emitState(entry);
  }

  async runAgentCommand(tabId: string, cwd: string, args: unknown): Promise<{ content: HostToolContent[]; isError: boolean }> {
    const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });
    try {
      const entry = this.entry(tabId);
      const generation = entry.generation;
      const serial = entry.serial !== null && this.boundBy.get(entry.serial) === entry ? entry.serial : null;
      const session = `omp-ui-${createHash("sha256").update(tabId).digest("hex").slice(0, 12)}`;
      const outPath = path.join(this.tempDir(), `omp-ui-device-${randomUUID()}.png`);
      const plan = planDeviceCommand(args, serial === null ? null : { serial, session }, outPath);
      if (plan.kind === "refused") return text(plan.reason, true);
      const sdk = this.sdk();
      if (sdk === null) return text(missingSdkText(androidSdkStatus(sdk)), true);
      switch (plan.kind) {
        case "targets": {
          const inventory = await this.inventory(tabId);
          if (this.stale(entry, generation)) return text("The device session changed while listing targets.", true);
          const lines = inventory.targets.map((t) => `${t.serial ?? "-"}\t${t.avd}\t${t.state}${t.availabilityReason ? `\t${t.availabilityReason}` : ""}`);
          return text(lines.length === 0 ? "No emulators or AVDs found." : `serial\tavd\tstate\n${lines.join("\n")}`);
        }
        case "profiles": {
          const inventory = await this.inventory(tabId);
          if (this.stale(entry, generation)) return text("The device session changed while listing profiles.", true);
          return text(JSON.stringify({ creation: inventory.creation, profiles: inventory.profiles }, null, 2));
        }
        case "state": return text(JSON.stringify(this.currentState(entry), null, 2));
        case "use":
        case "create":
        case "rotate":
        case "posture": {
          const action: DevicePaneAction = plan.kind === "use" ? "serial" in plan.target ? { action: "bind", serial: plan.target.serial } : { action: "boot", avd: plan.target.avd }
            : plan.kind === "create" ? { action: "create", profileId: plan.profileId, imagePackage: plan.imagePackage, avd: plan.avd }
            : plan.kind === "rotate" ? { action: "rotate", bindingId: entry.bindingId ?? "", rotation: plan.rotation }
            : { action: "set-posture", bindingId: entry.bindingId ?? "", posture: plan.posture };
          const state = await this.act(tabId, action);
          if (this.entries.get(tabId) !== entry) return text("The device session changed.", true);
          if (!entry.open) this.setOpen(tabId, true);
          return text(JSON.stringify(state, null, 2), state.phase === "error" || state.actionError !== null);
        }
        case "forward": {
          if (this.operations.has(tabId) || this.tabLeases.has(tabId) || serial === null || entry.phase !== "streaming") return text("A ready device without another operation is required.", true);
          const bin = this.agentDeviceBin();
          if (bin === null) return text("agent-device is not available: its bin/agent-device.mjs was not found in this install.", true);
          return await this.forward(entry, sdk, bin, cwd, plan.argv, plan.screenshotOut ? outPath : null, serial);
        }
      }
    } catch (err) { return text(`device command failed: ${errorText(err)}`, true); }
  }

  diagnostics(): DevicePaneDiagnostics[] {
    return [...this.entries.values()].map((entry) => ({ tabId: entry.tabId, serial: entry.serial, phase: entry.phase, subscribers: entry.sinks.size,
      framesEncoded: entry.framesEncoded, framesCoalesced: entry.framesCoalesced, lastEncodeMs: entry.lastEncodeMs, maxEncodeMs: entry.maxEncodeMs }));
  }
  dispose(tabId: string, opts?: { forget?: boolean }): void {
    const entry = this.entries.get(tabId);
    if (opts?.forget === true) this.remembered.delete(tabId);
    if (entry === undefined) return;
    this.operations.get(tabId)?.abort.abort();
    clearTimeout(entry.actingTimer);
    if (entry.serial !== null && opts?.forget !== true) this.remembered.set(tabId, { serial: entry.serial, avd: entry.avd });
    this.release(entry);
    this.entries.delete(tabId);
    this.send(CH.onDevicePaneState, tabId, this.currentState(newEntry(tabId)));
  }
  disposeAll(): void { for (const tabId of [...this.entries.keys()]) this.dispose(tabId); }

  private entry(tabId: string): DeviceEntry {
    let entry = this.entries.get(tabId);
    if (entry === undefined) { entry = newEntry(tabId); this.entries.set(tabId, entry); }
    return entry;
  }
  private stale(entry: DeviceEntry, generation: number): boolean { return entry.generation !== generation || this.entries.get(entry.tabId) !== entry; }
  private current(op: Operation): boolean { return !op.abort.signal.aborted && this.operations.get(op.entry.tabId) === op && op.entry.bindingId === op.expectedBindingId && !this.stale(op.entry, op.generation); }
  private currentState(entry: DeviceEntry): DevicePaneState {
    return {
      serial: entry.serial, avd: entry.avd, bindingId: entry.bindingId, geometryRevision: entry.geometryRevision, phase: entry.phase,
      agent: entry.agent, error: entry.error, actionError: entry.actionError, open: entry.open, display: entry.display === null ? null : { ...entry.display },
      rotation: entry.rotation, posture: entry.posture, hingeAngle: entry.hingeAngle, screen: entry.screen, inputReady: entry.inputReady,
      capabilities: { rotation: { ...entry.capabilities.rotation }, postures: { ...entry.capabilities.postures, supported: entry.capabilities.postures.supported.map((p) => ({ ...p })) } },
      operation: entry.operation === null ? null : { ...entry.operation },
    };
  }
  private emitState(entry: DeviceEntry): void { if (this.entries.get(entry.tabId) === entry) this.send(CH.onDevicePaneState, entry.tabId, this.currentState(entry)); }
  private setPhase(entry: DeviceEntry, phase: DevicePaneState["phase"], error: string | null = null): void { entry.phase = phase; entry.error = error; this.emitState(entry); }
  private reject(entry: DeviceEntry, reason: string): DevicePaneState { entry.actionError = reason; this.emitState(entry); return this.currentState(entry); }

  private async installedImages(sdk: AndroidSdkPaths): Promise<DeviceSystemImage[]> {
    const ls = async (dir: string) => { try { return await this.listDir(dir); } catch { return []; } };
    const images: DeviceSystemImage[] = [];
    const root = path.join(sdk.sdkRoot, "system-images");
    for (const api of await ls(root)) {
      for (const tag of await ls(path.join(root, api))) {
        for (const abi of await ls(path.join(root, api, tag))) {
          const dir = path.join(root, api, tag, abi);
          try {
            const [source, files] = await Promise.all([this.readFile(path.join(dir, "source.properties")), ls(dir)]);
            const checked = await Promise.all(files.filter((file) => ["system.img", "vendor.img", "ramdisk.img", "userdata.img", "kernel-ranchu"].includes(file)).map(async (file) => {
              try {
                const info = await this.statFile(path.join(dir, file));
                return info.isFile && info.size > 0 ? file : null;
              } catch { return null; }
            }));
            const image = parseInstalledSystemImage(`system-images;${api};${tag};${abi}`, source, checked.filter((file): file is string => file !== null), process.arch);
            if (image !== null) images.push(image);
          } catch { /* Incomplete SDK packages are not installed images. */ }
        }
      }
    }
    return images.sort((a, b) => b.api - a.api || a.packageId.localeCompare(b.packageId));
  }
  private async runningEmulators(sdk: AndroidSdkPaths): Promise<Array<{ serial: string; avd: string; online: boolean }>> {
    const env = androidChildEnv(sdk);
    const devices = await this.run(sdk.adb, ["devices"], { env, timeoutMs: ADB_TIMEOUT_MS });
    const rows = parseAdbDevices(devices.stdout).filter((r) => SERIAL_RE.test(r.serial));
    const records = this.discover();
    return Promise.all(rows.map(async (row) => {
      const name = discoveryForSerial(records, row.serial)?.values.get("avd.name");
      const avd = name !== undefined && AVD_RE.test(name) ? name : await this.adbAvdName(sdk, row.serial);
      return { serial: row.serial, avd: avd ?? row.serial, online: row.state === "device" };
    }));
  }
  private async adbAvdName(sdk: AndroidSdkPaths, serial: string): Promise<string | null> {
    const out = await this.run(sdk.adb, ["-s", serial, "emu", "avd", "name"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS });
    return out.code === 0 ? out.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "OK" && AVD_RE.test(line)) ?? null : null;
  }
  private async configPath(avd: string): Promise<string> {
    const home = resolveAndroidAvdHome(process.env, this.home());
    let metadata = "";
    try { metadata = await this.readFile(path.join(home, `${avd}.ini`)); } catch { /* The resolver handles a conventional AVD without metadata. */ }
    return resolveAvdConfigPath(avd, metadata, home);
  }

  private async perform(op: Operation, action: DevicePaneAction): Promise<void> {
    const entry = op.entry;
    if (action.action === "rotate" || action.action === "set-posture") return this.control(op, action);
    if (action.action === "power-off") return this.powerOff(op);
    const sdk = this.sdk();
    if (sdk === null || sdk.emulator === null) throw new Error(missingSdkText(androidSdkStatus(sdk)));
    if (action.action === "refresh") {
      if (entry.serial === null) return;
      entry.inputRecovery = null;
      if (entry.client !== null && entry.phase === "streaming") {
        await this.observeCapabilities(entry, sdk, op.generation, op.abort.signal);
        if (!this.current(op)) return;
        this.invalidateGeometry(entry);
        const raw = await entry.client.getScreenshot(STREAM_FORMAT, op.abort.signal);
        if (!this.current(op)) return;
        entry.inputBlocked = entry.capabilities.postures.available && entry.guest?.current !== entry.posture;
        if (entry.inputBlocked) entry.actionError = "The Android guest has not committed the observed native posture; refresh after it settles.";
        this.observeFrame(entry, raw);
        return;
      }
      await this.connect(op, sdk, entry.serial, entry.avd);
      return;
    }
    if (action.action === "bind") {
      if (!SERIAL_RE.test(action.serial)) throw new Error("Invalid emulator serial.");
      if (this.claimed(action.serial, entry)) throw new Error(CONFLICT_ERROR);
      const running = await this.runningEmulators(sdk);
      if (!this.current(op)) return;
      const target = running.find((r) => r.serial === action.serial && r.online);
      if (!target) throw new Error("The selected emulator is not running.");
      if (this.claimed(action.serial, entry) || this.reserved(target.avd, op)) throw new Error(CONFLICT_ERROR);
      await this.connect(op, sdk, action.serial, target.avd);
      return;
    }
    if (action.action !== "boot" && action.action !== "create") return;
    if (!AVD_RE.test(action.avd)) throw new Error("Invalid AVD name.");
    if (action.action === "create" && (action.avd === "." || action.avd === ".." || action.avd.startsWith("-"))) throw new Error("Choose an AVD name that does not start with '-' and is not '.' or '..'.");
    if (this.reserved(action.avd, op)) throw new Error(CONFLICT_ERROR);
    this.reservations.set(action.avd, op);
    const inventory = await this.inventory(entry.tabId);
    if (!this.current(op)) return;
    const target = inventory.targets.find((t) => t.avd === action.avd && t.serial !== null);
    if (target !== undefined && target.serial !== null) {
      if (action.action === "create") throw new Error("An AVD with that name already exists; choose another name.");
      if (this.claimed(target.serial, entry)) throw new Error(CONFLICT_ERROR);
      await this.connect(op, sdk, target.serial, action.avd);
      return;
    }
    // Re-read the actual AVD list; reservations are presentation rows, never existence evidence.
    const avdsOut = await this.run(sdk.emulator, ["-list-avds"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS });
    if (!this.current(op)) return;
    if (avdsOut.code !== 0) throw new Error("Could not list existing AVDs.");
    const exists = parseAvdList(avdsOut.stdout).includes(action.avd);
    if (action.action === "boot" && !exists) throw new Error("The AVD does not exist. Use Create with a native SDK profile and installed image first.");
    if (action.action === "create") {
      if (exists) throw new Error("An AVD with that name already exists; choose another name.");
      const offer = inventory.profiles.find((profile) => profile.id === action.profileId);
      if (!offer?.available || !offer.images.some((image) => image.packageId === action.imagePackage)) throw new Error(offer?.reason ?? "The selected native profile and installed image are not compatible.");
      if (!inventory.creation.available || sdk.avdmanager === null) throw new Error(inventory.creation.reason ?? "Android command-line tools are required to create an AVD.");
      const created = await this.run(sdk.avdmanager, ["create", "avd", "-n", action.avd, "-k", action.imagePackage, "-d", action.profileId], { env: androidChildEnv(sdk), timeoutMs: PROVISION_TIMEOUT_MS });
      if (!this.current(op)) return;
      if (created.code !== 0) throw new Error(`avdmanager could not create ${action.avd}: ${(created.stderr.trim() || "creation failed").slice(0, 500)}`);
      const cfg = await this.configPath(action.avd);
      if (!this.current(op)) return;
      try {
        const original = await this.readFile(cfg);
        if (!this.current(op)) return;
        const patched = patchAvdKeyboard(original);
        await this.writeFile(cfg, patched);
        if (!this.current(op)) return;
        const readback = await this.readFile(cfg);
        if (!this.current(op)) return;
        if (readback !== patched || ini(readback).get("hw.keyboard") !== "yes") throw new Error("keyboard configuration readback did not match");
      } catch (err) {
        if (!this.current(op)) return;
        throw new Error(`Created ${action.avd}, but could not enable and verify its hardware keyboard at ${cfg}: ${errorText(err)}. The AVD was left intact; repair hw.keyboard=yes there before booting it.`, { cause: err });
      }
    }
    const acceleration = await this.run(sdk.emulator, ["-accel-check"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS });
    if (!this.current(op)) return;
    const accelerationStatus = /^\s*accel:\s*\r?\n\s*(-?\d+)\s*$/m.exec(acceleration.stdout)?.[1];
    if (acceleration.code !== 0 || accelerationStatus !== "0") {
      const evidence = [acceleration.stdout, acceleration.stderr].filter((text) => text.trim() !== "").join("\n").trim().slice(0, 1_000);
      throw new Error(`${action.action === "create" ? `Created ${action.avd}; the AVD was left intact. ` : ""}The Android emulator at ${sdk.emulator} cannot use host acceleration: ${evidence || "the acceleration check did not confirm a usable hypervisor"}. Enable usable KVM (Linux), HVF (macOS), or WHPX (Windows), then boot this existing AVD again.`);
    }
    op.state.stage = "starting";
    this.activate(op, null, action.avd, "booting");
    const env = androidChildEnv(sdk);
    const gpu = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === "darwin" || process.platform === "win32" ? "host" : SOFTWARE_GPU;
    const spawnEmulator = (flag: string) => this.spawnDetached(sdk.emulator!, ["-avd", action.avd, "-no-window", "-no-audio", "-no-boot-anim", "-gpu", flag], env);
    if (!this.current(op)) return;
    await this.awaitBoot(op, sdk, action.avd, spawnEmulator(gpu), gpu, spawnEmulator);
  }
  private claimed(serial: string, entry: DeviceEntry): boolean {
    const owner = this.boundBy.get(serial);
    return owner !== undefined && owner !== entry || this.serialLeases.has(serial);
  }
  private reserved(avd: string, op: Operation): boolean { const owner = this.reservations.get(avd); return owner !== undefined && owner !== op; }
  private activate(op: Operation, serial: string | null, avd: string | null, phase: DevicePaneState["phase"]): void {
    const entry = op.entry;
    this.release(entry);
    op.generation = entry.generation;
    entry.bindingId = op.bindingId;
    op.expectedBindingId = op.bindingId;
    entry.geometryRevision = 1;
    entry.serial = serial;
    entry.avd = avd;
    entry.operation = op.state;
    entry.actionError = null;
    if (serial !== null) this.boundBy.set(serial, entry);
    this.setPhase(entry, phase);
  }
  private async connect(op: Operation, sdk: AndroidSdkPaths, serial: string, avd: string | null): Promise<void> {
    if (!this.current(op) || this.claimed(serial, op.entry)) return;
    const entry = op.entry;
    op.state.stage = "connecting";
    this.activate(op, serial, avd, "connecting");
    entry.bindAbort = op.abort;
    try {
      const endpoint = await this.ensureEndpoint(serial, sdk, op.abort.signal);
      if (!this.current(op)) return;
      const client = this.createGrpc(endpoint);
      entry.client = client;
      entry.offClientError = client.onError((err) => { if (entry.client === client && this.entries.get(entry.tabId) === entry) this.streamFailed(entry, `emulator connection lost: ${err.message}`); });
      if (entry.avd === null) {
        const name = await this.adbAvdName(sdk, serial);
        if (!this.current(op)) return;
        entry.avd = name;
      }
      await this.observeCapabilities(entry, sdk, op.generation, op.abort.signal);
      if (!this.current(op)) return;
      entry.bindAbort = null;
      this.setPhase(entry, "streaming");
      this.notifications(entry);
      this.syncStream(entry);
    } catch (err) {
      if (!this.current(op)) return;
      this.teardown(entry);
      this.setPhase(entry, "error", errorText(err));
    }
  }
  private async awaitBoot(op: Operation, sdk: AndroidSdkPaths, avd: string, firstPid: number | null, firstGpu: string, spawnEmulator: (gpu: string) => number | null): Promise<void> {
    let pid = firstPid;
    let retried = firstGpu !== "host";
    let serial: string | null = null;
    for (let poll = 0; poll < DISCOVERY_POLLS && serial === null; poll++) {
      if (pid === null) throw new Error(`could not start the emulator for ${avd}`);
      await delay(DISCOVERY_POLL_MS);
      if (!this.current(op)) return;
      const record = discoveryForAvd(this.discover(), avd);
      if (record !== null) {
        const candidate = `emulator-${record.values.get("port.serial")}`;
        if (SERIAL_RE.test(candidate)) serial = candidate;
      } else if (!this.pidAlive(pid)) {
        if (retried) throw new Error(`the emulator for ${avd} exited before it started`);
        retried = true;
        if (!this.current(op)) return;
        pid = spawnEmulator(SOFTWARE_GPU);
      }
    }
    if (serial === null) throw new Error(`the emulator for ${avd} did not start within 60 s`);
    if (this.claimed(serial, op.entry)) throw new Error(CONFLICT_ERROR);
    const entry = op.entry;
    entry.serial = serial;
    this.boundBy.set(serial, entry);
    this.emitState(entry);
    for (let poll = 0; poll < BOOT_POLLS; poll++) {
      const out = await this.run(sdk.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS });
      if (!this.current(op)) return;
      if (out.code === 0 && out.stdout.trim() === "1") { await this.connect(op, sdk, serial, avd); return; }
      await delay(BOOT_POLL_MS);
      if (!this.current(op)) return;
    }
    throw new Error(`${avd} did not finish booting within 180 s`);
  }

  private async observeCapabilities(entry: DeviceEntry, sdk: AndroidSdkPaths, generation: number, signal: AbortSignal): Promise<void> {
    const client = entry.client;
    const serial = entry.serial;
    if (client === null || serial === null) return;
    const bindingId = entry.bindingId;
    const valid = () => !signal.aborted && !this.stale(entry, generation) && entry.client === client && entry.bindingId === bindingId;
    let hw: Hardware | null = null;
    if (entry.avd !== null && AVD_RE.test(entry.avd)) {
      try {
        const cfg = await this.configPath(entry.avd);
        if (!valid()) return;
        const text = await this.readFile(cfg);
        if (!valid()) return;
        hw = hardware(text);
      } catch { if (!valid()) return; }
    }
    const optional = async <T>(get: () => Promise<T>): Promise<T | null> => {
      try { const value = await get(); return valid() ? value : null; }
      catch (err) { if (!valid() || isOptionalError(err)) return null; return null; }
    };
    const [rotation, hinge, posture, displays, states, sensors, displayPower, supportedStates, inputDevices] = await Promise.all([
      optional(() => client.getPhysicalModel(1, signal)), optional(() => client.getPhysicalModel(10, signal)),
      optional(() => client.getPhysicalModel(16, signal)), optional(() => client.getDisplayConfigurations(signal)),
      this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "device_state"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS }),
      this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "sensorservice"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS }),
      this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "display"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS }),
      this.run(sdk.adb, ["-s", serial, "shell", "cmd", "device_state", "print-states"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS }),
      optional(() => this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "input"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS, maxOutputBytes: OUTPUT_LIMIT_BYTES })),
    ]);
    if (!valid()) return;
    entry.hardware = hw;
    entry.displays = (displays ?? []).filter((display) => Number.isInteger(display.display) && display.display >= 0 && [display.width, display.height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384));
    entry.guest = guestEvidence(supportedStates.code === 0 ? supportedStates.stdout : "", states.code === 0 ? states.stdout : "", sensors.code === 0 ? sensors.stdout : "");
    entry.nativeWheel = inputDevices?.code === 0 ? nativeWheelAxes(inputDevices.stdout) : null;
    if (displayPower.code === 0) this.observeGuestScreen(entry, displayPower.stdout);
    const rotationValues = modelValues(rotation, 1, 3);
    const hingeValues = modelValues(hinge, 10, 1);
    const postureValues = modelValues(posture, 16, 1);
    entry.hingeAngle = hingeValues?.[0] ?? null;
    entry.nativePosture = postureValues && Number.isInteger(postureValues[0]) && NATIVE_POSTURES[postureValues[0]] ? postureValues[0] : null;
    entry.posture = entry.nativePosture === null ? null : NATIVE_POSTURES[entry.nativePosture] ?? null;
    const rotationAvailable = hw?.values.get("hw.accelerometer") === "yes" && rotationValues !== null && entry.guest.accelerometer;
    entry.capabilities.rotation = { available: rotationAvailable, reason: rotationAvailable ? null : "Physical rotation requires enabled native and guest accelerometers and a successful three-axis model readback." };
    const supported = hw?.postures.filter((p) => entry.guest!.states.has(p.posture)) ?? [];
    const reason = hw?.postureReason ?? (hw === null ? "The AVD hardware configuration could not be observed." : hingeValues === null || entry.nativePosture === null ? "Native hinge and posture readback are unavailable." : !entry.guest.hingeSensor ? "The Android guest has no observed hinge-angle sensor." : supported.length === 0 ? "The Android guest exposes no matching foldable device states." : null);
    entry.capabilities.postures = { available: reason === null && supported.length > 0, reason, supported: reason === null ? supported : [] };
    const primary = entry.displays.find((d) => d.display === 0);
    entry.display = primary ? { width: primary.width, height: primary.height } : hw && hw.width && hw.height ? { width: hw.width, height: hw.height } : null;
    this.emitState(entry);
  }

  private notifications(entry: DeviceEntry): void {
    const client = entry.client;
    if (client === null || entry.notificationAbort !== null) return;
    const generation = entry.generation;
    const abort = new AbortController();
    entry.notificationAbort = abort;
    void client.streamNotification((event) => {
      if (abort.signal.aborted || this.stale(entry, generation) || entry.client !== client) return;
      this.onNotification(entry, event);
    }, abort.signal).catch((err: unknown) => {
      if (abort.signal.aborted || this.stale(entry, generation) || isOptionalError(err)) return;
      // Optional notification failure does not sever a working screenshot/input connection.
      entry.actionError = `Device notifications are unavailable: ${errorText(err)}`;
      this.emitState(entry);
    });
  }
  private onNotification(entry: DeviceEntry, event: EmulatorNotification): void {
    if (event.type === "posture") {
      if (!Number.isInteger(event.posture) || !NATIVE_POSTURES[event.posture]) return;
      if (entry.nativePosture !== event.posture) {
        entry.nativePosture = event.posture;
        entry.posture = NATIVE_POSTURES[event.posture];
        this.invalidateGeometry(entry);
        this.emitState(entry);
        this.kickScreenshot(entry);
      }
    } else if (event.type === "display-configurations") {
      const next = event.displays.filter((d) => Number.isInteger(d.display) && d.display >= 0 && [d.width, d.height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384));
      if (JSON.stringify(next) !== JSON.stringify(entry.displays)) {
        this.invalidateGeometry(entry);
        entry.displays = next;
        const primary = next.find((d) => d.display === 0);
        entry.display = primary ? { width: primary.width, height: primary.height } : null;
        this.emitState(entry);
        this.kickScreenshot(entry);
      }
    } else if (event.type === "display-power" && event.display === (entry.geometry?.display ?? 0)) {
      if (event.powerMode === 0 || event.powerMode === 3) {
        entry.nativeScreen = "inactive";
        this.inactive(entry);
      } else if (event.powerMode === 2 || event.powerMode === 4) {
        entry.nativeScreen = "active";
        this.kickScreenshot(entry);
      }
    }
  }

  private async controlImage(client: EmulatorGrpc, signal: AbortSignal): Promise<EmulatorImage | null | undefined> {
    try { return decodeImage(await client.getScreenshot(STREAM_FORMAT, signal)); }
    catch (err) {
      // FAILED_PRECONDITION here means the guest has not posted a frame, not that the display is inactive.
      if (err instanceof GrpcStatusError && err.status === 9) return undefined;
      throw err;
    }
  }
  private async control(op: Operation, action: Extract<DevicePaneAction, { action: "rotate" | "set-posture" }>): Promise<void> {
    const entry = op.entry;
    const client = entry.client;
    if (client === null || entry.phase !== "streaming") throw new Error("A connected emulator is required.");
    const offer = action.action === "set-posture" ? entry.capabilities.postures.supported.find((p) => p.posture === action.posture) : undefined;
    if (action.action === "rotate" && !entry.capabilities.rotation.available) throw new Error(entry.capabilities.rotation.reason ?? "Physical rotation is unavailable.");
    if (action.action === "set-posture" && (!entry.capabilities.postures.available || offer === undefined)) throw new Error(entry.capabilities.postures.reason ?? "That native posture is unavailable.");
    let previousTimestamp = entry.lastTimestampUs;
    entry.inputRecovery = null;
    entry.inputBlocked = true;
    this.invalidateGeometry(entry);
    this.emitState(entry);
    const deadline = this.now() + CONTROL_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (this.current(op)) this.reject(entry, "The native device control timed out after 15 seconds.");
      op.abort.abort();
    }, CONTROL_TIMEOUT_MS);
    try {
      const baseline = await this.controlImage(client, op.abort.signal);
      if (!this.current(op)) return;
      if (baseline === null) this.inactive(entry);
      else if (baseline !== undefined) previousTimestamp = Math.max(previousTimestamp, baseline.timestampUs);
      const recovery = { timestampUs: previousTimestamp, rotation: action.action === "rotate" ? action.rotation : null, posture: action.action === "set-posture" ? action.posture : null };
      const z = action.action === "rotate" ? [0, 90, -180, -90][action.rotation] : 0;
      await client.setPhysicalModel(action.action === "rotate" ? 1 : 10, action.action === "rotate" ? [0, 0, z] : [offer!.targetAngle], op.abort.signal);
      if (!this.current(op)) {
        if (this.entries.get(entry.tabId) === entry && entry.client === client && this.now() >= deadline) this.reject(entry, "The native device control timed out after 15 seconds.");
        return;
      }
      while (this.current(op) && this.now() < deadline) {
        entry.inputBlocked = true;
        entry.inputRecovery = null;
        const physical = await client.getPhysicalModel(action.action === "rotate" ? 1 : 10, op.abort.signal);
        if (!this.current(op)) return;
        const values = modelValues(physical, action.action === "rotate" ? 1 : 10, action.action === "rotate" ? 3 : 1);
        if (values === null) throw new Error("The emulator returned an unsuccessful or malformed physical-model readback.");
        let intended = false;
        if (action.action === "rotate") intended = rotationDistance(values[0], 0) <= 1 && rotationDistance(values[1], 0) <= 1 && rotationDistance(values[2], z) <= 1;
        else {
          const native = await client.getPhysicalModel(16, op.abort.signal);
          if (!this.current(op)) return;
          const postures = modelValues(native, 16, 1);
          if (postures === null) throw new Error("The emulator returned an unsuccessful or malformed native posture readback.");
          entry.hingeAngle = values[0];
          entry.nativePosture = postures[0];
          entry.posture = NATIVE_POSTURES[postures[0]] ?? null;
          intended = Math.abs(values[0] - offer!.targetAngle) <= 1 && postures[0] === offer!.nativeId;
        }
        if (intended && action.action === "rotate") {
          entry.inputRecovery = recovery;
          this.recoverInput(entry);
        }
        const image = await this.controlImage(client, op.abort.signal);
        if (!this.current(op)) return;
        const fresh = image !== undefined && image !== null && image.timestampUs > previousTimestamp && image.timestampUs > 0;
        const screenshotMatches = image !== undefined && image !== null && (action.action !== "rotate" || image.rotation === action.rotation);
        if (image === null) this.inactive(entry);
        else if (fresh && screenshotMatches) this.observeFrame(entry, image);
        if (intended) {
          const sdk = this.sdk();
          const serial = entry.serial;
          if (sdk !== null && serial !== null) {
            const env = androidChildEnv(sdk);
            const timeoutMs = Math.max(1, Math.min(ADB_TIMEOUT_MS, Math.floor(deadline - this.now())));
            const [states, sensors, displayPower] = await Promise.all([
              this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "device_state"], { env, timeoutMs }),
              this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "sensorservice"], { env, timeoutMs }),
              this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "display"], { env, timeoutMs }),
            ]);
            if (!this.current(op)) return;
            entry.guest = guestEvidence(entry.guest?.states ?? new Set(), states.code === 0 ? states.stdout : "", sensors.code === 0 ? sensors.stdout : "");
            if (displayPower.code === 0) this.observeGuestScreen(entry, displayPower.stdout);
          }
          if (action.action === "rotate" || entry.guest?.current === action.posture) {
            if (action.action === "set-posture") entry.inputRecovery = recovery;
            this.recoverInput(entry);
            if (fresh && screenshotMatches || action.action === "set-posture" && image === null) {
              entry.inputBlocked = false;
              entry.inputRecovery = null;
              return;
            }
          }
        }
        await delay(CONTROL_POLL_MS);
        if (!this.current(op)) return;
      }
      throw new Error("The native device control timed out after 15 seconds without matching physical and fresh screenshot observations.");
    } catch (err) {
      if (this.entries.get(entry.tabId) === entry && entry.client === client && entry.generation === op.generation) this.reject(entry, this.now() >= deadline ? "The native device control timed out after 15 seconds." : errorText(err));
    } finally {
      clearTimeout(timeout);
    }
  }
  private async powerOff(op: Operation): Promise<void> {
    const entry = op.entry;
    const serial = entry.serial;
    if (serial === null) return;
    let stopped = false;
    if (entry.client !== null) {
      try { await entry.client.setVmState(VM_SHUTDOWN); stopped = true; }
      catch { /* The existing console shutdown remains the explicit fallback. */ }
      if (!this.current(op)) return;
    }
    const sdk = this.sdk();
    if (!stopped && sdk !== null) {
      const result = await this.run(sdk.adb, ["-s", serial, "emu", "kill"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS });
      if (!this.current(op)) return;
      if (result.code !== 0) throw new Error("The emulator did not accept the power-off request.");
      stopped = true;
    }
    if (!this.current(op) || !stopped) return;
    this.remembered.delete(entry.tabId);
    this.unbind(entry);
  }

  private releasePointers(entry: DeviceEntry): void {
    if (entry.inputSender !== null) for (const [id, point] of entry.activePointers) entry.inputSender.send(encodeTouchInput([{ x: point.x, y: point.y, id, pressure: 0 }], point.display));
    entry.activePointers.clear();
  }
  private releaseInput(entry: DeviceEntry): void {
    this.cancelWheel(entry);
    this.releasePointers(entry);
    if (entry.inputSender !== null) for (const key of entry.heldKeys) entry.inputSender.send(encodeKeyInput({ eventType: 1, key }));
    entry.heldKeys.clear();
    entry.inputEpoch += 1;
    entry.inputGuard = null;
  }
  private invalidateGeometry(entry: DeviceEntry, bump = true, preserveSlot = false): void {
    this.releaseInput(entry);
    entry.inputReady = false;
    entry.cached = null;
    entry.observedTimestampUs = 0;
    entry.pending = null;
    entry.geometry = null;
    entry.frameKey = null;
    entry.requiredTimestampUs = entry.lastTimestampUs;
    if (!preserveSlot) {
      clearTimeout(entry.slotTimer);
      entry.slotTimer = undefined;
    }
    if (bump && entry.bindingId !== null) {
      if (entry.geometryRevision >= 0xffff_ffff) {
        entry.bindingId = randomUUID();
        entry.geometryRevision = 1;
        const operation = this.operations.get(entry.tabId);
        if (operation?.entry === entry) operation.expectedBindingId = entry.bindingId;
      }
      else entry.geometryRevision += 1;
    }
  }
  private inactive(entry: DeviceEntry): void {
    const changed = entry.screen !== "inactive" || entry.geometry !== null || entry.cached !== null;
    if (changed) this.invalidateGeometry(entry);
    entry.screen = "inactive";
    if (changed) this.emitState(entry);
  }
  private teardown(entry: DeviceEntry): void {
    this.invalidateGeometry(entry, false);
    entry.generation += 1;
    entry.inputRecovery = null;
    entry.inputSender?.close();
    entry.inputSender = null;
    this.stopStream(entry);
    entry.bindAbort?.abort();
    entry.bindAbort = null;
    entry.notificationAbort?.abort();
    entry.notificationAbort = null;
    entry.offClientError?.();
    entry.offClientError = null;
    entry.client?.close();
    entry.client = null;
    entry.screenshotInFlight = false;
    entry.powerPollInFlight = false;
  }
  private release(entry: DeviceEntry): void {
    this.teardown(entry);
    if (entry.serial !== null && this.boundBy.get(entry.serial) === entry) this.boundBy.delete(entry.serial);
    entry.display = null;
    entry.rotation = null;
    entry.posture = null;
    entry.hingeAngle = null;
    entry.nativePosture = null;
    entry.hardware = null;
    entry.guest = null;
    entry.nativeWheel = null;
    entry.displays = [];
    entry.screen = "unknown";
    entry.inputBlocked = false;
    entry.inputRecovery = null;
    entry.guestScreen = "unknown";
    entry.nativeScreen = "unknown";
    entry.lastTimestampUs = 0;
    entry.requiredTimestampUs = 0;
    entry.capabilities = capabilities();
  }
  private unbind(entry: DeviceEntry): void {
    this.release(entry);
    entry.serial = null;
    entry.avd = null;
    entry.bindingId = null;
    entry.geometryRevision = 0;
    entry.operation = null;
    entry.actionError = null;
    this.setPhase(entry, "unbound");
  }

  private observeGuestScreen(entry: DeviceEntry, text: string): void {
    const direct = /\bmScreenState\s*=\s*(OFF|ON)\b/.exec(text);
    const primary = text.split(/\r?\n/).find((line) => line.includes("DisplayDeviceInfo") && /FLAG_DEFAULT_DISPLAY|type INTERNAL|Built-in Screen/.test(line));
    const state = direct?.[1] ?? (primary === undefined ? undefined : /\bstate\s*[=:]?\s*(OFF|ON)\b/.exec(primary)?.[1]);
    if (state === undefined) return;
    const previous = entry.guestScreen;
    entry.guestScreen = state === "OFF" ? "inactive" : "active";
    if (entry.guestScreen === "inactive") this.inactive(entry);
    else if (previous === "inactive") {
      this.invalidateGeometry(entry);
      this.emitState(entry);
      this.kickScreenshot(entry);
    }
  }

  private schedulePowerPoll(entry: DeviceEntry): void {
    if (this.entries.get(entry.tabId) !== entry || entry.client === null || entry.powerPoll !== undefined || entry.powerPollInFlight || entry.sinks.size === 0 || entry.phase !== "streaming") return;
    const generation = entry.generation;
    const bindingId = entry.bindingId;
    entry.powerPoll = setTimeout(() => {
      entry.powerPoll = undefined;
      const sdk = this.sdk();
      const serial = entry.serial;
      const valid = () => !this.stale(entry, generation) && entry.bindingId === bindingId && entry.sinks.size > 0 && entry.phase === "streaming";
      if (!valid() || sdk === null || serial === null) { this.schedulePowerPoll(entry); return; }
      const revision = entry.geometryRevision;
      entry.powerPollInFlight = true;
      void this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "display"], { env: androidChildEnv(sdk), timeoutMs: ADB_TIMEOUT_MS }).then((result) => {
        if (!valid() || entry.geometryRevision !== revision) return;
        if (result.code === 0) this.observeGuestScreen(entry, result.stdout);
      }, () => {}).finally(() => {
        if (this.stale(entry, generation)) return;
        entry.powerPollInFlight = false;
        this.schedulePowerPoll(entry);
      });
    }, 1_000);
  }

  private syncStream(entry: DeviceEntry): boolean {
    const client = entry.client;
    if (entry.sinks.size === 0 || entry.phase !== "streaming" || client === null) { this.stopStream(entry); return false; }
    this.schedulePowerPoll(entry);
    if (entry.streamAbort !== null) return false;
    const abort = new AbortController();
    const generation = entry.generation;
    entry.streamAbort = abort;
    void client.streamScreenshot(STREAM_FORMAT, (raw) => {
      if (entry.streamAbort === abort && !abort.signal.aborted && !this.stale(entry, generation) && entry.client === client) this.onRaw(entry, raw);
    }, abort.signal).then(() => {
      if (entry.streamAbort === abort && !abort.signal.aborted) this.streamFailed(entry, "emulator stream ended: closed by the emulator");
    }, (err: unknown) => {
      if (entry.streamAbort === abort && !abort.signal.aborted) this.streamFailed(entry, `emulator stream ended: ${errorText(err)}`);
    });
    if (entry.cached === null) this.kickScreenshot(entry);
    return true;
  }
  private stopStream(entry: DeviceEntry): void {
    this.releaseInput(entry);
    if (entry.sinks.size === 0) entry.cached = null;
    clearTimeout(entry.powerPoll);
    entry.powerPoll = undefined;
    entry.streamAbort?.abort();
    entry.streamAbort = null;
    entry.pending = null;
    clearTimeout(entry.slotTimer);
    entry.slotTimer = undefined;
  }
  private kickScreenshot(entry: DeviceEntry): void {
    const client = entry.client;
    if (client === null || entry.phase !== "streaming" || entry.screenshotInFlight) return;
    const generation = entry.generation;
    const bindingId = entry.bindingId;
    const revision = entry.geometryRevision;
    entry.screenshotInFlight = true;
    void client.getScreenshot(STREAM_FORMAT).then((raw) => {
      if (this.stale(entry, generation) || entry.client !== client) return;
      entry.screenshotInFlight = false;
      if (entry.bindingId !== bindingId || entry.geometryRevision !== revision) return;
      if (entry.cached === null) this.onRaw(entry, raw);
    }, () => { if (!this.stale(entry, generation) && entry.client === client) entry.screenshotInFlight = false; });
  }
  private streamFailed(entry: DeviceEntry, message: string): void { this.teardown(entry); this.setPhase(entry, "error", message); }
  private onRaw(entry: DeviceEntry, raw: Uint8Array): void {
    // Observe transitions before coalescing, so screen-off cannot leave a pressed pointer or cached image.
    let image: EmulatorImage | null;
    try { image = decodeImage(raw); } catch { return; }
    if (image === null) { this.inactive(entry); return; }
    if (entry.guestScreen === "inactive" || entry.nativeScreen === "inactive") { this.inactive(entry); return; }
    if (image.timestampUs < entry.lastTimestampUs || image.timestampUs <= entry.requiredTimestampUs) return;
    if (entry.sinks.size === 0) { this.observeFrame(entry, image); return; }
    const geometry = this.frameGeometry(entry, image);
    const frameKey = geometry?.key ?? [image.width, image.height, image.rotation, image.display, image.displayMode, JSON.stringify(image.foldedDisplay)].join(":");
    const changed = entry.frameKey !== null && entry.frameKey !== frameKey || entry.screen === "inactive";
    if (changed) this.invalidateGeometry(entry, true, true);
    entry.frameKey = frameKey;
    entry.rotation = image.rotation;
    entry.screen = "active";
    entry.lastTimestampUs = image.timestampUs;
    if (changed) this.emitState(entry);
    if (entry.pending !== null) entry.framesCoalesced += 1;
    entry.pending = image;
    if (entry.slotTimer === undefined) this.fireSlot(entry);
  }
  private fireSlot(entry: DeviceEntry): void {
    const raw = entry.pending;
    if (raw === null) { entry.slotTimer = undefined; return; }
    entry.pending = null;
    this.observeFrame(entry, raw);
    entry.slotTimer = entry.sinks.size === 0 ? undefined : setTimeout(() => this.fireSlot(entry), FRAME_INTERVAL_MS);
  }
  private frameGeometry(entry: DeviceEntry, image: EmulatorImage): Geometry | null {
    const native = entry.displays.find((d) => d.display === image.display);
    const inputWidth = native?.width ?? (image.display === 0 ? entry.hardware?.width : 0) ?? 0;
    const inputHeight = native?.height ?? (image.display === 0 ? entry.hardware?.height : 0) ?? 0;
    if (!inputWidth || !inputHeight) return null;
    const folded = image.foldedDisplay;
    const deviceName = entry.hardware?.values.get("hw.device.name") ?? "";
    const knownCover = deviceName === "pixel_fold" || deviceName === "pixel_9_pro_fold";
    let separateCover = false;
    if (image.display === 0 && folded !== null && knownCover && entry.hardware !== null) {
      for (const [key] of entry.hardware.values) {
        const route = /^hw\.sensor\.hinge\.fold_to_displayRegion\.0\.(\d+)_at_posture$/.exec(key);
        if (!route) continue;
        const prefix = `hw.displayRegion.0.${route[1]}.`;
        if (positive(entry.hardware.values.get(`${prefix}width`)) === folded.width && positive(entry.hardware.values.get(`${prefix}height`)) === folded.height
          && Number(entry.hardware.values.get(`${prefix}xOffset`) ?? 0) === folded.xOffset && Number(entry.hardware.values.get(`${prefix}yOffset`) ?? 0) === folded.yOffset) separateCover = true;
      }
      if (!separateCover) return null;
    } else if (image.display === 0 && folded !== null && deviceName.includes("fold") && !["7.6in Foldable", "6.7in Foldable", "8in Foldable"].includes(deviceName)) {
      return null;
    }
    const captureWidth = separateCover && folded !== null ? folded.width : inputWidth;
    const captureHeight = separateCover && folded !== null ? folded.height : inputHeight;
    const regionWidth = folded?.width ?? captureWidth;
    const regionHeight = folded?.height ?? captureHeight;
    const xOffset = separateCover ? 0 : folded?.xOffset ?? 0;
    const yOffset = separateCover ? 0 : folded?.yOffset ?? 0;
    if (![captureWidth, captureHeight, regionWidth, regionHeight].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) || ![xOffset, yOffset].every((n) => Number.isInteger(n) && n >= 0) || xOffset + regionWidth > captureWidth || yOffset + regionHeight > captureHeight) return null;
    const key = [image.width, image.height, image.rotation, image.display, image.displayMode, inputWidth, inputHeight, captureWidth, captureHeight, regionWidth, regionHeight, xOffset, yOffset, folded === null ? "whole" : "folded"].join(":");
    return { key, rotation: image.rotation, display: image.display, inputWidth, inputHeight, captureWidth, captureHeight, regionWidth, regionHeight, xOffset, yOffset, folded: folded !== null };
  }
  private recoverInput(entry: DeviceEntry): void {
    const recovery = entry.inputRecovery;
    const geometry = entry.geometry;
    // Failure remains visible; recovery requires a fresh native observation with matching geometry, not a JPEG or paint acknowledgement.
    if (recovery !== null && geometry !== null && entry.screen === "active"
      && entry.observedTimestampUs > recovery.timestampUs
      && (recovery.rotation === null || geometry.rotation === recovery.rotation)
      && (recovery.posture === null || entry.posture === recovery.posture && entry.guest?.current === recovery.posture)) {
      entry.inputBlocked = false;
      entry.inputRecovery = null;
    }
  }
  private observeFrame(entry: DeviceEntry, raw: Uint8Array | EmulatorImage): void {
    if (entry.bindingId === null || entry.client === null || entry.phase !== "streaming") return;
    if (entry.guestScreen === "inactive" || entry.nativeScreen === "inactive") { this.inactive(entry); return; }
    try {
      const image = raw instanceof Uint8Array ? decodeImage(raw) : raw;
      if (image === null) { this.inactive(entry); return; }
      if (image.timestampUs > 0 && image.timestampUs < entry.lastTimestampUs) return;
      const geometry = this.frameGeometry(entry, image);
      const frameKey = geometry?.key ?? [image.width, image.height, image.rotation, image.display, image.displayMode, JSON.stringify(image.foldedDisplay)].join(":");
      if (entry.frameKey !== null && entry.frameKey !== frameKey || entry.screen === "inactive") this.invalidateGeometry(entry);
      if (image.timestampUs <= entry.requiredTimestampUs) { this.emitState(entry); return; }
      entry.frameKey = frameKey;
      entry.geometry = geometry;
      if (geometry === null) entry.actionError = GEOMETRY_ERROR;
      else if (entry.actionError === GEOMETRY_ERROR) entry.actionError = null;
      entry.rotation = image.rotation;
      entry.screen = "active";
      entry.lastTimestampUs = image.timestampUs;
      entry.frameNumber += 1;
      entry.observedTimestampUs = image.timestampUs;
      this.recoverInput(entry);
      entry.inputReady = !entry.inputBlocked && geometry !== null && entry.operation === null && !this.tabLeases.has(entry.tabId);
      if (entry.sinks.size === 0) entry.cached = null;
      this.emitState(entry);
      if (entry.sinks.size > 0) this.encodeFrame(entry, image);
    } catch { /* A malformed image cannot become geometry or readiness evidence. */ }
  }
  private encodeFrame(entry: DeviceEntry, image: EmulatorImage): void {
    if (entry.bindingId === null || entry.sinks.size === 0) return;
    try {
      const started = this.now();
      // decodeImage returns a view over transport bytes: never mutate that input or a queued/replayed message.
      if (entry.bgra.length < image.pixels.length) entry.bgra = new Uint8Array(image.pixels.length);
      const bgra = entry.bgra;
      for (let i = 0; i < image.pixels.length; i += 4) {
        bgra[i] = image.pixels[i + 2]; bgra[i + 1] = image.pixels[i + 1]; bgra[i + 2] = image.pixels[i]; bgra[i + 3] = image.pixels[i + 3];
      }
      const jpeg = this.encodeJpeg(Buffer.from(bgra.buffer, bgra.byteOffset, image.pixels.length), image.width, image.height, DEVICE_PANE_JPEG_QUALITY);
      if (jpeg.length === 0) throw new Error("The emulator screenshot could not be encoded.");
      const header = encodeDevicePaneFrameHeader({ width: image.width, height: image.height, dsf: 1, bindingId: entry.bindingId, geometryRevision: entry.geometryRevision });
      const frame = new Uint8Array(header.length + jpeg.length);
      frame.set(header); frame.set(jpeg, header.length);
      const elapsed = this.now() - started;
      entry.framesEncoded += 1;
      entry.lastEncodeMs = elapsed;
      entry.maxEncodeMs = Math.max(entry.maxEncodeMs ?? 0, elapsed);
      entry.cached = frame;
      if (entry.sinks.size > 0) this.send(CH.onDevicePaneFrame, entry.tabId, frame);
    } catch { /* A failed JPEG cannot be cached, delivered, or acknowledged as painted. */ }
  }
  private mapPoint(entry: DeviceEntry, ux: number, uy: number): { x: number; y: number } | null {
    const geometry = entry.geometry;
    if (geometry === null || !Number.isFinite(ux) || !Number.isFinite(uy)) return null;
    const u = Math.min(1, Math.max(0, ux));
    const v = Math.min(1, Math.max(0, uy));
    const [x, y] = geometry.rotation === 0 ? [u, v] : geometry.rotation === 1 ? [1 - v, u] : geometry.rotation === 2 ? [1 - u, 1 - v] : [v, 1 - u];
    const clamp = (value: number, extent: number) => Math.max(0, Math.min(extent - 1, Math.round(value)));
    return {
      x: clamp((geometry.xOffset + x * geometry.regionWidth) * geometry.inputWidth / geometry.captureWidth, geometry.inputWidth),
      y: clamp((geometry.yOffset + y * geometry.regionHeight) * geometry.inputHeight / geometry.captureHeight, geometry.inputHeight),
    };
  }

  private async forward(entry: DeviceEntry, sdk: AndroidSdkPaths, bin: string, cwd: string, argv: string[], screenshotPath: string | null, serial: string): Promise<{ content: HostToolContent[]; isError: boolean }> {
    const generation = entry.generation;
    const orientation = argv[0] === "orientation";
    this.releaseInput(entry);
    this.tabLeases.set(entry.tabId, (this.tabLeases.get(entry.tabId) ?? 0) + 1);
    this.serialLeases.set(serial, (this.serialLeases.get(serial) ?? 0) + 1);
    entry.inputReady = false;
    if (orientation) this.invalidateGeometry(entry);
    const bindingId = entry.bindingId;
    let orientationReconciled = !orientation;
    this.beginActing(entry);
    const current = () => !this.stale(entry, generation) && entry.bindingId === bindingId && entry.serial === serial;
    try {
      const result = await this.run(process.execPath, [bin, ...argv], {
        env: { ...androidChildEnv(sdk), ELECTRON_RUN_AS_NODE: "1", AGENT_DEVICE_STATE_DIR: this.stateDir(), AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST: serial, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" },
        cwd, timeoutMs: DEVICE_TOOL_TIMEOUT_MS,
      });
      if (!current()) return { content: [{ type: "text", text: "The device binding changed while agent-device was running; its result was discarded." }], isError: true };
      if (orientation && entry.client !== null) {
        const client = entry.client;
        const baseline = entry.lastTimestampUs;
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), CONTROL_TIMEOUT_MS);
        try {
          const displayPower = await this.run(sdk.adb, ["-s", serial, "shell", "dumpsys", "display"], { env: androidChildEnv(sdk), timeoutMs: CONTROL_TIMEOUT_MS });
          if (!current() || entry.client !== client) return { content: [{ type: "text", text: "The device binding changed while reconciling orientation." }], isError: true };
          if (displayPower.code === 0) this.observeGuestScreen(entry, displayPower.stdout);
          while (!abort.signal.aborted) {
            const raw = await client.getScreenshot(STREAM_FORMAT, abort.signal);
            if (!current() || entry.client !== client) return { content: [{ type: "text", text: "The device binding changed while reconciling orientation." }], isError: true };
            const observed = decodeImage(raw);
            if (observed === null) {
              this.inactive(entry);
              orientationReconciled = true;
              break;
            }
            if (observed.timestampUs > baseline) {
              this.observeFrame(entry, raw);
              orientationReconciled = true;
              break;
            }
            await delay(CONTROL_POLL_MS);
            if (!current()) return { content: [{ type: "text", text: "The device binding changed while reconciling orientation." }], isError: true };
          }
          if (!orientationReconciled) throw new Error("The guest orientation policy changed, but a fresh screenshot was not observed within 15 seconds.");
        } finally { clearTimeout(timeout); }
      }
      const output = [result.stdout, result.stderr].filter((s) => s.trim() !== "").join("\n");
      const failed = result.code !== 0;
      const prefix = failed ? `agent-device exited with ${result.code === null ? "no exit code (killed or not started)" : `code ${result.code}`}\n` : "";
      const content: HostToolContent[] = [{ type: "text", text: truncateOutput(`${prefix}${output || (failed ? "" : "(no output)")}`.trimEnd()) }];
      if (screenshotPath !== null) {
        try {
          const png = await readFile(screenshotPath);
          if (!current()) return { content: [{ type: "text", text: "The device binding changed while reading the screenshot." }], isError: true };
          content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        } catch { /* Text output describes a command that did not produce a screenshot. */ }
      }
      return { content, isError: failed };
    } finally {
      if (screenshotPath !== null) await rm(screenshotPath, { force: true }).catch(() => {});
      this.dropLease(this.tabLeases, entry.tabId);
      this.dropLease(this.serialLeases, serial);
      if (current()) {
        if (!orientationReconciled) this.invalidateGeometry(entry);
        entry.inputReady = !entry.inputBlocked && entry.screen === "active" && entry.geometry !== null && entry.operation === null;
        this.endActing(entry);
        this.emitState(entry);
        if (entry.inputReady && entry.cached !== null && entry.sinks.size > 0) this.send(CH.onDevicePaneFrame, entry.tabId, entry.cached);
      }
    }
  }
  private dropLease(leases: Map<string, number>, key: string): void {
    const count = (leases.get(key) ?? 1) - 1;
    if (count <= 0) leases.delete(key); else leases.set(key, count);
  }
  private beginActing(entry: DeviceEntry): void {
    clearTimeout(entry.actingTimer);
    entry.actingTimer = undefined;
    entry.agent = "acting";
    if (!entry.open) entry.open = true;
    this.emitState(entry);
  }
  private endActing(entry: DeviceEntry): void {
    clearTimeout(entry.actingTimer);
    entry.actingTimer = setTimeout(() => {
      entry.actingTimer = undefined;
      if (this.entries.get(entry.tabId) !== entry || this.tabLeases.has(entry.tabId)) return;
      entry.agent = "attached";
      this.emitState(entry);
    }, DEVICE_PANE_ACTING_MS);
  }
}
