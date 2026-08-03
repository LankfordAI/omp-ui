/**
 * `@`-mention detection, insertion and painting for the composer.
 *
 * The extraction rules duplicate core/mention-resolve.ts — itself a port of
 * omp v17.2.6 src/utils/file-mentions.ts — because this module must stay
 * Node-free (pure, like fuzzy.ts and magic-keywords.ts) and the shareable half
 * of core is types-only. There is deliberately no code-fence masking: omp's
 * extractor fires inside backticks, so the paint must too — paint that hides a
 * mention omp will fire is worse than paint inside a code span.
 */

// The same four constants as omp's file-mentions.ts (see the header).
const FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;

function sanitizeMentionPath(rawPath: string): string | null {
  let cleaned = rawPath.trim();
  cleaned = cleaned.replace(LEADING_PUNCTUATION_REGEX, "");
  cleaned = cleaned.replace(TRAILING_PUNCTUATION_REGEX, "");
  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The @-word at the caret, or null. `start` is the index of the `@`.
 *
 * The word is scanned left over anything that is not an omp mention-boundary
 * character, so `(@fo` and `"@fo` trigger exactly as omp would extract them,
 * while `a@b` (email) never does — the `@` must lead its word.
 */
export function detectAtQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let start = caret;
  while (start > 0 && !MENTION_BOUNDARY_REGEX.test(text[start - 1] as string)) start--;
  if (start === caret || text[start] !== "@") return null;
  if (start > 0 && !MENTION_BOUNDARY_REGEX.test(text[start - 1] as string)) return null;
  return { start, query: text.slice(start + 1, caret) };
}

/**
 * Replaces `@`(start)..caret with the mention plus one trailing space, and
 * returns the new text and caret. Paths containing whitespace take omp's
 * quoted form (`@"…"`), which its extractor reads as one token.
 */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  relPath: string,
): { text: string; caret: number } {
  const mention = /\s/.test(relPath) ? `@"${relPath}"` : `@${relPath}`;
  const next = text.slice(0, start) + mention + " " + text.slice(caret);
  return { text: next, caret: start + mention.length + 1 };
}

/**
 * Ranges of mentions whose sanitized path is in `known` (files + derived
 * dirs). A bare dir mention (`@src` for known `src/`) counts too: omp's stat
 * resolves it to the directory, so the paint must not call it unresolved.
 * Ranges cover `@` through the token end, quotes included, and never overlap
 * (the regex is global and non-overlapping by construction).
 */
export function mentionRanges(
  text: string,
  known: ReadonlySet<string>,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  FILE_MENTION_REGEX.lastIndex = 0; // a module-level /g regex is stateful
  for (const match of text.matchAll(FILE_MENTION_REGEX)) {
    const index = match.index ?? 0;
    if (!(index === 0 || MENTION_BOUNDARY_REGEX.test(text[index - 1] as string))) continue;
    const rawPath = match[1] ?? match[2] ?? match[3];
    if (!rawPath) continue;
    const cleaned =
      match[1] !== undefined || match[2] !== undefined
        ? rawPath.trim()
        : sanitizeMentionPath(rawPath);
    if (!cleaned) continue;
    if (!known.has(cleaned) && !known.has(`${cleaned}/`)) continue;
    ranges.push({ from: index, to: index + match[0].length });
  }
  return ranges;
}

/**
 * Every ancestor dir of each file path, with a trailing "/": `a/b/c.ts`
 * yields `a/` and `a/b/`. Feeds both the highlight's known set and the
 * picker's dir rows.
 */
export function deriveDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let slash = file.indexOf("/");
    while (slash !== -1) {
      dirs.add(file.slice(0, slash + 1));
      slash = file.indexOf("/", slash + 1);
    }
  }
  return [...dirs].sort();
}
