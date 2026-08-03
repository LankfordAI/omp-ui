export interface DiffRow {
  kind: "add" | "del" | "ctx" | "meta";
  lineNum?: number;
  text: string;
}

/** One changed file in a branch working-tree diff, ready for DiffViewer. */
export interface DiffFile {
  path: string;
  op: "modified" | "create" | "delete";
  rows: DiffRow[];
}

const NUMBERED_ROW = /^([+\- ])(\d+)\|(.*)$/;

/**
 * Standard unified diff → the same DiffRow[] DiffViewer renders. File and hunk
 * headers (`diff --git`, `---`/`+++`, `@@`, mode/similarity lines) become meta
 * rows; content lines map by sign. Line numbers are not carried in unified
 * diffs, so rows get none (DiffViewer renders a blank gutter).
 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      // git always writes file headers (`--- a/x`, `+++ b/y`) with a space;
      // keep them metadata rather than scanning them as content.
      rows.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1) });
    } else {
      rows.push({ kind: "meta", text: line });
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
 * `new file mode` / `deleted file mode` mark the operation, so renames and
 * edits both read as "modified".
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
    files.push({ path, op, rows: parseUnifiedDiff(section) });
  }
  for (const u of untracked) {
    files.push({
      path: u.path,
      op: "create",
      rows: u.binary
        ? [{ kind: "meta", text: "binary file" }]
        : u.text.split("\n").map((text) => ({ kind: "add" as const, text })),
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
