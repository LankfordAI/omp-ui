import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { git } from "./git";
import { slugifyProjectName } from "./worktree-branch";
import { listRemoteNames, type GitRunner } from "./branches";
import { parseRemoteWebUrl } from "./pr-url";
import type { KnowledgeHome, VaultProjectIdentity, VaultRegistry } from "./types";

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
 * (the owner), lowercased, plus every web path segment URL-decoded in its
 * original case, or a marker when nothing names both — "no-repo" outside a
 * git checkout, "no-remote" inside one with no remote, "unknown" when no
 * single remote URL names a host and an owner. The remote-selection
 * precedence is `origin`, else a single remote, else none; scp-style and URL
 * forms via parseRemoteWebUrl, credentials dropped. Never rejects.
 */
async function remoteIdentity(
  cwd: string,
  deps: ResolvedDeps,
): Promise<{ host: string; owner: string; segments: string[] } | "no-repo" | "no-remote" | "unknown"> {
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
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    });
    const owner = segments[0]?.toLowerCase();
    if (owner === undefined) return "unknown";
    return { host, owner, segments };
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

/** Cap on one vault folder name (and on the #787 legacy name as a whole). */
export const VAULT_FOLDER_MAX = 64;

/**
 * The #787 folder name (v0.20.2): `slug-owner`, the whole name trimmed to
 * VAULT_FOLDER_MAX with any trailing dash stripped; the plain slug when the
 * owner has no usable characters. Kept only to find that legacy folder.
 */
function ownerSuffixedFolder(displayName: string, owner: string): string {
  const base = slugifyProjectName(displayName);
  if (!/[a-z0-9]/.test(owner.toLowerCase())) return base;
  return `${base}-${slugifyProjectName(owner)}`.slice(0, VAULT_FOLDER_MAX).replace(/-+$/, "");
}

/** One remote path segment as a vault folder name, or null when nothing usable is left. */
export function vaultFolderSegment(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- control characters are illegal in folder names
  let s = raw.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, "-")
    .replace(/^[.\s]+/, "").slice(0, VAULT_FOLDER_MAX).replace(/[.\s]+$/, "");
  if (s === "") return null;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s)) s = `${s}-`;
  return s;
}

/** No web remote: today's plain-slug folder and Index, byte-identical. */
export function plainVaultProject(displayName: string): VaultProjectIdentity {
  const slug = slugifyProjectName(displayName);
  return { key: null, folder: slug, indexTitle: `${slug} Index`, legacy: null };
}

/**
 * The vault project identity (#794): nested `Owner/Repo` folders from the
 * remote web path in original case, keyed by the lowercased path, so every
 * clone of one repo computes the same folder whatever its directory is
 * called. Fewer than two usable segments yields the plain slug. Pure.
 */
export function vaultProjectIdentity(displayName: string, segments: string[] | null): VaultProjectIdentity {
  const safe = segments?.map(vaultFolderSegment) ?? null;
  if (segments === null || safe === null || safe.length < 2 || safe.some((s) => s === null)) {
    return plainVaultProject(displayName);
  }
  const folders = safe as string[];
  const ownerSegment = folders[0]!.toLowerCase();
  const plain = slugifyProjectName(displayName);
  const suffixed = ownerSuffixedFolder(displayName, segments[0]!.toLowerCase());
  return {
    key: segments.join("/").toLowerCase(),
    folder: folders.join("/"),
    indexTitle: `${folders[folders.length - 1]} Index`,
    legacy: {
      // A legacy name equal to the owner folder (case-insensitive FS) is the owner folder itself.
      suffixed: suffixed === plain || suffixed.toLowerCase() === ownerSegment ? null : suffixed,
      plain: plain.toLowerCase() === ownerSegment ? "" : plain,
    },
  };
}

/**
 * Resolve the vault project identity for a project from its git remote.
 * Never rejects: any git or parse failure yields plainVaultProject.
 */
export async function resolveVaultProject(
  displayName: string,
  projectCwd: string,
  deps: KnowledgeHomeDeps = {},
): Promise<VaultProjectIdentity> {
  const resolved: ResolvedDeps = {
    runGit: deps.runGit ?? git,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    home: deps.home ?? os.homedir(),
    readFile: deps.readFile ?? ((p) => readFile(p, "utf8")),
  };
  const identity = await remoteIdentity(projectCwd, resolved);
  return vaultProjectIdentity(displayName, typeof identity === "object" ? identity.segments : null);
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
