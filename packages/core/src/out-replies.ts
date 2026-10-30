import { compareVersions } from "./semver";

/**
 * omp 18.14 lets the agent reply mid-turn by writing Markdown to `out://` —
 * the `write` tool, or `> out://` from bash (issue #969). omp gates it behind
 * `out.enabled`, on by default only in its own TUI; omp-ui pins it on for
 * native sessions through a `--config` overlay (ADR-0038 pattern).
 *
 * Renderer-safe: no Node imports, so the transcript and main share one gate.
 * Not registered against `MIN_SUPPORTED_OMP`: an older omp has no `out://`
 * scheme, so below the gate omp-ui writes no overlay and a `write` stays a
 * card — nothing is promised there that the harness cannot honour.
 */
export const OUT_REPLIES_MIN_OMP = "18.14.0";

/** Unknown version is unsupported: an older omp has no `out://` scheme at all. */
export function supportsOutReplies(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, OUT_REPLIES_MIN_OMP) >= 0;
}

/** omp's internal-URL scheme parser (`packages/tui/src/chat/reply-write.ts` uses the same). */
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const REPLY_SCHEME = "out";

/**
 * Port of omp's `isReplyWrite`: true when a `write` call targets `out://`,
 * false when it targets anything else, undefined while streamed args are
 * still undecided (no path yet, or a path that is a prefix of `out://`).
 */
export function isReplyWrite(toolName: string, args: unknown): boolean | undefined {
  if (toolName !== "write") return false;
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const target = typeof record.path === "string" ? record.path : record.file_path;
  if (typeof target !== "string") return undefined;
  const scheme = SCHEME.exec(target)?.[1];
  if (scheme !== undefined) return scheme.toLowerCase() === REPLY_SCHEME;
  return `${REPLY_SCHEME}://`.startsWith(target.toLowerCase()) ? undefined : false;
}

/** The Markdown a reply write carries; streamed args may not have it yet. */
export function replyWriteContent(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const content = (args as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

/** Port of omp's `toolResultReplies`: each `> out://` write a bash run made. */
export function toolResultReplies(details: unknown): string[] {
  if (typeof details !== "object" || details === null) return [];
  const replies = (details as Record<string, unknown>).replies;
  return Array.isArray(replies) ? replies.filter((r): r is string => typeof r === "string") : [];
}
