/**
 * omp's "magic keywords" — `ultrathink`, `orchestrate`, `workflowz`, `jevify` —
 * matched the way omp itself matches them.
 *
 * Typing one of these as standalone prose makes omp append a hidden system
 * notice that steers the turn (`AgentSession.prompt` → `#createMagicKeywordNotices`).
 * The composer's glow and every prompt omp-ui composes are gated on this
 * matcher, so the match rules here are a faithful port of omp's rather than an
 * approximation: a keyword that glows but does not fire — or fires without
 * glowing — is worse than no affordance at all.
 *
 * Ported from omp 18.3.2 `packages/tui/src/prompt/{markdown-prose,magic-keywords}.ts`
 * and `packages/coding-agent/src/modes/magic-keywords.ts`. Four keywords.
 *
 * Pure: zero imports, no DOM, no Node. Shared by the main process (file blocks,
 * one-shots) and the renderer (paint); colours live in the renderer.
 */

/** One row of omp's MAGIC_KEYWORDS table. */
export interface MagicKeywordSpec {
  /** omp's id: the `magicKeywords.<id>` setting and the `<id>-notice` custom type. */
  readonly id: string;
  /** The standalone prose word omp matches, case-sensitively. */
  readonly word: string;
  /** Hue ramp endpoints in degrees; hue(t) = (start + t * (end - start)) mod 360. */
  readonly hue: readonly [number, number];
  /** Tools that must be in the enabled roster before omp attaches the notice. */
  readonly requires: readonly string[];
}

/** omp 18.3.2 MAGIC_KEYWORDS, in omp's notice-push order. */
export const MAGIC_KEYWORDS = [
  { id: "ultrathink", word: "ultrathink", hue: [0, 330], requires: [] },
  { id: "orchestrate", word: "orchestrate", hue: [150, 280], requires: ["task"] },
  { id: "workflow", word: "workflowz", hue: [30, 150], requires: ["task", "eval"] },
  { id: "jevify", word: "jevify", hue: [300, 420], requires: ["eval"] },
] as const satisfies readonly MagicKeywordSpec[];

export type MagicKeyword = (typeof MAGIC_KEYWORDS)[number]["word"];

export const ALL_MAGIC_KEYWORDS: ReadonlySet<MagicKeyword> = new Set(
  MAGIC_KEYWORDS.map((k) => k.word),
);

/** A run of the draft: `keyword` is null for ordinary prose. */
export interface KeywordSegment {
  text: string;
  keyword: MagicKeyword | null;
}

// ---------------------------------------------------------------------------
// Prose masking — port of omp's markdown-prose.ts
// ---------------------------------------------------------------------------

// Tag/element name: HTML5/XML start char + name chars. Sticky so we can probe at
// a precise offset without slicing.
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;

// A line that opens or closes a fenced code block: up to 3 leading spaces then a
// run of >=3 backticks or tildes.
const FENCE = /^( {0,3})([`~]{3,})/;

/** Index just past the run of backticks beginning at `i`. */
function backtickRunEnd(text: string, i: number, n: number): number {
  let j = i;
  while (j < n && text[j] === "`") j++;
  return j;
}

/**
 * Find the closing backtick run that matches an opening run of `runLen`
 * backticks, scanning from `from`. Returns the index just past the closing run,
 * or -1 when no run of the exact length exists (an unmatched run is literal text,
 * not a code span). Already-masked positions (fenced code) are skipped.
 */
function findBacktickClose(
  text: string,
  from: number,
  n: number,
  runLen: number,
  masked: Uint8Array,
): number {
  let k = from;
  while (k < n) {
    if (masked[k]) {
      k++;
      continue;
    }
    if (text[k] === "`") {
      const e = backtickRunEnd(text, k, n);
      if (e - k === runLen) return e;
      k = e;
      continue;
    }
    k++;
  }
  return -1;
}

/**
 * Index of the `>` that closes a tag whose attributes begin at `j`, honoring
 * quoted attribute values. Returns -1 when the tag is malformed (a new `<`
 * appears first, or there is no `>`), so callers can treat the `<` as literal.
 */
function findTagEnd(text: string, j: number, n: number): number {
  let quote = "";
  for (let k = j; k < n; k++) {
    const ch = text[k];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return k;
    if (ch === "<") return -1;
  }
  return -1;
}

/**
 * Locate the `</name>` that balances an opening `<name>` at `start`, counting
 * nested same-name tags. Returns the index just past the matching close tag's
 * `>`, or -1 when the section is never closed (so callers mask only the opening
 * tag rather than swallowing the rest of the document).
 */
function findMatchingClose(
  text: string,
  start: number,
  n: number,
  name: string,
  masked: Uint8Array,
): number {
  const lname = name.toLowerCase();
  let depth = 1;
  let k = start;
  while (k < n) {
    if (masked[k] || text[k] !== "<") {
      k++;
      continue;
    }
    let m = k + 1;
    let isClose = false;
    if (text[m] === "/") {
      isClose = true;
      m++;
    }
    TAG_NAME.lastIndex = m;
    const nm = TAG_NAME.exec(text);
    if (!nm) {
      k++;
      continue;
    }
    const gt = findTagEnd(text, TAG_NAME.lastIndex, n);
    if (gt < 0) {
      k++;
      continue;
    }
    if (nm[0].toLowerCase() === lname) {
      if (isClose) {
        depth--;
        if (depth === 0) return gt + 1;
      } else if (text[gt - 1] !== "/") {
        depth++;
      }
    }
    k = gt + 1;
  }
  return -1;
}

/**
 * Mask the HTML/XML construct beginning at `<` (index `i`): an HTML comment, a
 * self-closing/closing tag (the tag alone), or an opening tag together with the
 * content through its matching close tag. Returns the index just past the masked
 * region, or `i` when the `<` does not begin a tag (e.g. a stray less-than).
 */
function maskTagAt(text: string, i: number, n: number, masked: Uint8Array): number {
  if (text.startsWith("<!--", i)) {
    const end = text.indexOf("-->", i + 4);
    const stop = end < 0 ? n : end + 3;
    for (let p = i; p < stop; p++) masked[p] = 1;
    return stop;
  }
  let j = i + 1;
  let closing = false;
  if (text[j] === "/") {
    closing = true;
    j++;
  }
  TAG_NAME.lastIndex = j;
  const nm = TAG_NAME.exec(text);
  if (!nm) return i;
  const gt = findTagEnd(text, TAG_NAME.lastIndex, n);
  if (gt < 0) return i;
  const tagEnd = gt + 1;
  const selfClosing = text[gt - 1] === "/";
  for (let p = i; p < tagEnd; p++) masked[p] = 1;
  if (closing || selfClosing) return tagEnd;
  const close = findMatchingClose(text, tagEnd, n, nm[0], masked);
  if (close < 0) return tagEnd;
  for (let p = tagEnd; p < close; p++) masked[p] = 1;
  return close;
}

/**
 * Phase 1 of the mask: mark every line inside (or opening/closing) a fenced
 * code block in `masked`, line by line. Returns the marker run of a fence `text`
 * opens and never closes (e.g. "~~~" or "````"), or null when every fence is
 * balanced.
 */
function maskFences(text: string, masked: Uint8Array): string | null {
  const n = text.length;
  let fenceChar = "";
  let fenceLen = 0;
  let lineStart = 0;
  while (lineStart <= n) {
    let nl = text.indexOf("\n", lineStart);
    if (nl < 0) nl = n;
    const line = text.slice(lineStart, nl);
    const open = FENCE.exec(line);
    if (fenceChar) {
      for (let p = lineStart; p < nl; p++) masked[p] = 1;
      // A closing fence is the same char, at least as long, with nothing else on the line.
      if (
        open &&
        open[2]![0] === fenceChar &&
        open[2]!.length >= fenceLen &&
        line.slice(open[1]!.length + open[2]!.length).trim() === ""
      ) {
        fenceChar = "";
        fenceLen = 0;
      }
    } else if (open) {
      const marker = open[2]!;
      const ch = marker[0]!;
      // A backtick fence's info string may not contain a backtick.
      if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
        fenceChar = ch;
        fenceLen = marker.length;
        for (let p = lineStart; p < nl; p++) masked[p] = 1;
      }
    }
    if (nl === n) break;
    lineStart = nl + 1;
  }
  return fenceChar === "" ? null : fenceChar.repeat(fenceLen);
}

/**
 * Return a copy of `text` with identical length (indices map 1:1) where every
 * character inside a non-prose region is replaced by a space. Non-prose regions
 * are markdown fenced code blocks, inline code spans, and HTML/XML tags together
 * with the content they enclose. Newlines are preserved. Text with no construct
 * that could open such a region is returned unchanged.
 *
 * The equal length is the whole point: matches are found in the mask, then
 * sliced out of the original.
 */
export function maskNonProse(text: string): string {
  if (!text.includes("`") && !text.includes("<") && !text.includes("~~~")) {
    return text;
  }
  const n = text.length;
  const masked = new Uint8Array(n);

  // Phase 1: fenced code blocks, line by line.
  maskFences(text, masked);

  // Phase 2: inline code spans and HTML/XML, over not-yet-masked regions.
  let i = 0;
  while (i < n) {
    if (masked[i]) {
      i++;
      continue;
    }
    const c = text[i];
    if (c === "`") {
      const runEnd = backtickRunEnd(text, i, n);
      const close = findBacktickClose(text, runEnd, n, runEnd - i, masked);
      if (close >= 0) {
        for (let p = i; p < close; p++) masked[p] = 1;
        i = close;
      } else {
        i = runEnd;
      }
      continue;
    }
    if (c === "<") {
      const end = maskTagAt(text, i, n, masked);
      i = end > i ? end : i + 1;
      continue;
    }
    i++;
  }

  const arr = text.split("");
  for (let p = 0; p < n; p++) {
    if (masked[p] && arr[p] !== "\n") arr[p] = " ";
  }
  return arr.join("");
}

/**
 * The marker run ("```", "~~~~", …) of a fenced block `text` opens and never
 * closes; null when every fence is balanced. Appending the run closes the
 * block, so a draft left inside an open fence cannot swallow what follows.
 */
export function unclosedFence(text: string): string | null {
  if (!text.includes("`") && !text.includes("~~~")) return null;
  return maskFences(text, new Uint8Array(text.length));
}

// ---------------------------------------------------------------------------
// Keyword matching — port of magic-keyword-boundary.ts and the keyword modules
// ---------------------------------------------------------------------------

/**
 * Characters that bind a keyword into an identifier or path segment, and so
 * keep the occurrence code rather than prose. Sentence punctuation and quotes
 * may touch the word; letters, digits, `_`, `.`, `/`, `\`, `-`, a `::` prefix,
 * a file-extension dot, and an immediate `(` all disqualify it.
 */
const LEFT = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;
const RIGHT = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

// Case-sensitive by design: omp fires on the lowercase word only. Built once
// from the table, in omp's notice-push order.
const MATCHES: ReadonlyArray<{ word: MagicKeyword; match: RegExp }> = MAGIC_KEYWORDS.map(
  (k) => ({ word: k.word, match: new RegExp(`${LEFT}${k.word}${RIGHT}`, "gu") }),
);

/**
 * Splits `text` into alternating prose and keyword runs. Matching happens
 * against the masked copy so a keyword inside a code span, fence, or XML
 * section never lights up — omp would not fire its notice for one either — while
 * the emitted text is always sliced from the original. `allowed` drops matches
 * for words outside the set.
 *
 * Segments are never empty, and their texts rejoin to exactly `text`.
 */
export function magicKeywordSegments(
  text: string,
  allowed: ReadonlySet<MagicKeyword> = ALL_MAGIC_KEYWORDS,
): KeywordSegment[] {
  if (text === "") return [];
  const masked = maskNonProse(text);
  const hits: { start: number; end: number; keyword: MagicKeyword }[] = [];
  for (const { word, match } of MATCHES) {
    if (!allowed.has(word)) continue;
    for (const m of masked.matchAll(match)) {
      const start = m.index;
      hits.push({ start, end: start + m[0].length, keyword: word });
    }
  }
  if (hits.length === 0) return [{ text, keyword: null }];
  // The four literals are distinct and none contains another, so matches can
  // never overlap — ordering them is enough, no merge pass.
  hits.sort((a, b) => a.start - b.start);

  const segments: KeywordSegment[] = [];
  let last = 0;
  for (const hit of hits) {
    if (hit.start > last) segments.push({ text: text.slice(last, hit.start), keyword: null });
    segments.push({ text: text.slice(hit.start, hit.end), keyword: hit.keyword });
    last = hit.end;
  }
  if (last < text.length) segments.push({ text: text.slice(last), keyword: null });
  return segments;
}

/** The keywords omp would match in `text` (settings and tools aside). */
export function keywordsIn(text: string): ReadonlySet<MagicKeyword> {
  const found = new Set<MagicKeyword>();
  for (const segment of magicKeywordSegments(text)) {
    if (segment.keyword !== null) found.add(segment.keyword);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Inert quoting — framing that keeps un-authored text from arming keywords
// ---------------------------------------------------------------------------

/** Length of the longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    run = text[i] === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * A fenced block nothing inside can escape: the fence is one backtick longer than any run in
 * `text` (min 3) and `info` holds no backtick. The caller places it at a line start and
 * follows it with a newline or the end of the text.
 */
export function inertBlock(text: string, info = "text"): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** A single-line code span: newlines fold to spaces; padded when empty or backtick-edged. */
export function inertInline(text: string): string {
  const flat = text.replace(/\s*[\r\n]+\s*/g, " ");
  const run = "`".repeat(longestBacktickRun(flat) + 1);
  const pad = flat === "" || flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${run}${pad}${flat}${pad}${run}`;
}

export interface KeywordQuoting {
  block(text: string, info?: string): string;
  inline(text: string): string;
}

/** Emit fields exactly as given. */
export const VERBATIM_QUOTING: KeywordQuoting = { block: (t) => t, inline: (t) => t };

/** Emit fields framed so nothing inside can arm a keyword. */
export const INERT_QUOTING: KeywordQuoting = { block: inertBlock, inline: inertInline };

/**
 * Builds with every un-authored field verbatim; when that text would arm any keyword, rebuilds
 * with every field inert. `build` must not contain intended keywords — withKeywords() prepends
 * those afterwards.
 */
export function withoutAccidentalKeywords(
  build: (quote: KeywordQuoting) => string,
): string {
  const verbatim = build(VERBATIM_QUOTING);
  return keywordsIn(verbatim).size === 0 ? verbatim : build(INERT_QUOTING);
}
