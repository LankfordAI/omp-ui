/**
 * A deliberately small Markdown subset, parsed to a node tree.
 *
 * Agent text and tool output are untrusted, so there is no HTML path at all —
 * the renderer emits React elements from these nodes and nothing else. Two
 * consequences shape the whole parser: it must never throw on arbitrary bytes,
 * and every unmatched marker degrades to literal text rather than swallowing
 * the rest of the message. Streaming makes that the common case, not the edge
 * case: half a fence and a lone `**` arrive on nearly every frame.
 */

export type MdBlock =
  | { kind: "p"; spans: MdSpan[] }
  | { kind: "heading"; level: number; spans: MdSpan[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "list"; ordered: boolean; items: MdSpan[][] }
  | { kind: "quote"; spans: MdSpan[] }
  | { kind: "table"; headers: MdSpan[][]; rows: MdSpan[][][] }
  | { kind: "rule" };

export type MdSpan =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string };

/* --------------------------------------------------------------- inline */

const NOT_SPACE = /[^ \t\n]/;
const SPACE = /[ \t\n]/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function runLength(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

/** First `ch` at or after `from`, giving up at the line end. */
function indexOnLine(src: string, ch: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === "\n") return -1;
    if (c === ch) return j;
  }
  return -1;
}

/**
 * Every inline delimiter is line-bounded. A stray marker then costs one line
 * of fidelity instead of eating the remainder of a streaming message.
 */
function findClosingRun(src: string, from: number, ch: string, minLen: number): number {
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === "\n") return -1;
    if (c !== ch) continue;
    const n = runLength(src, j, ch);
    // A run preceded by whitespace closes nothing — that is what keeps
    // arithmetic like `a * b * c` from reading as emphasis.
    if (n >= minLen && NOT_SPACE.test(src[j - 1] ?? " ")) return j;
    j += n - 1;
  }
  return -1;
}

function findCodeClose(src: string, from: number, len: number): number {
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === "\n") return -1;
    if (c !== "`") continue;
    const n = runLength(src, j, "`");
    if (n === len) return j;
    j += n - 1;
  }
  return -1;
}

function readLink(src: string, i: number): { span: MdSpan; next: number } | null {
  const close = indexOnLine(src, "]", i + 1);
  if (close === -1 || src[close + 1] !== "(") return null;
  const paren = indexOnLine(src, ")", close + 2);
  if (paren === -1) return null;
  const text = src.slice(i + 1, close);
  if (text === "") return null;
  const dest = src.slice(close + 2, paren).trim();
  const href =
    dest.startsWith("<") && dest.endsWith(">") && dest.length > 1
      ? dest.slice(1, -1)
      : (dest.split(/[ \t]+/)[0] ?? "");
  if (href === "") return null;
  return { span: { kind: "link", text, href }, next: paren + 1 };
}

/**
 * `*`/`_` emphasis. The flanking checks are the whole reason this is not a
 * regex: they keep `snake_case_name` and `a * b` out of the emphasis path.
 */
function readEmphasis(src: string, i: number, ch: string): { span: MdSpan; next: number } | null {
  const open = Math.min(runLength(src, i, ch), 3);
  const start = i + open;
  if (start >= src.length || SPACE.test(src[start] ?? " ")) return null;
  if (ch === "_" && WORD_CHAR.test(src[i - 1] ?? "")) return null;

  const close = findClosingRun(src, start + 1, ch, open >= 2 ? 2 : 1);
  if (close === -1) return null;
  const next = close + Math.min(open, runLength(src, close, ch));
  if (ch === "_" && WORD_CHAR.test(src[next] ?? "")) return null;

  const text = src.slice(start, close);
  if (text === "") return null;
  return { span: { kind: open >= 2 ? "strong" : "em", text }, next };
}

function parseInline(src: string): MdSpan[] {
  const out: MdSpan[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";

    if (c === "`") {
      const n = runLength(src, i, "`");
      const start = i + n;
      const close = findCodeClose(src, start, n);
      if (close > start) {
        const raw = src.slice(start, close);
        // CommonMark: one padding space per side is delimiter, not content —
        // it exists so a span may itself start or end with a backtick.
        const padded = raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "";
        flush();
        out.push({ kind: "code", text: padded ? raw.slice(1, -1) : raw });
        i = close + n;
        continue;
      }
      buf += "`".repeat(n);
      i += n;
      continue;
    }

    if (c === "[") {
      const link = readLink(src, i);
      if (link) {
        flush();
        out.push(link.span);
        i = link.next;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const em = readEmphasis(src, i, c);
      if (em) {
        flush();
        out.push(em.span);
        i = em.next;
        continue;
      }
      const n = runLength(src, i, c);
      buf += c.repeat(n);
      i += n;
      continue;
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

/* --------------------------------------------------------------- blocks */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET_RE = /^ {0,3}[-*+](?:[ \t]+(.*))?$/;
const ORDERED_RE = /^ {0,3}\d{1,9}[.)](?:[ \t]+(.*))?$/;
const BLANK_RE = /^[ \t]*$/;

/** Scanned rather than matched: the regex for this shape backtracks badly. */
function isRule(line: string): boolean {
  if (line.startsWith("    ")) return false;
  const compact = line.replace(/[ \t]/g, "");
  if (compact.length < 3) return false;
  const ch = compact[0];
  if (ch !== "-" && ch !== "*" && ch !== "_") return false;
  for (const c of compact) if (c !== ch) return false;
  return true;
}

function fenceCloses(line: string, ch: string, minLen: number): boolean {
  let k = 0;
  while (k < 4 && line[k] === " ") k++;
  if (k > 3) return false;
  const n = runLength(line, k, ch);
  return n >= minLen && BLANK_RE.test(line.slice(k + n));
}

function listMarker(line: string): { ordered: boolean; text: string } | null {
  if (isRule(line)) return null;
  const bullet = BULLET_RE.exec(line);
  if (bullet) return { ordered: false, text: bullet[1] ?? "" };
  const ordered = ORDERED_RE.exec(line);
  if (ordered) return { ordered: true, text: ordered[1] ?? "" };
  return null;
}

/**
 * Split a GFM table row into its cells, or null when the line is not a table
 * row. Honors backslash-escaped pipes (`\|` is a literal pipe and does not
 * split the row), strips the outer pipes when the trimmed line starts and
 * ends with `|`, and trims the single optional space around each cell.
 */
function splitTableRow(line: string): string[] | null {
  // A table row needs at least one pipe: a bare paragraph line before a `---`
  // rule must stay a paragraph, never become a one-cell table header.
  if (!line.includes("|")) return null;
  let src = line.trim();
  if (src.startsWith("|") && src.endsWith("|")) {
    src = src.slice(1, -1);
  }
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    if (c === "|") {
      // A pipe preceded by an odd run of backslashes is escaped — collapse
      // one backslash and keep the pipe inside the cell.
      let bs = 0;
      for (let j = i - 1; j >= 0 && src[j] === "\\"; j--) bs++;
      if (bs % 2 === 1) {
        buf = buf.slice(0, -1) + "|";
        continue;
      }
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  cells.push(buf);
  // A lone outer pipe leaves an empty edge cell; drop them all.
  while (cells.length > 0 && cells[0]?.trim() === "") cells.shift();
  while (cells.length > 0 && cells[cells.length - 1]?.trim() === "") cells.pop();
  if (cells.length < 1) return null;
  return cells.map((c) => c.trim());
}

/** True when every cell looks like a `---` / `:--:` delimiter and one has `-`. */
function isDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (!cells || cells.length === 0) return false;
  return (
    cells.every((c) => /^:?-+:?$/.test(c)) && cells.some((c) => c.includes("-"))
  );
}

/** Lines that interrupt an open paragraph or list item rather than joining it. */
function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    isRule(line) ||
    listMarker(line) !== null
  );
}

export function parseMarkdown(src: string): MdBlock[] {
  if (typeof src !== "string" || src === "") return [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (BLANK_RE.test(line)) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const ch = marker[0] ?? "`";
      const info = (fence[2] ?? "").trim();
      const body: string[] = [];
      let j = i + 1;
      // An unclosed fence keeps everything after it: mid-stream the closer has
      // simply not arrived yet, and dropping the body would flicker the view.
      while (j < lines.length && !fenceCloses(lines[j] ?? "", ch, marker.length)) {
        body.push(lines[j] ?? "");
        j++;
      }
      blocks.push({
        kind: "code",
        lang: info === "" ? null : (info.split(/[ \t]+/)[0] ?? null),
        text: body.join("\n"),
      });
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const text = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "");
      blocks.push({ kind: "heading", level, spans: parseInline(text) });
      i++;
      continue;
    }

    // A GFM table: the header must be followed by a delimiter row (block
    // boundary, like fenced code). Until the delimiter lands mid-stream the
    // header keeps rendering as a paragraph and reflows to a table.
    const tableCells = splitTableRow(line);
    if (tableCells && isDelimiterRow(lines[i + 1] ?? "")) {
      const headers = tableCells.map(parseInline);
      const rows: MdSpan[][][] = [];
      let j = i + 2;
      // Consume every following line that splits as a row; blank lines and
      // anything else end the table.
      while (j < lines.length) {
        const cells = splitTableRow(lines[j] ?? "");
        if (!cells) break;
        rows.push(cells.map(parseInline));
        j++;
      }
      blocks.push({ kind: "table", headers, rows });
      i = j;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const body: string[] = [quote[1] ?? ""];
      let j = i + 1;
      for (;;) {
        const next = j < lines.length ? QUOTE_RE.exec(lines[j] ?? "") : null;
        if (!next) break;
        body.push(next[1] ?? "");
        j++;
      }
      blocks.push({ kind: "quote", spans: parseInline(body.join("\n")) });
      i = j;
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      const { ordered } = marker;
      const texts: string[] = [marker.text];
      let j = i + 1;
      while (j < lines.length) {
        const current = lines[j] ?? "";
        if (BLANK_RE.test(current)) {
          // A blank ends the list unless another item of the same kind follows.
          const after = listMarker(lines[j + 1] ?? "");
          if (after && after.ordered === ordered) {
            j++;
            continue;
          }
          break;
        }
        const next = listMarker(current);
        if (next) {
          if (next.ordered !== ordered) break;
          texts.push(next.text);
          j++;
          continue;
        }
        if (startsBlock(current)) break;
        // Wrapped or deeper-indented lines stay with the open item, indent and
        // all — flattening a nested list beats dropping it.
        texts[texts.length - 1] = `${texts[texts.length - 1] ?? ""}\n${current}`;
        j++;
      }
      blocks.push({ kind: "list", ordered, items: texts.map((t) => parseInline(t)) });
      i = j;
      continue;
    }

    const para: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      const current = lines[j] ?? "";
      if (BLANK_RE.test(current) || startsBlock(current)) break;
      para.push(current);
      j++;
    }
    blocks.push({ kind: "p", spans: parseInline(para.join("\n")) });
    i = j;
  }

  return blocks;
}

const SAFE_SCHEME = /^(?:https?:\/\/|mailto:)/i;
// Control characters are the point: a URL smuggling NUL/ESC/DEL must be rejected,
// so no-control-regex is inverted here — matching them is the security check.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * Link targets come from untrusted text, so this allow-list is the whole
 * policy: anything not plainly a web or mail address renders as literal text.
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  return trimmed !== "" && !CONTROL_CHAR.test(trimmed) && SAFE_SCHEME.test(trimmed);
}
