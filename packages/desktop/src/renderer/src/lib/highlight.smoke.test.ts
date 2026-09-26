// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GrammarState, ThemedToken } from "shiki/core";
import {
  advanceStreamHighlight,
  createShikiStreamTokenizer,
  tokenizeCode,
  useIncrementalHighlightTokens,
  STREAM_HIGHLIGHT_CHAR_CAP,
  type StreamAdvance,
  type StreamCache,
} from "./highlight";
import { applyTheme, DEFAULT_THEME_ID, resolveTheme, THEMES } from "./themes";

// Real shiki, real HTML grammar, real runtime theme — the equivalence claim
// behind grammar-state continuation: streaming a source in pieces and
// continuing the grammar must produce byte-identical token content and
// identical colours to one-pass tokenization (offsets are chunk-relative in
// the incremental path, so they are not compared; the renderer never reads
// them). Cuts land inside a tag, an attribute value, a comment, a <style>
// rule, and a <script> statement, in source order: every position where an
// incomplete grammar context could leak into later lines.

const theme = resolveTheme(DEFAULT_THEME_ID);
const KEY = `html\u0000omp-${theme.id}`;

/** Incomplete-prefix markers, ascending by offset within one block. */
const MARKS = [
  "<!-- a streamed comme", // inside a comment
  '<section class="pl', // inside a tag: attribute started, not closed
  'data-step="4', // inside an attribute value
  ".plan { color: #2", // inside a <style> rule
  "console.log(t.le", // inside a <script> statement
] as const;

function sampleBlock(): string {
  return [
    "<!-- a streamed comment <div> that must not toggle -->",
    '<section class="plan" data-step="4">',
    "  <h2>Incremental highlighting</h2>",
    "  <style>",
    "    .plan { color: #222; background: #fff; }",
    '    .plan[data-step]::after { content: "\\2192"; }',
    "  </style>",
    "  <script>",
    "    const t = document.querySelectorAll('.plan');",
    "    // trailing </div in a JS comment must not toggle HTML",
    '    console.log(t.length, "<em>alert</em>");',
    "  </script>",
    '  <a href="#x" title="a &quot;b&quot; c">link</a>',
    "</section>",
    "",
  ].join("\n");
}

function sampleHtml(): string {
  // 478 chars per block; 45 blocks ≈ 21.5k — over the one-shot cap, under
  // the stream cap.
  return sampleBlock().repeat(45);
}

/** Prefix lengths at which the stream is cut, ascending, all < source.length. */
function cutPoints(source: string, marks: readonly string[]): number[] {
  const cuts: number[] = [];
  let from = 0;
  for (const mark of marks) {
    const idx = source.indexOf(mark, from);
    expect(idx, `sample must contain ${mark} after ${from}`).toBeGreaterThan(-1);
    cuts.push(idx + mark.length);
    from = idx + 1;
  }
  return cuts;
}

function flat(lines: Array<Array<{ content: string }>>): string {
  return lines.map((line) => line.map((t) => t.content).join("")).join("\n");
}

async function streamAll(source: string, cuts: number[]) {
  const inner = createShikiStreamTokenizer("html", theme);
  const slices: string[] = [];
  const tokenize = async (slice: string, state: GrammarState | undefined) => {
    slices.push(slice);
    return inner(slice, state);
  };
  let cache: StreamCache | null = null;
  const prefixes = [...cuts, source.length];
  let last: StreamAdvance | null = null;
  for (const end of prefixes) {
    last = await advanceStreamHighlight({
      code: source.slice(0, end),
      key: KEY,
      cache,
      isCurrent: () => true,
      tokenize,
    });
    expect(last.kind, `prefix cut at ${end}`).toBe("tokens");
    if (last.kind !== "tokens") throw new Error("unexpected plain fallback");
    cache = last.cache;
  }
  if (!last) throw new Error("no prefixes");
  // Structural O(delta): every fed slice is a ≤8k batch or the current
  // tail — never the accumulated draft.
  for (const slice of slices) {
    expect(slice.length).toBeLessThan(source.length);
  }
  return { last, cache, slices };
}

function compareLines(
  inc: StreamAdvance,
  onePass: Array<Array<{ content: string; color?: string; fontStyle?: number }>>,
) {
  expect(inc.kind).toBe("tokens");
  if (inc.kind !== "tokens") return;
  expect(inc.lines.length).toBe(onePass.length);
  for (let i = 0; i < onePass.length; i++) {
    const a = inc.lines[i]!;
    const b = onePass[i]!;
    expect(a.map((t) => t.content), `line ${i} content`).toEqual(b.map((t) => t.content));
    expect(a.map((t) => t.color ?? null), `line ${i} color`).toEqual(
      b.map((t) => t.color ?? null),
    );
    expect(a.map((t) => t.fontStyle ?? 0), `line ${i} style`).toEqual(
      b.map((t) => t.fontStyle ?? 0),
    );
  }
}

describe("incremental vs one-pass with the real HTML grammar", () => {
  const source = sampleHtml();

  // Generous timeouts: under full-suite CPU contention the real-grammar
  // tokenization can exceed vitest's 5 s default; correctness, not timing,
  // is what is asserted.
  it("sample exceeds the one-shot cap and stays under the stream cap", () => {
    expect(source.length).toBeGreaterThan(20_000);
    expect(source.length).toBeLessThan(STREAM_HIGHLIGHT_CHAR_CAP);
  });

  it("streamed tokenization equals one-pass tokenization token for token", { timeout: 30_000 }, async () => {
    const { last } = await streamAll(source, cutPoints(source, MARKS));
    compareLines(last, await tokenizeCode("html", source, theme));
    // And the rendered rows reproduce the source exactly.
    if (last.kind === "tokens") expect(flat(last.lines)).toBe(source);
  });

  it("a cut mid-<script> keeps the tail line's embedded scope exact", { timeout: 30_000 }, async () => {
    // Stream to the mid-script cut only: the tail at that point must
    // tokenize under the same embedded-JS scope one-pass gives it.
    const cut = cutPoints(source, MARKS).at(-1)!;
    const mid = source.slice(0, cut);
    const { last } = await streamAll(mid, cutPoints(mid, MARKS.slice(0, -1)));
    const onePass = await tokenizeCode("html", mid, theme);
    expect(last.kind).toBe("tokens");
    if (last.kind !== "tokens") return;
    const tailInc = last.lines.at(-1)!;
    const tailOne = onePass.at(-1)!;
    expect(tailInc.map((t) => t.content)).toEqual(tailOne.map((t) => t.content));
    expect(tailInc.map((t) => t.color ?? null)).toEqual(tailOne.map((t) => t.color ?? null));
  });
});

/* ---------------------------------------- hook over React (live path) */

// The hook itself, driven exactly like ToolCard drives it during a live
// write: render, commit the growing source, let the batch yields land.
// This is the automated stand-in for the native-transcript smoke check
// (issue #369). Real timers are deliberate here: the hook's inter-batch
// yields are real setTimeout calls, and the poll below waits on the actual
// state signal (rows matching the expected source), never a guessed sleep.
interface HookProbe {
  source: string;
  lines: ThemedToken[][] | null;
  root: Root;
  /** Commits `source` to the hook host (setState → re-render → effect). */
  commit: () => void;
}

function HookHost({ probe }: { probe: HookProbe }) {
  const [code, setCode] = useState(probe.source);
  probe.commit = () => setCode(probe.source);
  probe.lines = useIncrementalHighlightTokens(code, "html", true);
  return null;
}

function renderHook(source: string): HookProbe {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const probe: HookProbe = { source, lines: null, root, commit: () => {} };
  act(() => root.render(createElement(HookHost, { probe })));
  return probe;
}

/** Streams `chunks` through the hook, awaiting the rows-match signal. */
async function stream(probe: HookProbe, chunks: string[]) {
  let want = "";
  for (const chunk of chunks) {
    probe.source += chunk;
    want += chunk;
    let done = false;
    for (let i = 0; i < 400 && !done; i++) {
      await act(async () => {
        probe.commit();
        await new Promise((r) => setTimeout(r, 5));
      });
      done = probe.lines !== null && flat(probe.lines) === want;
    }
    expect(done, `hook settled at ${probe.source.length} chars`).toBe(true);
  }
}

describe("useIncrementalHighlightTokens live stream (real shiki)", () => {
  beforeEach(() => {
    applyTheme(resolveTheme(DEFAULT_THEME_ID));
  });

  const chunks = (size: number, take?: number) => {
    const source = sampleHtml();
    const parts: string[] = [];
    for (let i = 0; i < source.length; i += size) parts.push(source.slice(i, i + size));
    return take === undefined ? parts : parts.slice(0, take);
  };

  it("streams past the one-shot cap with colored tokens", { timeout: 30_000 }, async () => {
    const probe = renderHook("");
    await stream(probe, chunks(4_000));

    const lines = probe.lines;
    expect(lines).not.toBeNull();
    expect(lines!.length).toBeGreaterThan(100);
    // Colored beyond the one-shot cap: at least one non-default colour.
    const colours = new Set(lines!.flat().map((t) => t.color ?? null));
    expect(colours.size).toBeGreaterThan(1);
    // Rows reconstruct the source.
    expect(flat(lines!)).toBe(sampleHtml());
    act(() => probe.root.unmount());
  });

  it("stable rows keep identity across an append", { timeout: 30_000 }, async () => {
    const probe = renderHook("");
    await stream(probe, chunks(4_000, 3));
    const before = probe.lines!;
    expect(before).not.toBeNull();

    const cut = before.length - 1; // rows before the last (tail-bearing) line
    probe.source += "\n// tail line\n";
    for (let i = 0; i < 400 && !(probe.lines && flat(probe.lines).endsWith("// tail line\n")); i++) {
      await act(async () => {
        probe.commit();
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    const after = probe.lines!;
    expect(after.length).toBeGreaterThan(cut);
    // Every row that existed before the append is the same array object —
    // which is what lets ToolLine's memo skip them.
    for (let i = 0; i < cut; i++) expect(after[i]).toBe(before[i]);
    act(() => probe.root.unmount());
  });
  it("a theme switch mid-stream rebuilds without old-theme colours", { timeout: 30_000 }, async () => {
    const probe = renderHook("");
    await stream(probe, chunks(4_000, 3));
    const oldColours = new Set((probe.lines ?? []).flat().map((t) => t.color ?? null));

    const next = THEMES.find((t) => t.id !== DEFAULT_THEME_ID)!;
    act(() => applyTheme(next));
    await settleTo(probe);
    const rebuilt = probe.lines;
    expect(rebuilt).not.toBeNull();
    const newColours = new Set((rebuilt ?? []).flat().map((t) => t.color ?? null));
    const palette = Object.values(next.code).map((c) => c.toLowerCase());
    for (const c of newColours) {
      if (c) expect(palette, `colour ${c} after switch`).toContain(c.toLowerCase());
    }
    // Colours unique to the old theme are gone entirely.
    const oldOnly = [...oldColours].filter((c) => c && !palette.includes(c.toLowerCase()));
    for (const c of oldOnly) expect(newColours.has(c)).toBe(false);
    act(() => {
      applyTheme(resolveTheme(DEFAULT_THEME_ID));
      probe.root.unmount();
    });
  });

  /** Lets the hook run until its rows exactly reproduce the current source. */
  async function settleTo(probe: HookProbe) {
    for (let i = 0; i < 400; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      if (probe.lines && flat(probe.lines) === probe.source) return;
    }
  }
});
