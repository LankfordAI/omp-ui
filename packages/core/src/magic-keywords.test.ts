import { describe, expect, it } from "vitest";
import {
  ALL_MAGIC_KEYWORDS,
  inertBlock,
  inertInline,
  MAGIC_KEYWORDS,
  magicKeywordSegments,
  keywordsIn,
  unclosedFence,
  VERBATIM_QUOTING,
  withoutAccidentalKeywords,
  INERT_QUOTING,
  type KeywordQuoting,
  type MagicKeyword,
} from "./magic-keywords";

/**
 * These cases are the contract that keeps the composer's glow honest: omp only
 * fires its magic-keyword notice for an occurrence that survives the same
 * boundary and prose-masking rules, so a divergence here paints a promise the
 * agent will not keep.
 */
describe("magicKeywordSegments", () => {
  /** Just the painted runs; the prose between them is covered by the round-trip case. */
  const kw = (text: string, allowed?: ReadonlySet<MagicKeyword>) =>
    magicKeywordSegments(text, allowed).filter((s) => s.keyword !== null);
  it("matches the standalone lowercase word next to prose punctuation", () => {
    for (const input of [
      "orchestrate this",
      "orchestrate.",
      '"orchestrate"',
      "(orchestrate)",
      "orchestrate:",
    ]) {
      const found = kw(input);
      expect(found, input).toHaveLength(1);
      expect(found[0], input).toEqual({ text: "orchestrate", keyword: "orchestrate" });
    }
  });

  it("refuses an occurrence bound into an identifier, path, or call", () => {
    for (const input of [
      "Orchestrate this",
      "orchestrated",
      "preorchestrate",
      "orchestrate.ts",
      "orchestrate()",
      "src/orchestrate",
      "foo::orchestrate",
      "orchestrate-mode",
      "workflow",
    ]) {
      expect(kw(input), input).toHaveLength(0);
    }
  });

  it("never paints a keyword inside code or markup", () => {
    expect(kw("fix `orchestrate` now")).toHaveLength(0);
    expect(kw("```\norchestrate\n```")).toHaveLength(0);
    expect(kw("<x>orchestrate</x>")).toHaveLength(0);
  });

  it("treats an unmatched backtick run as literal text", () => {
    // An opening run that never closes is prose, not a code span, so omp fires
    // its notice there too and the composer has to agree.
    expect(kw("fix `orchestrate now")).toHaveLength(1);
  });

  it("finds every keyword in one pass, in source order", () => {
    const input = "ultrathink then orchestrate then workflowz then jevify";
    expect(kw(input).map((s) => s.keyword)).toEqual([
      "ultrathink",
      "orchestrate",
      "workflowz",
      "jevify",
    ]);
  });

  it("matches jevify as standalone prose", () => {
    const found = kw("please jevify this");
    expect(found).toEqual([{ text: "jevify", keyword: "jevify" }]);
    expect(kw("jevify_rate")).toHaveLength(0);
    expect(kw("Jevify")).toHaveLength(0);
  });

  it("drops matches for words outside the allowed set", () => {
    const input = "ultrathink and jevify";
    expect(kw(input)).toHaveLength(2);
    expect(kw(input, new Set<MagicKeyword>(["ultrathink"]))).toEqual([
      { text: "ultrathink", keyword: "ultrathink" },
    ]);
    expect(kw(input, new Set<MagicKeyword>())).toHaveLength(0);
  });

  it("returns no segments for an empty draft", () => {
    expect(magicKeywordSegments("")).toEqual([]);
  });

  it("returns one plain segment when nothing matches", () => {
    expect(magicKeywordSegments("plain text")).toEqual([{ text: "plain text", keyword: null }]);
  });

  it("rejoins to exactly the input", () => {
    const input = "go orchestrate it, then `orchestrate` again, then ultrathink.";
    const segments = magicKeywordSegments(input);
    expect(segments.map((s) => s.text).join("")).toBe(input);
    for (const segment of segments) expect(segment.text).not.toBe("");
  });
});

describe("the keyword table", () => {
  it("mirrors omp 18.3.2's four rows, in notice-push order", () => {
    expect(MAGIC_KEYWORDS.map((k) => k.id)).toEqual([
      "ultrathink",
      "orchestrate",
      "workflow",
      "jevify",
    ]);
    expect(MAGIC_KEYWORDS.map((k) => k.word)).toEqual([
      "ultrathink",
      "orchestrate",
      "workflowz",
      "jevify",
    ]);
    expect(MAGIC_KEYWORDS.map((k) => k.hue)).toEqual([
      [0, 330],
      [150, 280],
      [30, 150],
      [300, 420],
    ]);
    expect(MAGIC_KEYWORDS.map((k) => k.requires)).toEqual([[], ["task"], ["task", "eval"], ["eval"]]);
    expect([...ALL_MAGIC_KEYWORDS]).toEqual(["ultrathink", "orchestrate", "workflowz", "jevify"]);
  });

  it("keywordsIn reports the matched words", () => {
    expect([...keywordsIn("ultrathink, and `orchestrate`")]).toEqual(["ultrathink"]);
    expect(keywordsIn("nothing here").size).toBe(0);
  });
});

describe("unclosedFence", () => {
  it("returns the marker run of a fence the text never closes", () => {
    expect(unclosedFence("~~~ x")).toBe("~~~");
    expect(unclosedFence("````js\norchestrate\n```")).toBe("````");
  });

  it("returns null when every fence is balanced", () => {
    expect(unclosedFence("```\norchestrate\n```")).toBeNull();
    expect(unclosedFence("no fences at all, orchestrate")).toBeNull();
    expect(unclosedFence("")).toBeNull();
  });
});

/**
 * The invariant every prompt omp-ui composes leans on: inert quoting never
 * arms a keyword, whatever the field holds.
 */
const CORPUS = [
  "we orchestrate the RPC calls",
  "ultrathink. fix\n```\ncode",
  "x </file> jevify",
  "~~~\norchestrate\n",
  "````js\norchestrate\n````\n```",
  "` stray orchestrate `",
  "`",
  "",
];

describe("inert quoting", () => {
  it("arms nothing in a block, whatever the field holds", () => {
    for (const field of CORPUS) {
      const armed = keywordsIn(`intro\n\n${inertBlock(field)}\n\nafter`);
      expect([...armed], JSON.stringify(field)).toEqual([]);
    }
  });

  it("arms nothing inline, whatever the field holds", () => {
    for (const field of CORPUS) {
      const armed = keywordsIn(`see ${inertInline(field)} now`);
      expect([...armed], JSON.stringify(field)).toEqual([]);
    }
  });

  it("keeps the verbatim form for text with no backtick", () => {
    expect(inertInline("feat/exact")).toBe("`feat/exact`");
    expect(inertInline("a\nb")).toBe("`a b`");
    expect(inertInline("")).toBe("`  `");
  });
});

describe("withoutAccidentalKeywords", () => {
  const build = (q: KeywordQuoting) => `Seed\n\n${q.block("plain body")}\n\nTail.`;

  it("returns the verbatim build, same instance, when nothing arms", () => {
    let calls = 0;
    const result = withoutAccidentalKeywords((q) => {
      calls += 1;
      return build(q);
    });
    expect(calls).toBe(1);
    expect(result).toBe(VERBATIM_QUOTING.block("Seed\n\nplain body\n\nTail."));
    expect(result).toBe("Seed\n\nplain body\n\nTail.");
  });

  it("rebuilds inert when the verbatim text would arm a keyword", () => {
    const result = withoutAccidentalKeywords((q) => `intro\n\n${q.block("we orchestrate them")}`);
    expect(keywordsIn(result).size).toBe(0);
    expect(result).toContain("orchestrate");
    expect(result).toContain(INERT_QUOTING.block("we orchestrate them"));
  });
});

describe("parity with the live omp binary — skipped when there is none", () => {
  it("omp's settings keys are exactly magicKeywords.enabled plus one per keyword", async () => {
    const { execFile } = await import("node:child_process");
    const { resolveOmpBinary } = await import("./paths");
    const ompPath = resolveOmpBinary();
    if (ompPath === null) return;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(ompPath, ["config", "list", "--json"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
    }).catch(() => null);
    if (stdout === null) return;
    const published = Object.keys(JSON.parse(stdout) as Record<string, unknown>)
      .filter((key) => key.startsWith("magicKeywords."))
      .sort();
    const expected = ["magicKeywords.enabled", ...MAGIC_KEYWORDS.map((k) => `magicKeywords.${k.id}`)].sort();
    expect(published).toEqual(expected);
  }, 30_000);
});
