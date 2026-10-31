import { statSync } from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import path from "node:path";
import { withoutAppImageRuntime } from "./appimage-env";
import { DEVICE_AVD_PATTERN, type DeviceSdkStatus } from "./device-pane";

export interface AndroidSdkProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  isFile?: (p: string) => boolean;
}

export interface AndroidSdkPaths {
  sdkRoot: string;
  adb: string;
  emulator: string | null;
}

/** An emulator discovery file name: `pid_<pid>.ini` or `pid_<pid>_info.ini`. */
export const DISCOVERY_FILE_PATTERN = /^pid_(\d+)(_info)?\.ini$/;

const AVD_RE = new RegExp(DEVICE_AVD_PATTERN);

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function defaultSdkRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const p = pathFor(platform);
  switch (platform) {
    case "darwin":
      return [p.join(home, "Library", "Android", "sdk")];
    case "win32": {
      const local = env.LOCALAPPDATA ?? p.join(home, "AppData", "Local");
      return [p.join(local, "Android", "Sdk")];
    }
    default:
      return [p.join(home, "Android", "Sdk"), p.join(home, "Android", "sdk")];
  }
}

/** ANDROID_HOME, then ANDROID_SDK_ROOT, then the OS default; the first root holding platform-tools/adb wins. */
export function resolveAndroidSdk(deps: AndroidSdkProbeDeps = {}): AndroidSdkPaths | null {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const isFile = deps.isFile ?? defaultIsFile;
  const p = pathFor(platform);
  const exe = platform === "win32" ? ".exe" : "";
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, ...defaultSdkRoots(platform, env, home)];
  for (const root of roots) {
    if (!root) continue;
    const adb = p.join(root, "platform-tools", `adb${exe}`);
    if (!isFile(adb)) continue;
    const emulator = p.join(root, "emulator", `emulator${exe}`);
    return { sdkRoot: root, adb, emulator: isFile(emulator) ? emulator : null };
  }
  return null;
}

export function androidSdkStatus(paths: AndroidSdkPaths | null): DeviceSdkStatus {
  if (!paths) return { status: "missing", missing: ["sdk", "adb", "emulator"] };
  if (!paths.emulator) return { status: "missing", missing: ["emulator"] };
  return { status: "ready", sdkRoot: paths.sdkRoot };
}

/** Prepends platform-tools and emulator dirs; sets ANDROID_HOME. Base env is withoutAppImageRuntime(). */
export function androidChildEnv(
  paths: AndroidSdkPaths,
  base: NodeJS.ProcessEnv = withoutAppImageRuntime(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const p = pathFor(platform);
  const env = { ...base };
  const pathKey = platform === "win32" ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path") : "PATH";
  const dirs = [p.dirname(paths.adb)];
  if (paths.emulator) dirs.push(p.dirname(paths.emulator));
  const existing = env[pathKey];
  env[pathKey] = [...dirs, ...(existing ? [existing] : [])].join(p.delimiter);
  env.ANDROID_HOME = paths.sdkRoot;
  return env;
}

/** `adb devices -l` → serial/state rows; skips the header and blank lines. */
export function parseAdbDevices(stdout: string): Array<{ serial: string; state: string }> {
  const rows: Array<{ serial: string; state: string }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [serial, state] = line.split(/\s+/);
    if (serial && state) rows.push({ serial, state });
  }
  return rows;
}

/** `emulator -list-avds` → names; drops lines that fail DEVICE_AVD_PATTERN (the emulator prints INFO lines). */
export function parseAvdList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => AVD_RE.test(l));
}

/** `key=value` lines of a pid_<pid>.ini discovery file. */
export function parseDiscoveryIni(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    out.set(raw.slice(0, eq).trim(), raw.slice(eq + 1).trim());
  }
  return out;
}

/** Candidate discovery dirs, in order. */
export function emulatorDiscoveryDirs(
  deps: AndroidSdkProbeDeps & { tmpdir?: string; uid?: number } = {},
): string[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const tmp = deps.tmpdir ?? osTmpdir();
  const p = pathFor(platform);
  const running = (root: string) => p.join(root, "avd", "running");
  const userAndroid = running(p.join(home, ".android"));
  const dirs: string[] = [];
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? p.join(home, "AppData", "Local");
    dirs.push(running(p.join(local, "Temp")), userAndroid);
  } else if (platform === "darwin") {
    dirs.push(running(p.join(home, "Library", "Caches", "TemporaryItems")), userAndroid, running(tmp));
  } else {
    if (env.XDG_RUNTIME_DIR) dirs.push(running(env.XDG_RUNTIME_DIR));
    const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid !== undefined) dirs.push(running(`/run/user/${uid}`));
    dirs.push(env.ANDROID_EMULATOR_HOME ? running(env.ANDROID_EMULATOR_HOME) : userAndroid, running(tmp));
  }
  return [...new Set(dirs)];
}

/** `wm size` output → the override size if present, else the physical size. */
export function parseWmSize(stdout: string): { width: number; height: number } | null {
  const pick = (label: string) => {
    const m = new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`).exec(stdout);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  };
  return pick("Override") ?? pick("Physical");
}
