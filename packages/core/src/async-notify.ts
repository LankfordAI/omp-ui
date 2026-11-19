import { isObject } from "./guards";

/**
 * omp 19's `async-notify` notices (issue #1235): the lines a background bash
 * job or a supervised service matched against its `notify` regex, delivered to
 * the session that started it as an ordinary custom message — a batch of
 * per-source reports folded into one message, persisted in the session file.
 *
 * The contract is upstream's (`packages/coding-agent/src/session/async-notify.ts`
 * and `packages/tui/src/chat/messages.ts` on v19.0.0, verified against
 * omp/19.0.0 over rpc-ui): a message_start/message_end pair whose message is
 * `{role: "custom", customType: "async-notify", content: <rendered notice>,
 * display: true, attribution: "agent", details: {reports: [...]}}`. Both frames
 * carry the complete message; no delta ever streams between them.
 *
 * Parsing here is deliberately tolerant where strictness would drop a real
 * notice: unknown extra keys on the report survive (omp may add fields), a
 * report with an unusable `id`/`type` is dropped alone, and every text field is
 * clamped. An older harness (18.22.x) never sends this customType at all, so
 * everything downstream keeps today's behavior untouched.
 */

/** omp's `ASYNC_NOTIFY_MESSAGE_TYPE` on the wire. */
export const ASYNC_NOTIFY_MESSAGE_TYPE = "async-notify";

/** Reports kept from one message; a burst wider than this is display-poison. */
export const ASYNC_NOTIFY_REPORT_CAP = 32;
/** Lines kept per report per message (upstream caps at 50; the cap bounds a hostile frame). */
export const ASYNC_NOTIFY_LINES_CAP = 128;
/** UTF-16 ceiling on one reported line (upstream cuts at 400). */
export const ASYNC_NOTIFY_LINE_CHARS = 1024;
/** UTF-16 ceilings on the report's identity fields. */
export const ASYNC_NOTIFY_ID_CHARS = 160;
export const ASYNC_NOTIFY_PATTERN_CHARS = 512;

/** One background source's share of an async-notify message (upstream `AsyncNotifyReport`). */
export interface AsyncNotifyReport {
  /** The job's id or the service's name, as `proc://` takes it. */
  id: string;
  type: "bash" | "service";
  /** Source of its `notify` regex. */
  pattern: string;
  /** Matching output lines, oldest first. */
  lines: string[];
  /** Matching lines upstream left out of `lines`. */
  omitted: number;
  /** Whether the source was still running when the notice was built. */
  running: boolean;
  /** It matched too often (or its allowance ran out): this is its last notice. */
  stopped: boolean;
}

function clampText(value: unknown, max: number): string | null {
  return typeof value === "string" ? (value.length > max ? value.slice(0, max) : value) : null;
}

/** One report, clamped; null when its identity fields are unusable. */
export function parseAsyncNotifyReport(value: unknown): AsyncNotifyReport | null {
  if (!isObject(value)) return null;
  const id = clampText(value.id, ASYNC_NOTIFY_ID_CHARS);
  if (id === null || id === "") return null;
  if (value.type !== "bash" && value.type !== "service") return null;
  const pattern = clampText(value.pattern, ASYNC_NOTIFY_PATTERN_CHARS) ?? "";
  const rawLines = Array.isArray(value.lines) ? value.lines : [];
  const lines: string[] = [];
  for (const line of rawLines.slice(0, ASYNC_NOTIFY_LINES_CAP)) {
    const text = clampText(line, ASYNC_NOTIFY_LINE_CHARS);
    if (text !== null) lines.push(text);
  }
  const omitted = typeof value.omitted === "number" && Number.isFinite(value.omitted) && value.omitted > 0
    ? Math.floor(value.omitted)
    : 0;
  return { id, type: value.type, pattern, lines, omitted, running: value.running === true, stopped: value.stopped === true };
}

/** The reports of an async-notify `details` payload; empty or malformed is null. */
export function parseAsyncNotifyReports(details: unknown): AsyncNotifyReport[] | null {
  if (!isObject(details) || !Array.isArray(details.reports)) return null;
  const reports: AsyncNotifyReport[] = [];
  for (const report of details.reports.slice(0, ASYNC_NOTIFY_REPORT_CAP)) {
    const parsed = parseAsyncNotifyReport(report);
    if (parsed !== null) reports.push(parsed);
  }
  return reports.length === 0 ? null : reports;
}

/** True for the async-notify custom message (hidden notices are not messages we own). */
export function isAsyncNotifyMessage(message: unknown): message is { details?: unknown; content?: unknown } {
  if (!isObject(message)) return false;
  return (
    message.role === "custom" &&
    message.customType === ASYNC_NOTIFY_MESSAGE_TYPE &&
    message.display !== false
  );
}

/** The reports a message_start/message_end frame carries for the pane feed; null for anything else. */
export function asyncNotifyReportsFromFrame(frame: unknown): AsyncNotifyReport[] | null {
  if (!isObject(frame) || frame.type !== "message_end") return null;
  if (!isAsyncNotifyMessage(frame.message)) return null;
  return parseAsyncNotifyReports(frame.message.details);
}
