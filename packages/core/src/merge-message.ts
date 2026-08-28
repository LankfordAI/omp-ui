/**
 * The merge-back commit message (issue #333).
 *
 * Merge-back always writes a merge commit, so the base branch carries one
 * record per worktree session instead of a silent fast-forward. The message is
 * built from the commits being folded in: their subjects, plus every GitHub
 * closing reference found in their full messages, re-emitted as `Fixes <ref>`
 * lines so the merge commit itself names what the session closes.
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

export interface MergeMessage {
  /** First line of the merge commit. */
  subject: string;
  /** Everything after the blank line; "" when there is nothing to add. */
  body: string;
}

/** Clips `text` to `max` characters, marking a cut with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
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
 * Builds the merge commit message for folding `branch` into `destination`.
 * `messages` are the full `%B` messages of the non-merge commits being merged,
 * oldest first — the order they read in the body.
 */
export function buildMergeMessage({
  branch,
  destination,
  messages,
}: {
  branch: string;
  destination: string;
  messages: readonly string[];
}): MergeMessage {
  const subjects = messages.map(subjectOf).filter((subject) => subject !== "");
  const refs = closingRefs(messages);

  let subject: string;
  if (subjects.length === 1) {
    const prefix = `Merge ${branch}: `;
    subject = prefix + clip(subjects[0], Math.max(0, SUBJECT_MAX - prefix.length));
  } else if (subjects.length > 1) {
    subject = `Merge ${branch} into ${destination} (${subjects.length} commits)`;
  } else {
    subject = `Merge ${branch} into ${destination}`;
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
  if (refs.length > 0) {
    paragraphs.push(refs.map((ref) => `Fixes ${ref}`).join("\n"));
  }

  return { subject, body: paragraphs.join("\n\n") };
}
