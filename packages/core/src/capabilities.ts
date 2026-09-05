// The session-capabilities wire contract. Pure — zero imports — because the
// renderer imports it directly via the @omp-ui/core/capabilities subpath,
// exactly like advisor-stats.ts and mcp-status.ts. The generating half (which
// writes the extension file) lives in capabilities-extension.ts and consumes
// these same constants, so the two sides of the channel can never drift.

/**
 * `setStatus` key carrying the JSON capability snapshot. Routed, never
 * rendered raw. A snapshot describes the root live session's loaded skills and
 * complete registered tool roster; MCP configuration is resolved separately by
 * omp-ui's own config reader.
 */
export const CAPABILITIES_STATUS_KEY = "omp-ui:capabilities";

/** Hidden slash command the spawner sends to bind and arm the bridge. */
export const CAPABILITIES_COMMAND = "omp-ui-capabilities";

/** Per-description cap on the wire; the rest stays in the session's memory. */
export const CAPABILITY_DESCRIPTION_LIMIT = 2_048;

/**
 * Hard cap on the serialized snapshot (UTF-8 bytes). The publisher replaces an
 * over-budget roster with a `payload-too-large` unavailable snapshot rather
 * than emitting a partial inventory; the parser rejects anything over it.
 */
export const CAPABILITY_STATUS_BYTE_LIMIT = 256 * 1024;

export type CapabilitySectionId = "mcp" | "skills" | "tools";

/** Why a section could not be observed. Never confused with an empty roster. */
export type CapabilityReason =
  | "missing-api"
  | "read-failed"
  | "payload-too-large";

export type CapabilitySection<T> =
  | { status: "available"; items: T[] }
  | { status: "unavailable"; reason: CapabilityReason };

export interface CapabilitySkill {
  name: string;
  description: string;
  /** True when `description` was cut at {@link CAPABILITY_DESCRIPTION_LIMIT}. */
  descriptionTruncated: boolean;
  /** SKILL.md path; kept verbatim as identity, control chars are display-only. */
  filePath: string;
  /** Raw source label, or null when unrecognized. */
  source: string | null;
  /** Recognized discovery scope only; synthesized/temporary scopes are null. */
  scope: "user" | "project" | null;
  /** hide metadata; null when the field is absent. Hidden ≠ not loaded. */
  hidden: boolean | null;
}

export interface CapabilityTool {
  name: string;
  description: string;
  descriptionTruncated: boolean;
  source: "builtin" | "extension" | "mcp" | "sdk" | "unknown";
  /** Source path only when OMP reports an actual identity, else null. */
  sourcePath: string | null;
  /** Membership in the enabled-name set; null when that API is missing. */
  enabled: boolean | null;
  /** Membership in the model-directly-exposed set; null when unknown. */
  direct: boolean | null;
  /** Mounted as an `xd://` device; null when that API is missing. */
  xdev: boolean | null;
  /** Reachable through the Eval bridge; null when that API is missing. */
  evalBridge: boolean | null;
  /** Exact MCP ownership from tool metadata; null when unknown. */
  mcpServerName: string | null;
  mcpToolName: string | null;
}

export interface CapabilitySnapshot {
  version: 1;
  /** Per-process identity; a new key replaces the predecessor's inventory. */
  processKey: string;
  /** Root session id at sample time; null while unobserved. */
  sessionId: string | null;
  /** Strictly increasing per published replacement. */
  revision: number;
  /** Last published change (not a heartbeat). */
  updatedAt: number;
  ompVersion: string | null;
  /** `skillsSettings.enableSkillCommands`; null when unreadable. */
  skillCommandsEnabled: boolean | null;
  skills: CapabilitySection<CapabilitySkill>;
  tools: CapabilitySection<CapabilityTool>;
}

export type SessionCapabilitiesResult =
  | { status: "available"; snapshot: CapabilitySnapshot }
  | { status: "starting" | "bridge-unavailable" | "terminal" | "not-live" | "missing-session" };

/**
 * Parses the JSON published on {@link CAPABILITIES_STATUS_KEY}. Builds a
 * freshly constructed allowlist DTO — unknown fields never enter the result.
 * Any malformed member rejects the snapshot as a whole (null), so bad data can
 * never surface as an empty successful inventory.
 */
export function parseCapabilitySnapshot(text: string | undefined): CapabilitySnapshot | null {
  if (!text) return null;
  if (utf8Length(text) > CAPABILITY_STATUS_BYTE_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.processKey !== "string" || record.processKey.length === 0) return null;
  if (record.sessionId !== null && typeof record.sessionId !== "string") return null;
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision <= 0) return null;
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) return null;
  if (record.ompVersion !== null && typeof record.ompVersion !== "string") return null;
  const skillCommandsEnabled = nullableBoolean(record.skillCommandsEnabled);
  if (skillCommandsEnabled === INVALID) return null;
  const skills = parseSection(record.skills, parseSkill);
  if (skills === INVALID) return null;
  const tools = parseSection(record.tools, parseTool);
  if (tools === INVALID) return null;
  if (tools.status === "available") {
    const names = new Set<string>();
    for (const tool of tools.items) {
      if (names.has(tool.name)) return null;
      names.add(tool.name);
    }
  }
  return {
    version: 1,
    processKey: record.processKey,
    sessionId: (record.sessionId as string | null) ?? null,
    revision: record.revision,
    updatedAt: record.updatedAt,
    ompVersion: (record.ompVersion as string | null) ?? null,
    skillCommandsEnabled,
    skills,
    tools,
  };
}

/** Hidden slash command that arms the bridge and binds its UI context. */
export function capabilitiesMessage(): string {
  return `/${CAPABILITIES_COMMAND}`;
}

const INVALID = Symbol("invalid");

function parseSection<T>(
  value: unknown,
  parseItem: (record: Record<string, unknown>) => T | typeof INVALID,
): CapabilitySection<T> | typeof INVALID {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return INVALID;
  const record = value as Record<string, unknown>;
  if (record.status === "unavailable") {
    const reason = record.reason;
    if (reason !== "missing-api" && reason !== "read-failed" && reason !== "payload-too-large") return INVALID;
    return { status: "unavailable", reason };
  }
  if (record.status !== "available" || !Array.isArray(record.items)) return INVALID;
  const items: T[] = [];
  for (const raw of record.items) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return INVALID;
    const item = parseItem(raw as Record<string, unknown>);
    if (item === INVALID) return INVALID;
    items.push(item);
  }
  return { status: "available", items };
}

function parseSkill(record: Record<string, unknown>): CapabilitySkill | typeof INVALID {
  if (typeof record.name !== "string" || record.name.length === 0) return INVALID;
  const description = parseDescription(record);
  if (description === INVALID) return INVALID;
  if (typeof record.filePath !== "string") return INVALID;
  if (record.source !== null && typeof record.source !== "string") return INVALID;
  const scope = record.scope;
  if (scope !== null && scope !== "user" && scope !== "project") return INVALID;
  const hidden = nullableBoolean(record.hidden);
  if (hidden === INVALID) return INVALID;
  return {
    name: record.name,
    description: description.text,
    descriptionTruncated: description.truncated,
    filePath: record.filePath,
    source: (record.source as string | null) ?? null,
    scope: scope as "user" | "project" | null,
    hidden,
  };
}

function parseTool(record: Record<string, unknown>): CapabilityTool | typeof INVALID {
  if (typeof record.name !== "string" || record.name.length === 0) return INVALID;
  const description = parseDescription(record);
  if (description === INVALID) return INVALID;
  const source = record.source;
  if (
    source !== "builtin" && source !== "extension" && source !== "mcp" &&
    source !== "sdk" && source !== "unknown"
  ) return INVALID;
  if (record.sourcePath !== null && typeof record.sourcePath !== "string") return INVALID;
  const enabled = nullableBoolean(record.enabled);
  if (enabled === INVALID) return INVALID;
  const direct = nullableBoolean(record.direct);
  if (direct === INVALID) return INVALID;
  const xdev = nullableBoolean(record.xdev);
  if (xdev === INVALID) return INVALID;
  const evalBridge = nullableBoolean(record.evalBridge);
  if (evalBridge === INVALID) return INVALID;
  if (record.mcpServerName !== null && typeof record.mcpServerName !== "string") return INVALID;
  if (record.mcpToolName !== null && typeof record.mcpToolName !== "string") return INVALID;
  return {
    name: record.name,
    description: description.text,
    descriptionTruncated: description.truncated,
    source,
    sourcePath: (record.sourcePath as string | null) ?? null,
    enabled,
    direct,
    xdev,
    evalBridge,
    mcpServerName: (record.mcpServerName as string | null) ?? null,
    mcpToolName: (record.mcpToolName as string | null) ?? null,
  };
}

function parseDescription(
  record: Record<string, unknown>,
): { text: string; truncated: boolean } | typeof INVALID {
  if (typeof record.description !== "string") return INVALID;
  if (record.descriptionTruncated !== true && record.descriptionTruncated !== false) return INVALID;
  // The publisher slices to exactly the cap when truncating, and never exceeds
  // it otherwise; either violation is a malformed frame, not a display choice.
  if (record.description.length > CAPABILITY_DESCRIPTION_LIMIT) return INVALID;
  const truncated = record.descriptionTruncated === true;
  if (truncated && record.description.length !== CAPABILITY_DESCRIPTION_LIMIT) return INVALID;
  return { text: record.description, truncated };
}

function nullableBoolean(value: unknown): boolean | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (value === true || value === false) return value;
  return INVALID;
}

/** UTF-8 byte length without runtime imports (pure scan, no allocation). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xdc00 && code < 0xe000) bytes += 0; // trail surrogate
    else if (code >= 0xd800 && code < 0xdc00) { bytes += 4; i++; } // lead surrogate
    else bytes += 3;
  }
  return bytes;
}
