import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where a headless `lite` fleet member keeps its state (issue #1010).
 *
 * The desktop app pins Electron's userData under `app.getPath("appData")`
 * (desktop/src/main/index.ts): packaged `@omp-ui/desktop`, unpackaged dev
 * variants. The lite member is plain Node, so it mirrors the same parent —
 * Electron's appData root computed here without Electron — and lives beside
 * it as a sibling dir: `<appData>/omp-ui-lite`, or `<appData>/omp-ui-lite-dev`
 * when NODE_ENV=development marks a dev run (mirroring the desktop's separate
 * dev identity, so a dev member never shares state with an installed one).
 */

/** The lite home with `OMP_UI_LITE_HOME` override winning, else appData-derived. */
export function resolveLiteHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMP_UI_LITE_HOME;
  if (override !== undefined && override.trim() !== "") return override;
  const name = env.NODE_ENV === "development" ? "omp-ui-lite-dev" : "omp-ui-lite";
  return path.join(electronAppDataDir(env), name);
}

/** Electron's `app.getPath("appData")`, reproduced from env + platform only. */
export function electronAppDataDir(env: NodeJS.ProcessEnv): string {
  const platform = env.OS ?? process.platform;
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData !== undefined && appData.trim() !== "") return appData;
    return path.join(win32Home(env), "AppData", "Roaming");
  }
  if (platform === "darwin") return path.join(posixHome(env), "Library", "Application Support");
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim() !== "") return xdg;
  return path.join(posixHome(env), ".config");
}

function win32Home(env: NodeJS.ProcessEnv): string {
  const drive = env.HOMEDRIVE ?? "C:";
  const base = env.HOMEPATH ?? "\\Users\\Default";
  return `${drive}${base}`;
}

function posixHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? os.homedir();
}

/** The data dir itself, created 0700 (the registry and instance id inside are secrets). */
export function ensureLiteHome(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is umask-filtered; pin it so a permissive umask can't widen the dir.
  fs.chmodSync(dataDir, 0o700);
  return dataDir;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the member's stable instance id (`<dataDir>/instance-id`), minting and
 * persisting (0600) one on first boot. A joiner compares this against its own
 * to detect `self` (issue #416); the desktop keeps it in registry settings,
 * the lite member in a plain file so `status` never has to trust a parseable
 * registry.
 */
export function ensureInstanceId(dataDir: string, mint: () => string): string {
  const file = path.join(dataDir, "instance-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (UUID_PATTERN.test(existing)) return existing;
  } catch {
    // Absent or unreadable: mint below.
  }
  const id = mint();
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}
