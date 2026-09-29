// omp's WATCHDOG.yml rules that the renderer needs too. Pure — zero imports —
// so it is browser-safe via the @omp-ui/core/watchdog subpath. Every rule
// ports omp 18.4.2 (advisor/config.ts); see ADR-0039 for the drift risk.

export const WATCHDOG_DEFAULT_TOOLS = ["read", "grep", "glob", "recall"] as const;

/** omp 18.4.2 `pce` (advisor/config.ts). Pinned. */
export const WATCHDOG_KNOWN_TOOLS = [
  "read", "bash", "edit", "ast_grep", "ast_edit", "ask", "debug", "ida", "eval", "github",
  "glob", "grep", "find", "lsp", "checkpoint", "rewind", "context_notes", "new_context",
  "security_scan", "task", "wait", "todo", "web_search", "write", "memory_edit", "retain",
  "recall", "reflect", "learn", "manage_skill",
] as const;

export const WATCHDOG_TOOL_ALIASES: Readonly<Record<string, string>> = { search: "grep" };

/** Tools that let an advisor mutate files or run commands. */
export const WATCHDOG_MUTATING_TOOLS: readonly string[] = ["write", "edit", "bash", "eval"];

/** omp's `slug(name)`. */
export function advisorSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "advisor";
}

/** Resolves one typed tool name to a known tool, or null. */
export function resolveWatchdogTool(name: string): string | null {
  const aliased = WATCHDOG_TOOL_ALIASES[name] ?? name;
  return (WATCHDOG_KNOWN_TOOLS as readonly string[]).includes(aliased) ? aliased : null;
}

/** The tools an entry really gets: omitted → defaults, [] → none, all-unknown → defaults. */
export function effectiveAdvisorTools(tools: readonly string[] | null): string[] {
  if (tools === null) return [...WATCHDOG_DEFAULT_TOOLS];
  if (tools.length === 0) return [];
  const out: string[] = [];
  for (const name of tools) {
    const resolved = resolveWatchdogTool(name);
    if (resolved !== null && !out.includes(resolved)) out.push(resolved);
  }
  return out.length === 0 ? [...WATCHDOG_DEFAULT_TOOLS] : out;
}
