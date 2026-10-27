/**
 * The merge-back commit message (issue #333).
 *
 * Merge-back always writes a merge commit, so the base branch carries one
 * record per worktree session instead of a silent fast-forward. The message is
 * built from the commits being folded in: their subjects, plus every GitHub
 * closing reference found in their full messages, re-emitted as `Fixes <ref>`
 * lines so the merge commit itself names what the session closes, then a
 * `Refs #N` line for every other issue they cite, so the merge commit marks
 * every citation it carries and passes the repo's `commit-msg` check (#949).
 *
 * No subject shape names the worktree branch (issue #490): that name is minted
 * per machine — project slug + base segments + random 8-hex tail (issues
 * #405/#428/#438) — and names nothing once the checkout is gone, so the
 * durable merge record must not depend on it. The branch stays recoverable
 * from the merge commit's second parent and the session transcript.
 */

/** Cap on the subject line: pathological input, not a style limit. */
const SUBJECT_MAX = 200;
/** Longest bullet line in the body, so the list stays scannable. */
const BULLET_MAX = 100;
/** Bullets listed before the tail collapses into a count. */
const BULLET_LIMIT = 20;

/**
 * GitHub's closing keywords followed by an issue reference — `#12`,
 * `owner/repo#12`, or `GH-12` — matched case-insensitively, the same shapes
 * GitHub scans in the commits themselves.
 */
const CLOSING_REF =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]+((?:[\w.-]+\/[\w.-]+)?#\d+|GH-\d+)/gi;
/** An issue citation, the same shape scripts/release-notes.mjs RE.cited reads. */
const CITED_REF = /(^|[\s([])#(\d+)\b/g;
/** Inline code spans: a "#N" inside backticks is not a citation. */
const CODE_SPAN = /`[^`\n]*`/g;

export interface MergeMessage {
  /** First line of the merge commit. */
  subject: string;
  /** Everything after the blank line; "" when there is nothing to add. */
  body: string;
}

/**
 * Clips `text` to `max` characters, marking a cut with an ellipsis. A cut never
 * leaves an unclosed code span or a partial issue reference behind.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = text.slice(0, Math.max(0, max - 3));
  if ((kept.match(/`/g)?.length ?? 0) % 2 === 1) kept = kept.slice(0, kept.lastIndexOf("`"));
  return `${kept.replace(/\(?#\d*$/, "").trimEnd()}...`;
}

/** First non-empty line of a commit message, trimmed; "" when there is none. */
function subjectOf(message: string): string {
  for (const line of message.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** Ordered unique closing references across `messages`; first occurrence wins. */
function closingRefs(messages: readonly string[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const match of message.matchAll(CLOSING_REF)) {
      const key = match[1].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(match[1]);
    }
  }
  return refs;
}

/**
 * Ordered unique `#N` citations across `messages` that no closing reference
 * covers, as `#N`. Git comment lines ("#" not followed by a digit) and inline
 * code spans are skipped.
 */
function notedRefs(messages: readonly string[], closing: readonly string[]): string[] {
  const seen = new Set(closing.map((ref) => ref.toLowerCase()));
  const noted: string[] = [];
  for (const message of messages) {
    const text = message
      .split("\n")
      .filter((line) => !/^#(?!\d)/.test(line))
      .join("\n")
      .replace(CODE_SPAN, "");
    for (const match of text.matchAll(CITED_REF)) {
      const ref = `#${match[2]}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      noted.push(ref);
    }
  }
  return noted;
}

/**
 * Builds the merge commit message for folding into `destination`.
 * `messages` are the full `%B` messages of the non-merge commits being merged,
 * oldest first — the order they read in the body.
 */
export function buildMergeMessage({
  destination,
  messages,
}: {
  destination: string;
  messages: readonly string[];
}): MergeMessage {
  const subjects = messages.map(subjectOf).filter((subject) => subject !== "");
  const refs = closingRefs(messages);
  const noted = notedRefs(messages, refs);

  let subject: string;
  if (subjects.length === 1) {
    subject = clip(subjects[0], SUBJECT_MAX);
  } else if (subjects.length > 1) {
    subject = `Merge work into ${destination} (${subjects.length} commits)`;
  } else {
    subject = `Merge work into ${destination}`;
  }

  const paragraphs: string[] = [];
  if (subjects.length > 1) {
    const listed = subjects
      .slice(0, BULLET_LIMIT)
      .map((entry) => `- ${clip(entry, BULLET_MAX)}`);
    if (subjects.length > BULLET_LIMIT) {
      listed.push(`- ... and ${subjects.length - BULLET_LIMIT} more`);
    }
    paragraphs.push(listed.join("\n"));
  }
  if (refs.length > 0 || noted.length > 0) {
    paragraphs.push(
      [...refs.map((ref) => `Fixes ${ref}`), ...noted.map((ref) => `Refs ${ref}`)].join("\n"),
    );
  }

  return { subject, body: paragraphs.join("\n\n") };
}
