import type { ThemedToken } from "shiki/core";

export interface DiffRow {
  kind: "add" | "del" | "ctx" | "meta";
  /** add/ctx: new-file line; del: old-file line. Absent on meta rows. */
  lineNum?: number;
  text: string;
}

/** One changed file in a branch working-tree diff, ready for DiffViewer. */
export interface DiffFile {
  path: string;
  op: "modified" | "create" | "delete";
  rows: DiffRow[];
  /** Raw git section for the copy button (applies with `git apply`); absent for untracked files. */
  patch?: string;
  /** Old path when git reports `rename from`. */
  renamedFrom?: string;
  /** git reported `Binary files … differ`, or an untracked file contains a NUL. */
  binary?: boolean;
}

const NUMBERED_ROW = /^([+\- ])(\d+)\|(.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Standard unified diff → the same DiffRow[] DiffViewer renders. The file
 * preamble (`diff --git`, `index`, mode/rename lines, `---`/`+++`, `Binary
 * files`) is dropped; `@@` hunk headers and `\ No newline` markers become meta
 * rows. Line numbers come from the hunk headers: add/ctx rows carry the
 * new-file line, del rows the old-file line. Inside a hunk every line is
 * content by its sign, so `--- x` there is a deleted `-- x`.
 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "meta", text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) rows.push({ kind: "meta", text: line });
    else if (line.startsWith("+")) rows.push({ kind: "add", lineNum: newLine++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", lineNum: oldLine++, text: line.slice(1) });
    else {
      // " x" is context; a bare "" is context whose trailing space was stripped.
      rows.push({ kind: "ctx", lineNum: newLine, text: line.slice(1) });
      oldLine++;
      newLine++;
    }
  }
  return rows;
}

/** Maps a git path back from git's quoting (`"a b"` → `a b`, \" → "). */
function unquoteGitPath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\"/g, '"');
  }
  return p;
}

/**
 * The two paths on a `diff --git a/x b/y` header. git quotes either side when
 * the path needs it (`"a/my file.ts" "b/my file.ts"`), so the split is
 * quote-aware — the optional quote groups are back-referenced to pair each
 * side's opening and closing quote.
 */
function splitGitPathPair(header: string): { a: string; b: string } | null {
  const body = header.startsWith("diff --git") ? header.slice("diff --git".length).trim() : header;
  const m = /^("?)(a\/.*?)\1\s+("?)(b\/.*?)\3$/.exec(body);
  if (!m) return null;
  return {
    a: unquoteGitPath((m[2] ?? "").replace(/^a\//, "")),
    b: unquoteGitPath((m[4] ?? "").replace(/^b\//, "")),
  };
}

/**
 * Splits a multi-file `git diff` into per-file sections and adds untracked
 * files as creates. A section's `diff --git a/x b/y` header names the file;
 * `new file mode` / `deleted file mode` mark the operation; renames read as
 * "modified" and carry `renamedFrom`. Each section keeps its raw text as
 * `patch`; `Binary files … differ` sets `binary`.
 */
export function parseBranchDiff(
  diff: string,
  untracked: { path: string; text: string; binary: boolean }[] = [],
): DiffFile[] {
  const files: DiffFile[] = [];
  for (const section of diff.split(/(?=^diff --git )/m)) {
    if (!section.trim()) continue;
    const header = section.split("\n", 1)[0] ?? "";
    const pair = splitGitPathPair(header);
    if (!pair) continue;
    const path = pair.b;
    if (!path) continue;
    const op: DiffFile["op"] = /new file mode/.test(section)
      ? "create"
      : /deleted file mode/.test(section)
        ? "delete"
        : "modified";
    const renameFrom = /^rename from (.+)$/m.exec(section)?.[1];
    const file: DiffFile = {
      path,
      op,
      rows: parseUnifiedDiff(section),
      patch: section.endsWith("\n") ? section : `${section}\n`,
    };
    if (renameFrom !== undefined) file.renamedFrom = unquoteGitPath(renameFrom);
    if (/^Binary files .* differ$/m.test(section)) file.binary = true;
    files.push(file);
  }
  for (const u of untracked) {
    if (u.binary) {
      files.push({ path: u.path, op: "create", rows: [], binary: true });
      continue;
    }
    const lines = u.text === "" ? [] : u.text.replace(/\n$/, "").split("\n");
    files.push({
      path: u.path,
      op: "create",
      rows: lines.map((text, i) => ({ kind: "add" as const, lineNum: i + 1, text })),
    });
  }
  return files;
}

/**
 * OMP's generateDiffString format is NOT unified diff: rows of
 * `+<num>|<text>` / `-<num>|<text>` / ` <num>|<text>`, `@@ ` context markers,
 * and an `*** End of File` marker — no hunk headers. Anything unrecognized
 * stays a meta row verbatim (forward-compatible).
 */
export function parseOmpDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of diff.split("\n")) {
    const m = NUMBERED_ROW.exec(line);
    if (m) {
      const [, sig = " ", num = "", text = ""] = m;
      const kind = sig === "+" ? "add" : sig === "-" ? "del" : "ctx";
      rows.push({ kind, lineNum: Number(num), text });
    } else {
      rows.push({ kind: "meta", text: line });
    }
  }
  return rows;
}

/** +/− counts shared by DiffViewer's header and the branch diff pane's summary. */
export function diffCounts(rows: readonly DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added++;
    else if (row.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * Word-level ranges. A run of del rows directly followed by a run of add rows
 * pairs its i-th del with its i-th add. Each pair marks the span between the
 * common prefix and common suffix; pairs with nothing in common (or empty on
 * both sides) and unpaired rows get null. Index-aligned with `rows`.
 */
export function pairWordRanges(rows: readonly DiffRow[]): ([number, number] | null)[] {
  const out: ([number, number] | null)[] = rows.map(() => null);
  let i = 0;
  while (i < rows.length) {
    if (rows[i]?.kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (rows[i]?.kind === "del") i++;
    const addStart = i;
    while (rows[i]?.kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const d = rows[delStart + k]?.text ?? "";
      const a = rows[addStart + k]?.text ?? "";
      const max = Math.min(d.length, a.length);
      let p = 0;
      while (p < max && d[p] === a[p]) p++;
      let s = 0;
      while (s < max - p && d[d.length - 1 - s] === a[a.length - 1 - s]) s++;
      const dr: [number, number] = [p, d.length - s];
      const ar: [number, number] = [p, a.length - s];
      if (p + s === 0 || (dr[0] === dr[1] && ar[0] === ar[1])) continue;
      out[delStart + k] = dr;
      out[addStart + k] = ar;
    }
  }
  return out;
}

export interface DiffSegment {
  text: string;
  color?: string;
  emph: boolean;
}

/**
 * Splits one row into render segments. `tokens` are ignored when undefined or
 * when their contents don't join back to `text`. `range` marks the emph span;
 * token pieces split at its boundaries. Segment texts always join to `text`.
 */
export function rowSegments(
  text: string,
  tokens: readonly ThemedToken[] | undefined,
  range: [number, number] | null,
): DiffSegment[] {
  const pieces: { text: string; color?: string }[] =
    tokens && tokens.map((tk) => tk.content).join("") === text
      ? tokens.map((tk) => (tk.color ? { text: tk.content, color: tk.color } : { text: tk.content }))
      : [{ text }];
  const out: DiffSegment[] = [];
  let pos = 0;
  for (const piece of pieces) {
    const end = pos + piece.text.length;
    const cuts = [pos];
    if (range) {
      for (const c of range) if (c > pos && c < end) cuts.push(c);
    }
    cuts.push(end);
    for (let k = 0; k < cuts.length - 1; k++) {
      const from = cuts[k] ?? pos;
      const to = cuts[k + 1] ?? end;
      if (from === to) continue;
      const seg: DiffSegment = {
        text: text.slice(from, to),
        emph: range !== null && from >= range[0] && to <= range[1],
      };
      if (piece.color) seg.color = piece.color;
      out.push(seg);
    }
    pos = end;
  }
  if (out.length === 0) out.push({ text, emph: false });
  return out;
}
