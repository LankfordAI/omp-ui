import { describe, expect, it } from "vitest";
import { parseOmpDiff } from "./omp-diff";

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
