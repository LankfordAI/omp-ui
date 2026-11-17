// omp's WATCHDOG.yml rules that the renderer needs too. Pure — node-free —
// so it is browser-safe via the @omp-ui/core/watchdog subpath. Every rule
// ports omp 18.4.2 (advisor/config.ts); see ADR-0039 for the drift risk.
import { compareVersions } from "./semver";

export const WATCHDOG_DEFAULT_TOOLS = ["read", "grep", "glob", "recall"] as const;

/** omp 18.4.2 `pce` (advisor/config.ts). Pinned. */
const WATCHDOG_KNOWN_TOOLS_18_4 = [
  "read", "bash", "edit", "ast_grep", "ast_edit", "ask", "debug", "ida", "eval", "github",
  "glob", "grep", "find", "lsp", "checkpoint", "rewind", "context_notes", "new_context",
  "security_scan", "task", "wait", "todo", "web_search", "write", "memory_edit", "retain",
  "recall", "reflect", "learn", "manage_skill",
] as const;

/** omp 18.22.0 removed `ida` from `BUILTIN_TOOL_NAMES` (the capability moved
 *  into the eval `dsm` namespace, which is not a built tool name — so no `dsm`
 *  entry replaces it). An advisor list naming `ida` there drops it, and an
 *  all-unknown list falls back to the defaults (`advisor/config.ts`
 *  `filterAdvisorTools`); mirror that exactly (issue #1199). */
export const IDA_REMOVED_IN_OMP = "18.22.0";

const WATCHDOG_KNOWN_TOOLS_POST_IDA: readonly string[] = WATCHDOG_KNOWN_TOOLS_18_4.filter(
  (tool) => tool !== "ida",
);

/** The known-tool list scoped to one omp version: `ida` only below 18.22.0.
 *  An unknown version keeps it — the removal engages only on a confirmed
 *  current binary, so an older omp never loses a tool it actually grants. */
export function watchdogKnownTools(ompVersion: string | null): readonly string[] {
  return ompVersion !== null && compareVersions(ompVersion, IDA_REMOVED_IN_OMP) >= 0
    ? WATCHDOG_KNOWN_TOOLS_POST_IDA
    : WATCHDOG_KNOWN_TOOLS_18_4;
}

/** omp's resolver lowercases the typed name before alias/known-tool lookup
 *  (binary `Xyo`), so `tools: [Read]` is valid to omp; mirror that here. */
export const WATCHDOG_TOOL_ALIASES: Readonly<Record<string, string>> = { search: "grep" };

/** Tools that let an advisor mutate files or run commands. */
export const WATCHDOG_MUTATING_TOOLS: readonly string[] = ["write", "edit", "bash", "eval"];

/** omp's `slug(name)`. */
export function advisorSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "advisor";
}

/** Resolves one typed tool name to a known tool for `ompVersion`, or null. */
export function resolveWatchdogTool(name: string, ompVersion: string | null = null): string | null {
  const key = name.toLowerCase();
  const aliased = WATCHDOG_TOOL_ALIASES[key] ?? key;
  return watchdogKnownTools(ompVersion).includes(aliased) ? aliased : null;
}

/** The tools an entry really gets on `ompVersion`: omitted → defaults,
 *  [] → none, all-unknown → defaults. */
export function effectiveAdvisorTools(tools: readonly string[] | null, ompVersion: string | null = null): string[] {
  if (tools === null) return [...WATCHDOG_DEFAULT_TOOLS];
  if (tools.length === 0) return [];
  const out: string[] = [];
  for (const name of tools) {
    const resolved = resolveWatchdogTool(name, ompVersion);
    if (resolved !== null && !out.includes(resolved)) out.push(resolved);
  }
  return out.length === 0 ? [...WATCHDOG_DEFAULT_TOOLS] : out;
}
