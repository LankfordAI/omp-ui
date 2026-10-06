// Vault registry (CONTEXT.md "Vault registry", issue #764): the setting's
// parser, the pure transforms the vault:* handlers apply, obsidian.json
// detection, and the obsidian://open builder main hands to the opener.
// Node-only, so it has no package.json subpath; the renderer-safe half is
// vault-shared.ts.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateVaultRoot, type RootGuard } from "./knowledge-vault";
import type {
  KnowledgeVaultDiagnostics,
  ObsidianListEntry,
  VaultDetection,
  VaultRegistry,
  VaultRegistryEntry,
  VaultRowStatus,
} from "./types";
import { DEFAULT_HOME_FOLDER, normalizeHomeFolder, obsidianOpenUri, vaultNameFromPath, type VaultAction } from "./vault-shared";

export interface ObsidianList { file: string; vaults: ObsidianListEntry[]; cli: boolean }

/** Never throws; drops malformed rows and duplicate names after the first; repairs the default. Fresh object per call. */
export function parseVaultRegistry(value: unknown): VaultRegistry {
  if (typeof value !== "object" || value === null) return { vaults: [], defaultWriteVault: null };
  const raw = value as Record<string, unknown>;
  const vaults: VaultRegistryEntry[] = [];
  for (const row of Array.isArray(raw.vaults) ? raw.vaults : []) {
    if (typeof row !== "object" || row === null) continue;
    const { name, path: rowPath, homeFolder, allowWritesOutsideHome } = row as Record<string, unknown>;
    if (typeof name !== "string" || name === "" || typeof rowPath !== "string" || rowPath === "") continue;
    if (typeof allowWritesOutsideHome !== "boolean" || typeof homeFolder !== "string") continue;
    const normalized = normalizeHomeFolder(homeFolder);
    if (normalized === null || vaults.some((v) => v.name === name)) continue;
    vaults.push({ name, path: rowPath, homeFolder: normalized, allowWritesOutsideHome });
  }
  const wanted = raw.defaultWriteVault;
  const defaultWriteVault =
    typeof wanted === "string" && vaults.some((v) => v.name === wanted) ? wanted : (vaults[0]?.name ?? null);
  return { vaults, defaultWriteVault };
}

/**
 * Candidate obsidian.json files in order; first readable wins.
 * linux: ${XDG_CONFIG_HOME (non-empty) or <home>/.config}/obsidian/obsidian.json, then <home>/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json;
 * darwin: <home>/Library/Application Support/obsidian/obsidian.json;
 * win32: ${APPDATA (non-empty) or <home>\AppData\Roaming}\obsidian\obsidian.json;
 * any other platform: []. Join with path.win32 when platform === "win32", else path.posix.
 */
export function obsidianListCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  if (platform === "linux") {
    const config = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.posix.join(home, ".config");
    return [
      path.posix.join(config, "obsidian", "obsidian.json"),
      path.posix.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
    ];
  }
  if (platform === "darwin") {
    return [path.posix.join(home, "Library", "Application Support", "obsidian", "obsidian.json")];
  }
  if (platform === "win32") {
    const appData = env.APPDATA ? env.APPDATA : path.win32.join(home, "AppData", "Roaming");
    return [path.win32.join(appData, "obsidian", "obsidian.json")];
  }
  return [];
}

/**
 * null when unreadable, not JSON, or not an object. Entries need a non-empty string id key and a non-empty string path;
 * others are skipped. open = value.open === true. cli = doc.cli === true. Each path is realpath'd (fallback path.resolve).
 */
export async function readObsidianList(file: string): Promise<{ vaults: ObsidianListEntry[]; cli: boolean } | null> {
  let doc: unknown;
  try {
    doc = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const { vaults: rawVaults, cli } = doc as Record<string, unknown>;
  const vaults: ObsidianListEntry[] = [];
  if (typeof rawVaults === "object" && rawVaults !== null && !Array.isArray(rawVaults)) {
    for (const [id, entry] of Object.entries(rawVaults)) {
      if (id === "" || typeof entry !== "object" || entry === null) continue;
      const { path: original, open } = entry as Record<string, unknown>;
      if (typeof original !== "string" || original === "") continue;
      let real: string;
      try {
        real = await fs.realpath(original);
      } catch {
        real = path.resolve(original);
      }
      vaults.push({ id, path: real, open: open === true });
    }
  }
  return { vaults, cli: cli === true };
}

/** First candidate whose readObsidianList is non-null, with its file; null when none. */
export async function findObsidianList(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): Promise<ObsidianList | null> {
  for (const file of obsidianListCandidates(env, platform, home)) {
    const list = await readObsidianList(file);
    if (list !== null) return { file, vaults: list.vaults, cli: list.cli };
  }
  return null;
}

/** Row status, Obsidian-list membership and the import list for the Settings page. Never throws. */
export async function detectVaults(
  reg: VaultRegistry,
  opts: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; guard: RootGuard; uriHandler: boolean },
): Promise<VaultDetection> {
  const found = await findObsidianList(opts.env, opts.platform, opts.home);
  const list = found?.vaults ?? [];
  const rows: VaultDetection["rows"] = {};
  const rowReals: Array<{ name: string; real: string }> = [];
  for (const row of reg.vaults) {
    const check = await validateVaultRoot(row.path, opts.guard);
    let status: VaultRowStatus;
    let real: string;
    if (check.ok) {
      real = check.real;
      try {
        status = (await fs.stat(path.join(real, ".obsidian"))).isDirectory() ? "ok" : "no-obsidian-dir";
      } catch {
        status = "no-obsidian-dir";
      }
    } else {
      real = path.resolve(row.path);
      status = check.code === "unreachable" ? "missing" : "refused-root";
    }
    const obsidianId = obsidianIdFor(real, list);
    rows[row.name] = { status, inObsidianList: obsidianId !== null, obsidianId };
    rowReals.push({ name: row.name, real });
  }
  return {
    obsidianListFile: found?.file ?? null,
    obsidianList: list.map((entry) => ({
      ...entry,
      registeredAs: rowReals.find((r) => r.real === entry.path)?.name ?? null,
    })),
    cliRegistered: found?.cli ?? false,
    uriHandler: opts.uriHandler,
    rows,
  };
}

/** Exact string match of rootReal against the (already realpath'd) list paths. */
export function obsidianIdFor(rootReal: string, list: ObsidianListEntry[]): string | null {
  return list.find((entry) => entry.path === rootReal)?.id ?? null;
}

function requireVault(reg: VaultRegistry, name: string): void {
  if (!reg.vaults.some((v) => v.name === name)) throw new Error(`unknown vault "${name}"`);
}

/**
 * Appends a row for an already resolved and validated folder (the caller ran
 * resolveProjectPath and validateVaultRoot). The name is the folder basename;
 * the first row becomes the Default write vault. Never mutates `reg`.
 */
export function addVaultEntry(reg: VaultRegistry, absPath: string): VaultRegistry {
  const name = vaultNameFromPath(absPath);
  if (reg.vaults.some((v) => v.name === name)) throw new Error(`A vault named ${name} is already registered.`);
  return {
    vaults: [...reg.vaults, { name, path: absPath, homeFolder: DEFAULT_HOME_FOLDER, allowWritesOutsideHome: false }],
    defaultWriteVault: reg.defaultWriteVault ?? name,
  };
}

/** Drops the row; a removed default moves to the first remaining row, or null. Never mutates `reg`. */
export function removeVaultEntry(reg: VaultRegistry, name: string): VaultRegistry {
  requireVault(reg, name);
  const vaults = reg.vaults.filter((v) => v.name !== name);
  return {
    vaults,
    defaultWriteVault: reg.defaultWriteVault === name ? (vaults[0]?.name ?? null) : reg.defaultWriteVault,
  };
}

export function setDefaultWriteVault(reg: VaultRegistry, name: string): VaultRegistry {
  requireVault(reg, name);
  return { vaults: [...reg.vaults], defaultWriteVault: name };
}

export function setVaultHomeFolder(reg: VaultRegistry, name: string, input: string): VaultRegistry {
  requireVault(reg, name);
  const homeFolder = normalizeHomeFolder(input);
  if (homeFolder === null) throw new Error("Use a folder inside the vault, like omp-ui/.");
  return {
    vaults: reg.vaults.map((v) => (v.name === name ? { ...v, homeFolder } : v)),
    defaultWriteVault: reg.defaultWriteVault,
  };
}

export function setVaultWritesOutsideHome(reg: VaultRegistry, name: string, on: boolean): VaultRegistry {
  requireVault(reg, name);
  return {
    vaults: reg.vaults.map((v) => (v.name === name ? { ...v, allowWritesOutsideHome: on } : v)),
    defaultWriteVault: reg.defaultWriteVault,
  };
}

/**
 * The obsidian://open URI main hands to the opener. Vault-id keyed when the
 * root is in obsidian.json; otherwise path keyed, so Obsidian opens the folder
 * (or note) as a vault without a prior registration.
 */
export function buildVaultOpenUri(rootReal: string, rel: string | null, list: ObsidianListEntry[]): string {
  const id = obsidianIdFor(rootReal, list);
  if (id !== null) return obsidianOpenUri({ vault: id }, rel);
  return obsidianOpenUri({ path: rel === null ? rootReal : path.join(rootReal, ...rel.split("/")) }, null);
}

/** The diagnostics section body; never copies a folder path (#758). */
export function knowledgeVaultDiagnostics(
  reg: VaultRegistry,
  d: VaultDetection,
  calls: Record<string, Partial<Record<VaultAction, number>>>,
): KnowledgeVaultDiagnostics {
  return {
    vaults: reg.vaults.map((v) => ({
      name: v.name,
      homeFolder: v.homeFolder,
      allowWritesOutsideHome: v.allowWritesOutsideHome,
      isDefault: v.name === reg.defaultWriteVault,
      status: d.rows[v.name]?.status ?? "missing",
      inObsidianList: d.rows[v.name]?.inObsidianList ?? false,
    })),
    obsidianListFound: d.obsidianListFile !== null,
    cliRegistered: d.cliRegistered,
    uriHandler: d.uriHandler,
    calls,
  };
}
