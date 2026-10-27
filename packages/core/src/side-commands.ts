// The side-command wire contract (issue #955). Pure — zero runtime imports —
// because the renderer imports it through the @omp-ui/core/side-commands
// subpath; side-commands-extension.ts interpolates these same constants.
// omp ≥ 18.13.0 runs `side: true` file slash commands as /btw in its TUI
// only; over rpc it expands them as ordinary prompts. The bridge publishes
// the live session's side set and renders one command with omp's own
// renderFileSlashCommand, so omp-ui never re-implements template expansion.

export const SIDE_COMMANDS_STATUS_KEY = "omp-ui:side-commands";
export const SIDE_COMMANDS_COMMAND = "omp-ui-side-commands";
export const SIDE_COMMANDS_RENDER_ARG_PREFIX = "render ";
export const SIDE_COMMANDS_STATUS_BYTE_LIMIT = 256 * 1024;

export const SIDE_COMMAND_FAILURES = ["not-side", "render-failed", "empty", "too-long"] as const;
export type SideCommandFailure = (typeof SIDE_COMMAND_FAILURES)[number];

export interface SideCommandRenderRequest {
  requestId: string;
  name: string;
  /** Everything after the first space, verbatim (omp's parseFileSlashInvocation). */
  args: string;
}

export type SideCommandResult =
  | { requestId: string; ok: true; question: string }
  | { requestId: string; ok: false; reason: SideCommandFailure; message: string | null };

export interface SideCommandsSnapshot {
  version: 1;
  processKey: string;
  revision: number;
  available: boolean;
  /** Null exactly when available. */
  unavailable: string | null;
  /** Names of the live session's side: true file commands, sorted. */
  commands: string[];
  /** The latest render result, correlated by the client's requestId. */
  result: SideCommandResult | null;
}

/** The hidden prompt that makes the bridge publish the side set. */
export function sideCommandsArmMessage(): string {
  return `/${SIDE_COMMANDS_COMMAND}`;
}

/** The hidden prompt that asks the bridge to render one side command. */
export function sideCommandRenderMessage(request: SideCommandRenderRequest): string {
  return `/${SIDE_COMMANDS_COMMAND} ${SIDE_COMMANDS_RENDER_ARG_PREFIX}${JSON.stringify(request)}`;
}

/** omp's parseFileSlashInvocation: split at the FIRST space only. */
export function parseFileSlashInvocation(line: string): { name: string; args: string } | null {
  if (!line.startsWith("/")) return null;
  const space = line.indexOf(" ");
  const name = space === -1 ? line.slice(1) : line.slice(1, space);
  if (name === "") return null;
  return { name, args: space === -1 ? "" : line.slice(space + 1) };
}

/** The TUI's title: `/name` or `/name <trimmed args>`. */
export function sideCommandTitle(name: string, args: string): string {
  const trimmed = args.trim();
  return trimmed === "" ? `/${name}` : `/${name} ${trimmed}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function parseResult(value: unknown): SideCommandResult | null | undefined {
  if (value === null) return null;
  const raw = asObject(value);
  if (raw === null || !isNonEmptyString(raw.requestId)) return undefined;
  const requestId = raw.requestId;
  if (raw.ok === true) {
    return typeof raw.question === "string"
      ? { requestId, ok: true, question: raw.question }
      : undefined;
  }
  if (raw.ok === false) {
    const { reason, message } = raw;
    if (!SIDE_COMMAND_FAILURES.includes(reason as SideCommandFailure)) return undefined;
    if (message !== null && typeof message !== "string") return undefined;
    return { requestId, ok: false, reason: reason as SideCommandFailure, message };
  }
  return undefined;
}

/** Total parser; null for anything malformed or over the byte limit. */
export function parseSideCommandsSnapshot(text: string | undefined): SideCommandsSnapshot | null {
  if (text === undefined) return null;
  if (new TextEncoder().encode(text).length > SIDE_COMMANDS_STATUS_BYTE_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = asObject(parsed);
  if (raw === null) return null;
  const { version, processKey, revision, available, unavailable, commands } = raw;
  if (version !== 1 || !isNonEmptyString(processKey)) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
  if (typeof available !== "boolean") return null;
  if (available ? unavailable !== null : !isNonEmptyString(unavailable)) return null;
  if (!Array.isArray(commands) || !commands.every(isNonEmptyString)) return null;
  const result = parseResult(raw.result);
  if (result === undefined) return null;
  return {
    version: 1,
    processKey,
    revision,
    available,
    unavailable: unavailable as string | null,
    commands: [...commands],
    result,
  };
}
