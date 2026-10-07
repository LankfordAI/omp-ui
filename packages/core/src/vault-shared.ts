// Knowledge vault rules shared by main and the renderer (issue #764). Pure —
// zero runtime imports — because the renderer imports it directly via the
// @omp-ui/core/vault-shared subpath, exactly like worktree-branch.ts.
// The node half (the Vault registry transforms, obsidian.json detection, the
// root guard) lives in vault-registry.ts and knowledge-vault.ts and consumes
// these same rules, so the home-folder and URI shapes can never drift.
import type { KnowledgeHome } from "./types";

export const DEFAULT_HOME_FOLDER = "omp-ui/";
export const VAULT_WRITE_TOOLS = ["omp-ui_vault_create", "omp-ui_vault_append", "omp-ui_vault_edit", "omp-ui_vault_link"] as const;
export type VaultAction = "search" | "read" | "list" | "create" | "append" | "edit" | "link";
const VAULT_ACTIONS: readonly string[] = ["search", "read", "list", "create", "append", "edit", "link"];

/** A persisted preference, not a registry membership check: removed vault pins stay intact. */
export function isKnowledgeHome(value: unknown): value is KnowledgeHome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const home = value as Record<string, unknown>;
  if (Object.keys(home).some((key) => key !== "home" && key !== "vault")) return false;
  if (home.home !== "docs" && home.home !== "vault" && home.home !== "both") return false;
  return !("vault" in home) || (typeof home.vault === "string" && home.vault.length > 0);
}

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

export interface ObsidianNoteTarget {
  vaultName: string;
  file: string;
}

function hasAsciiControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A strict note-only URI parser. Registry membership and filesystem checks happen when activated. */
export function parseObsidianNoteUri(href: string): ObsidianNoteTarget | null {
  if (/\s/.test(href) || hasAsciiControl(href)) return null;
  const match = /^obsidian:\/\/open\?([^#]*)$/i.exec(href);
  if (match === null) return null;
  const pairs = match[1].split("&");
  if (pairs.length !== 2) return null;

  let vaultName: string | null = null;
  let file: string | null = null;
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator === -1) return null;
    const key = pair.slice(0, separator);
    if (key !== "vault" && key !== "file") return null;
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, " "));
    } catch {
      return null;
    }
    if (value.length === 0 || hasAsciiControl(value)) return null;
    if (key === "vault") {
      if (vaultName !== null || value.trim().length === 0) return null;
      vaultName = value;
    } else {
      if (file !== null) return null;
      file = value;
    }
  }
  if (vaultName === null || file === null) return null;

  file = file.replace(/\\/g, "/");
  if (file.startsWith("/") || /^[A-Za-z]:/.test(file) || /[#^]/.test(file)) return null;
  if (file.split("/").some((segment) => segment.length === 0 || segment.startsWith("."))) return null;
  return { vaultName, file: /\.md$/i.test(file) ? file : `${file}.md` };
}

function encodeReplyQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A reply link for a successfully resolved Markdown note, keeping its exact path and extension. */
export function obsidianReplyLink(vaultName: string, file: string, title: string): string {
  const label = title.replace(/[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g, "\\$&");
  const vault = encodeReplyQueryValue(vaultName);
  const path = encodeReplyQueryValue(file);
  return `[${label}](obsidian://open?vault=${vault}&file=${path})`;
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
  adopted?: string[];              // create: vault paths of omp-ui notes moved in from legacy project folders
  matchedFiles?: number; returnedFiles?: number; truncated?: boolean;  // search, list
}

const STRING_FIELDS = ["title", "preview", "diff", "baseHash", "indexNotePath"] as const;
const STRING_ARRAY_FIELDS = ["stamp", "collisions", "adopted"] as const;
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
