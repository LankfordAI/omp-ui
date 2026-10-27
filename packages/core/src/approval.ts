/**
 * The wire shape of omp's tool-approval prompt (issue #681, ADR-0038).
 *
 * An approval over rpc-ui is an ordinary `extension_ui_request` with
 * `method: "select"` with the approval option pair (see the answer protocol
 * below), its title built by omp's formatApprovalPrompt: line 0 `Allow tool: <name>`,
 * then optional `Origin: MCP server tool` / `Reason: <policy reason>` lines, then the tool's
 * formatApprovalDetails(args) lines; a provider-safety run appends the sentinel
 * line `Provider safety checks:` plus its entries. Pure, renderer-importable:
 * the frame router and the approval card both read this, main keeps counting
 * the frame as a plain blocking dialog.
 *
 * Answer protocol (verified against omp 18.12.2): the options are
 * `["Approve", "Deny"]`, or on omp ≥ 18.11.3 when the prompt carries a session
 * subject, `["Approve", "Approve <subject> for this session", "Deny"]` (issue
 * #883). The reply is still the option label: omp's runner maps the answered
 * label to `"once" | "session" | "deny"`, comparing a middle-choice reply for
 * exact equality against its own composed label — so the session answer MUST
 * echo the frame's verbatim middle label, never a reconstruction. On omp ≥
 * 18.13.1 a restricted-folder prompt uses the two-option shape with
 * `Reason: Restricted folder: <path>`, and omp composes no session option for
 * it because its session-subject lookup requires `source === "mode"`.
 */

export const APPROVAL_ALLOW = "Approve";
export const APPROVAL_DENY = "Deny";

/** omp ≥ 18.11.3 composes the middle option as "Approve ${subject} for this session"
 *  from its policy key, which may differ from the tool name in the title. */
const SESSION_OPTION = /^Approve .+ for this session$/;

/** Semantic answer; the slice maps it to the frame's wire label. */
export type ApprovalChoice = "once" | "session" | "deny";

const ORIGIN_MCP_LINE = "Origin: MCP server tool";
const REASON_PREFIX = "Reason: ";
const RESTRICTED_PREFIX = "Restricted folder: ";
const SAFETY_SENTINEL = "Provider safety checks:";

export interface ApprovalPrompt {
  toolName: string;
  /** Set for `mcp__*` tools with no `approval` config entry. */
  origin: "mcp" | null;
  reason: string | null;
  /** The folder named by a `Reason: Restricted folder: <path>` line (omp ≥ 18.13.1,
   *  `tools.restrictedFolders`), verbatim; null otherwise. Such a prompt asks in
   *  every approval mode and omp offers no session choice for it. */
  restrictedFolder: string | null;
  /** formatApprovalDetails lines — where bash commands / edit arguments land. */
  details: string[];
  /** Lines after the sentinel line; empty when no provider-safety run. */
  providerSafety: string[];
  /** Verbatim middle option label ("Approve <subject> for this session"),
   *  null on the two-option shape. MUST be echoed back untouched to answer
   *  "session" — omp compares it for exact equality against its own label. */
  sessionLabel: string | null;
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
 * frame's options must be exactly ["Approve","Deny"] or, on omp ≥ 18.11.3,
 * ["Approve", <session label>, "Deny"] with the middle matching
 * `Approve <subject> for this session`. Anything else — a third-party
 * extension coining the title, a grown or reordered option list, a
 * confirm/input frame — returns null and the generic dialog renders the
 * frame. The card is provably omp's own protocol or nothing.
 */
export function parseApprovalPrompt(title: unknown, options: unknown): ApprovalPrompt | null {
  if (typeof title !== "string") return null;
  const [firstLine = "", ...restLines] = title.split("\n");
  const match = /^Allow tool: (.+)$/.exec(firstLine);
  if (match === null) return null;
  const toolName = match[1]!.trim();
  if (toolName === "") return null;
  if (!Array.isArray(options) || (options.length !== 2 && options.length !== 3)) return null;
  if (optionLabel(options[0]) !== APPROVAL_ALLOW) return null;
  const denyIndex = options.length - 1;
  if (optionLabel(options[denyIndex]) !== APPROVAL_DENY) return null;
  let sessionLabel: string | null = null;
  if (options.length === 3) {
    const middle = optionLabel(options[1]);
    if (middle === null || !SESSION_OPTION.test(middle)) return null;
    sessionLabel = middle;
  }
  const prompt: ApprovalPrompt = {
    toolName,
    origin: null,
    reason: null,
    restrictedFolder: null,
    details: [],
    providerSafety: [],
    sessionLabel,
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
  if (prompt.reason !== null && prompt.reason.startsWith(RESTRICTED_PREFIX)) {
    const folder = prompt.reason.slice(RESTRICTED_PREFIX.length);
    if (folder !== "") prompt.restrictedFolder = folder;
  }
  return prompt;
}
