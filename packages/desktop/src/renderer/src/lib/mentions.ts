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

interface ParsedMention {
  path: string;
  from: number;
  to: number;
}

/** Omp-compatible mention tokens, before any known-file filtering. */
function parsedMentions(text: string): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  FILE_MENTION_REGEX.lastIndex = 0; // a module-level /g regex is stateful
  for (const match of text.matchAll(FILE_MENTION_REGEX)) {
    const index = match.index ?? 0;
    if (!(index === 0 || MENTION_BOUNDARY_REGEX.test(text[index - 1] as string))) continue;
    const rawPath = match[1] ?? match[2] ?? match[3];
    if (!rawPath) continue;
    const path =
      match[1] !== undefined || match[2] !== undefined
        ? rawPath.trim()
        : sanitizeMentionPath(rawPath);
    if (!path) continue;
    mentions.push({ path, from: index, to: index + match[0].length });
  }
  return mentions;
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
  return parsedMentions(text)
    .filter(({ path }) => known.has(path) || known.has(`${path}/`))
    .map(({ from, to }) => ({ from, to }));
}

const FILE_CONTEXT_OPEN = '\n\n<file path="';
const FILE_CONTEXT_HEADER_END = '">\n';
const FILE_CONTEXT_CLOSE = "\n</file>";

/**
 * Parses a terminal sequence of exact file blocks. A closing-tag-looking line
 * inside file content is skipped unless the remainder completes the sequence.
 */
function resolvedPathsAt(text: string, start: number): string[] | null {
  function parseBlock(blockStart: number): string[] | null {
    if (!text.startsWith(FILE_CONTEXT_OPEN, blockStart)) return null;
    const pathStart = blockStart + FILE_CONTEXT_OPEN.length;
    const headerEnd = text.indexOf(FILE_CONTEXT_HEADER_END, pathStart);
    if (headerEnd === -1) return null;
    const path = text.slice(pathStart, headerEnd);
    if (path === "") return null;

    const bodyStart = headerEnd + FILE_CONTEXT_HEADER_END.length;
    let close = text.indexOf(FILE_CONTEXT_CLOSE, bodyStart);
    while (close !== -1) {
      const afterClose = close + FILE_CONTEXT_CLOSE.length;
      if (afterClose === text.length) return [path];
      if (text.startsWith(FILE_CONTEXT_OPEN, afterClose)) {
        const rest = parseBlock(afterClose);
        if (rest !== null) return [path, ...rest];
      }
      close = text.indexOf(FILE_CONTEXT_CLOSE, close + 1);
    }
    return null;
  }

  return parseBlock(start);
}

function pathsPreserveMentionOrder(
  paths: readonly string[],
  mentionPaths: readonly string[],
): boolean {
  const seen = new Set<string>();
  let mentionStart = 0;
  for (const path of paths) {
    if (seen.has(path)) return false;
    seen.add(path);
    const mentionIndex = mentionPaths.indexOf(path, mentionStart);
    if (mentionIndex === -1) return false;
    mentionStart = mentionIndex + 1;
  }
  return true;
}

/**
 * Removes only omp-ui's proven terminal resolved-file suffix from display
 * text. The expanded payload itself remains unchanged outside derived state.
 */
export function splitResolvedMentionContext(text: string): { text: string; paths: string[] } {
  let start = text.indexOf(FILE_CONTEXT_OPEN);
  while (start !== -1) {
    const paths = resolvedPathsAt(text, start);
    if (paths !== null) {
      const prefix = text.slice(0, start);
      const mentionPaths = [...new Set(parsedMentions(prefix).map(({ path }) => path))];
      return pathsPreserveMentionOrder(paths, mentionPaths)
        ? { text: prefix, paths }
        : { text, paths: [] };
    }
    start = text.indexOf(FILE_CONTEXT_OPEN, start + 1);
  }
  return { text, paths: [] };
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
