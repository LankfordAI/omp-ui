// The host-tools / host-URI wire contract (issue #688, ADR-0043). Pure —
// no `node:` imports, only the pure fleet constants — because renderer and desktop main share it exactly like
// browser-pane.ts: main answers host frames from the owning process, and the
// renderer keeps only the error-result fallback. The frame parsers and result
// builders live here so both sides speak the protocol off one definition that
// mirrors omp's own guards (verified against omp 18.4.3): a success tool
// result MUST carry `result.content` as an array or omp drops it as
// malformed, and a URI scheme must match `^[a-z][a-z0-9+.-]*$`.

import { FLEET_BATCH_MAX, FLEET_COMMAND_MAX, FLEET_DETACHED_EXEC_TIMEOUT_MS, FLEET_EXEC_POLL_WAIT_MAX_MS, FLEET_TOOLS } from "./fleet";

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
    description: "omp-ui app-owned virtual files: the session's current plan (omp-ui://plan) and the day's session index (omp-ui://sessions)",
    writable: false,
    immutable: true,
  };
}

/** Notify is always present; registered vaults enable the seven vault tools; the fleet setting enables the three fleet tools. */
export function hostToolsDefinition(
  opts: { vault: boolean; fleet: boolean } = { vault: false, fleet: false },
): RpcHostToolDefinition[] {
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
  if (opts.vault) tools.push(...vaultTools());
  if (opts.fleet) tools.push(...fleetTools());
  return tools;
}

function vaultTools(): RpcHostToolDefinition[] {
  const vault = {
    type: "string",
    description: "Registry name of the vault. Omit to use this project's vault.",
  };
  return [
    {
      name: "omp-ui_vault_search",
      loadMode: "essential",
      description:
        "Search the user's Obsidian vault by note title, body text, tags and frontmatter values. Every word must match, case-insensitive. Folder paths are not searched; use omp-ui_vault_list for those. Returns the true match count and ready-to-use Markdown Reply links that open the exact notes in Obsidian. Search before you create a note.",
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
        "Read one note from the user's Obsidian vault, verbatim with its frontmatter. Returns a ready-to-use Markdown Reply link for the exact note and a baseHash that omp-ui_vault_edit and omp-ui_vault_link require. A bare title resolves like an Obsidian wikilink.",
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
        "List the notes in a vault folder and its subfolders, with ready-to-use Markdown Reply links for the exact notes. Defaults to the omp-ui home folder.",
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
        "Create a note in the omp-ui home folder. omp-ui files it under this project's folder, writes the provenance frontmatter, and links it from the project's index note. Give a Title Case title with no folders and a markdown body with no frontmatter and no repeated title heading. Returns a ready-to-use Markdown Reply link for the exact note and a Wikilink to use inside vault notes.",
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
  ];
}

/**
 * The fleet dispatch tools (issue #899, ADR-0061). Registered only while the
 * user turned on "Let agents dispatch fleet work" and the session was not
 * itself agent-dispatched. A remote-owned session answers from its own
 * host's fleet; omp's host-tool approval tier governs each call.
 */
function fleetTools(): RpcHostToolDefinition[] {
  const [machines, dispatch, status, exec, project, execPoll, update] = FLEET_TOOLS;
  return [
    {
      name: machines,
      loadMode: "essential",
      description:
        "List the omp-ui fleet: this computer plus every joined omp-ui instance, with status, CPU and free memory, live sessions and running turns, placement preference, and your access rung on each member. Each member also gets an ssh line (the user@address to reach it with your own ssh, where the address is the host this app joined it at and omp-ui holds no SSH keys; whether its port 22 answered; its platform; the project roots it accepts checkouts under) and a system line: its OS and the package managers found on it, with a manager not on the member's PATH listed with its absolute path. Then each ready machine's projects and repository keys. Use the names and keys with omp-ui_fleet_dispatch.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: dispatch,
      loadMode: "essential",
      description:
        "Start new build-mode omp sessions on fleet machines, each running the given prompt unattended on the named machine, in a fresh worktree by default. Without machines, omp-ui places the work automatically on the least-loaded machines with the same repository. Returns a batch id and one line per started session. Dispatching is not idempotent: poll progress with omp-ui_fleet_status instead of dispatching again.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The first prompt each dispatched session runs." },
          title: { type: "string", description: "Session title; defaults to the prompt's first line." },
          project: {
            type: "string",
            description: "An absolute path of a project registered on this computer, or a repository key (host/owner/repo) from omp-ui_fleet_machines.",
          },
          machines: {
            type: "array",
            items: { type: "string" },
            description: 'Machine nicknames, or "this computer". Omit for automatic placement.',
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: FLEET_BATCH_MAX,
            description: "Copies for automatic placement, one per machine. Default 1.",
          },
          workspace: {
            type: "string",
            enum: ["worktree", "checkout"],
            description: "worktree (default) starts each session in a new git worktree; checkout uses the project checkout itself.",
          },
        },
        required: ["prompt", "project"],
        additionalProperties: false,
      },
    },
    {
      name: status,
      loadMode: "essential",
      description:
        "Report on fleet sessions from one dispatch: machine, title, state (working, awaiting answer, idle, dormant), and the session summary once it is not working. Give exactly one of batchId or dispatchId from omp-ui_fleet_dispatch. Poll this instead of re-dispatching.",
      parameters: {
        type: "object",
        properties: {
          batchId: { type: "string" },
          dispatchId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: exec,
      loadMode: "essential",
      description:
        "Run one command on a fleet member's shell (issues #901, #905). The owning machine decides: each member grants you an access rung, and anything above it comes back refused with the reason; omp-ui_fleet_machines shows your rung, OS, and package managers per member. By default the call waits up to 30 s and answers with the exit code and output. Set detach true for anything longer (package installs, toolchain or virtualenv setup): the member starts it detached under a 30 min cap and answers with an execId to poll with omp-ui_fleet_exec_poll. There is no stdin, so nothing may prompt. Use non-interactive flags (dnf -y, apt-get -y, zypper -n, pacman --noconfirm, brew with NONINTERACTIVE=1, winget --accept-source-agreements --accept-package-agreements --disable-interactivity, choco -y) and sudo -n where root is needed. sudo -n fails at once unless the member allows passwordless sudo; omp-ui never handles passwords. Linux and macOS members run /bin/sh -c; Windows members run PowerShell. Output is byte-capped per stream; this computer is refused (use your own tools there). Raise access through the member's Settings → Remote instances → Fleet access, never here.",
      parameters: {
        type: "object",
        properties: {
          machine: { type: "string", description: 'Machine nickname from omp-ui_fleet_machines; "this computer" is refused.' },
          command: {
            type: "string",
            description: `One shell command string (max ${FLEET_COMMAND_MAX} characters). The member runs it in its own shell.`,
          },
          cwd: { type: "string", description: "Working directory on the member; defaults to its user's home." },
          timeoutMs: {
            type: "integer",
            minimum: 100,
            maximum: FLEET_DETACHED_EXEC_TIMEOUT_MS,
            description: "Shorten the member's cap (30 s, or 30 min with detach); cannot extend it.",
          },
          detach: {
            type: "boolean",
            description: "Start a detached exec (30 min cap) and answer with an execId instead of waiting.",
          },
        },
        required: ["machine", "command"],
        additionalProperties: false,
      },
    },
    {
      name: project,
      loadMode: "essential",
      description:
        "Manage projects on a fleet member within its declared roots (issue #901): verb clone clones an https repository URL into a root, verb register adds an existing checkout under one. Needs the manage rung on that member; refusals come back as text with the reason. To provision a member with a repository https clone cannot reach (private, SSH-only remote) or that needs setup: ssh -o BatchMode=yes to the user@address omp-ui_fleet_machines lists, git clone into one of its project roots, run the repository's own setup inside the clone (npm install, python -m venv, ...; a Windows member's ssh shell is cmd or PowerShell), then call register with that checkout's absolute path exactly as the root is listed.",
      parameters: {
        type: "object",
        properties: {
          machine: { type: "string" },
          verb: { type: "string", enum: ["clone", "register"] },
          repositoryUrl: { type: "string", description: "clone only: https URL, no credentials." },
          path: { type: "string", description: "register only: absolute checkout path under a declared root." },
        },
        required: ["machine", "verb"],
        additionalProperties: false,
      },
    },
    {
      name: execPoll,
      loadMode: "essential",
      description:
        "Check on, or cancel, one detached exec you started with omp-ui_fleet_exec detach true (issue #905). Waits up to waitMs for it to finish, then answers with its state (running, exited, timed out, cancelled, revoked), exit code, and output: the last 4 KiB per stream while running, up to 64 KiB once finished. While it runs, poll again; never start the same command twice. revoked means the member's owner withdrew your access and the process was killed.",
      parameters: {
        type: "object",
        properties: {
          machine: { type: "string" },
          execId: { type: "string" },
          cancel: { type: "boolean", description: "Kill the process and its whole tree." },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: FLEET_EXEC_POLL_WAIT_MAX_MS,
            description: "How long to wait for it to finish; default 25000.",
          },
        },
        required: ["machine", "execId"],
        additionalProperties: false,
      },
    },
    {
      name: update,
      loadMode: "essential",
      description:
        "Update a fleet member's own omp binary or omp-ui install (fleet remote version update). Needs Full control on that member; refuses this computer, which updates itself from Settings → Updates. The member does all machine work on itself from its own network: nothing is shipped across the fleet socket. action check answers what the member runs now and what it could move to; action update installs the newest (or `version`) omp binary into the member's managed path — it takes effect for sessions started afterwards, never running ones — or stages an omp-ui update on that machine; action apply arms a staged omp-ui update so it applies at that machine's next natural quit, never by restarting it out from under its work. A refused call answers why as text. An accepted update starts a maintenance job: poll with this same tool (same arguments) — it answers the job's state, progress, and outcome. Do not start the same update twice.",
      parameters: {
        type: "object",
        properties: {
          machine: { type: "string", description: 'Machine nickname from omp-ui_fleet_machines; "this computer" is refused.' },
          target: { type: "string", enum: ["omp", "app"], description: "Which version to move: the member's omp binary or its own omp-ui install." },
          action: { type: "string", enum: ["check", "update", "apply"] },
          version: {
            type: "string",
            description: "Optional exact omp release for action update (e.g. 18.13.1); omit for latest.",
          },
        },
        required: ["machine", "target", "action"],
        additionalProperties: false,
      },
    },
  ];
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
  opts: { vault: boolean; fleet: boolean } = { vault: false, fleet: false },
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
