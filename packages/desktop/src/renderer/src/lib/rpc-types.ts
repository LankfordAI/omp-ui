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

export interface SessionRuntime {
  thinkingLevel: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string | null;
  followUpMode: string | null;
  interruptMode: string | null;
  autoCompactionEnabled: boolean;
  sessionId: string | null;
  sessionFile: string | null;
  messageCount: number;
  queuedMessageCount: number;
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
}

/**
 * Where a dispatched prompt came from. `advisor_reply` is omp-ui's own answer to
 * a late advisor review: it rides `followUp` like a queued prompt, but it never
 * titles the session and never resets the auto-reply loop guard.
 */
export type PromptRoute = "prompt" | "steer" | "follow_up" | "advisor_reply";

/** A never-loaded session: every field neutral, nothing pretending to be known. */
export function emptySessionRuntime(): SessionRuntime {
  return {
    thinkingLevel: null,
    isStreaming: false,
    isCompacting: false,
    steeringMode: null,
    followUpMode: null,
    interruptMode: null,
    autoCompactionEnabled: false,
    sessionId: null,
    sessionFile: null,
    messageCount: 0,
    queuedMessageCount: 0,
    contextUsage: null,
  };
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parseContextUsage(value: unknown): ContextUsage | null {
  if (value === null || typeof value !== "object") return null;
  return {
    tokens: numField(value, "tokens") ?? 0,
    contextWindow: numField(value, "contextWindow") ?? 0,
    percent: numField(value, "percent") ?? 0,
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

/** `get_state.data` → the subset the UI renders; `systemPrompt`/`dumpTools` are dropped. */
export function parseSessionRuntime(value: unknown, previous: SessionRuntime): SessionRuntime {
  if (value === null || typeof value !== "object") return previous;
  // Partial frames (session_info_update, config_update) omit most keys — an
  // absent key keeps the previous value instead of resetting the HUD.
  return {
    thinkingLevel: strField(value, "thinkingLevel") ?? previous.thinkingLevel,
    isStreaming: boolField(value, "isStreaming") ?? previous.isStreaming,
    isCompacting: boolField(value, "isCompacting") ?? previous.isCompacting,
    steeringMode: strField(value, "steeringMode") ?? previous.steeringMode,
    followUpMode: strField(value, "followUpMode") ?? previous.followUpMode,
    interruptMode: strField(value, "interruptMode") ?? previous.interruptMode,
    autoCompactionEnabled:
      boolField(value, "autoCompactionEnabled") ?? previous.autoCompactionEnabled,
    sessionId: strField(value, "sessionId") ?? previous.sessionId,
    sessionFile: strField(value, "sessionFile") ?? previous.sessionFile,
    messageCount: numField(value, "messageCount") ?? previous.messageCount,
    queuedMessageCount: numField(value, "queuedMessageCount") ?? previous.queuedMessageCount,
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
    subagents.push({
      id,
      name: strField(raw, "name"),
      agent: strField(raw, "agent"),
      status: strField(raw, "status") ?? strField(field(raw, "progress"), "status"),
      label: strField(raw, "description") ?? strField(raw, "task"),
    });
  }
  return subagents;
}
