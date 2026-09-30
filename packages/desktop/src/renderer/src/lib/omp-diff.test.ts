import { describe, expect, it } from "vitest";
import { pairWordRanges, parseBranchDiff, parseOmpDiff, parseUnifiedDiff, rowSegments, type DiffRow } from "./omp-diff";

describe("parseOmpDiff", () => {
  it("parses add/del/ctx numbered rows", () => {
    const rows = parseOmpDiff("+12|const a = 1;\n-12|const a = 2;\n 13|const b = 3;");
    expect(rows).toEqual([
      { kind: "add", lineNum: 12, text: "const a = 1;" },
      { kind: "del", lineNum: 12, text: "const a = 2;" },
      { kind: "ctx", lineNum: 13, text: "const b = 3;" },
    ]);
  });

  it("keeps pipes inside the content", () => {
    const rows = parseOmpDiff("+1|a | b | c");
    expect(rows[0]).toEqual({ kind: "add", lineNum: 1, text: "a | b | c" });
  });

  it("marks @@ context and *** End of File as meta", () => {
    const rows = parseOmpDiff("@@ -10,3 +10,4 @@\n@@ some context\n*** End of File");
    expect(rows).toEqual([
      { kind: "meta", text: "@@ -10,3 +10,4 @@" },
      { kind: "meta", text: "@@ some context" },
      { kind: "meta", text: "*** End of File" },
    ]);
  });

  it("passes anything else through as meta verbatim", () => {
    const rows = parseOmpDiff("not a diff row\n+nopipe\n\n  |missing num");
    expect(rows.map((r) => r.kind)).toEqual(["meta", "meta", "meta", "meta"]);
    expect(rows[3]!.text).toBe("  |missing num");
  });

  it("handles empty input", () => {
    expect(parseOmpDiff("")).toEqual([{ kind: "meta", text: "" }]);
  });
});

describe("parseUnifiedDiff", () => {
  it("drops the preamble and numbers rows from the hunk header", () => {
    const rows = parseUnifiedDiff(
      "diff --git a/src/a.ts b/src/a.ts\n" +
        "index abc..def 100644\n" +
        "--- a/src/a.ts\n" +
        "+++ b/src/a.ts\n" +
        "@@ -1,3 +1,4 @@\n" +
        " export const a = 1;\n" +
        "-export const b = 2;\n" +
        "+export const b = 3;\n",
    );
    expect(rows).toEqual([
      { kind: "meta", text: "@@ -1,3 +1,4 @@" },
      { kind: "ctx", lineNum: 1, text: "export const a = 1;" },
      { kind: "del", lineNum: 2, text: "export const b = 2;" },
      { kind: "add", lineNum: 2, text: "export const b = 3;" },
    ]);
  });

  it("reads ---/+++ inside a hunk as content (SQL comments)", () => {
    const rows = parseUnifiedDiff("@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n select 1;");
    expect(rows.slice(1)).toEqual([
      { kind: "del", lineNum: 1, text: "-- old comment" },
      { kind: "add", lineNum: 1, text: "++ new comment" },
      { kind: "ctx", lineNum: 2, text: "select 1;" },
    ]);
  });

  it("numbers across hunks, bare context lines and no-newline markers", () => {
    const rows = parseUnifiedDiff(
      "@@ -1,2 +1,2 @@\n a\n\n@@ -10,2 +11,2 @@\n-x\n\\ No newline at end of file\n+y\n z\n",
    );
    expect(rows).toEqual([
      { kind: "meta", text: "@@ -1,2 +1,2 @@" },
      { kind: "ctx", lineNum: 1, text: "a" },
      { kind: "ctx", lineNum: 2, text: "" },
      { kind: "meta", text: "@@ -10,2 +11,2 @@" },
      { kind: "del", lineNum: 10, text: "x" },
      { kind: "meta", text: "\\ No newline at end of file" },
      { kind: "add", lineNum: 11, text: "y" },
      { kind: "ctx", lineNum: 12, text: "z" },
    ]);
  });
});

describe("parseBranchDiff", () => {
  it("splits a multi-file diff into per-file DiffFiles with ops", () => {
    const files = parseBranchDiff(
      `diff --git a/src/a.ts b/src/a.ts\nindex x..y 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n` +
        `diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 000..abc\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hello\n` +
        `diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n`,
    );
    expect(files.map((f) => [f.path, f.op])).toEqual([
      ["src/a.ts", "modified"],
      ["new.ts", "create"],
      ["old.ts", "delete"],
    ]);
    expect(files[0]!.rows.some((r) => r.kind === "add" && r.text === "new")).toBe(true);
  });

  it("unquotes git paths that contain spaces", () => {
    const files = parseBranchDiff('diff --git "a/my file.ts" "b/my file.ts"\n--- a/my file.ts\n+++ b/my file.ts\n@@ -1 +1 @@\n-a\n+b');
    expect(files[0]!.path).toBe("my file.ts");
  });

  it("appends untracked files as numbered creates without a trailing blank row", () => {
    const files = parseBranchDiff("", [{ path: "notes.txt", text: "a\nb\n", binary: false }]);
    expect(files).toEqual([
      {
        path: "notes.txt",
        op: "create",
        rows: [
          { kind: "add", lineNum: 1, text: "a" },
          { kind: "add", lineNum: 2, text: "b" },
        ],
      },
    ]);
  });

  it("gives empty and binary untracked files no rows", () => {
    expect(parseBranchDiff("", [{ path: "e.txt", text: "", binary: false }])).toEqual([
      { path: "e.txt", op: "create", rows: [] },
    ]);
    expect(parseBranchDiff("", [{ path: "blob.bin", text: "", binary: true }])).toEqual([
      { path: "blob.bin", op: "create", rows: [], binary: true },
    ]);
  });

  it("carries renames and binary markers from git sections", () => {
    const rename = "diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n";
    const binary = "diff --git a/img.bin b/img.bin\nindex 1..2 100644\nBinary files a/img.bin and b/img.bin differ\n";
    const [r, bin] = parseBranchDiff(rename + binary);
    expect(r).toEqual({ path: "b.txt", op: "modified", rows: [], patch: rename, renamedFrom: "a.txt" });
    expect(bin!.binary).toBe(true);
    expect(bin!.rows).toEqual([]);
  });

  it("collapses to an empty list for a clean tree", () => {
    expect(parseBranchDiff("", [])).toEqual([]);
  });
});

const del = (text: string): DiffRow => ({ kind: "del", text });
const add = (text: string): DiffRow => ({ kind: "add", text });

describe("pairWordRanges", () => {
  it("marks the changed span between common prefix and suffix", () => {
    expect(pairWordRanges([del("const a = 1;"), add("const a = 2;")])).toEqual([
      [10, 11],
      [10, 11],
    ]);
  });

  it("pairs only up to the shorter run", () => {
    expect(pairWordRanges([del("x = 1"), del("y = 1"), add("x = 2")])).toEqual([[4, 5], null, [4, 5]]);
  });

  it("leaves unrelated lines and ctx-separated runs unpaired", () => {
    expect(pairWordRanges([del("abc"), add("xyz")])).toEqual([null, null]);
    expect(pairWordRanges([del("a1"), { kind: "ctx", text: "c" }, add("a2")])).toEqual([null, null, null]);
  });
});

describe("rowSegments", () => {
  const tok = (content: string, color: string) => ({ content, color, offset: 0 });

  it("splits tokens at range boundaries and joins back to the text", () => {
    const segs = rowSegments("const a = 2;", [tok("const", "#1"), tok(" a = 2;", "#2")], [10, 11]);
    expect(segs.map((s) => s.text).join("")).toBe("const a = 2;");
    expect(segs.filter((s) => s.emph)).toEqual([{ text: "2", color: "#2", emph: true }]);
    expect(segs[0]).toEqual({ text: "const", color: "#1", emph: false });
  });

  it("ignores tokens that do not join back to the text", () => {
    expect(rowSegments("abc", [tok("xyz", "#1")], null)).toEqual([{ text: "abc", emph: false }]);
  });
});
