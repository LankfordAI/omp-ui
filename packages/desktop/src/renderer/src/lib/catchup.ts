// A catch-up digest (issue #273). Pure: the store settles one snapshot per
// resurface and CatchupCard renders it. No model call, no I/O.
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import type { RenderItem } from "./transcript";

/** A session unseen beyond this earns a digest on resurface (issue #273). */
export const CATCHUP_THRESHOLD_MS = 15 * 60 * 1_000;

const TURN_CAP = 5;
const FILE_CAP = 4;
const LIFECYCLE_CAP = 4;
const PROMPT_SNIPPET = 80;

export type CatchupOutcome = "completed" | "error" | "interrupted" | "truncated" | "running";
export interface CatchupTurn {
  /** First line of the prompt, truncated; "(image)" for an image-only prompt. */
  prompt: string;
  outcome: CatchupOutcome;
}
export interface CatchupFile {
  path: string;
  op: "write" | "edit" | "read";
}
export interface CatchupDigest {
  since: number;
  awayMs: number;
  /** Last TURN_CAP in-window turns, chronological. */
  turns: CatchupTurn[];
  turnsOmitted: number;
  /** Deduped by path, first-seen order, op upgraded to the strongest seen. */
  files: CatchupFile[];
  filesOmitted: number;
  /** Main-model spend (USD) since `since`. */
  cost: number;
  tokens: { input: number; output: number; cacheRead: number };
  /** Advisor session-tree totals — NOT windowed (the extension publishes no window). */
  advisor: { cost: number; tokens: number } | null;
  /** Compaction/retry marker labels fired since `since`, deduped, in order. */
  lifecycle: string[];
  lifecycleOmitted: number;
  pendingPlan: { title: string } | null;
}
interface Args {
  items: readonly RenderItem[];
  advisor: AdvisorStatsView | null;
  since: number;
  now: number;
  /** True while the session's turn is running (a streaming end reads "running"). */
  live: boolean;
  pendingPlanTitle: string | null;
}

function outcome(stopReason: string | undefined): CatchupOutcome {
  switch (stopReason) {
    case "error": return "error";
    case "aborted": return "interrupted";
    case "maxTokens":
    case "length": return "truncated";
    default: return "completed"; // "stop" | "end_turn" | undefined
  }
}
function opOf(op: string | undefined): CatchupFile["op"] {
  if (op === "write" || op === "create") return "write";
  if (op === "edit") return "edit";
  return "read"; // read details carry no op; any other tool with a path reads
}
const OP_RANK: Record<CatchupFile["op"], number> = { write: 3, edit: 2, read: 1 };

export function buildCatchupDigest({
  items, advisor, since, now, live, pendingPlanTitle,
}: Args): CatchupDigest | null {
  const inWindow = (t: { timestamp?: number }): boolean => (t.timestamp ?? 0) >= since;

  // --- Turns: one per in-window user item, through the next user item ---
  const all: CatchupTurn[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "user" || !inWindow(item)) continue;
    let last: { stopReason?: string; streaming?: boolean } | null = null;
    for (let j = i + 1; j < items.length; j++) {
      const next = items[j];
      if (next.kind === "user") break;
      if (next.kind === "assistant") last = next;
    }
    const line = item.text.split("\n")[0]?.trim() ?? "";
    all.push({
      prompt: line === "" ? "(image)"
        : line.length > PROMPT_SNIPPET ? `${line.slice(0, PROMPT_SNIPPET - 1)}…` : line,
      // A streaming end with a live session is the current turn; with a dead
      // one the turn died mid-stream (no message_end ever arrived).
      outcome: last === null || last.streaming === true
        ? (live ? "running" : "interrupted")
        : outcome(last.stopReason),
    });
  }

  // --- Files touched: tool cards with a path, deduped, op upgraded ---
  const fileMap = new Map<string, CatchupFile>();
  for (const item of items) {
    if (item.kind !== "tool" || item.path === undefined || !inWindow(item)) continue;
    const op = opOf(item.op);
    const existing = fileMap.get(item.path);
    if (existing === undefined || OP_RANK[op] > OP_RANK[existing.op]) {
      fileMap.set(item.path, { path: item.path, op });
    }
  }
  const fileList = [...fileMap.values()];

  // --- Spend and tokens: windowed assistant receipts ---
  let cost = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0 };
  for (const item of items) {
    if (item.kind !== "assistant" || item.streaming || item.usage === undefined || !inWindow(item)) continue;
    cost += item.usage.cost;
    tokens.input += item.usage.input;
    tokens.output += item.usage.output;
    tokens.cacheRead += item.usage.cacheRead;
  }

  // --- Advisor: session-tree totals, included only when nonzero ---
  const advisorView =
    advisor !== null && advisor.available === true && (advisor.cost > 0 || advisor.totalTokens > 0)
      ? { cost: advisor.cost, tokens: advisor.totalTokens }
      : null;

  // --- Lifecycle: compaction and retry markers only ---
  const seen: string[] = [];
  for (const item of items) {
    if (item.kind !== "marker" || !inWindow(item)) continue;
    if (!/compact|retry/i.test(item.label)) continue;
    if (seen.includes(item.label)) continue;
    seen.push(item.label);
  }

  const empty =
    all.length === 0 && fileList.length === 0 && cost === 0 &&
    advisorView === null && seen.length === 0 && pendingPlanTitle === null;
  if (empty) return null;

  return {
    since,
    awayMs: Math.max(0, now - since),
    turns: all.slice(-TURN_CAP),
    turnsOmitted: Math.max(0, all.length - TURN_CAP),
    files: fileList.slice(0, FILE_CAP),
    filesOmitted: Math.max(0, fileList.length - FILE_CAP),
    cost,
    tokens,
    advisor: advisorView,
    lifecycle: seen.slice(0, LIFECYCLE_CAP),
    lifecycleOmitted: Math.max(0, seen.length - LIFECYCLE_CAP),
    pendingPlan: pendingPlanTitle === null ? null : { title: pendingPlanTitle },
  };
}
