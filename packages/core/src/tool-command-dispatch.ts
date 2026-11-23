/**
 * The tool-command dispatch record of one bash run (issue #1274). From omp
 * 19.1, tools mounted as commands run inside `bash` and the result's details
 * carry every invocation so far, in invocation order (`ToolCommandDispatch[]`
 * on `BashToolDetails.toolCommands`): the nested cards the TUI and collab-web
 * draw under the bash card are built from exactly this record, because the
 * RPC wire emits no separate `tool_execution_*` frames for a command call —
 * docs/rpc.md names the dispatch record (plus `host_tool_call`) as the host's
 * only identification of an in-bash command. An older binary publishes no
 * record, and a run that dispatched nothing carries none: both read as empty.
 */

/** One tool command executed inside a bash call. */
export interface ToolCommandDispatch {
  /** The wrapped session tool's name (`read`, `grep`, an MCP name…). */
  tool: string;
  /** `help` ran the tool's own help text; `execute` ran the tool. */
  mode: "help" | "execute";
  /** Exit status of this invocation, independent of the outer shell status. */
  exitCode: number;
  /** Validated renderer args when omp projected them; absent for some dispatches. */
  args?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** One entry of the record; undefined for anything that is not a dispatch. */
function parseEntry(value: unknown): ToolCommandDispatch | undefined {
  const entry = record(value);
  if (entry === undefined) return undefined;
  const tool = entry.tool;
  const mode = entry.mode;
  const exitCode = entry.exitCode;
  if (typeof tool !== "string" || tool === "") return undefined;
  if (mode !== "help" && mode !== "execute") return undefined;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) return undefined;
  const args = record(entry.args);
  return args === undefined
    ? { tool, mode, exitCode }
    : { tool, mode, exitCode, args };
}

/** The dispatches a tool result's details record, in invocation order. A
 *  missing or malformed list — including one whose every entry is bad — reads
 *  as empty: the bash card renders no nested rows rather than guessing. */
export function parseToolCommandDispatches(details: unknown): ToolCommandDispatch[] {
  const list = record(details)?.toolCommands;
  if (!Array.isArray(list)) return [];
  const dispatches: ToolCommandDispatch[] = [];
  for (const entry of list) {
    const parsed = parseEntry(entry);
    if (parsed !== undefined) dispatches.push(parsed);
  }
  return dispatches;
}
