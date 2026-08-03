import { describe, expect, it } from "vitest";
import { parseBranchDiff, parseOmpDiff, parseUnifiedDiff } from "./omp-diff";

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
  it("maps headers to meta and content lines by sign", () => {
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
      { kind: "meta", text: "diff --git a/src/a.ts b/src/a.ts" },
      { kind: "meta", text: "index abc..def 100644" },
      { kind: "meta", text: "--- a/src/a.ts" },
      { kind: "meta", text: "+++ b/src/a.ts" },
      { kind: "meta", text: "@@ -1,3 +1,4 @@" },
      { kind: "ctx", text: "export const a = 1;" },
      { kind: "del", text: "export const b = 2;" },
      { kind: "add", text: "export const b = 3;" },
    ]);
  });

  it("treats only space-suffixed ++/-- lines as headers, content otherwise", () => {
    const rows = parseUnifiedDiff("+--- header\n+++ not a header\n+++not a header");
    expect(rows).toEqual([
      { kind: "add", text: "--- header" },
      { kind: "meta", text: "+++ not a header" },
      { kind: "add", text: "++not a header" },
    ]);
  });

  it("drops the trailing empty row after a final newline", () => {
    expect(parseUnifiedDiff("+a\n+b\n")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("passes no-newline markers through as meta", () => {
    const rows = parseUnifiedDiff("+x\n\\ No newline at end of file\n");
    expect(rows.map((r) => r.kind)).toEqual(["add", "meta"]);
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

  it("appends untracked files as creates", () => {
    const files = parseBranchDiff("", [
      { path: "notes.txt", text: "line one\nline two", binary: false },
    ]);
    expect(files).toEqual([
      {
        path: "notes.txt",
        op: "create",
        rows: [
          { kind: "add", text: "line one" },
          { kind: "add", text: "line two" },
        ],
      },
    ]);
  });

  it("renders untracked binaries as a single meta row", () => {
    const files = parseBranchDiff("", [{ path: "blob.bin", text: "", binary: true }]);
    expect(files).toEqual([{ path: "blob.bin", op: "create", rows: [{ kind: "meta", text: "binary file" }] }]);
  });

  it("collapses to an empty list for a clean tree", () => {
    expect(parseBranchDiff("", [])).toEqual([]);
  });
});
