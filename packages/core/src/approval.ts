/**
 * The wire shape of omp's tool-approval prompt (issue #681, ADR-0038).
 *
 * An approval over rpc-ui is an ordinary `extension_ui_request` with
 * `method: "select"` and options `["Approve", "Deny"]`, its title built by
 * omp's formatApprovalPrompt: line 0 `Allow tool: <name>`, then optional
 * `Origin: MCP server tool` / `Reason: <policy reason>` lines, then the tool's
 * formatApprovalDetails(args) lines; a provider-safety run appends the sentinel
 * line `Provider safety checks:` plus its entries. Pure, renderer-importable:
 * the frame router and the approval card both read this, main keeps counting
 * the frame as a plain blocking dialog.
 *
 * Answer protocol: the exact string `"Approve"` approves, anything else denies
 * — omp's runner compares only against `"Approve"`. There is no session-wide
 * "always allow" verb over rpc; the richer TUI-only set is out of reach.
 */

export const APPROVAL_ALLOW = "Approve";
export const APPROVAL_DENY = "Deny";

const ORIGIN_MCP_LINE = "Origin: MCP server tool";
const REASON_PREFIX = "Reason: ";
const SAFETY_SENTINEL = "Provider safety checks:";

export interface ApprovalPrompt {
  toolName: string;
  /** Set for `mcp__*` tools with no `approval` config entry. */
  origin: "mcp" | null;
  reason: string | null;
  /** formatApprovalDetails lines — where bash commands / edit arguments land. */
  details: string[];
  /** Lines after the sentinel line; empty when no provider-safety run. */
  providerSafety: string[];
}

/** Mirrors ExtensionDialogHost's readOptions: an option is a bare string or
 *  an object whose label (falling back to its value) is what omp renders. */
function optionLabel(option: unknown): string | null {
  if (typeof option === "string") return option;
  if (option !== null && typeof option === "object") {
    const record = option as Record<string, unknown>;
    if (typeof record.label === "string") return record.label;
    if (typeof record.value === "string") return record.value;
  }
  return null;
}

/**
 * Strict recognizer: the title's line 0 must start `Allow tool: ` AND the
 * frame's options must be exactly ["Approve","Deny"] in that order. Anything
 * else — a third-party extension coining the title, omp growing the option
 * list, a confirm/input frame — returns null and the generic dialog renders
 * the frame. The card is provably omp's own protocol or nothing.
 */
export function parseApprovalPrompt(title: unknown, options: unknown): ApprovalPrompt | null {
  if (typeof title !== "string") return null;
  const [firstLine = "", ...restLines] = title.split("\n");
  const match = /^Allow tool: (.+)$/.exec(firstLine);
  if (match === null) return null;
  const toolName = match[1]!.trim();
  if (toolName === "") return null;
  if (!Array.isArray(options) || options.length !== 2) return null;
  if (optionLabel(options[0]) !== APPROVAL_ALLOW || optionLabel(options[1]) !== APPROVAL_DENY) {
    return null;
  }
  const prompt: ApprovalPrompt = {
    toolName,
    origin: null,
    reason: null,
    details: [],
    providerSafety: [],
  };
  let safety = false;
  for (const line of restLines) {
    if (safety) {
      prompt.providerSafety.push(line);
      continue;
    }
    if (line === SAFETY_SENTINEL) {
      safety = true;
    } else if (line === ORIGIN_MCP_LINE) {
      prompt.origin = "mcp";
    } else if (line.startsWith(REASON_PREFIX)) {
      prompt.reason = line.slice(REASON_PREFIX.length);
    } else {
      prompt.details.push(line);
    }
  }
  return prompt;
}
