// Knowledge vault rules shared by main and the renderer (issue #764). Pure —
// zero imports — because the renderer imports it directly via the
// @omp-ui/core/vault-shared subpath, exactly like worktree-branch.ts.
// The node half (the Vault registry transforms, obsidian.json detection, the
// root guard) lives in vault-registry.ts and knowledge-vault.ts and consumes
// these same rules, so the home-folder and URI shapes can never drift.

export const DEFAULT_HOME_FOLDER = "omp-ui/";
export const VAULT_WRITE_TOOLS = ["omp-ui_vault_create", "omp-ui_vault_append", "omp-ui_vault_edit", "omp-ui_vault_link"] as const;
export type VaultAction = "search" | "read" | "list" | "create" | "append" | "edit" | "link";
const VAULT_ACTIONS: readonly string[] = ["search", "read", "list", "create", "append", "edit", "link"];

/** Trim, drop a leading "./", split on / and \, refuse empty/absolute/drive/".."/dot segments; join with "/" plus one trailing "/". */
export function normalizeHomeFolder(input: string): string | null {
  let s = input.trim();
  if (s.startsWith("./") || s.startsWith(".\\")) s = s.slice(2);
  if (s === "" || /^[/\\]/.test(s) || /^[A-Za-z]:/.test(s)) return null;
  const segments = s.split(/[/\\]+/).filter((seg) => seg !== "");
  if (segments.length === 0 || segments.some((seg) => seg.startsWith("."))) return null;
  return `${segments.join("/")}/`;
}

/** Last path segment, splitting both separators (worktreeBranchPrefix's rule, without the slug). "" when none. */
export function vaultNameFromPath(absPath: string): string {
  const segments = absPath.split(/[\\/]+/).filter((part) => part !== "");
  return segments[segments.length - 1] ?? "";
}

/** obsidian://open URIs. `file` is vault-relative; a trailing ".md" is stripped; every value encodeURIComponent'd. */
export function obsidianOpenUri(target: { vault: string } | { path: string }, file: string | null): string {
  if ("path" in target) return `obsidian://open?path=${encodeURIComponent(target.path)}`;
  const base = `obsidian://open?vault=${encodeURIComponent(target.vault)}`;
  return file === null ? base : `${base}&file=${encodeURIComponent(file.replace(/\.md$/i, ""))}`;
}

/** The `details` every vault tool result carries (#757); the keys the card and the rail read. */
export interface VaultToolDetails {
  vaultName: string;
  vaultId: string | null;          // 16-hex Obsidian id when the vault is in obsidian.json
  path: string | null;             // vault-relative, ".md" kept; null for search
  action: VaultAction;
  createdByOmpUi: boolean | null;  // null for search and list
  title?: string;
  stamp?: string[];                // "key: value" lines, create only
  preview?: string;                // create: body as written; append: the appended text
  diff?: string;                   // edit and link: omp numbered-row format (section 3, item 6)
  baseHash?: string;               // read and every write: sha256 hex of the file after the call
  indexNotePath?: string;          // create inside a project folder
  collisions?: string[];           // create: other vault paths with the same basename
  matchedFiles?: number; returnedFiles?: number; truncated?: boolean;  // search, list
}

const STRING_FIELDS = ["title", "preview", "diff", "baseHash", "indexNotePath"] as const;
const STRING_ARRAY_FIELDS = ["stamp", "collisions"] as const;
const NUMBER_FIELDS = ["matchedFiles", "returnedFiles"] as const;

/** Structural guard; null unless vaultName is a string and action is a VaultAction. Copies only known, correctly typed keys. */
export function parseVaultDetails(details: unknown): VaultToolDetails | null {
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (typeof d.vaultName !== "string" || typeof d.action !== "string" || !VAULT_ACTIONS.includes(d.action)) {
    return null;
  }
  const out: VaultToolDetails = {
    vaultName: d.vaultName,
    vaultId: typeof d.vaultId === "string" ? d.vaultId : null,
    path: typeof d.path === "string" ? d.path : null,
    action: d.action as VaultAction,
    createdByOmpUi: typeof d.createdByOmpUi === "boolean" ? d.createdByOmpUi : null,
  };
  for (const key of STRING_FIELDS) {
    const value = d[key];
    if (typeof value === "string") out[key] = value;
  }
  for (const key of STRING_ARRAY_FIELDS) {
    const value = d[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) out[key] = [...value];
  }
  for (const key of NUMBER_FIELDS) {
    const value = d[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  if (typeof d.truncated === "boolean") out.truncated = d.truncated;
  return out;
}
