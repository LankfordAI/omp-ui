import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { git } from "./git";
import { slugifyProjectName } from "./worktree-branch";
import { listRemoteNames, type GitRunner } from "./branches";
import { parseRemoteWebUrl } from "./pr-url";
import type { KnowledgeHome, VaultRegistry } from "./types";

const GIT_TIMEOUT_MS = 5_000;

export type ResolvedKnowledgeHome =
  | { kind: "docs"; source: "set" | "default" }
  | { kind: "vault" | "both"; vault: string; source: "set" | "default" }
  | { kind: "broken"; pinned: string } // pin names an unregistered vault
  | { kind: "none" }; // vault/both chosen or defaulted, but no vault registered

export interface KnowledgeHomeDeps {
  runGit?: GitRunner;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  readFile?: (p: string) => Promise<string>;
}

interface ResolvedDeps {
  runGit: GitRunner;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  readFile: (p: string) => Promise<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** gh's config dir: GH_CONFIG_DIR, then $XDG_CONFIG_HOME/gh, then %APPDATA%\GitHub CLI (win32), then ~/.config/gh. */
export function ghConfigDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (env.XDG_CONFIG_HOME) return p.join(env.XDG_CONFIG_HOME, "gh");
  if (platform === "win32") {
    const appData = env.APPDATA ? env.APPDATA : path.win32.join(home, "AppData", "Roaming");
    return path.win32.join(appData, "GitHub CLI");
  }
  return path.posix.join(home, ".config", "gh");
}

/** Lowercased host → lowercased logins, from each host's `users` keys plus its `user` value. Never throws. */
export function ghLogins(hostsYml: string): Map<string, Set<string>> {
  const logins = new Map<string, Set<string>>();
  let doc: unknown;
  try {
    doc = yaml.load(hostsYml);
  } catch {
    return logins;
  }
  if (!isPlainObject(doc)) return logins;
  for (const [host, entry] of Object.entries(doc)) {
    if (!isPlainObject(entry)) continue;
    const names = new Set<string>();
    if (isPlainObject(entry.users)) {
      for (const login of Object.keys(entry.users)) names.add(login.toLowerCase());
    }
    const user = entry.user;
    if (typeof user === "string" && user !== "") names.add(user.toLowerCase());
    else if (typeof user === "number") names.add(String(user).toLowerCase());
    if (names.size > 0) logins.set(host.toLowerCase(), names);
  }
  return logins;
}

/**
 * The repo's remote identity: the remote's web host and first path segment
 * (the owner), lowercased, or a marker when nothing names both — "no-repo"
 * outside a git checkout, "no-remote" inside one with no remote, "unknown"
 * when no single remote URL names a host and an owner. The remote-selection
 * precedence is `origin`, else a single remote, else none; scp-style and URL
 * forms via parseRemoteWebUrl, credentials dropped. Never rejects.
 */
async function remoteIdentity(
  cwd: string,
  deps: ResolvedDeps,
): Promise<{ host: string; owner: string } | "no-repo" | "no-remote" | "unknown"> {
  const opts = { timeoutMs: GIT_TIMEOUT_MS };
  try {
    await deps.runGit(cwd, ["rev-parse", "--show-toplevel"], opts);
  } catch {
    return "no-repo";
  }
  try {
    const timed: GitRunner = (root, args) => deps.runGit(root, args, opts);
    const names = await listRemoteNames(cwd, timed);
    if (names.length === 0) return "no-remote";
    const remote = names.includes("origin") ? "origin" : names.length === 1 ? names[0]! : null;
    if (remote === null) return "unknown";
    const web = parseRemoteWebUrl(await deps.runGit(cwd, ["remote", "get-url", remote], opts));
    if (web === null) return "unknown";
    const url = new URL(web);
    const host = url.hostname.toLowerCase();
    const owner = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    if (owner === undefined) return "unknown";
    return { host, owner };
  } catch {
    return "unknown";
  }
}

/**
 * The routing default (issue #766): true when knowledge belongs in repo docs —
 * not a git repo, no remote, or the remote's owner is one of the user's own gh
 * logins on that host. Reads gh's hosts.yml; no network, no gh subprocess.
 */
async function routesToDocs(cwd: string, deps: ResolvedDeps): Promise<boolean> {
  const identity = await remoteIdentity(cwd, deps);
  if (identity === "no-repo" || identity === "no-remote") return true;
  if (identity === "unknown") return false;
  const join = deps.platform === "win32" ? path.win32.join : path.posix.join;
  let text: string;
  try {
    text = await deps.readFile(join(ghConfigDir(deps.env, deps.platform, deps.home), "hosts.yml"));
  } catch {
    return false;
  }
  return ghLogins(text).get(identity.host)?.has(identity.owner) === true;
}

/** Cap on the whole folder name so a long owner cannot balloon the vault path. */
export const VAULT_FOLDER_MAX = 64;

/**
 * The vault project folder (#787): the plain slug with no owner; otherwise
 * `slug-owner`, the whole name trimmed to VAULT_FOLDER_MAX with any trailing
 * dash stripped. An owner with no usable characters yields the plain slug; an
 * owner that slugs equal to the name is not special-cased (`ansible/ansible`
 * is `ansible-ansible`, ambiguous nowhere).
 */
export function vaultProjectFolder(displayName: string, owner: string | null): string {
  const base = slugifyProjectName(displayName);
  if (owner === null || !/[a-z0-9]/.test(owner.toLowerCase())) return base;
  return `${base}-${slugifyProjectName(owner)}`.slice(0, VAULT_FOLDER_MAX).replace(/-+$/, "");
}

/**
 * Resolve the vault project folder for a project: the name's slug plus the
 * remote's owner when the remote has a web face with an owner, so two
 * same-named repos from different owners keep separate folders in a vault
 * Obsidian Sync carries across machines. Never rejects: any git or parse
 * failure falls back to the plain slug.
 */
export async function resolveVaultProjectFolder(
  displayName: string,
  projectCwd: string,
  deps: KnowledgeHomeDeps = {},
): Promise<string> {
  const resolved: ResolvedDeps = {
    runGit: deps.runGit ?? git,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    home: deps.home ?? os.homedir(),
    readFile: deps.readFile ?? ((p) => readFile(p, "utf8")),
  };
  const identity = await remoteIdentity(projectCwd, resolved);
  return vaultProjectFolder(displayName, typeof identity === "object" ? identity.owner : null);
}

/** Never rejects: every git or file failure maps to a rule outcome. */
export async function resolveKnowledgeHome(
  home: KnowledgeHome | null,
  projectCwd: string,
  reg: VaultRegistry,
  deps: KnowledgeHomeDeps = {},
): Promise<ResolvedKnowledgeHome> {
  if (home !== null) {
    if (home.home === "docs") return { kind: "docs", source: "set" };
    const pinned = home.vault;
    if (pinned !== undefined && !reg.vaults.some((row) => row.name === pinned)) {
      return { kind: "broken", pinned };
    }
    if (reg.vaults.length === 0) return { kind: "none" };
    const vault = pinned ?? reg.defaultWriteVault;
    if (vault === null) return { kind: "none" };
    return { kind: home.home, vault, source: "set" };
  }
  const resolved: ResolvedDeps = {
    runGit: deps.runGit ?? git,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    home: deps.home ?? os.homedir(),
    readFile: deps.readFile ?? ((p) => readFile(p, "utf8")),
  };
  if (await routesToDocs(projectCwd, resolved)) return { kind: "docs", source: "default" };
  if (reg.vaults.length === 0 || reg.defaultWriteVault === null) return { kind: "none" };
  return { kind: "vault", vault: reg.defaultWriteVault, source: "default" };
}
