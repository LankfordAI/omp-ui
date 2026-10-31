import { DEVICE_AVD_PATTERN, DEVICE_SERIAL_PATTERN, DEVICE_TOOL_NAME } from "./device-pane";
import type { RpcHostToolDefinition } from "./host-bridge";

/** The device pane's host tool (issue #1006): agent-device argv, with device selection fixed by omp-ui. */
export function deviceTool(): RpcHostToolDefinition {
  return {
    name: DEVICE_TOOL_NAME,
    loadMode: "essential",
    description: [
      "Drive the Android emulator shown in this session's device pane; the user watches it live.",
      'omp-ui verbs: ["targets"] lists emulators and AVDs; ["use", "<serial|avd>"] binds (booting an AVD if needed) this session to one.',
      "Every other call is an agent-device command line passed as args, e.g. the loop: open <app> --foreground, snapshot -i, press @eN --settle, fill @eN <text>, screenshot, close.",
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
  | { kind: "use"; target: { serial: string } | { avd: string } }
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
  'No emulator is bound to this session. Call omp-ui_device with ["targets"] then ["use", "<serial or AVD>"].';

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
  if (command === "targets") {
    return rest.length === 0 ? { kind: "targets" } : { kind: "refused", reason: "targets takes no arguments." };
  }
  if (command === "use") {
    const [target] = rest;
    if (rest.length !== 1 || target === undefined) return { kind: "refused", reason: "use takes exactly one serial or AVD name." };
    if (SERIAL_RE.test(target)) return { kind: "use", target: { serial: target } };
    if (AVD_RE.test(target)) return { kind: "use", target: { avd: target } };
    return { kind: "refused", reason: `"${target}" is neither an emulator serial nor an AVD name.` };
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
