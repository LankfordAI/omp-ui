/**
 * Typed views over the omp `--mode=rpc-ui` payloads the UI actually renders.
 *
 * The parsers below are total: every protocol payload is `unknown`, and a
 * missing or wrong-typed field degrades to `null` / `0` / `[]` rather than
 * throwing. A renderer must never crash because omp added or dropped a key.
 */
import { arrField, boolField, field, numField, strField } from "./fields";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  thinking?: { mode?: string; efforts?: string[] } | null;
  supportsComputerUse?: boolean;
  /** Service tiers omp advertises for this row (e.g. `["priority"]`,
   *  `["priority","ultrafast"]`). Catalog truth; absent on rows omp sends
   *  no tiers for (issue #719). */
  serviceTiers?: string[];
}

/** Providers whose models reach a priority-serving tier the session setting
 *  controls (issue #689). Arm 1 of the composer's fast-mode visibility gate. */
const FAST_MODE_FAMILY_PROVIDERS: Record<string, true> = { openai: true, "openai-codex": true };
const FAST_MODE_FAMILY_APIS: Record<string, true> = { "anthropic-messages": true };
/** Providers excluded even when the row carries a family `api` value:
 *  Fireworks' tier is provider-scoped — `active` would misreport what the
 *  session toggle controls — and Copilot has no session tier at all. */
const FAST_MODE_UNCONTROLLABLE_PROVIDERS: Record<string, true> = {
  fireworks: true,
  "github-copilot": true,
};

/** OpenRouter id prefixes whose bundled catalog row is OpenAI- or Gemini-class —
 *  the two families omp's OpenRouter transport can carry a priority tier on
 *  (its family resolver reads `identity.class`, which no frame carries; the
 *  catalog's class agrees with the slug prefix for every OpenRouter row).
 *  `anthropic/…` is deliberately absent: the Anthropic priority tier is ignored
 *  via OpenRouter — fast Anthropic serving there is the separate 2x `-fast`
 *  sibling slug, a model switch, not this toggle — so the pill would sit
 *  permanently declined. `google/gemma…` / `google/veo…` are not Gemini-class. */
const FAST_MODE_OPENROUTER_PREFIXES = ["openai/", "google/gemini"] as const;
/** omp's thinking suffix, as in `modelRoles` selectors; OpenRouter also uses
 *  colons for routing (`:exacto`), so only a known level tail is a level. */
const LEVEL_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max|auto)$/;

function openRouterFastCapable(id: string): boolean {
  const slug = (id.endsWith("-") ? id.slice(0, -1) : id).replace(LEVEL_SUFFIX, "");
  // `~slug` catalog aliases (e.g. `~google/gemini-flash-latest`) route like their base row.
  const base = slug.startsWith("~") ? slug.slice(1) : slug;
  return FAST_MODE_OPENROUTER_PREFIXES.some((prefix) => base.startsWith(prefix));
}

/** Whether fast mode is plausibly controllable for this model. Not a truth
 *  source — omp resolves support per model; rows it can't decide ride arm 2
 *  of the gate (live state), and a wrong yes is caught by the set_fast_mode
 *  refusal path. A null model (not yet resolved) is no. */
export function modelSupportsFastMode(model: ModelInfo | null): boolean {
  if (model === null) return false;
  // Wire strings index these tables, so compare against `true` rather than
  // the value: `model.api === "constructor"` must not read as support.
  if (FAST_MODE_UNCONTROLLABLE_PROVIDERS[model.provider] === true) return false;
  if (model.provider === "openrouter") return openRouterFastCapable(model.id);
  return (
    FAST_MODE_FAMILY_PROVIDERS[model.provider] === true ||
    FAST_MODE_FAMILY_APIS[model.api ?? ""] === true
  );
}
/** The tier the fast control may offer for this row (issue #719):
 *  "ultrafast" when the catalog row advertises the tier, else "priority"
 *  wherever the existing binary gate says the family has a controllable
 *  tier, else null (no control at all — today's hidden-pill case).
 *  serviceTiers is catalog truth; modelSupportsFastMode stays the
 *  family/wire arm for rows that carry no tiers. */
export function modelFastTier(model: ModelInfo | null): "ultrafast" | "priority" | null {
  if (model === null) return null;
  if (model.serviceTiers?.includes("ultrafast") === true) return "ultrafast";
  return modelSupportsFastMode(model) ? "priority" : null;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  aliases?: string[];
  input?: { hint?: string };
  subcommands?: { name: string; description: string; usage?: string }[];
  source?: string;
}

export interface TodoTask {
  content: string;
  status: string;
}

export interface TodoPhase {
  phase?: string;
  tasks: TodoTask[];
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

/** omp's displayable queue-chip text (`queue_update` / get_state `queuedMessages`, omp ≥ 18.4.4). */
export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

/** omp 18.6.3+ (upstream #14153) usage-limit stages: the account is past its
 *  usage limit and serving is degraded until the window resets. */
export type UsageLimitStage = "low_priority" | "wrap_up";

export interface UsageLimit {
  stage: UsageLimitStage;
  /** Epoch ms of the window reset; null when omp reports no reset time. */
  resetsAtMs: number | null;
  /** low_priority only: remaining allowance, clamped 0–100. */
  allowanceLeftPercent?: number;
  /** wrap_up only: whether extra usage is enabled on the account. */
  extraUsage?: boolean;
}

export interface SessionRuntime {
  thinkingLevel: string | null;
  /** omp's automatic-thinking selector, `"auto"` or null. The selector the
  *  user configured; `thinkingLevel` always carries the current RESOLVED
  *  level. Frame- and seed-owned: get_state has no configured field, so
  *  parseSessionRuntime can only keep the previous value. */
  thinkingConfigured: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string | null;
  followUpMode: string | null;
  interruptMode: string | null;
  autoCompactionEnabled: boolean;
  /** omp's fast-mode SETTING (the /fast toggle). Frame- and get_state-owned;
  *  no record seed — get_state reports it directly at boot. */
  fastModeEnabled: boolean;
  /** Whether priority serving is ACTUALLY live: provider rejection can leave
  *  this false while fastModeEnabled is true; Fireworks' provider tier can
  *  leave it true while fastModeEnabled is false. Never derive one from the
  *  other; display reads this, the switch reads the setting. */
  fastModeActive: boolean;
  /** omp 18.6.3+ (upstream #14153): whether `/slow` applies to the active
   *  model. Non-optional on any capable runtime; older omp never emits the
   *  key, so the emptyRuntime default of false is also the pre-gate truth. */
  slowModeSupported: boolean;
  /** Whether `/slow` is on for the active model; always false when
   *  unsupported. get_state-owned — omp emits no slow-mode event. */
  slowModeEnabled: boolean;
  /** Where a true `slowModeEnabled` lives: `global` is omp's persisted
   *  config (providers.anthropic.slowMode) shared by every session,
   *  `session` is this session's flex tier. Null on unsupported runtimes. */
  slowModeScope: "session" | "global" | null;
  /** The account is past its usage limit; null outside a stage. Absent from
   *  a FULL state report once the stage clears — applyRpcState reads that
   *  absence as clear; partial frames keep the previous value. */
  usageLimit: UsageLimit | null;
  sessionId: string | null;
  sessionFile: string | null;
  messageCount: number;
  queuedMessageCount: number;
  /** Queue-chip text per queue; null until a runtime has reported it (older omp never does). */
  queuedMessages: QueuedMessages | null;
  contextUsage: ContextUsage | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: TokenTotals;
  cost: number;
  premiumRequests: number;
  contextUsage: ContextUsage | null;
}

export interface SubagentInfo {
  id: string;
  name?: string;
  agent?: string;
  status?: string;
  label?: string;
  /** omp 18.4.11+: the agent's own completion estimate, 0–100, while running. */
  completionPercent?: number;
}

/**
 * Where a dispatched prompt came from. `advisor_reply` is omp-ui's own answer to
 * a late advisor review and `stall_continue` its continue after a stalled turn:
 * both ride `followUp` like a queued prompt, but they never title the session
 * and never re-arm their loop guard — an auto-prompt is not human direction.
 */
export type PromptRoute =
  | "prompt"
  | "steer"
  | "follow_up"
  | "advisor_reply"
  | "stall_continue";

/** A never-loaded session: every field neutral, nothing pretending to be known. */
export function emptySessionRuntime(): SessionRuntime {
  return {
    thinkingLevel: null,
    thinkingConfigured: null,
    isStreaming: false,
    isCompacting: false,
    steeringMode: null,
    followUpMode: null,
    interruptMode: null,
    autoCompactionEnabled: false,
    fastModeEnabled: false,
    fastModeActive: false,
    slowModeSupported: false,
    slowModeEnabled: false,
    slowModeScope: null,
    usageLimit: null,
    sessionId: null,
    sessionFile: null,
    messageCount: 0,
    queuedMessageCount: 0,
    queuedMessages: null,
    contextUsage: null,
  };
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Both the `queue_update` frame and get_state's `queuedMessages` share this shape; anything else is unknown. */
export function parseQueuedMessages(value: unknown): QueuedMessages | null {
  const steering = field(value, "steering");
  const followUp = field(value, "followUp");
  if (!Array.isArray(steering) || !Array.isArray(followUp)) return null;
  return { steering: strList(steering), followUp: strList(followUp) };
}

export function parseContextUsage(value: unknown): ContextUsage | null {
  if (value === null || typeof value !== "object") return null;
  return {
    tokens: numField(value, "tokens") ?? 0,
    contextWindow: numField(value, "contextWindow") ?? 0,
    percent: numField(value, "percent") ?? 0,
  };
}

/** get_state's `usageLimit`: anything without an exact stage word is no stage.
 *  `resetsAtSec` (epoch seconds) becomes `resetsAtMs` here so the HUD's
 *  reset-time formatting keeps one home (`toLocaleString(localeTag())`). */
export function parseUsageLimit(value: unknown): UsageLimit | null {
  if (value === null || typeof value !== "object") return null;
  const stage = strField(value, "stage");
  if (stage !== "low_priority" && stage !== "wrap_up") return null;
  const resetsAtSec = numField(value, "resetsAtSec");
  const percent = numField(value, "allowanceLeftPercent");
  const extraUsage = boolField(value, "extraUsage");
  return {
    stage,
    resetsAtMs: resetsAtSec !== undefined && Number.isFinite(resetsAtSec) ? resetsAtSec * 1000 : null,
    ...(percent !== undefined && Number.isFinite(percent)
      ? { allowanceLeftPercent: Math.min(100, Math.max(0, percent)) }
      : {}),
    ...(extraUsage !== undefined ? { extraUsage } : {}),
  };
}

export function parseModelInfo(value: unknown): ModelInfo | null {
  const id = strField(value, "id");
  if (id === undefined) return null;
  const costRaw = field(value, "cost");
  const cost =
    costRaw !== null && typeof costRaw === "object"
      ? {
          input: numField(costRaw, "input"),
          output: numField(costRaw, "output"),
          cacheRead: numField(costRaw, "cacheRead"),
          cacheWrite: numField(costRaw, "cacheWrite"),
        }
      : undefined;
  const thinkingRaw = field(value, "thinking");
  const thinking =
    thinkingRaw !== null && typeof thinkingRaw === "object"
      ? { mode: strField(thinkingRaw, "mode"), efforts: strList(field(thinkingRaw, "efforts")) }
      : null;
  const serviceTiers = strList(field(value, "serviceTiers"));
  return {
    id,
    // omp always sends `name`, but a bare id beats rendering "undefined".
    name: strField(value, "name") ?? id,
    provider: strField(value, "provider") ?? "",
    api: strField(value, "api"),
    reasoning: boolField(value, "reasoning"),
    input: strList(field(value, "input")),
    cost,
    contextWindow: numField(value, "contextWindow"),
    maxTokens: numField(value, "maxTokens"),
    thinking,
    supportsComputerUse: boolField(value, "supportsComputerUse"),
    // Mirror parseCommandList's empty-`aliases` omission: a row without
    // tiers stays byte-identical to a pre-#719 parse.
    serviceTiers: serviceTiers.length > 0 ? serviceTiers : undefined,
  };
}

/** `get_available_models.data.models` — 414 entries, so unparseable rows drop silently. */
export function parseModelList(value: unknown): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const raw of arrField(value, "models")) {
    const model = parseModelInfo(raw);
    if (model) models.push(model);
  }
  return models;
}

/** Accepts both `get_available_commands.data` and the `available_commands_update` frame. */
export function parseCommandList(value: unknown): SlashCommandInfo[] {
  const commands: SlashCommandInfo[] = [];
  for (const raw of arrField(value, "commands")) {
    const name = strField(raw, "name");
    if (name === undefined) continue;
    const aliases = strList(field(raw, "aliases"));
    const inputRaw = field(raw, "input");
    const subcommands = arrField(raw, "subcommands").flatMap((sub) => {
      const subName = strField(sub, "name");
      if (subName === undefined) return [];
      return [
        {
          name: subName,
          description: strField(sub, "description") ?? "",
          usage: strField(sub, "usage"),
        },
      ];
    });
    commands.push({
      name,
      description: strField(raw, "description") ?? "",
      aliases: aliases.length > 0 ? aliases : undefined,
      input:
        inputRaw !== null && typeof inputRaw === "object"
          ? { hint: strField(inputRaw, "hint") }
          : undefined,
      subcommands: subcommands.length > 0 ? subcommands : undefined,
      source: strField(raw, "source"),
    });
  }
  return commands;
}

/**
 * Phases carry **`tasks`**, not `items` — a legacy `items` payload parses to a
 * phase with no tasks rather than silently rendering the wrong key.
 */
export function parseTodoPhases(value: unknown): TodoPhase[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => ({
    phase: strField(raw, "phase"),
    tasks: arrField(raw, "tasks").flatMap((task) => {
      const content = strField(task, "content");
      if (content === undefined) return [];
      return [{ content, status: strField(task, "status") ?? "pending" }];
    }),
  }));
}

/** `slowModeScope` carries exactly one of the two literals on a capable runtime;
 * anything else (older omp, a lying frame) keeps the previous value. */
function slowModeScopeField(value: unknown): "session" | "global" | undefined {
  const scope = strField(value, "slowModeScope");
  return scope === "session" || scope === "global" ? scope : undefined;
}

/** `get_state.data` → the subset the UI renders; `systemPrompt`/`dumpTools` are dropped. */
export function parseSessionRuntime(value: unknown, previous: SessionRuntime): SessionRuntime {
  if (value === null || typeof value !== "object") return previous;
  // Partial frames (session_info_update, config_update) omit most keys — an
  // absent key keeps the previous value instead of resetting the HUD.
  return {
    thinkingLevel: strField(value, "thinkingLevel") ?? previous.thinkingLevel,
    // get_state reports only the resolved level (no `configured` field), so
    // the selector is owned by frames and the record seed — never here.
    thinkingConfigured: previous.thinkingConfigured,
    isStreaming: boolField(value, "isStreaming") ?? previous.isStreaming,
    isCompacting: boolField(value, "isCompacting") ?? previous.isCompacting,
    steeringMode: strField(value, "steeringMode") ?? previous.steeringMode,
    followUpMode: strField(value, "followUpMode") ?? previous.followUpMode,
    interruptMode: strField(value, "interruptMode") ?? previous.interruptMode,
    autoCompactionEnabled:
      boolField(value, "autoCompactionEnabled") ?? previous.autoCompactionEnabled,
    fastModeEnabled: boolField(value, "fastModeEnabled") ?? previous.fastModeEnabled,
    fastModeActive: boolField(value, "fastModeActive") ?? previous.fastModeActive,
    slowModeSupported: boolField(value, "slowModeSupported") ?? previous.slowModeSupported,
    slowModeEnabled: boolField(value, "slowModeEnabled") ?? previous.slowModeEnabled,
    slowModeScope: slowModeScopeField(value) ?? previous.slowModeScope,
    // Presence of the key matters: an explicit `usageLimit: null` clears the
    // stage, while a partial frame that omits the key keeps it.
    usageLimit: Object.hasOwn(value, "usageLimit")
      ? parseUsageLimit(field(value, "usageLimit"))
      : previous.usageLimit,
    sessionId: strField(value, "sessionId") ?? previous.sessionId,
    sessionFile: strField(value, "sessionFile") ?? previous.sessionFile,
    messageCount: numField(value, "messageCount") ?? previous.messageCount,
    queuedMessageCount: numField(value, "queuedMessageCount") ?? previous.queuedMessageCount,
    queuedMessages: parseQueuedMessages(field(value, "queuedMessages")) ?? previous.queuedMessages,
    contextUsage: parseContextUsage(field(value, "contextUsage")) ?? previous.contextUsage,
  };
}

export function parseSessionStats(value: unknown): SessionStats | null {
  if (value === null || typeof value !== "object") return null;
  const tokens = field(value, "tokens");
  return {
    userMessages: numField(value, "userMessages") ?? 0,
    assistantMessages: numField(value, "assistantMessages") ?? 0,
    toolCalls: numField(value, "toolCalls") ?? 0,
    toolResults: numField(value, "toolResults") ?? 0,
    totalMessages: numField(value, "totalMessages") ?? 0,
    tokens: {
      input: numField(tokens, "input") ?? 0,
      output: numField(tokens, "output") ?? 0,
      reasoning: numField(tokens, "reasoning") ?? 0,
      cacheRead: numField(tokens, "cacheRead") ?? 0,
      cacheWrite: numField(tokens, "cacheWrite") ?? 0,
      total: numField(tokens, "total") ?? 0,
    },
    cost: numField(value, "cost") ?? 0,
    premiumRequests: numField(value, "premiumRequests") ?? 0,
    contextUsage: parseContextUsage(field(value, "contextUsage")),
  };
}

/** `get_subagents.data.subagents` — snapshots keyed by id; `description` is the label. */
export function parseSubagents(value: unknown): SubagentInfo[] {
  const subagents: SubagentInfo[] = [];
  for (const raw of arrField(value, "subagents")) {
    const id = strField(raw, "id");
    if (id === undefined) continue;
    const progress = field(raw, "progress");
    const percent = numField(raw, "completionPercent") ?? numField(progress, "completionPercent");
    subagents.push({
      id,
      name: strField(raw, "name"),
      agent: strField(raw, "agent"),
      status: strField(raw, "status") ?? strField(progress, "status"),
      label: strField(raw, "description") ?? strField(raw, "task"),
      completionPercent:
        percent !== undefined && Number.isFinite(percent)
          ? Math.min(100, Math.max(0, percent))
          : undefined,
    });
  }
  return subagents;
}
