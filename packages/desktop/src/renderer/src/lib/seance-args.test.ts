import { describe, expect, it } from "vitest";
import { parseSeanceArgs } from "./seance-args";

describe("parseSeanceArgs (issue #885)", () => {
  it.each([
    ["", {}],
    ["   ", {}],
    ["019faeab", { source: "019faeab" }],
    ["/home/u/x.jsonl", { source: "/home/u/x.jsonl" }],
    ["./rel/session.jsonl.gz", { source: "./rel/session.jsonl.gz" }],
    ["019faeab --model anthropic/a:b", { source: "019faeab", model: "anthropic/a:b" }],
    ["--model anthropic/a:b 019faeab", { source: "019faeab", model: "anthropic/a:b" }],
    ["019faeab --model=anthropic/a:b", { source: "019faeab", model: "anthropic/a:b" }],
    ["--model=anthropic/a:b", { model: "anthropic/a:b" }],
  ] as const)("parses %j", (args, want) => {
    expect(parseSeanceArgs(args)).toEqual(want);
  });

  it.each([
    ["--model", "--model needs a selector"],
    ["--model --other", "--model needs a selector"],
    ["019faeab --model", "--model needs a selector"],
    ["--model a --model b", "--model may appear only once"],
    ["--model=a --model=b", "--model may appear only once"],
    ["--fast", 'unknown flag “--fast”'],
    ["019faeab 019faecd", "at most one session"],
  ] as const)("refuses %j", (args, reason) => {
    const parsed = parseSeanceArgs(args);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain(reason);
    expect(parsed.source).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });

  it("carries the usage sentence in every refusal", () => {
    for (const args of ["--fast", "--model", "a b"]) {
      expect(parseSeanceArgs(args).error).toMatch(/^usage: \/seance \[session id\|path\] \[--model selector\]/);
    }
  });
});
