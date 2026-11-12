import { describe, expect, it } from "vitest";
import { transcriptPlanCandidates } from "./transcript-plan-source";

const html = "<!doctype html><html><body>Plan &amp; 😀</body></html>";
function entry(id: string, parentId: string | null, content: unknown = html, role = "user", stopReason = "stop") {
  return { id, parentId, type: "message", timestamp: "2026-11-12T00:00:00Z", message: { role, content, stopReason } };
}

describe("transcriptPlanCandidates", () => {
  it("preserves duplicate entries and duplicate fences with absolute part indices", () => {
    const text = `intro\n\`\`\`html\n${html}\n\`\`\`\n\`\`\`html\n${html}\n\`\`\``;
    const parts = [{ type: "thinking", thinking: html }, { type: "image", data: html }, { type: "text", text }];
    const result = transcriptPlanCandidates([entry("a", null, parts), entry("b", "a", parts, "assistant", "toolUse")], "b")!;
    expect(result.map((candidate) => [candidate.entryId, candidate.contentIndex, candidate.start])).toEqual([
      ["a", 2, text.indexOf(html)], ["a", 2, text.lastIndexOf(html)], ["b", 2, text.indexOf(html)], ["b", 2, text.lastIndexOf(html)],
    ]);
    for (const candidate of result) {
      expect(candidate.text).toBe(text);
      expect(candidate.text.slice(candidate.start, candidate.end)).toBe(`${html}\n`);
    }
  });

  it.each(["\n", "\r\n", "\r"])("keeps original UTF16 offsets and list indentation with %j lines", (newline) => {
    const body = `  ${html}${newline}`;
    const text = `😀 &amp; prose${newline}\t12. ~~~~HTML extra${newline}${body}\t~~~~~${newline}`;
    const candidate = transcriptPlanCandidates([entry("a", null, text)], "a")![0]!;
    expect(candidate.start).toBe(text.indexOf(body));
    expect(candidate.end).toBe(text.indexOf("\t~~~~~"));
    expect(candidate.text.slice(candidate.start, candidate.end)).toBe(body);
  });

  it("treats a whole document as one option even with internal fences", () => {
    const text = `<html><body>\n\`\`\`html\n${html}\n\`\`\`\n</body></html>\r\n`;
    expect(transcriptPlanCandidates([entry("a", null, text)], "a")).toEqual([
      { entryId: "a", role: "user", timestamp: "2026-11-12T00:00:00Z", contentIndex: null, start: 0, end: text.length, text },
    ]);
  });

  it("excludes incomplete, nonhtml and mixed prose documents and nested fences", () => {
    const samples = [html + " prose", "prose " + html, "```html\n" + html, "```js\n" + html + "\n```", "```text\n```html\n" + html + "\n```\n```", "```html\n<html>\n```", "```html\n" + html + "\n~~~"];
    for (const text of samples) expect(transcriptPlanCandidates([entry("a", null, text)], "a")).toEqual([]);
  });

  it("includes only users and completed assistants", () => {
    const roles = [entry("a", null), entry("b", "a", html, "assistant"), entry("c", "b", html, "assistant", "toolUse"), entry("d", "c", html, "toolResult"), entry("e", "d", html, "assistant", "error"), entry("f", "e", html, "assistant", "aborted"), entry("g", "f", html, "assistant", "length")];
    expect(transcriptPlanCandidates(roles, "g")!.map((candidate) => candidate.entryId)).toEqual(["a", "b", "c"]);
  });

  it("walks through compaction and ignores offbranch messages", () => {
    const entries = [entry("a", null), { id: "compact", parentId: "a", type: "compaction", firstKeptEntryId: "compact" }, entry("b", "compact"), entry("off", "a")];
    expect(transcriptPlanCandidates(entries, "b")!.map((candidate) => candidate.entryId)).toEqual(["a", "b"]);
  });

  it("rejects duplicate ids, cycles, missing leaf and malformed ancestry", () => {
    const samples = [[entry("a", null), entry("a", null)], [entry("a", "b"), entry("b", "a")], [entry("a", "missing")], [{ ...entry("a", null), parentId: 1 }], [{ ...entry("a", null), parentId: undefined }], [null], [entry("other", null)]];
    for (const entries of samples) expect(transcriptPlanCandidates(entries, "a")).toBeNull();
    expect(transcriptPlanCandidates([], null)).toBeNull();
  });
});

describe("transcript plan fence boundaries", () => {
  it.each(["- ", "+ ", "* ", "1. ", "2) ", "\t"])("recognizes one list marker or indentation %j", (prefix) => {
    const text = `${prefix}\`\`\`HTML meta\n${html}\n  \`\`\`\`\t`;
    const candidates = transcriptPlanCandidates([entry("a", null, text)], "a")!;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.text.slice(candidates[0]!.start, candidates[0]!.end)).toBe(`${html}\n`);
  });

  it("requires a whitespace-delimited html token and a same-character sufficient closer", () => {
    for (const text of [`\`\`\`html-extra\n${html}\n\`\`\``, `\`\`\`\`html\n${html}\n\`\`\``, `~~~html\n${html}\n~~~ trailing`, `- - \`\`\`html\n${html}\n\`\`\``]) {
      expect(transcriptPlanCandidates([entry("a", null, text)], "a")).toEqual([]);
    }
  });
});
