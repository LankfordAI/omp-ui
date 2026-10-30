/**
 * MCP endpoint (issue #996, ADR-0080): the shared, pure half. omp-ui's own
 * opt-in MCP server on the remote-access listener, for outside apps and
 * agents. Types, limits, the tool catalog with its scopes, and the strict
 * parsers every side agrees on. Zero `node:` imports — the renderer imports
 * this module through the `@omp-ui/core/mcp-endpoint` subpath; token hashes
 * live in mcp-endpoint-store.ts and the HTTP protocol in @omp-ui/server.
 */

/**
 * Cumulative scopes, lowest first, mirroring the Fleet access rungs:
 * read ~ Observe, dispatch ~ Dispatch, send = dispatch plus follow-ups into
 * the sessions this client started.
 */
export const MCP_SCOPES = ["read", "dispatch", "send"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export function mcpScopeAllows(held: McpScope, need: McpScope): boolean {
  return MCP_SCOPES.indexOf(held) >= MCP_SCOPES.indexOf(need);
}

/** The URL path on the remote-access listener. */
export const MCP_PATH = "/mcp";
export const MCP_CLIENT_NAME_MAX = 80; // code points, after trim
export const MCP_RATE_MAX = 1000;
/** Session starts and sends per hour a new client starts with. */
export const MCP_DEFAULT_RATE_PER_HOUR = 6;
/** Session starts and sends per hour across every MCP client; a ceiling on agent spend. */
export const MCP_GLOBAL_PER_HOUR = 60;
/** Audit rows kept, newest last. */
export const MCP_CALL_LOG_MAX = 200;
/** Request bodies above this many bytes answer 413; a full-size prompt fits. */
export const MCP_BODY_MAX_BYTES = 1024 * 1024;
/** Client ids are 128 random bits, base64url (22 characters). */
export const MCP_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Every token starts with this, so a leaked one is recognizable to secret scanners. */
export const MCP_TOKEN_PREFIX = "ompui_mcp_";
/** MCP protocol revisions this endpoint answers, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
/** Sessions `list_sessions` returns at most, newest first. */
export const MCP_SESSION_LIST_MAX = 100;

/** Persisted client settings; only the token's SHA-256 is stored, beside it, never here. */
export interface McpClientRecord {
  id: string;
  name: string;
  scope: McpScope;
  enabled: boolean;
  /** Session starts and sends per hour; null = only the app-wide ceiling applies. */
  ratePerHour: number | null;
  createdAt: string;
}

export type McpClientInput = Omit<McpClientRecord, "id" | "createdAt">;
export type McpClientPatch = Partial<McpClientInput>;

/** The one reply that ever carries a token in the clear (create and rotate). */
export interface McpTokenReveal {
  client: McpClientRecord;
  token: string;
}

export type McpCallOutcome =
  | "ok"
  /** The tool answered with a refusal: bad arguments, not found, not yours. */
  | "refused"
  /** The tool needs a higher scope than the client holds. */
  | "forbidden"
  | "rate-limited"
  | "error";

/** One audit row. Never carries the arguments (prompts, messages) or the token. */
export interface McpCall {
  id: string;
  at: string;
  clientId: string;
  /** The client's name when the call arrived. */
  clientName: string;
  remoteAddress: string;
  tool: string;
  /** The session or project the call named, when it named one. */
  target: string | null;
  outcome: McpCallOutcome;
  /** Refusal or failure detail; for a started session, its tab. */
  message: string | null;
  durationMs: number;
}

/** Pushed on `mcp:state`; host-local, never proxied to a joined instance. */
export interface McpEndpointState {
  /** The Accept MCP clients master switch (`mcpEndpointEnabled`). */
  enabled: boolean;
  clients: McpClientRecord[];
  /** Newest last, capped at MCP_CALL_LOG_MAX. */
  calls: McpCall[];
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`);
}

export function validateMcpClientName(value: unknown): string {
  if (typeof value !== "string") throw new Error("name must be a string");
  const name = value.trim();
  if (name === "" || [...name].length > MCP_CLIENT_NAME_MAX || CONTROL_CHARS.test(name)) {
    throw new Error(`name must be 1 to ${MCP_CLIENT_NAME_MAX} characters without control characters`);
  }
  return name;
}

export function validateMcpRate(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MCP_RATE_MAX) {
    throw new Error(`rate limit must be a whole number from 1 to ${MCP_RATE_MAX}, or none`);
  }
  return value;
}

const INPUT_KEYS = ["name", "scope", "enabled", "ratePerHour"] as const;

function parseField(key: (typeof INPUT_KEYS)[number], value: unknown): unknown {
  switch (key) {
    case "name":
      return validateMcpClientName(value);
    case "scope":
      if (typeof value !== "string" || !(MCP_SCOPES as readonly string[]).includes(value)) {
        throw new Error(`scope must be ${MCP_SCOPES.join(", ")}`);
      }
      return value;
    case "enabled":
      if (typeof value !== "boolean") throw new Error("enabled must be a boolean");
      return value;
    case "ratePerHour":
      return validateMcpRate(value);
  }
}

/** Strict parse of a create request. Messages are user-facing. */
export function parseMcpClientInput(value: unknown): McpClientInput {
  const raw = objectValue(value, "MCP client");
  rejectUnknownKeys(raw, INPUT_KEYS, "MCP client");
  const out: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) out[key] = parseField(key, raw[key]);
  return out as unknown as McpClientInput;
}

/** Strict parse of an update; absent keys keep their value. */
export function parseMcpClientPatch(value: unknown): McpClientPatch {
  const raw = objectValue(value, "MCP client change");
  rejectUnknownKeys(raw, INPUT_KEYS, "MCP client change");
  const out: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    if (raw[key] !== undefined) out[key] = parseField(key, raw[key]);
  }
  return out as McpClientPatch;
}

/** Strict shape guard for a persisted record; anything else is dropped at load. */
export function isMcpClientRecord(value: unknown): value is McpClientRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !MCP_CLIENT_ID_PATTERN.test(v.id) || typeof v.createdAt !== "string") return false;
  if (Object.keys(v).some((k) => k !== "id" && k !== "createdAt" && !(INPUT_KEYS as readonly string[]).includes(k))) return false;
  try {
    for (const key of INPUT_KEYS) parseField(key, v[key]);
  } catch {
    return false;
  }
  return true;
}

// ── Tool catalog ─────────────────────────────────────────────────────────────

export type McpToolName =
  | "list_machines"
  | "list_projects"
  | "list_sessions"
  | "session_status"
  | "start_session"
  | "send_to_session";

export interface McpToolDescriptor {
  name: McpToolName;
  /** The lowest scope that may list and call it. */
  scope: McpScope;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

const MACHINE_DESC = 'A machine name from list_machines: "this computer" or a joined instance\'s nickname.';

export const MCP_TOOLS: readonly McpToolDescriptor[] = [
  {
    name: "list_machines",
    scope: "read",
    readOnly: true,
    description:
      "List the omp-ui fleet: this computer plus every joined omp-ui instance, with status, CPU and free memory, live sessions and running turns, versions, and each ready machine's projects with their repository keys.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_projects",
    scope: "read",
    readOnly: true,
    description:
      "List the projects on every ready fleet machine: machine, absolute path, repository key (host/owner/repo), and whether a model provider is ready there. Pass a path or repository key to start_session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_sessions",
    scope: "read",
    readOnly: true,
    description: `List project sessions on every fleet machine, newest first (at most ${MCP_SESSION_LIST_MAX}): session id, machine, project, title, and state (working, awaiting answer, idle, dormant). Sessions this client started are marked. Private sessions and chats are never listed.`,
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: MACHINE_DESC },
        project: { type: "string", description: "Only sessions in this project: its absolute path or repository key." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_status",
    scope: "read",
    readOnly: true,
    description:
      "Report one session's state (working, awaiting answer, idle, dormant) and its latest landed reply. Poll this to follow a session you started; a session awaiting answer waits for the user in omp-ui.",
    inputSchema: {
      type: "object",
      properties: { session: { type: "string", description: "A session id from list_sessions or start_session." } },
      required: ["session"],
      additionalProperties: false,
    },
  },
  {
    name: "start_session",
    scope: "dispatch",
    readOnly: false,
    description:
      "Start one new omp session in a project with the given prompt, running unattended. It starts in read-only Plan mode unless planMode is false; a plan ends at a plan review the user answers in omp-ui. By default it runs in a fresh worktree. Answers with the session id to pass to session_status and send_to_session.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The session's first prompt." },
        project: {
          type: "string",
          description: "An absolute project path on this computer, or a repository key (host/owner/repo) from list_projects.",
        },
        machine: { type: "string", description: `${MACHINE_DESC} Without it, this computer takes the session when it has the project, otherwise omp-ui places it.` },
        title: { type: "string", description: "Session title; derived from the prompt when absent." },
        planMode: { type: "boolean", description: "False starts the session in Build mode, able to edit files. Default true." },
        workspace: { type: "string", enum: ["worktree", "checkout"], description: "worktree (default) or the project checkout." },
      },
      required: ["prompt", "project"],
      additionalProperties: false,
    },
  },
  {
    name: "send_to_session",
    scope: "send",
    readOnly: false,
    description:
      "Send a message into a session this client started with start_session: mode queue (default) delivers it after the current turn, or starts a turn when idle; mode steer delivers it into the running turn. A session waiting for the user's answer refuses; a session that is not running resumes and receives the message first.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "A session id start_session reported." },
        message: { type: "string" },
        mode: { type: "string", enum: ["queue", "steer"] },
      },
      required: ["session", "message"],
      additionalProperties: false,
    },
  },
];

export function mcpTool(name: string): McpToolDescriptor | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

export type McpToolArguments =
  | { ok: true; tool: "list_machines" | "list_projects" }
  | { ok: true; tool: "list_sessions"; machine: string | null; project: string | null }
  | { ok: true; tool: "session_status"; session: string }
  | {
      ok: true;
      tool: "start_session";
      prompt: string;
      project: string;
      machine: string | null;
      title: string | null;
      planMode: boolean;
      workspace: "worktree" | "checkout";
    }
  | { ok: true; tool: "send_to_session"; session: string; message: string; mode: "queue" | "steer" }
  | { ok: false; reason: string };

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function optionalName(value: unknown, label: string): string | null | { error: string } {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") return { error: `${label} must be a non-empty string` };
  return value.trim();
}

/**
 * Strict shape parse of one tool call's arguments; a refusal is the
 * caller-facing reason. Content rules (prompt length, title, message size)
 * are the fleet validators', applied where the request is built.
 */
export function parseMcpToolArguments(name: McpToolName, raw: unknown): McpToolArguments {
  const args = raw === undefined || raw === null ? {} : raw;
  if (typeof args !== "object" || Array.isArray(args)) return refuse("arguments must be an object");
  const a = args as Record<string, unknown>;
  const unknownArg = (allowed: readonly string[]): { ok: false; reason: string } | null => {
    const key = Object.keys(a).find((k) => !allowed.includes(k));
    return key === undefined ? null : refuse(`unknown argument "${key}"`);
  };
  switch (name) {
    case "list_machines":
    case "list_projects":
      return unknownArg([]) ?? { ok: true, tool: name };
    case "list_sessions": {
      const bad = unknownArg(["machine", "project"]);
      if (bad !== null) return bad;
      const machine = optionalName(a.machine, "machine");
      if (machine !== null && typeof machine === "object") return refuse(machine.error);
      const project = optionalName(a.project, "project");
      if (project !== null && typeof project === "object") return refuse(project.error);
      return { ok: true, tool: name, machine, project };
    }
    case "session_status": {
      const bad = unknownArg(["session"]);
      if (bad !== null) return bad;
      if (typeof a.session !== "string" || a.session.trim() === "") return refuse("session must be a non-empty string");
      return { ok: true, tool: name, session: a.session.trim() };
    }
    case "start_session": {
      const bad = unknownArg(["prompt", "project", "machine", "title", "planMode", "workspace"]);
      if (bad !== null) return bad;
      if (typeof a.prompt !== "string" || a.prompt.trim() === "") return refuse("prompt must not be blank");
      if (typeof a.project !== "string" || a.project.trim() === "") return refuse("project must be a non-empty string");
      const machine = optionalName(a.machine, "machine");
      if (machine !== null && typeof machine === "object") return refuse(machine.error);
      if (a.title !== undefined && typeof a.title !== "string") return refuse("title must be a string");
      if (a.planMode !== undefined && typeof a.planMode !== "boolean") return refuse("planMode must be true or false");
      if (a.workspace !== undefined && a.workspace !== "worktree" && a.workspace !== "checkout") {
        return refuse("workspace must be worktree or checkout");
      }
      return {
        ok: true,
        tool: name,
        prompt: a.prompt,
        project: a.project.trim(),
        machine,
        title: typeof a.title === "string" && a.title.trim() !== "" ? a.title : null,
        planMode: a.planMode !== false,
        workspace: a.workspace === "checkout" ? "checkout" : "worktree",
      };
    }
    case "send_to_session": {
      const bad = unknownArg(["session", "message", "mode"]);
      if (bad !== null) return bad;
      if (typeof a.session !== "string" || a.session.trim() === "") return refuse("session must be a non-empty string");
      if (typeof a.message !== "string" || a.message.trim() === "") return refuse("message must not be blank");
      if (a.mode !== undefined && a.mode !== "queue" && a.mode !== "steer") return refuse("mode must be queue or steer");
      return { ok: true, tool: name, session: a.session.trim(), message: a.message, mode: a.mode === "steer" ? "steer" : "queue" };
    }
  }
}

/** `${origin}/mcp` from the listener's first pairing URL; the token query never rides along. */
export function mcpEndpointUrl(urls: readonly string[]): string | null {
  const first = urls[0];
  if (first === undefined) return null;
  return `${first.split(/[?#]/)[0]!.replace(/\/+$/, "")}${MCP_PATH}`;
}

/**
 * What Copy MCP URL puts on the clipboard: the URL, then an `mcpServers`
 * entry in the streamable-HTTP shape omp, Claude Code, and Cursor read.
 */
export function mcpClientConfig(url: string, token: string): string {
  const config = {
    mcpServers: {
      "omp-ui": { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
    },
  };
  return `${url}\n\n${JSON.stringify(config, null, 2)}\n`;
}

/** The placeholder Copy MCP URL uses once the token is no longer shown. */
export const MCP_TOKEN_PLACEHOLDER = "YOUR_TOKEN";
