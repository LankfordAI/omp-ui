import { DEVICE_AVD_PATTERN, DEVICE_SERIAL_PATTERN, DEVICE_TOOL_NAME } from "./device-pane";
import type { EmulatorPosture, EmulatorRotation } from "./device-pane";
import { isNativeDeviceProfile, parseDeviceSystemImagePackage } from "./device-profiles";
import type { RpcHostToolDefinition } from "./host-bridge";

/** The device pane's host tool (issue #1006): agent-device argv, with device selection fixed by omp-ui. */
export function deviceTool(): RpcHostToolDefinition {
  return {
    name: DEVICE_TOOL_NAME,
    loadMode: "essential",
    description: [
      "Drive the Android emulator shown in this session's device pane; the user watches it live.",
      'omp-ui verbs: ["targets"] lists existing emulators and AVDs; ["use", "<serial|avd>"] binds one (booting an existing AVD if needed), never creates an absent AVD.',
      '["profiles"] lists the owner machine\'s supported native profiles and installed images; ["create", "<profileId>", "<imagePackage>", "<avd>"] explicitly creates a new AVD. Creation is accepted asynchronously, not ready: poll ["state"] for its actual lifecycle, operation and readiness.',
      '["rotate", "0|90|180|270"] physically rotates the bound emulator; ["posture", "closed|half-open|open|flipped|tent"] changes a supported physical posture. These controls do not override the guest app\'s orientation policy.',
      "Every other call is an allowed agent-device command line passed as args, e.g. the loop: open <app> --foreground, snapshot -i, press @eN --settle, fill @eN <text>, screenshot, close. The forwarded orientation command retains its guest orientation lock/auto semantics; it is not physical rotate.",
      "A bare screenshot returns the image inline.",
      "Device selection flags (--platform, --serial, --session, etc.) are fixed by omp-ui and refused if passed.",
      "Perform UI actions through this tool rather than raw adb, so the user can watch them happen.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        args: { type: "array", items: { type: "string", maxLength: 4096 }, minItems: 1, maxItems: 64 },
      },
      required: ["args"],
    },
  };
}

export type DeviceToolPlan =
  | { kind: "targets" }
  | { kind: "profiles" }
  | { kind: "use"; target: { serial: string } | { avd: string } }
  | { kind: "create"; profileId: string; imagePackage: string; avd: string }
  | { kind: "state" }
  | { kind: "rotate"; rotation: EmulatorRotation }
  | { kind: "posture"; posture: EmulatorPosture }
  | { kind: "forward"; argv: string[]; screenshotOut: boolean }
  | { kind: "refused"; reason: string };

const FORWARD_COMMANDS: Record<string, true> = {
  "open": true,
  "close": true,
  "apps": true,
  "appstate": true,
  "snapshot": true,
  "press": true,
  "click": true,
  "fill": true,
  "type": true,
  "longpress": true,
  "focus": true,
  "scroll": true,
  "swipe": true,
  "gesture": true,
  "back": true,
  "home": true,
  "app-switcher": true,
  "hardware-button": true,
  "wait": true,
  "is": true,
  "get": true,
  "find": true,
  "screenshot": true,
  "diff": true,
  "install": true,
  "reinstall": true,
  "uninstall": true,
  "logs": true,
  "keyboard": true,
  "clipboard": true,
  "orientation": true,
  "settings": true,
  "alert": true,
  "capabilities": true,
  "perf": true,
  "network": true,
  "trace": true,
  "record": true,
  "metro": true,
  "react-devtools": true,
  "react-native": true,
  "help": true,
};

const REFUSED_FLAGS = ["--serial", "--udid", "--device", "--platform", "--session", "--config", "--state-dir"];

const NO_BINDING_REASON =
  'No emulator is bound to this session. Call omp-ui_device with ["targets"] then ["use", "<serial or existing AVD>"], or explicitly ["create", "<profileId>", "<imagePackage>", "<avd>"] after ["profiles"].';

const SERIAL_RE = new RegExp(DEVICE_SERIAL_PATTERN);
const AVD_RE = new RegExp(DEVICE_AVD_PATTERN);

function validArgs(args: unknown): string[] | null {
  if (typeof args !== "object" || args === null || Array.isArray(args) || !("args" in args)) return null;
  if (Object.keys(args).length !== 1) return null;
  const list = args.args;
  if (!Array.isArray(list) || list.length < 1 || list.length > 64) return null;
  const strings: string[] = [];
  for (const a of list) {
    if (typeof a !== "string" || a.length > 4096) return null;
    strings.push(a);
  }
  return strings;
}

/** argv is the agent's args; binding/session are appended by main, never taken from the agent. */
export function planDeviceCommand(
  args: unknown,
  binding: { serial: string; session: string } | null,
  outPath: string,
): DeviceToolPlan {
  const argv = validArgs(args);
  if (argv === null) return { kind: "refused", reason: "args must be { args: string[] } with 1 to 64 items." };
  for (const arg of argv) {
    const flag = REFUSED_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
    if (flag !== undefined) return { kind: "refused", reason: `${flag} is fixed by omp-ui and cannot be passed.` };
  }
  const [command, ...rest] = argv as [string, ...string[]];
  if (command === "targets" || command === "profiles" || command === "state") {
    return rest.length === 0 ? { kind: command } : { kind: "refused", reason: `${command} takes no arguments.` };
  }
  if (command === "use") {
    const [target] = rest;
    if (rest.length !== 1 || target === undefined) return { kind: "refused", reason: "use takes exactly one serial or AVD name." };
    if (SERIAL_RE.test(target)) return { kind: "use", target: { serial: target } };
    if (AVD_RE.test(target)) return { kind: "use", target: { avd: target } };
    return { kind: "refused", reason: `"${target}" is neither an emulator serial nor an AVD name.` };
  }
  if (command === "create") {
    const [profileId, imagePackage, avd] = rest;
    if (rest.length !== 3 || profileId === undefined || imagePackage === undefined || avd === undefined) {
      return { kind: "refused", reason: "create takes exactly one native profile ID, installed image package ID and new AVD name." };
    }
    if (!isNativeDeviceProfile(profileId)) return { kind: "refused", reason: `"${profileId}" is not a supported native device profile ID. Call profiles for available profiles.` };
    if (imagePackage.length > 256 || parseDeviceSystemImagePackage(imagePackage) === null) {
      return { kind: "refused", reason: "create requires an exact installed mobile system-image package ID from profiles." };
    }
    if (!AVD_RE.test(avd) || avd === "." || avd === ".." || avd.startsWith("-")) {
      return { kind: "refused", reason: `"${avd}" is not a valid new AVD name.` };
    }
    return { kind: "create", profileId, imagePackage, avd };
  }
  if (command === "rotate") {
    if (rest.length === 1) {
      switch (rest[0]) {
        case "0": return { kind: "rotate", rotation: 0 };
        case "90": return { kind: "rotate", rotation: 1 };
        case "180": return { kind: "rotate", rotation: 2 };
        case "270": return { kind: "rotate", rotation: 3 };
      }
    }
    return { kind: "refused", reason: "rotate takes exactly one physical rotation: 0, 90, 180 or 270." };
  }
  if (command === "posture") {
    if (rest.length === 1) {
      switch (rest[0]) {
        case "closed":
        case "half-open":
        case "open":
        case "flipped":
        case "tent": return { kind: "posture", posture: rest[0] };
      }
    }
    return { kind: "refused", reason: "posture takes exactly one physical posture: closed, half-open, open, flipped or tent." };
  }
  if (!Object.hasOwn(FORWARD_COMMANDS, command)) return { kind: "refused", reason: `"${command}" is not an allowed agent-device command.` };
  if (binding === null) return { kind: "refused", reason: NO_BINDING_REASON };
  const out = [...argv];
  let screenshotOut = false;
  if (command === "screenshot") {
    let positional = false;
    let hasOut = false;
    let hasScale = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--out" || arg.startsWith("--out=")) hasOut = true;
      if (arg === "--scale" || arg.startsWith("--scale=")) hasScale = true;
      if (arg === "--out" || arg === "--scale") i++;
      else if (!arg.startsWith("-")) positional = true;
    }
    if (!positional && !hasOut) {
      out.push("--out", outPath);
      if (!hasScale) out.push("--scale", "0.5");
      screenshotOut = true;
    }
  }
  out.push("--platform", "android", "--serial", binding.serial, "--session", binding.session);
  return { kind: "forward", argv: out, screenshotOut };
}
