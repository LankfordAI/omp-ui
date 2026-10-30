/**
 * Annotations (issue #983): a quoted transcript or plan selection plus the
 * user's comment, carried on the next prompt. The rpc frame has no field for
 * them, so — like the attached-documents block (ADR-0044) — they ride the
 * prompt text as an omp-ui-authored block the transcript derivation parses
 * back out into chips (ADR-0077).
 *
 * The block LEADS the prompt, ahead of the typed draft, so the model reads the
 * quotes before the request about them:
 *
 *     <annotations>
 *     > quoted line
 *     > another quoted line
 *     the comment
 *
 *     > a second quote
 *     </annotations>
 *
 *     the typed draft
 *
 * Every quote line starts with `>`; comment lines follow it, are never blank,
 * and never start with `>`, `<`, or `\` (those get a `\` escape), so no body
 * line can be mistaken for the close tag or for the next quote. The tag
 * section is also what omp's keyword masking skips, so a quoted `ultrathink`
 * arms nothing.
 */

export interface Annotation {
  /** The selected text, normalized by `normalizeAnnotationQuote`. */
  quote: string;
  /** The user's comment, normalized by `normalizeAnnotationComment`; empty when the quote stands alone. */
  comment: string;
}

const BLOCK_OPEN = "<annotations>";
const BLOCK_CLOSE = "</annotations>";

/** CRLF folded, trailing spaces dropped per line, and outer blank lines trimmed. */
export function normalizeAnnotationQuote(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start++;
  while (end > start && lines[end - 1] === "") end--;
  return lines.slice(start, end).join("\n");
}

/** CRLF folded, lines trimmed, and blank lines dropped: a blank line ends an entry on the wire. */
export function normalizeAnnotationComment(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function annotationLines(annotation: Annotation): string[] {
  const lines = annotation.quote.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
  if (annotation.comment !== "")
    lines.push(...annotation.comment.split("\n").map((line) => (/^[>\\<]/.test(line) ? `\\${line}` : line)));
  return lines;
}

/** Prepends the annotations block; a prompt without annotations is unchanged. */
export function withAnnotationContext(message: string, annotations: readonly Annotation[]): string {
  if (annotations.length === 0) return message;
  const body = annotations.map((annotation) => annotationLines(annotation).join("\n")).join("\n\n");
  const block = `${BLOCK_OPEN}\n${body}\n${BLOCK_CLOSE}`;
  return message === "" ? block : `${block}\n\n${message}`;
}

/** The body's entries, or null when any line breaks the grammar above. */
function parseBody(body: string): Annotation[] | null {
  const lines = body.split("\n");
  const out: Annotation[] = [];
  let i = 0;
  while (i < lines.length) {
    const quote: string[] = [];
    while (i < lines.length && lines[i]!.startsWith(">")) {
      const line = lines[i]!;
      if (line === ">") quote.push("");
      else if (line.startsWith("> ")) quote.push(line.slice(2));
      else return null;
      i++;
    }
    if (quote.length === 0) return null;
    const comment: string[] = [];
    while (i < lines.length && lines[i] !== "") {
      const line = lines[i]!;
      if (line.startsWith(">") || line.startsWith("<")) return null;
      comment.push(line.startsWith("\\") ? line.slice(1) : line);
      i++;
    }
    out.push({ quote: quote.join("\n"), comment: comment.join("\n") });
    if (i < lines.length) {
      // One blank line separates entries; a trailing separator is malformed.
      if (lines[i] !== "" || i === lines.length - 1) return null;
      i++;
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Removes only a proven leading annotations block, mirroring
 * `splitDocumentContext`: a lookalike anywhere else — or a block whose body
 * does not parse — passes through untouched.
 */
export function splitAnnotationContext(text: string): { text: string; annotations: Annotation[] } {
  if (!text.startsWith(`${BLOCK_OPEN}\n`)) return { text, annotations: [] };
  // No body line can start with `<`, so the first close line is the close.
  const close = text.indexOf(`\n${BLOCK_CLOSE}`, BLOCK_OPEN.length);
  if (close === -1) return { text, annotations: [] };
  const after = close + 1 + BLOCK_CLOSE.length;
  if (after !== text.length && !text.startsWith("\n\n", after)) return { text, annotations: [] };
  const annotations = parseBody(text.slice(BLOCK_OPEN.length + 1, close));
  if (annotations === null) return { text, annotations: [] };
  return { text: text.slice(after === text.length ? after : after + 2), annotations };
}

/** One-line chip preview of a quote: whitespace collapsed, ellipsized past `max`. */
export function annotationQuotePreview(quote: string, max = 60): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
