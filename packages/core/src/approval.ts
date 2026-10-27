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
 * Answer protocol (verified against omp 18.13.2): the options are
 * `["Approve", "Deny"]`, or on omp ≥ 18.11.3 when the prompt carries a session
 * subject, `["Approve", "Approve <subject> for this session", "Deny"]` (issue
 * #883). Under the Ask and remember tier (`always-ask-cached`, omp ≥ 18.12.3,
 * issue #950) the prompt may also carry N ∈ {1, 2} grants, folder before target:
 * `[...grant labels, ...grant always-labels, "Approve Once", session?, "Deny"]`.
 * Folder grants read `Approve Directory: <dir>` / `Always Approve Directory: <dir>`;
 * target grants `Approve File` / `Always Approve File`, or a bare `Approve` /
 * `Always Approve` for a non-file target — which is why "Approve Once" is
 * located first to tell the shapes apart. The reply is always the option
 * label: omp's runner compares it for exact equality against its own composed
 * labels, so session and grant answers MUST echo the frame's verbatim label,
 * never a reconstruction. approvalReply does that mapping. On omp ≥
 * 18.13.1 a restricted-folder prompt uses the two-option shape with
 * `Reason: Restricted folder: <path>`, and omp composes no session option for
 * it because its session-subject lookup requires `source === "mode"`.
 */

import type { ApprovalMode } from "./types";

/** omp's `tools.approvalMode` tiers in omp's own order (issue #681, #950).
 *  The one list every codec, guard, and picker reads. */
export const APPROVAL_MODES = ["always-ask", "always-ask-cached", "write", "yolo"] as const;

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export const APPROVAL_ALLOW = "Approve";
export const APPROVAL_DENY = "Deny";
export const APPROVAL_ONCE = "Approve Once";

/** omp ≥ 18.11.3 composes the middle option as "Approve ${subject} for this session"
 *  from its policy key, which may differ from the tool name in the title. */
const SESSION_OPTION = /^Approve .+ for this session$/;

const FOLDER_GRANT = /^Approve Directory: (.+)$/;
/** Target grant pairs omp composes (file target, then any other target). */
const TARGET_GRANTS: readonly (readonly [string, string])[] = [
  ["Approve File", "Always Approve File"],
  ["Approve", "Always Approve"],
];

/** One remember-choice of an Ask and remember prompt (omp ≥ 18.12.3, issue #950).
 *  Both labels are verbatim frame text; omp matches the reply by equality. */
export interface ApprovalGrant {
  scope: "folder" | "target";
  /** Remembers for this session. */
  label: string;
  /** Remembers across sessions (omp's approval-cache.db). */
  alwaysLabel: string;
}

/** Semantic answer; approvalReply maps it to the frame's wire label. */
export type ApprovalChoice =
  | "once"
  | "session"
  | "deny"
  | { grant: ApprovalGrant["scope"]; always: boolean };

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
  /** In omp's order, folder before target; empty on the 2- and 3-option shapes. */
  grants: ApprovalGrant[];
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

function readGrant(label: string, alwaysLabel: string): ApprovalGrant | null {
  if (FOLDER_GRANT.test(label)) {
    return alwaysLabel === `Always ${label}` ? { scope: "folder", label, alwaysLabel } : null;
  }
  for (const [once, always] of TARGET_GRANTS) {
    if (label === once && alwaysLabel === always) return { scope: "target", label, alwaysLabel };
  }
  return null;
}

function readOptions(
  options: unknown,
): { sessionLabel: string | null; grants: ApprovalGrant[] } | null {
  if (!Array.isArray(options)) return null;
  const labels: string[] = [];
  for (const option of options) {
    const label = optionLabel(option);
    if (label === null) return null;
    labels.push(label);
  }
  if (labels.length < 2 || labels[labels.length - 1] !== APPROVAL_DENY) return null;
  const onceAt = labels.indexOf(APPROVAL_ONCE);
  const grants: ApprovalGrant[] = [];
  let afterAllow: number;
  if (onceAt === -1) {
    // 2- or 3-option shape: "Approve" leads.
    if (labels[0] !== APPROVAL_ALLOW) return null;
    afterAllow = 1;
  } else {
    // N label/alwaysLabel pairs precede "Approve Once"; omp emits N ∈ {1, 2}.
    const n = onceAt / 2;
    if (!Number.isInteger(n) || n < 1 || n > 2) return null;
    for (let i = 0; i < n; i += 1) {
      const grant = readGrant(labels[i]!, labels[n + i]!);
      if (grant === null) return null;
      grants.push(grant);
    }
    if (n === 2 && (grants[0]!.scope !== "folder" || grants[1]!.scope !== "target")) return null;
    afterAllow = onceAt + 1;
  }
  const between = labels.slice(afterAllow, -1);
  if (between.length > 1) return null;
  const sessionLabel = between[0] ?? null;
  if (sessionLabel !== null && !SESSION_OPTION.test(sessionLabel)) return null;
  return { sessionLabel, grants };
}

/** The wire label answering `choice`, or null when the frame offers no such
 *  choice ("session" without a session label, a grant scope it lacks). */
export function approvalReply(prompt: ApprovalPrompt, choice: ApprovalChoice): string | null {
  if (choice === "deny") return APPROVAL_DENY;
  if (choice === "once") return prompt.grants.length > 0 ? APPROVAL_ONCE : APPROVAL_ALLOW;
  if (choice === "session") return prompt.sessionLabel;
  const grant = prompt.grants.find((g) => g.scope === choice.grant);
  if (grant === undefined) return null;
  return choice.always ? grant.alwaysLabel : grant.label;
}

/**
 * Strict recognizer: the title's line 0 must start `Allow tool: ` AND the
 * frame's options must be one of omp's three shapes: ["Approve","Deny"];
 * on omp ≥ 18.11.3 ["Approve", <session label>, "Deny"] with the middle
 * matching `Approve <subject> for this session`; or on omp ≥ 18.12.3 (Ask and
 * remember, issue #950) one or two grant label pairs (folder before target,
 * each label followed later by its `Always …` twin), then "Approve Once", an
 * optional session label, and "Deny". Anything else — a third-party extension
 * coining the title, a grown, mismatched or reordered option list, a
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
  const read = readOptions(options);
  if (read === null) return null;
  const prompt: ApprovalPrompt = {
    toolName,
    origin: null,
    reason: null,
    restrictedFolder: null,
    details: [],
    providerSafety: [],
    sessionLabel: read.sessionLabel,
    grants: read.grants,
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
