// The omp settings allowlist. Pure — zero imports — because the renderer
// imports it directly via the @omp-ui/core/omp-settings-keys subpath, exactly
// like plan.ts and advisor-stats.ts. The reading and writing half lives in
// omp-settings.ts (node:child_process, main process only) and consumes these
// same constants, so the page's grouping and the write allowlist can never
// drift.

export interface OmpSettingGroup {
  title: string;
  description?: string;
  keys: readonly string[];
}

/** Memory settings live on their own settings page but share the core allowlist. */
export const MEMORY_SETTING_GROUP: OmpSettingGroup = {
  title: "Memory",
  description:
    "Mnemopi gives sessions durable recall. per-project-tagged writes project-local " +
    "and recalls project + global. Backend changes apply to sessions started afterwards.",
  keys: [
    "memory.backend",
    "mnemopi.scoping",
    "mnemopi.autoRecall",
    "mnemopi.autoRetain",
    "mnemopi.noEmbeddings",
    "autolearn.enabled",
  ],
};

/**
 * The web_search routing keys. Allowlisted but NOT in OMP_SETTING_GROUPS: an array-valued
 * setting renders as a read-only JSON span on the omp page (rows.tsx), so the Providers page
 * carries a dedicated closed select for webSearchOrder instead. webSearchExclude has no editor
 * here — it is read only to warn when a chosen provider is one omp will always skip.
 * These are the LEGACY binding: allowlisted so pre-18.2.x binaries stay readable and
 * writable. On modern omp the Providers page binds the same control to the `web` role of
 * OMP_MODEL_ROLES_KEY instead (ADR-0036); nothing is written to these keys unless the
 * snapshot still publishes them.
 */
export const WEB_SEARCH_SETTING_GROUP: OmpSettingGroup = {
  title: "Web search",
  keys: ["providers.webSearchOrder", "providers.webSearchExclude"],
};

/**
 * The subagent model override record (ADR-0031). Allowlisted but NOT in
 * OMP_SETTING_GROUPS: a record renders as a read-only JSON span on the omp
 * page (rows.tsx), so the page's "Subagent models" section carries one row
 * per agent instead, editing at the Global or Project layer explicitly.
 */
export const OMP_SUBAGENT_MODELS_KEY = "task.agentModelOverrides";
export const SUBAGENT_MODEL_SETTING_GROUP: OmpSettingGroup = {
  title: "Subagent models",
  keys: [OMP_SUBAGENT_MODELS_KEY],
};

/**
 * The subagent fan-out cap. Allowlisted but NOT in OMP_SETTING_GROUPS: a
 * plain group row commits through `omp config set`, which is Global-only by
 * construction, so the page's dedicated "Subagent concurrency" section edits
 * this key at the Global or Project layer explicitly instead (a row would be
 * a Global-only duplicate).
 */
export const OMP_MAX_CONCURRENCY_KEY = "task.maxConcurrency";
export const SUBAGENT_CONCURRENCY_SETTING_GROUP: OmpSettingGroup = {
  title: "Subagent concurrency",
  keys: [OMP_MAX_CONCURRENCY_KEY],
};

/** The exact-interpreter override; "" means "let omp discover one" (issue #671). */
export const PYTHON_INTERPRETER_KEY = "python.interpreter";

/** The omp settings the settings surface exposes, grouped for the omp page. */
export const OMP_SETTING_GROUPS: ReadonlyArray<OmpSettingGroup> = [
  {
    title: "Advisor",
    keys: [
      "advisor.enabled",
      "advisor.subagents",
      "advisor.syncBacklog",
      "advisor.immuneTurns",
    ],
  },
  {
    title: "Context",
    keys: [
      "compaction.enabled",
      "compaction.idleEnabled",
      "autoResume",
      "compaction.thresholdPercent",
      "compaction.thresholdTokens",
      "compaction.reserveTokens",
    ],
  },
  {
    title: "Providers",
    description:
      "OpenRouter’s nitro variant prioritizes throughput. Longer watchdog budgets tolerate quiet reasoning but delay recovery from a dead stream; 0 disables a watchdog.",
    keys: [
      "providers.openrouterVariant",
      "providers.streamFirstEventTimeoutSeconds",
      "providers.streamIdleTimeoutSeconds",
    ],
  },
  {
    title: "Display",
    keys: [
      "display.showTokenUsage",
      "hideThinkingBlock",
      "git.enabled",
      "colorBlindMode",
    ],
  },
  {
    // Python for the eval tool (#671). An omp that publishes neither key
    // renders no section — readOmpSettings' per-key rule already covers it.
    title: "Python",
    keys: [PYTHON_INTERPRETER_KEY, "python.kernelMode"],
  },
];
export const OMP_SETTING_KEYS: readonly string[] = [
  ...OMP_SETTING_GROUPS.flatMap((group) => group.keys),
  ...MEMORY_SETTING_GROUP.keys,
  ...WEB_SEARCH_SETTING_GROUP.keys,
];
/** modelRoles is a record edited per-role, so it is handled apart from the scalar list. */
export const OMP_MODEL_ROLES_KEY = "modelRoles";
/** omp's built-in roles, in omp's own order (v17.2.7 config/model-roles.ts MODEL_ROLE_IDS).
 *  omp 18.2.x added a `web` role, deliberately NOT listed here: the Providers page owns it
 *  as a closed select (ADR-0036), because the omp page's free-text row would bypass the
 *  ADR-0027 list contract. omp 18.4.0 added a `judge` kind role, likewise NOT listed here:
 *  the generic row would offer the model[:level] thinking suffix, which judgment selectors
 *  never take — JudgeRoleRow renders it from its own catalog instead (issue #669).
 *  OmpPage.commitRole spreads the whole record, so these siblings round-trip untouched. */
export const OMP_MODEL_ROLE_IDS = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
] as const;

/** omp's model-kind role for structured judgment (omp 18.4.0, issue #669).
 *  NOT in OMP_MODEL_ROLE_IDS: the generic chat row would offer the
 *  model[:level] thinking suffix, which judgment selectors never take.
 *  JudgeRoleRow renders it; commitRole's merged-record spread keeps every
 *  sibling role in one write. */
export const OMP_JUDGE_ROLE_ID = "judge";
