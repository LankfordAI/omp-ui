// The omp settings allowlist. Pure — zero imports — because the renderer
// imports it directly via the @omp-ui/core/omp-settings-keys subpath, exactly
// like plan.ts and advisor-stats.ts. The reading and writing half lives in
// omp-settings.ts (node:child_process, main process only) and consumes these
// same constants, so the page's grouping and the write allowlist can never
// drift.

/** The omp settings the settings surface exposes, grouped for the omp page. */
export const OMP_SETTING_GROUPS: ReadonlyArray<{ title: string; keys: readonly string[] }> = [
  {
    title: "Advisor",
    keys: ["advisor.enabled", "advisor.subagents", "advisor.syncBacklog", "advisor.immuneTurns"],
  },
  { title: "Context", keys: ["compaction.enabled", "compaction.idleEnabled", "autoResume"] },
  {
    title: "Providers",
    keys: ["providers.streamIdleTimeoutSeconds", "providers.streamFirstEventTimeoutSeconds"],
  },
  {
    title: "Display",
    keys: ["display.showTokenUsage", "hideThinkingBlock", "git.enabled", "colorBlindMode"],
  },
];
export const OMP_SETTING_KEYS: readonly string[] = OMP_SETTING_GROUPS.flatMap((g) => g.keys);
/** modelRoles is a record edited per-role, so it is handled apart from the scalar list. */
export const OMP_MODEL_ROLES_KEY = "modelRoles";
/** omp's built-in roles, in omp's own order (v17.2.7 config/model-roles.ts MODEL_ROLE_IDS). */
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
