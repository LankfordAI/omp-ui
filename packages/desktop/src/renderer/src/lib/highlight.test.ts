// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { GrammarState, ThemedToken } from "shiki/core";
import {
  advanceStreamHighlight,
  streamHighlightEligible,
  STREAM_HIGHLIGHT_BATCH_CHAR_CAP,
  STREAM_HIGHLIGHT_CHAR_CAP,
  STREAM_HIGHLIGHT_LINE_CAP,
  type StreamAdvance,
  type StreamCache,
  type StreamSliceTokenizer,
} from "./highlight";

// The state machine runs against a fake slice tokenizer that reproduces
// shiki's contract (line rows, plus a synthetic empty row after a
// newline-terminated slice) and records every input, so the O(delta) claims
// are enforced structurally: an append that resent the settled prefix shows
// up as a recorded slice, not as a timing assertion. No real shiki here —
// the smoke test owns grammar fidelity.

interface FakeCall {
  slice: string;
  state: GrammarState | undefined;
}

function harness(startState = 1) {
  const calls: FakeCall[] = [];
  let seq = startState;
  const tokenize: StreamSliceTokenizer = async (slice, state) => {
    calls.push({ slice, state });
    // Mirrors shiki's splitLines: /\r?\n/ separators, CR not in content.
    const parts = slice.split(/\r?\n/);
    const terminated = slice.endsWith("\n");
    const actual = parts.map((line) => [{ content: line, offset: 0 }] as ThemedToken[]);
    // Newline-terminated slices end with shiki's synthetic empty row; the
    // empty input tokenizes to exactly one empty row.
    const lines = slice === "" ? [[]] : terminated ? [...actual.slice(0, -1), []] : actual;
    return { lines, state: { id: ++seq } as unknown as GrammarState };
  };
  return { calls, tokenize };
}

const KEY = "html\u0000omp-graphite";

function run(
  code: string,
  tokenize: StreamSliceTokenizer,
  cache: StreamCache | null = null,
  key = KEY,
  isCurrent: () => boolean = () => true,
): Promise<StreamAdvance> {
  return advanceStreamHighlight({ code, key, cache, isCurrent, tokenize });
}

function settled(result: StreamAdvance, key = KEY): StreamCache {
  if (result.kind !== "tokens") throw new Error("expected a tokens result");
  return { ...result.cache, key };
}

function rowsOf(result: StreamAdvance): string[] {
  if (result.kind !== "tokens") throw new Error("expected a tokens result");
  return result.lines.map((line) => line.map((t) => t.content).join(""));
}

describe("advanceStreamHighlight append contract", () => {
  it("an append tokenizes only newly completed lines plus the current tail", async () => {
    const { calls, tokenize } = harness();
    const first = await run("a\nb\n<c", tokenize);
    calls.length = 0;

    const second = await run("a\nb\ncc\nd", tokenize, settled(first));

    // Settled prefix never resent: the only stable slice is the newly
    // completed line, and the final call is the unterminated tail.
    expect(calls.map((c) => c.slice)).toEqual(["cc\n", "d"]);
    expect(second.kind).toBe("tokens");
  });

  it("keeps stable line arrays referentially identical across appends", async () => {
    const { tokenize } = harness();
    const first = await run("a\nb\n", tokenize);
    if (first.kind !== "tokens") throw new Error("expected tokens");

    const second = await run("a\nb\nc\n", tokenize, settled(first));
    if (second.kind !== "tokens") throw new Error("expected tokens");
    expect(second.lines[0]).toBe(first.lines[0]);
    expect(second.lines[1]).toBe(first.lines[1]);
  });

  it("a tail-only correction reuses the stable grammar state", async () => {
    const { calls, tokenize } = harness();
    const first = await run("a\n<bb", tokenize);
    const stateAfterStable = calls.at(-1)!.state;
    calls.length = 0;

    const second = await run("a\n<cc", tokenize, settled(first));

    // No stable batch (nothing newly completed); the single tail call enters
    // from the exact state the stable region settled with.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice).toBe("<cc");
    expect(calls[0]!.state).toBe(stateAfterStable);
    expect(second.kind).toBe("tokens");
    // Tail correction must not have advanced the settled boundary.
    expect(settled(second).settledSource).toBe("a\n");
  });

  it("a correction inside the settled prefix rebuilds from the initial state", async () => {
    const { calls, tokenize } = harness();
    const first = await run("a\nb\n", tokenize);
    calls.length = 0;

    const second = await run("X\nb\n", tokenize, settled(first));

    expect(second.kind).toBe("tokens");
    expect(calls[0]!.slice).toBe("X\nb\n");
    expect(calls[0]!.state).toBeUndefined();
  });

  it("a key change (language or theme) rebuilds from the initial state", async () => {
    const { calls, tokenize } = harness();
    const first = await run("a\nb\n", tokenize);
    calls.length = 0;

    const second = await run("a\nb\nc", tokenize, settled(first), "css\u0000omp-graphite");

    expect(calls[0]!.state).toBeUndefined();
    expect(calls[0]!.slice).toBe("a\nb\n");
    expect(settled(second, "css\u0000omp-graphite").key).toBe("css\u0000omp-graphite");
  });

  it("a superseded run stops before its next tokenizer call", async () => {
    const { calls, tokenize } = harness();
    let current = true;
    const line = `${"x".repeat(60)}\n`;
    const lines = line.repeat(Math.ceil((2.5 * STREAM_HIGHLIGHT_BATCH_CHAR_CAP) / line.length));
    const advancing = run(lines, tokenize, null, KEY, () => current);
    // Supersede the run immediately; at most the batch in flight may call.
    current = false;
    const stale = await advancing;
    expect(stale.kind).toBe("stale");
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("isCurrent false at entry makes no tokenizer call at all", async () => {
    const { calls, tokenize } = harness();
    const result = await run("a\nb\n", tokenize, null, KEY, () => false);
    expect(result.kind).toBe("stale");
    expect(calls).toHaveLength(0);
  });

  it("a rejected tokenizer propagates to the caller (hook: plain)", async () => {
    await expect(
      run("a\n", async () => {
        throw new Error("grammar load failed");
      }),
    ).rejects.toThrow("grammar load failed");
  });
});

describe("advanceStreamHighlight source shapes", () => {
  it("empty input yields one empty row and reconstructs the source", async () => {
    const { calls, tokenize } = harness();
    const result = await run("", tokenize);
    expect(rowsOf(result)).toEqual([""]);
    expect(calls.map((c) => c.slice)).toEqual([""]);
    expect(settled(result).settledSource).toBe("");
  });

  it("a trailing newline settles fully; the tail tokenizes the empty string", async () => {
    const { calls, tokenize } = harness();
    const result = await run("a\n", tokenize);
    expect(settled(result).settledSource).toBe("a\n");
    expect(calls.at(-1)!.slice).toBe("");
    // The renderer joins rows with "\n" between them, so ["a", ""] renders
    // "a" + "\n" + "" = the exact source.
    expect(rowsOf(result).join("\n")).toBe("a\n");
  });

  it("CRLF settles at the LF; CR is separator, not content", async () => {
    const { tokenize } = harness();
    const result = await run("a\r\nb\r\n", tokenize);
    expect(rowsOf(result)).toEqual(["a", "b", ""]);
    expect(settled(result).settledSource).toBe("a\r\nb\r\n");
  });

  it("an unterminated single line never enters the stable cache", async () => {
    const { calls, tokenize } = harness();
    const result = await run("no newline at all", tokenize);
    expect(settled(result).settledSource).toBe("");
    expect(settled(result).stableLines).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice).toBe("no newline at all");
  });

  it("rendered rows always concatenate back to the exact source", async () => {
    const { tokenize } = harness();
    const sources = ["", "\n", "a", "a\n", "a\nb", "a\nb\n", "a\n\nb\n", "line1\nline2\n"];
    let cache: StreamCache | null = null;
    for (const source of sources) {
      const result = await run(source, tokenize, cache);
      expect(result.kind, source).toBe("tokens");
      if (result.kind !== "tokens") continue;
      expect(rowsOf(result).join("\n"), source).toBe(source);
      cache = settled(result);
    }
  });
});

describe("advanceStreamHighlight batching and guards", () => {
  const manyLines = (total: number) => {
    const line = `${"x".repeat(60)}\n`;
    return line.repeat(Math.ceil(total / line.length));
  };

  it("large stable slices are split into newline-aligned batches near 8k", async () => {
    const { calls, tokenize } = harness();
    const code = manyLines(2.5 * STREAM_HIGHLIGHT_BATCH_CHAR_CAP) + "tail";
    const result = await run(code, tokenize);

    const stable = calls.slice(0, -1); // all but the tail call
    expect(stable.length).toBe(3);
    for (const c of stable) {
      expect(c.slice.endsWith("\n")).toBe(true);
      // Cut at a newline once the cap is reached, so a batch exceeds 8k by
      // at most one physical line.
      expect(c.slice.length).toBeLessThan(
        STREAM_HIGHLIGHT_BATCH_CHAR_CAP + STREAM_HIGHLIGHT_LINE_CAP,
      );
    }
    expect(stable[0]!.state).toBeUndefined();
    expect(stable[1]!.state).toBeDefined();
    expect(calls.at(-1)!.slice).toBe("tail");
    expect(result.kind).toBe("tokens");
  });

  it("a stable slice under the batch cap stays one tokenizer call", async () => {
    const { calls, tokenize } = harness();
    await run(manyLines(STREAM_HIGHLIGHT_BATCH_CHAR_CAP - 100), tokenize);
    expect(calls.slice(0, -1)).toHaveLength(1);
  });

  it("an overlong physical line falls back to plain without calling the tokenizer", async () => {
    const { calls, tokenize } = harness();
    const long = "y".repeat(STREAM_HIGHLIGHT_LINE_CAP);
    const result = await run(`a\n${long}\nb\n`, tokenize);
    expect(result.kind).toBe("plain");
    expect(calls).toHaveLength(0);
  });

  it("a newly appended overlong line ends the incremental run", async () => {
    const { calls, tokenize } = harness();
    const first = await run("a\nb\n", tokenize);
    calls.length = 0;
    const second = await run(
      `a\nb\n${"y".repeat(STREAM_HIGHLIGHT_LINE_CAP)}`,
      tokenize,
      settled(first),
    );
    expect(second.kind).toBe("plain");
    expect(calls).toHaveLength(0);
  });
});

describe("streamHighlightEligible", () => {
  it("accepts just under the char cap, rejects at it", () => {
    const sample = (n: number) => `${"a".repeat(100)}\n`.repeat(Math.ceil(n / 101)).slice(0, n);
    expect(streamHighlightEligible(sample(STREAM_HIGHLIGHT_CHAR_CAP - 1))).toBe(true);
    expect(streamHighlightEligible(sample(STREAM_HIGHLIGHT_CHAR_CAP))).toBe(false);
  });

  it("rejects a physical line at the line cap, accepts one under it", () => {
    expect(
      streamHighlightEligible(`a\n${"b".repeat(STREAM_HIGHLIGHT_LINE_CAP - 1)}\nc`),
    ).toBe(true);
    expect(streamHighlightEligible(`a\n${"b".repeat(STREAM_HIGHLIGHT_LINE_CAP)}`)).toBe(false);
    expect(streamHighlightEligible("b".repeat(STREAM_HIGHLIGHT_LINE_CAP))).toBe(false);
  });

  it("rejects an overlong line anywhere, including the first", () => {
    const long = "z".repeat(STREAM_HIGHLIGHT_LINE_CAP);
    expect(streamHighlightEligible(`${long}\nshort\n`)).toBe(false);
    expect(streamHighlightEligible(`short\n${long}\nshort`)).toBe(false);
  });
});
