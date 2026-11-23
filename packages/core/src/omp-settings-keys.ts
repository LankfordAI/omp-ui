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
    // omp 18.20–18.22 (issue #1206): judge-gated relevance filtering of
    // auto-recalled memories (tri-state auto|on|off, off by default), and the
    // two asymmetric-embedder knobs — a recall-query text prefix for
    // instruction-tuned embedders, and sending `input_type` with embedding
    // requests. Plain rows through the generic SettingControl; upstream shows
    // them only while the mnemopi backend is active, and the existing per-key
    // "skip keys omp does not publish" rule covers the binary skew.
    "mnemopi.recallRelevance",
    "mnemopi.embeddingQueryPrefix",
    "mnemopi.embeddingInputType",
    "autolearn.enabled",
    // omp's hindsight global-scope gate (omp 18.16.0, issue #1033): a plain
    // boolean, off by default; upstream shows it only when the hindsight
    // backend is active. It renders through the generic SettingControl row.
    // An older binary publishes no key, so readOmpSettings emits no row — the
    // existing per-key "skip keys omp does not publish" rule covers the skew.
    "hindsight.globalScope",
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
 * omp's per-tool approval policy record, `tools.approval`, and the one entry
 * omp-ui edits in it: `computer.control` (omp 18.14.0, issue #976), which
 * answers the computer tool's foreground-control requests — `allow` or `deny`
 * without prompting, absent = ask. Allowlisted but NOT in OMP_SETTING_GROUPS:
 * the record is REPLACE-not-merge on `omp config set` and omp writes the dotted
 * entry name as one literal key (verified), so ComputerControlSection spreads
 * the whole global record back — the generic row would clobber sibling
 * per-tool policies.
 */
export const TOOL_APPROVAL_POLICIES_KEY = "tools.approval";
export const COMPUTER_CONTROL_POLICY = "computer.control";
export const TOOL_APPROVAL_POLICIES_SETTING_GROUP: OmpSettingGroup = {
  title: "Computer control",
  keys: [TOOL_APPROVAL_POLICIES_KEY],
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

/** The shared-work guard for the bash tool (omp 18.8.7, issue #832); scoped to
 *  shared checkouts, with discards in linked worktrees saved on
 *  refs/omp/discarded, since omp 18.14 (issue #973). */
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

/**
 * The paused providers the user turned back on (omp 18.19+, issue #1206).
 * Allowlisted but NOT in OMP_SETTING_GROUPS: an array renders as a read-only
 * JSON span there (rows.tsx), so UnpausedProvidersSection owns the editable
 * row. Global-only: omp reads only operator layers for this key
 * (`cfgOperatorUnpausedProviders`; a project config cannot unpause a provider,
 * verified upstream v18.22.0 `config/model-settings.ts`), and its own editor
 * carries the same restriction (`unpausedProvidersNotProject`).
 *
 * The choices are the providers omp's auth rules pause (`disabled "<reason>"`
 * in the catalog's auth stratum). `omp config list` publishes no option list
 * for this array, so the roster is curated here the way OMP_MODEL_ROLE_IDS is:
 * transcribed from upstream v18.22.0 `packages/catalog/src/compat/rules/auth/`
 * with each pause reason verbatim — the reason IS the risk acceptance omp's
 * editor makes the user read before re-enabling a provider. An id this list
 * does not name but the stored array holds still renders (remove-only), so an
 * omp that pauses a new provider loses no escape hatch.
 */
export const UNPAUSED_PROVIDERS_KEY = "auth.unpausedProviders";
export interface PausedProviderSpec {
  /** The auth-rule provider id — the string stored in the array. */
  id: string;
  label: string;
  /** omp's own `disabled "<reason>"` text: the account risk un-pausing accepts. */
  risk: string;
}
export const PAUSED_PROVIDER_SPECS: readonly PausedProviderSpec[] = [
  {
    id: "google-antigravity",
    label: "Google Antigravity (Gemini, Claude, GPT-OSS)",
    risk:
      "Google's terms do not allow third-party sign-in and Google has suspended accounts that used it (see #18341). Use GEMINI_API_KEY (AI Studio) or google-vertex instead.",
  },
];
export const UNPAUSED_PROVIDERS_SETTING_GROUP: OmpSettingGroup = {
  title: "Unpaused providers",
  keys: [UNPAUSED_PROVIDERS_KEY],
};

/**
 * The per-agent judge-armed prewalk record (omp 18.22, issue #1206):
 * agent name → `"on"`, `"off"`, or a model pattern; `"on"` arms the
 * `prewalk.autoTarget` hand-off and the native judge decides per assignment
 * when nothing arms unconditionally (`task.agentPrewalk` beats it).
 * Allowlisted but NOT in OMP_SETTING_GROUPS: a record renders as a read-only
 * JSON span there (rows.tsx) and is REPLACE-not-merge, so
 * AgentPrewalkAutoSection owns the editable rows with the whole-record
 * spread discipline (ADR-0031).
 */
export const AGENT_PREWALK_AUTO_KEY = "task.agentPrewalkAuto";
export const AGENT_PREWALK_AUTO_SETTING_GROUP: OmpSettingGroup = {
  title: "Judge-armed subagent prewalk",
  keys: [AGENT_PREWALK_AUTO_KEY],
};

/**
 * Composer next-message predictions. `composer.predictions` is the master
 * (omp 18.9.0): after a completed turn omp asks the active model to predict
 * the user's next message and ghosts it in the empty composer.
 * `composer.predictionAlternatives` (omp 18.16.0, issue #1030) asks for up to
 * four distinct candidates instead of one. Allowlisted but NOT in
 * OMP_SETTING_GROUPS: upstream lists the alternatives key only while the
 * master reads true (omp `modes/settings.ts`, condition
 * `composerPredictionsEnabled`), and the generic group loop would show both
 * rows unconditionally; ComposerPredictionSection mirrors the listing rule.
 * Both are plain booleans whose Switch renders through SettingControl. Since
 * issue #1239 they are also the gate for THIS UI: the composer-predictions
 * bridge (composer-predictions-extension.ts) reads omp's effective value at
 * request time, so an off value here never bills a native-tab prediction.
 * The alternatives' pick-list UI is still open (issue #1030): the native
 * composer renders only the first choice. RPC `predict_word` answers a single
 * `suffix` and `predict_word_feedback` carries no rank — that is the daemon's
 * word completion, a different upstream feature this bridge never touches.
 */
export const COMPOSER_PREDICTIONS_KEY = "composer.predictions";
export const COMPOSER_PREDICTION_ALTERNATIVES_KEY = "composer.predictionAlternatives";
export const COMPOSER_PREDICTION_SETTING_GROUP: OmpSettingGroup = {
  title: "Composer predictions",
  keys: [COMPOSER_PREDICTIONS_KEY, COMPOSER_PREDICTION_ALTERNATIVES_KEY],
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
      // omp 18.14 (issue #972): the planning model /prewalk restart returns to
      // (default @default) and the model or role prewalk hands off to at the
      // first edit (default @smol). Plain strings: model selector or @role.
      "prewalk.from",
      "prewalk.into",
    ],
  },
  SHARPSHOOTER_SETTING_GROUP,
  {
    title: "Providers",
    description:
      "OpenRouter’s nitro variant prioritizes throughput. Longer watchdog budgets tolerate quiet reasoning but delay recovery from a dead stream; 0 disables a watchdog. OpenAI live steering is off by default since omp 18.14: steers then wait for the next tool boundary.",
    keys: [
      "providers.openrouterVariant",
      "providers.streamFirstEventTimeoutSeconds",
      "providers.streamIdleTimeoutSeconds",
      // omp 18.14.0 (issue #971): off by default, so a steer typed while a GPT
      // response streams waits for the next tool boundary. On, omp delivers it
      // into the streaming response over the Codex WebSocket; a lane that
      // rejects it (unsupported_native_inflight_message) falls back to a turn.
      "providers.openaiLiveSteering",
      // omp 18.17.0 (issue #1063): enum low|medium|high whose default flipped
      // to low and now applies to Codex too; medium restores the answer length
      // sessions had before the flip. The options ride in from
      // `omp config list` via parseEnumOptions, so no option plumbing here.
      "textVerbosity",
      // omp 18.17.0 (issue #1068): off by default. On, catalog-supported
      // standard Responses models run over WebSockets with HTTP/SSE fallback.
      // Transport only — not openaiLiveSteering's mid-response steering above;
      // the distinction and the sessions-started-afterwards timing live in
      // OmpPage.tsx's row hint, because omp's own description cannot be
      // edited to carry them.
      "providers.openaiResponsesWebsockets",
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
    // omp 18.17.0 (issue #1069): edit dialect, including none, which removes
    // only edit and force-enables bash even when bash.enabled is off.
    // Options ride in from `omp config list` via parseEnumOptions, so older
    // binaries keep their own option set. OmpPage.tsx's row hint carries the
    // safety, degraded diff receipts, and sessions-started-afterwards caveats.
    // omp 18.19–18.22 (issue #1206) adds the todo mid-run nudge policy (enum
    // off|capped|backoff), grep's per-match context lines (the defaults
    // dropped to 0 in 18.20.1, which is why the rows exist), the selective
    // commit gate behind /commit, the disassembler backend enum
    // (auto|ghidra|ida|none), and find's verification model override plus its
    // verified-passage hit threshold (both unset = omp's built-in behavior).
    // Each is a plain scalar row; keys an older binary does not publish
    // render no row, the existing per-key skip rule.
    // omp 19.1 (issue #1275): the disassembler enum gains `binja` (Binary
    // Ninja), whose option rides in via parseEnumOptions like the others, and
    // binja.installDir points at that install — a plain string row.
    title: "Tools",
    keys: [
      "edit.mode",
      "todo.midRunNudges",
      "grep.contextBefore",
      "grep.contextAfter",
      "commit.enabled",
      "disassembler.backend",
      "binja.installDir",
      "find.verifyModel",
      "find.hitThreshold",
    ],
  },
  {
    // omp 19.1 (issue #1275): MCP servers moved into the omp daemon. On
    // (default), every omp instance shares one process per server with a
    // cached tool catalog; off keeps private per-session servers. Shared
    // servers stop after mcp.idleStopMinutes of disuse (default 5) and
    // restart on the next request. A boolean row and a number row; an older
    // binary publishes neither, so the per-key skip rule hides both.
    title: "MCP daemon",
    keys: ["mcp.shared", "mcp.idleStopMinutes"],
  },
  {
    // omp 18.20+ (issue #1206): the system prompt's rule that makes `edit`
    // mandatory for file edits and forbids sed/perl/python edits. On by
    // default; off omits the edit guidance entirely. A plain boolean row.
    title: "Prompt",
    keys: ["encourageEdits"],
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
    // omp 19.1 (issue #1275) adds pty.notify: enum on|off (default on) for the
    // "an interactive console is waiting on keyboard input" notices a bash pty
    // job raises; off silences them. Options ride in via parseEnumOptions.
    title: "Background jobs",
    keys: ["async.widgets", "pty.notify"],
  },
  {
    // omp 18.14 (issue #975): off by default. On, a task call may name each
    // item's assignment by `taskFile` (absolute path or local:// URL, ≤4 MiB)
    // instead of inline `task`; omp records the file's SHA-256 on the result.
    // omp 18.17.0 (issue #1067) adds `task.workerThreads`: it caps the worker
    // THREADS subagents fan out onto, not concurrent subagents, and 0 keeps
    // every subagent on the main thread — semantics OmpPage.tsx's row hint
    // carries verbatim, because omp's own description cannot be edited.
    title: "Subagents",
    keys: [
      "task.file",
      "task.workerThreads",
      // omp 18.20+ (issue #1206): enum off|suggest|on — the native judge
      // (resolved through the `judge` role) splits each new top-level prompt
      // into concurrent parts; suggest only reports the split, on tells the
      // agent to delegate it. Needs a native judge and the task tool;
      // without them nothing is judged. Plain enum row; options ride in via
      // parseEnumOptions.
      "task.autoParallel",
    ],
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
  ...TOOL_APPROVAL_POLICIES_SETTING_GROUP.keys,
  ...SPEND_CAP_SETTING_GROUP.keys,
  ...RESTRICTED_FOLDERS_SETTING_GROUP.keys,
  ...LIVE_VOICE_SETTING_GROUP.keys,
  ...STATUS_LINE_SETTING_GROUP.keys,
  ...COMPACTION_MODEL_THRESHOLD_SETTING_GROUP.keys,
  ...CONTEXT_FILES_SETTING_GROUP.keys,
  ...COMPOSER_PREDICTION_SETTING_GROUP.keys,
  ...UNPAUSED_PROVIDERS_SETTING_GROUP.keys,
  ...AGENT_PREWALK_AUTO_SETTING_GROUP.keys,
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
