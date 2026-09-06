// The capability mirror tables. Pure — zero imports — because the renderer
// bundles this file through the same subpath mechanism as omp-settings-keys.ts,
// while the resolver half (capability-catalog.ts, main process only) consumes
// these same constants, so a scope panel's rows and the write allowlist can
// never drift from each other.
//
// Mirrored from omp 18.1.10 source — packages/coding-agent/src/discovery/
// {builtin,claude,agents,codex}.ts (skill roots, provider priorities, and the
// skills.enableX gates), src/config/settings-schema.ts (the `skills.*` keys and
// their defaults), and src/tools/index.ts + src/sdk.ts (each tool's gate key).
// Bump with the pinned binary; guarded by omp-capability-keys.test.ts
// (live-binary parity, skipped when no binary is resolvable).

export type SkillOrigin = "pi" | "claude" | "agents" | "codex" | "managed" | "custom";

export interface SkillSourceSpec {
  origin: SkillOrigin;
  /** The level omp tags the root with; project roots are skipped at global scope. */
  scope: "user" | "project";
  /**
   * Which base the root hangs off: `os.homedir()`, the scope's working tree,
   * or omp's agent dir (`getOmpAgentDir()`, profile-aware).
   */
  base: "home" | "cwd" | "agentDir";
  /** path.join(base, ...parts). */
  parts: readonly string[];
  /** The `skills.enableX` gate that admits this root; null = always discovered. */
  gateKey: string | null;
  /**
   * omp's provider priority: the higher number wins a name collision, and
   * equal priorities fall back to table order (omp's provider-registration
   * order). `custom` is not a provider priority in omp — its loader overrides
   * any default-path skill by name (issue #7190); 1000 encodes that outcome.
   */
  priority: number;
  /** True when omp walks up from cwd to the repo root collecting this root. */
  walkUp?: boolean;
}

/**
 * The skill roots omp discovers, in omp's discovery order: provider priority
 * descending, and within one provider project roots before user roots (the
 * order each loader concatenates its scans in). The catalog resolves roots in
 * this table's order — first winner by name, losers rendered `shadowedBy`.
 * Not listed: providers whose roots are not plain directories omp scans on
 * disk at these paths (agent-plugins, claude-plugins, cline, github,
 * opencode, omp-plugins) and omp's embedded curated defaults
 * (discovery/builtin-defaults.ts, priority 1) — those skills appear in a live
 * session's roster, and the skills panel says so; they are never imitated here.
 */
export const SKILL_SOURCES: readonly SkillSourceSpec[] = [
  // native / pi — discovery/builtin.ts (PRIORITY 100)
  { origin: "pi", scope: "project", base: "cwd", parts: [".omp", "skills"], gateKey: "skills.enablePiProject", priority: 100 },
  { origin: "pi", scope: "user", base: "agentDir", parts: ["skills"], gateKey: "skills.enablePiUser", priority: 100 },
  // claude — discovery/claude.ts (PRIORITY 80); project roots walk up, skipping $HOME
  { origin: "claude", scope: "project", base: "cwd", parts: [".claude", "skills"], gateKey: "skills.enableClaudeProject", priority: 80, walkUp: true },
  { origin: "claude", scope: "user", base: "home", parts: [".claude", "skills"], gateKey: "skills.enableClaudeUser", priority: 80 },
  // agents — discovery/agents.ts (PRIORITY 70); .agent before .agents per directory
  { origin: "agents", scope: "project", base: "cwd", parts: [".agent", "skills"], gateKey: "skills.enableAgentsProject", priority: 70, walkUp: true },
  { origin: "agents", scope: "project", base: "cwd", parts: [".agents", "skills"], gateKey: "skills.enableAgentsProject", priority: 70, walkUp: true },
  { origin: "agents", scope: "user", base: "home", parts: [".agent", "skills"], gateKey: "skills.enableAgentsUser", priority: 70 },
  { origin: "agents", scope: "user", base: "home", parts: [".agents", "skills"], gateKey: "skills.enableAgentsUser", priority: 70 },
  // codex — discovery/codex.ts (PRIORITY 70, registered after agents); the
  // project root has no toggle of its own (only the user root is gated off).
  { origin: "codex", scope: "project", base: "cwd", parts: [".codex", "skills"], gateKey: null, priority: 70 },
  { origin: "codex", scope: "user", base: "home", parts: [".codex", "skills"], gateKey: "skills.enableCodexUser", priority: 70 },
  // managed — autolearn/managed-skills.ts (MANAGED_SKILLS_PRIORITY 5): omp's
  // own auto-learn roots, ungated by any toggle except the master switch.
  { origin: "managed", scope: "user", base: "agentDir", parts: ["managed-skills"], gateKey: null, priority: 5 },
];

/** Custom-directory roots get this priority; see SKILL_SOURCES' note on #7190. */
export const CUSTOM_SKILLS_PRIORITY = 1_000;

/**
 * The `<tool>.enabled` gates of omp's tool registry (tools/index.ts
 * `isToolAllowed` and sdk.ts' optional-tool registrations), in omp's builtin
 * registry order, hidden tools last. `rewind` shares checkpoint's key (the
 * pair is registered together), `security_scan`'s key is `security.enabled`,
 * and the sdk-registered `tts` tool's key is `speechgen.enabled`.
 *
 * Deliberately absent: settings whose prefix is not a registered tool —
 * browser/computer (eval preludes), fetch (URL reads inside `read`), exa (a
 * web_search provider), speech/stt/ttsr (voice features), vault (a URL
 * protocol), launch (a hub op), git/plan (integrations), compaction/advisor
 * (behaviors). The Tools catalog lists tools, not every boolean; those
 * settings keep whatever surface omp's own `omp config` docs assign them.
 * Tools whose availability is not a settings key at all (eval, task, hub, the
 * memory tools) cannot be catalogued honestly and are absent here; the live
 * roster shows them.
 */
export interface ToolGate {
  tool: string;
  key: string;
}

export const TOOL_ENABLED_KEYS: readonly ToolGate[] = [
  { tool: "bash", key: "bash.enabled" },
  { tool: "ast_grep", key: "astGrep.enabled" },
  { tool: "ast_edit", key: "astEdit.enabled" },
  { tool: "ask", key: "ask.enabled" },
  { tool: "debug", key: "debug.enabled" },
  { tool: "github", key: "github.enabled" },
  { tool: "glob", key: "glob.enabled" },
  { tool: "grep", key: "grep.enabled" },
  { tool: "lsp", key: "lsp.enabled" },
  { tool: "checkpoint", key: "checkpoint.enabled" },
  { tool: "rewind", key: "checkpoint.enabled" },
  { tool: "security_scan", key: "security.enabled" },
  { tool: "todo", key: "todo.enabled" },
  { tool: "web_search", key: "web_search.enabled" },
  { tool: "goal", key: "goal.enabled" },
  { tool: "generate_image", key: "generate_image.enabled" },
  { tool: "tts", key: "speechgen.enabled" },
];

/** Every `skills.*` key omp 18.1.10 publishes, in omp's schema order. */
export const SKILLS_SETTING_KEYS: readonly string[] = [
  "skills.enabled",
  "skills.enableSkillCommands",
  "skills.enableCodexUser",
  "skills.enableClaudeUser",
  "skills.enableClaudeProject",
  "skills.enablePiUser",
  "skills.enablePiProject",
  "skills.enableAgentsUser",
  "skills.enableAgentsProject",
  "skills.customDirectories",
  "skills.ignoredSkills",
  "skills.includeSkills",
];

/** The settings keys a tool mutation may target (deduplicated; `checkpoint.enabled` gates two tools). */
export const TOOL_SETTING_KEYS: readonly string[] = [
  "ask.enabled",
  "astEdit.enabled",
  "astGrep.enabled",
  "bash.enabled",
  "checkpoint.enabled",
  "debug.enabled",
  "generate_image.enabled",
  "github.enabled",
  "glob.enabled",
  "goal.enabled",
  "grep.enabled",
  "lsp.enabled",
  "security.enabled",
  "speechgen.enabled",
  "todo.enabled",
  "web_search.enabled",
];

/**
 * The `skills.*` keys that gate a root (the switchable ones). `skills.enabled`
 * is the master switch (edited through the omp settings page, not a row
 * here), and the three list/command keys are data, not gates.
 */
export const SKILL_GATE_KEYS: readonly string[] = [
  "skills.enableCodexUser",
  "skills.enableClaudeUser",
  "skills.enableClaudeProject",
  "skills.enablePiUser",
  "skills.enablePiProject",
  "skills.enableAgentsUser",
  "skills.enableAgentsProject",
];

/**
 * omp's schema defaults for the gate keys (settings-schema.ts, 18.1.10). Only
 * a fallback: when the settings read succeeds, omp's own published value wins.
 */
export const SKILL_GATE_DEFAULTS: Readonly<Record<string, boolean>> = {
  "skills.enabled": true,
  "skills.enableSkillCommands": true,
  "skills.enableCodexUser": false,
  "skills.enableClaudeUser": false,
  "skills.enableClaudeProject": true,
  "skills.enablePiUser": true,
  "skills.enablePiProject": true,
  "skills.enableAgentsUser": true,
  "skills.enableAgentsProject": true,
};
