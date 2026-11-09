import { statSync } from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import path from "node:path";
import { withoutAppImageRuntime } from "./appimage-env";
import { DEVICE_AVD_PATTERN, type DeviceInventory, type DeviceSdkStatus, type DeviceSystemImage } from "./device-pane";
import { nativeAndroidAbi } from "./device-profiles";

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
  /** Provisioning only; existing AVDs remain usable when command-line tools are absent. */
  avdmanager: string | null;
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
    const avdmanager = p.join(root, "cmdline-tools", "latest", "bin", `avdmanager${platform === "win32" ? ".bat" : ""}`);
    return {
      sdkRoot: root,
      adb,
      emulator: isFile(emulator) ? emulator : null,
      avdmanager: isFile(avdmanager) ? avdmanager : null,
    };
  }
  return null;
}

export function androidSdkStatus(paths: AndroidSdkPaths | null): DeviceSdkStatus {
  if (!paths) return { status: "missing", missing: ["sdk", "adb", "emulator"] };
  if (!paths.emulator) return { status: "missing", missing: ["emulator"] };
  return { status: "ready", sdkRoot: paths.sdkRoot };
}

/** Owner-machine creation readiness. This describes setup only; it never installs or downloads anything. */
export function androidCreationReadiness(
  paths: AndroidSdkPaths | null,
  arch: string,
  images: readonly DeviceSystemImage[],
): DeviceInventory["creation"] {
  const abi = nativeAndroidAbi(arch);
  const sdkRoot = paths?.sdkRoot ?? null;
  if (abi === null) {
    return {
      available: false,
      reason: `Native Android emulator creation is unsupported on owner architecture "${arch}".`,
      sdkRoot,
      installCommand: null,
    };
  }
  const packages: string[] = [];
  if (!paths) packages.push("platform-tools");
  if (!paths?.emulator) packages.push("emulator");
  if (!paths?.avdmanager) packages.push("cmdline-tools;latest");
  const hasImage = images.some((image) => image.abi === abi);
  if (!hasImage) packages.push(`system-images;android-35;google_apis;${abi}`);
  const installCommand = packages.length > 0 ? `sdkmanager ${packages.map((name) => `"${name}"`).join(" ")}` : null;
  const reason = !paths
    ? "The Android SDK and platform-tools are missing on the owner machine."
    : !paths.emulator
      ? "The Android emulator is missing from the owner Android SDK."
      : !paths.avdmanager
        ? "Android SDK Command-line Tools (avdmanager) are missing on the owner machine."
        : !hasImage
          ? `No complete installed ${abi} mobile system image is available on the owner machine.`
          : null;
  return { available: reason === null, reason, sdkRoot, installCommand };
}

/** Matches the Android tools' environment overrides; arguments stay explicit for deterministic callers. */
export function resolveAndroidAvdHome(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathFor(platform);
  if (env.ANDROID_AVD_HOME) return p.normalize(env.ANDROID_AVD_HOME);
  const userHome = env.ANDROID_EMULATOR_HOME || env.ANDROID_USER_HOME ||
    p.join(env.ANDROID_SDK_HOME || home, ".android");
  return p.join(userHome, "avd");
}

/** Root AVD metadata points to its real content directory, which may be outside the AVD home. */
export function resolveAvdConfigPath(
  avd: string,
  metadata: string,
  avdHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!AVD_RE.test(avd) || avd === "." || avd === "..") throw new Error("Invalid AVD name");
  const p = pathFor(platform);
  const values = parseDiscoveryIni(metadata);
  const absolute = values.get("path");
  if (absolute) {
    if (!p.isAbsolute(absolute)) throw new Error("AVD metadata path must be absolute");
    return p.join(absolute, "config.ini");
  }
  const relative = values.get("path.rel");
  if (relative) {
    if (p.isAbsolute(relative)) throw new Error("AVD metadata path.rel must be relative");
    return p.join(p.dirname(avdHome), relative, "config.ini");
  }
  return p.join(avdHome, `${avd}.avd`, "config.ini");
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
