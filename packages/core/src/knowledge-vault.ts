import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isWithin } from "./worktree";

/** The roots a vault may never be, or sit inside (#758, U1). */
export interface RootGuard { home: string; userData: string; agentDir: string; sessionsRoot: string; archiveRoot: string }
export type VaultRootCheck =
  | { ok: true; real: string }
  | { ok: false; code: "unreachable" | "refused"; reason: string };

async function realOrResolved(p: string): Promise<string> {
  try { return await fs.realpath(p); } catch { return path.resolve(p); }
}
const insideOrEqual = (root: string, candidate: string): boolean => candidate === root || isWithin(root, candidate);

/** Runs at add time and again at every call that touches the vault. A missing .obsidian/ never fails here. */
export async function validateVaultRoot(absPath: string, guard: RootGuard): Promise<VaultRootCheck> {
  let real: string;
  try { real = await fs.realpath(absPath); }
  catch { return { ok: false, code: "unreachable", reason: "vault folder is unreachable" }; }
  const refuse = (what: string): VaultRootCheck =>
    ({ ok: false, code: "refused", reason: `omp-ui cannot use ${real} as a vault: it is ${what}` });
  if (real === (await realOrResolved(guard.home))) return refuse("your home directory");
  if (path.parse(real).root === real) return refuse("the filesystem root");
  const roots: Array<[string, string]> = [
    ["inside omp-ui's data folder", guard.userData],
    ["inside omp's agent folder", guard.agentDir],
    ["inside omp's sessions folder", guard.sessionsRoot],
    ["inside omp's session archive", guard.archiveRoot],
  ];
  for (const [what, root] of roots) {
    if (insideOrEqual(await realOrResolved(root), real)) return refuse(what);
  }
  return { ok: true, real };
}

/**
 * Resolves a vault-relative path under an already-validated root. Refuses
 * empty, absolute, drive-letter, ".." and dot-leading segments lexically,
 * then walks up to the nearest existing ancestor and refuses anything whose
 * realpath leaves the root (a symlinked folder pointing outside). A leaf that
 * does not exist yet is fine as long as its existing ancestor is inside.
 */
export async function resolveVaultPath(
  rootReal: string,
  rel: string,
): Promise<{ ok: true; abs: string; rel: string } | { ok: false; reason: string }> {
  if (rel.trim() === "") return { ok: false, reason: "empty path" };
  if (rel.startsWith("/") || rel.startsWith("\\") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    return { ok: false, reason: `absolute paths are refused: ${rel}` };
  }
  const segments = rel.split(/[/\\]/).filter((s) => s !== "");
  if (segments.some((s) => s === "..")) return { ok: false, reason: `".." segments are refused: ${rel}` };
  if (segments.some((s) => s.startsWith("."))) {
    return { ok: false, reason: `hidden segments (starting with ".") are refused: ${rel}` };
  }
  let root: string;
  try {
    root = await fs.realpath(rootReal);
  } catch {
    return { ok: false, reason: "vault folder is unreachable" };
  }
  const normalized = segments.join("/");
  const abs = path.join(root, ...segments);
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!insideOrEqual(root, real)) return { ok: false, reason: `path leaves the vault: ${rel}` };
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return { ok: false, reason: `path leaves the vault: ${rel}` };
      probe = parent;
    }
  }
  return { ok: true, abs, rel: normalized };
}
