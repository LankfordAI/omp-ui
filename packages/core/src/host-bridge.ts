// The host-tools / host-URI wire contract (issue #688, ADR-0043). Pure —
// zero imports — because renderer and desktop main share it exactly like
// browser-pane.ts: main answers host frames from the owning process, and the
// renderer keeps only the error-result fallback. The frame parsers and result
// builders live here so both sides speak the protocol off one definition that
// mirrors omp's own guards (verified against omp 18.4.3): a success tool
// result MUST carry `result.content` as an array or omp drops it as
// malformed, and a URI scheme must match `^[a-z][a-z0-9+.-]*$`.

/** The one scheme omp-ui registers. Not in omp's reserved built-in set. */
export const HOST_URI_SCHEME = "omp-ui";

/** Namespaced so a collision (which rejects the WHOLE `set_host_tools`
    command) can never fire against a built-in or extension tool. */
export const HOST_NOTIFY_TOOL_NAME = "omp-ui_notify";

/** omp's reserved built-in internal-URL schemes; never register one of these. */
export const RESERVED_HOST_URI_SCHEMES: readonly string[] = [
  "omp",
  "agent",
  "artifact",
  "memory",
  "local",
  "skill",
  "rule",
  "mcp",
  "issue",
  "pr",
  "history",
  "ssh",
  "xd",
  "vault",
];

export interface RpcHostUriSchemeDefinition {
  scheme: string;
  description?: string;
  writable?: boolean;
  immutable?: boolean;
}

export interface RpcHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
  loadMode?: "essential" | "discoverable";
}

/**
 * The `omp-ui` scheme registration: read-only, immutable virtual files.
 * Writes are omitted deliberately — a model that could overwrite e.g. the
 * plan file would break the preflight's `sourceHash` integrity gate.
 */
export function hostUriSchemeDefinition(): RpcHostUriSchemeDefinition {
  return {
    scheme: HOST_URI_SCHEME,
    description: "omp-ui app-owned virtual files (the session's current plan)",
    writable: false,
    immutable: true,
  };
}

/** Notify is always present; registered vaults enable the seven vault tools. */
export function hostToolsDefinition(opts: { vault: boolean } = { vault: false }): RpcHostToolDefinition[] {
  const tools: RpcHostToolDefinition[] = [
    {
      name: HOST_NOTIFY_TOOL_NAME,
      description:
        "Post an OS desktop notification to the user with the given message. Use sparingly: it interrupts, like an attention transition.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The notification body." },
          title: {
            type: "string",
            description: "Optional title; defaults to the session's sidebar title.",
          },
        },
        required: ["message"],
      },
    },
  ];
  if (!opts.vault) return tools;

  const vault = {
    type: "string",
    description: "Registry name of the vault. Omit to use this project's vault.",
  };
  tools.push(
    {
      name: "omp-ui_vault_search",
      loadMode: "essential",
      description:
        "Search the user's Obsidian vault by note title, body text, tags and frontmatter values. Every word must match, case-insensitive. Folder paths are not searched; use omp-ui_vault_list for those. Returns the true match count. Search before you create a note.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          vault,
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: ["query"],
      },
    },
    {
      name: "omp-ui_vault_read",
      loadMode: "essential",
      description:
        "Read one note from the user's Obsidian vault, verbatim with its frontmatter. Returns a baseHash that omp-ui_vault_edit and omp-ui_vault_link require. A bare title resolves like an Obsidian wikilink.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: 'vault-relative, ".md" optional, or a bare title' },
          vault,
        },
        required: ["path"],
      },
    },
    {
      name: "omp-ui_vault_list",
      loadMode: "essential",
      description:
        "List the notes in a vault folder and its subfolders. Defaults to the omp-ui home folder.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          folder: { type: "string", description: "vault-relative" },
          vault,
        },
        required: [],
      },
    },
    {
      name: "omp-ui_vault_create",
      loadMode: "essential",
      description:
        "Create a note in the omp-ui home folder. omp-ui files it under this project's folder, writes the provenance frontmatter, and links it from the project's index note. Give a Title Case title with no folders and a markdown body with no frontmatter and no repeated title heading. Returns the link to use for this note.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          project: {
            type: "boolean",
            default: true,
            description: "false files the note at the home-folder root with no project, as for a Day write-up",
          },
          vault,
        },
        required: ["title", "body"],
      },
    },
    {
      name: "omp-ui_vault_append",
      loadMode: "essential",
      description: "Append markdown to the end of an existing note. Frontmatter is never touched.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, text: { type: "string" }, vault },
        required: ["path", "text"],
      },
    },
    {
      name: "omp-ui_vault_edit",
      loadMode: "essential",
      description:
        "Replace the body of a note you read this session. Frontmatter is kept byte for byte. Requires the baseHash from your latest omp-ui_vault_read of that path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          baseHash: { type: "string" },
          content: { type: "string" },
          vault,
        },
        required: ["path", "baseHash", "content"],
      },
    },
    {
      name: "omp-ui_vault_link",
      loadMode: "essential",
      description:
        "Append one wikilink line to a note, typically this project's index note, pointing at another note in the same vault. The target must exist. Requires the baseHash from your latest read of the note being edited.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          to: { type: "string", description: "vault-relative path or bare title" },
          baseHash: { type: "string" },
          vault,
        },
        required: ["path", "to", "baseHash"],
      },
    },
  );
  return tools;
}

/**
 * A well-formed host URI: lowercase `scheme://resource`. omp hands over the
 * resolved `InternalUrl.href`, so parsing is textual here. Null unless the
 * url parses with a scheme matching omp's own scheme grammar.
 */
export function parseHostUrl(url: string): { scheme: string; resource: string } | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/s.exec(url);
  if (match === null) return null;
  return { scheme: match[1] as string, resource: match[2] as string };
}

// Registration commands — the capabilitiesMessage() idiom: they ride
// `initialCommands` exactly once per process, on fresh spawn and resume
// alike, and both registrations persist across session switches. Fixed ids
// so spawn tests can assert them.

export function setHostUriSchemesCommand(id = "omp-ui-host-uri-1"): object {
  return { id, type: "set_host_uri_schemes", schemes: [hostUriSchemeDefinition()] };
}

export function setHostToolsCommand(
  opts: { vault: boolean } = { vault: false },
  id = "omp-ui-host-tools-1",
): object {
  return { id, type: "set_host_tools", tools: hostToolsDefinition(opts) };
}

// Inbound frame parsers. Tolerant like every other frame parser here: only
// `type`-matched frames with a string `id` parse; argument internals stay
// `unknown` until a handler narrows them.

export interface HostToolCall {
  id: string;
  toolCallId: string | null;
  toolName: string;
  args: unknown;
}

export function parseHostToolCall(frame: unknown): HostToolCall | null {
  if (typeof frame !== "object" || frame === null) return null;
  const record = frame as Record<string, unknown>;
  if (record.type !== "host_tool_call" || typeof record.id !== "string") return null;
  return {
    id: record.id,
    toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : null,
    toolName: typeof record.toolName === "string" ? record.toolName : "",
    args: record.arguments,
  };
}

/** The pending request id omp has abandoned; the host must NOT answer it. */
export function parseHostToolCancel(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const record = frame as Record<string, unknown>;
  if (record.type !== "host_tool_cancel" || typeof record.id !== "string") return null;
  return typeof record.targetId === "string" ? record.targetId : null;
}

export interface HostUriRequest {
  id: string;
  operation: "read" | "write";
  url: string;
  content: string | undefined;
}

export function parseHostUriRequest(frame: unknown): HostUriRequest | null {
  if (typeof frame !== "object" || frame === null) return null;
  const record = frame as Record<string, unknown>;
  if (record.type !== "host_uri_request" || typeof record.id !== "string") return null;
  if (record.operation !== "read" && record.operation !== "write") return null;
  if (typeof record.url !== "string") return null;
  return {
    id: record.id,
    operation: record.operation,
    url: record.url,
    content: typeof record.content === "string" ? record.content : undefined,
  };
}

export function parseHostUriCancel(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const record = frame as Record<string, unknown>;
  if (record.type !== "host_uri_cancel" || typeof record.id !== "string") return null;
  return typeof record.targetId === "string" ? record.targetId : null;
}

// Result builders. Every tool result — success or error — carries
// `result.content` as an array: omp's `isRpcHostToolResult` guard rejects a
// success frame without it, and the error text joins into the rejection OMP
// surfaces to the model. The return type is structurally an RpcFrame without
// importing one: this module stays node-free (ADR-0002, web build).
export type HostResultFrame = {
  [key: string]: unknown;
  type: "host_tool_result" | "host_uri_result";
  id: string;
};

export type HostToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function hostToolResult(
  id: string,
  content: HostToolContent[],
  details: Record<string, unknown>,
  isError = false,
): HostResultFrame {
  return {
    type: "host_tool_result",
    id,
    ...(isError ? { isError: true } : {}),
    result: { content, details },
  };
}

export function hostToolTextResult(id: string, text: string): HostResultFrame {
  return {
    type: "host_tool_result",
    id,
    result: { content: [{ type: "text", text }] },
  };
}

export function hostToolErrorResult(id: string, text: string): HostResultFrame {
  return {
    type: "host_tool_result",
    id,
    isError: true,
    result: { content: [{ type: "text", text }] },
  };
}

export type HostUriContentType = "text/plain" | "text/markdown" | "application/json";

export function hostUriReadResult(
  id: string,
  content: string,
  contentType: HostUriContentType,
): HostResultFrame {
  return { type: "host_uri_result", id, content, contentType };
}

export function hostUriOkResult(id: string): HostResultFrame {
  return { type: "host_uri_result", id };
}

export function hostUriErrorResult(id: string, message: string): HostResultFrame {
  return { type: "host_uri_result", id, isError: true, error: message };
}
