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
 * The /share targets. Allowlisted but NOT in OMP_SETTING_GROUPS: the
 * first-share privacy dialog reads the effective values; the omp page
 * shows no duplicate row, and no omp-ui surface writes these keys.
 */
export const SHARE_SETTING_GROUP: OmpSettingGroup = {
  title: "Share",
  keys: ["share.store", "share.serverUrl", "share.redactSecrets"],
};

/**
 * The per-model compaction thresholds (omp 18.8.8, issue #831). Allowlisted
 * but NOT in OMP_SETTING_GROUPS: `modelThresholds` is a record and would
 * render as a read-only JSON span (rows.tsx); the HUD reads both keys purely
 * to draw the notch, and no omp-ui surface writes them.
 */
export const COMPACTION_MODEL_THRESHOLD_SETTING_GROUP: OmpSettingGroup = {
  title: "Compaction model thresholds",
  keys: ["compaction.modelThresholds", "compaction.modelThresholdsEnabled"],
};

/**
 * Extra instruction files loaded beside the usual context file
 * (omp 18.8.8, issue #837). Allowlisted but NOT in OMP_SETTING_GROUPS:
 * an array value renders as a read-only JSON span there (rows.tsx), so
 * ContextFilesSection owns the editable row on the omp page.
 */
export const CONTEXT_FILES_EXTRA_KEY = "contextFiles.extra";
export const CONTEXT_FILES_SETTING_GROUP: OmpSettingGroup = {
  title: "Context files",
  keys: [CONTEXT_FILES_EXTRA_KEY],
};

/**
 * Folders where every read, write, edit, search, or command asks for an
 * explicit approval in every approval mode, yolo included (omp 18.13.1,
 * issue #951). Allowlisted but NOT in OMP_SETTING_GROUPS: an array renders
 * as a read-only JSON span in the generic row (rows.tsx), so
 * RestrictedFoldersSection owns the editable row. Global-only: omp marks the
 * key `restrictedFoldersNotProject`.
 */
export const RESTRICTED_FOLDERS_KEY = "tools.restrictedFolders";
export const RESTRICTED_FOLDERS_SETTING_GROUP: OmpSettingGroup = {
  title: "Restricted folders",
  keys: [RESTRICTED_FOLDERS_KEY],
};

/**
 * The privacy keys. Allowlisted but NOT in OMP_SETTING_GROUPS: the Providers
 * page renders its own switch for the telemetry opt-out (issue #670), so the
 * omp page shows no duplicate row for it. Allowlisted so the write boundary
 * covers the key; readOmpSettings' per-entry rule hides it on binaries that
 * do not publish it (omp < 18.4.0).
 */
export const OMP_TELEMETRY_EXPORT_KEY = "telemetry.otlpExportEnabled";
export const PRIVACY_SETTING_GROUP: OmpSettingGroup = {
  title: "Privacy",
  keys: [OMP_TELEMETRY_EXPORT_KEY],
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

/**
 * The tool-approval tier (issue #681, ADR-0038). Allowlisted but NOT in
 * OMP_SETTING_GROUPS: omp publishes no `options` for this key, so the generic
 * row would render the enum as free text — the page's dedicated "Tool
 * approval" section renders a select and edits the Global or Project layer
 * explicitly instead (the Subagent concurrency pattern).
 */
export const APPROVAL_SETTING_KEY = "tools.approvalMode";
export const APPROVAL_SETTING_GROUP: OmpSettingGroup = {
  title: "Tool approval",
  keys: [APPROVAL_SETTING_KEY],
};

/**
 * omp's per-session spend caps (omp 18.13.0, issue #952): positive USD
 * amounts; omp warns once at warnCost and stops sending model requests at
 * maxCost, subagents included. Allowlisted but NOT in OMP_SETTING_GROUPS: the
 * page's dedicated "Spend caps" section edits both keys at the Global or
 * Project layer and can clear them — a generic row is Global-only and cannot
 * unset a value.
 */
export const SESSION_WARN_COST_KEY = "session.warnCost";
export const SESSION_MAX_COST_KEY = "session.maxCost";
export const SPEND_CAP_SETTING_GROUP: OmpSettingGroup = {
  title: "Spend caps",
  keys: [SESSION_WARN_COST_KEY, SESSION_MAX_COST_KEY],
};

/**
 * omp's Codex realtime voice timbre (#802) and the two local-speech rates
 * (omp 18.8.7, issue #836). Allowlisted but NOT in OMP_SETTING_GROUPS: the
 * page's dedicated "Live voice" section renders the enum select, the sample
 * playback (issue #813), and the speed rows, so the generic loop would show
 * duplicate rows.
 */
export const LIVE_VOICE_SETTING_KEY = "live.voice";
export const SPEECH_SPEED_SETTING_KEY = "speech.speed";
export const TTS_LOCAL_SPEED_SETTING_KEY = "tts.localSpeed";
export const LIVE_VOICE_SETTING_GROUP: OmpSettingGroup = {
  title: "Live voice",
  keys: [LIVE_VOICE_SETTING_KEY, SPEECH_SPEED_SETTING_KEY, TTS_LOCAL_SPEED_SETTING_KEY],
};

/** The shared-work guard for the bash tool (omp 18.8.7, issue #832). */
export const BASH_GIT_GUARD_KEY = "bash.gitGuard";

/** Git safety for the bash tool. A plain boolean row; the worktree default
 *  lives in git-guard-overlay.ts, so an unconfigured worktree session boots
 *  guarded while an explicit user value always wins. */
export const GIT_SETTING_GROUP: OmpSettingGroup = {
  title: "Git",
  keys: [BASH_GIT_GUARD_KEY],
};

/** The exact-interpreter override; "" means "let omp discover one" (issue #671). */
export const PYTHON_INTERPRETER_KEY = "python.interpreter";

/**
 * Sharpshooter decision extraction (omp 18.12.0, issue #887). The shortest
 * prompt an exchange must reach before Sharpshooter extracts decisions from
 * it; lower fires more eagerly. A plain number row in the generic group loop.
 */
export const SHARPSHOOTER_SETTING_GROUP: OmpSettingGroup = {
  title: "Sharpshooter",
  description:
    "Shortest prompt length Sharpshooter extracts session decisions from; lower fires more eagerly.",
  keys: ["sharpshooter.minPromptLength"],
};

/**
 * The status line's per-segment options record (omp 18.11.3 / 18.12.0, issue
 * #887). Allowlisted but NOT in OMP_SETTING_GROUPS: it is a record whose
 * nested `pi.showProfile` flag the omp page edits by spread-merge — a raw
 * record write is REPLACE-not-merge (verified), so the generic JSON row
 * would clobber sibling segment options. StatusLineSection renders it.
 */
export const STATUS_LINE_SEGMENT_OPTIONS_KEY = "statusLine.segmentOptions";
export const STATUS_LINE_SETTING_GROUP: OmpSettingGroup = {
  title: "Status line",
  keys: [STATUS_LINE_SEGMENT_OPTIONS_KEY],
};

/** The omp settings the settings surface exposes, grouped for the omp page. */
export const OMP_SETTING_GROUPS: ReadonlyArray<OmpSettingGroup> = [
  {
    title: "Advisor",
    keys: [
      "advisor.enabled",
      "advisor.subagents",
      "advisor.syncBacklog",
      "advisor.immuneTurns",
      "advisor.reviewInterval",
      "advisor.maxNotesPerUpdate",
      // omp 18.12.1 (issue #882): minimum severity of a post-answer note that
      // wakes the agent; lower severities stay parked as a transcript card.
      "advisor.continueSeverity",
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
      // omp 18.11 (issue #871): pre-walks the context before the first turn.
      "prewalk.enabled",
    ],
  },
  SHARPSHOOTER_SETTING_GROUP,
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
      // omp 18.8.7 title cards (issue #838); the select options ride in from
      // `omp config list` via parseEnumOptions, so no option plumbing here.
      "title.icons",
    ],
  },
  {
    // Python for the eval tool (#671). An omp that publishes neither key
    // renders no section — readOmpSettings' per-key rule already covers it.
    title: "Python",
    keys: [PYTHON_INTERPRETER_KEY, "python.kernelMode"],
  },
  {
    // Per-call LSP request/diagnostic timeout. `lsp.requestTimeout` is an
    // omp 18.11.2 key; an older binary that doesn't publish it renders no
    // section — readOmpSettings' per-key rule already covers it (issue #871).
    title: "Language server",
    description:
      "Per-call timeout for language-server requests and diagnostics.",
    keys: ["lsp.requestTimeout"],
  },
  {
    // omp 18.12.3 (issue #954): the `widget` model role designs one live widget
    // per running background job, which the Jobs pane and HUD jobs chip draw.
    // Off stops omp from authoring widgets, so no further widget model calls.
    title: "Background jobs",
    keys: ["async.widgets"],
  },
  GIT_SETTING_GROUP,
];
export const OMP_SETTING_KEYS: readonly string[] = [
  ...OMP_SETTING_GROUPS.flatMap((group) => group.keys),
  ...MEMORY_SETTING_GROUP.keys,
  ...WEB_SEARCH_SETTING_GROUP.keys,
  ...PRIVACY_SETTING_GROUP.keys,
  ...SHARE_SETTING_GROUP.keys,
  ...APPROVAL_SETTING_GROUP.keys,
  ...SPEND_CAP_SETTING_GROUP.keys,
  ...RESTRICTED_FOLDERS_SETTING_GROUP.keys,
  ...LIVE_VOICE_SETTING_GROUP.keys,
  ...STATUS_LINE_SETTING_GROUP.keys,
  ...COMPACTION_MODEL_THRESHOLD_SETTING_GROUP.keys,
  ...CONTEXT_FILES_SETTING_GROUP.keys,
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
