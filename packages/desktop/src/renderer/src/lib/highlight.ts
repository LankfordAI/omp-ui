import { useEffect, useRef, useState } from "react";
import type { GrammarState, HighlighterCore, ThemedToken, ThemeRegistrationRaw } from "shiki/core";
import { DEFAULT_THEME_ID, resolveTheme, useTheme, type Theme } from "./themes";

/**
 * Syntax highlighting for transcript code blocks (issue #27).
 *
 * Everything here is lazy: the shiki core, the JS regex engine, and each
 * grammar arrive as their own dynamic chunks, so a session that never shows a
 * rust block never downloads the rust grammar. Until the highlighter resolves
 * the caller renders plain text — highlighting is an enhancement, never a
 * gate on seeing the code.
 *
 * The theme is built from the active runtime theme's `code` palette
 * (`lib/themes.ts`) rather than a stock shiki theme, so highlighted code sits
 * on the same planes as the rest of the transcript and follows a theme
 * switch. The signal accent is deliberately absent from every theme's `code`
 * map (ADR-0004): it means agent liveness, never syntax.
 */
function buildShikiTheme(theme: Theme): ThemeRegistrationRaw {
  return {
    name: `omp-${theme.id}`,
    type: theme.dark ? "dark" : "light",
    colors: {},
    settings: [
      // Default foreground = ink: code is primary reading content (issue #29).
      { settings: { foreground: theme.code.foreground } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: theme.code.comment, fontStyle: "italic" },
      },
      {
        scope: ["string", "punctuation.definition.string", "string.template"],
        settings: { foreground: theme.code.string },
      },
      {
        scope: [
          "constant.numeric",
          "constant.language",
          "constant.character",
          "constant.other.symbol",
        ],
        settings: { foreground: theme.code.constant },
      },
      {
        scope: ["keyword", "storage.type", "storage.modifier", "keyword.operator.new"],
        settings: { foreground: theme.code.keyword },
      },
      {
        scope: ["entity.name.function", "support.function", "meta.function-call entity.name"],
        settings: { foreground: theme.code.function },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "entity.other.inherited-class",
          "support.type",
          "support.class",
        ],
        settings: { foreground: theme.code.type },
      },
      {
        scope: ["variable.other.property", "support.type.property-name", "meta.object-literal.key"],
        settings: { foreground: theme.code.property },
      },
      {
        scope: ["entity.name.tag"],
        settings: { foreground: theme.code.keyword },
      },
      {
        scope: ["entity.other.attribute-name"],
        settings: { foreground: theme.code.type },
      },
      {
        scope: ["keyword.operator", "punctuation"],
        settings: { foreground: theme.code.punctuation },
      },
      {
        scope: ["markup.inserted"],
        settings: { foreground: theme.code.inserted },
      },
      {
        scope: ["markup.deleted"],
        settings: { foreground: theme.code.deleted },
      },
    ],
  };
}

/**
 * Grammars offered, keyed by shiki's canonical name. Each entry is a lazy
 * chunk; the set is curated to what a coding agent actually emits rather
 * than the full 200-grammar bundle.
 */
const LANG_IMPORTS: Record<string, () => Promise<unknown>> = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
};

/** Fence-tag spellings that differ from shiki's canonical grammar name. */
const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  "c++": "cpp",
  cs: "csharp",
  dockerfile: "docker",
  golang: "go",
  js: "javascript",
  jsonc: "json",
  kt: "kotlin",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  yml: "yaml",
};

/** `null` = unknown language: render plain, never guess a grammar. */
export function resolveLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const key = lang.toLowerCase();
  const canonical = ALIASES[key] ?? key;
  return canonical in LANG_IMPORTS ? canonical : null;
}

/** Fence-style language guess from a file path's extension; undefined when there is none. */
export function langFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

/** Payloads above this many characters stay plain; tokenizing them costs more than it shows. */
export const HIGHLIGHT_CHAR_CAP = 20_000;

/* ------------------------------------------- incremental streaming */

/**
 * Budget for the live-streaming path (issue #369). Larger than the one-shot
 * cap because each delta pays only for its newly completed lines plus the
 * unstable tail, never the accumulated prefix.
 */
export const STREAM_HIGHLIGHT_CHAR_CAP = 100_000;

/** Physical lines at or above this length never enter the grammar at all. */
export const STREAM_HIGHLIGHT_LINE_CAP = 4_000;

/** Newline-aligned chunk fed to the tokenizer per yield of the event loop. */
export const STREAM_HIGHLIGHT_BATCH_CHAR_CAP = 8_000;

/**
 * One slice tokenization: continue the grammar from `state` (undefined =
 * initial state) and return the slice's token lines plus the grammar state
 * after it. A slice ending in `\n` returns shiki's synthetic empty row for
 * the line after the final newline; the stream advance drops that row, so
 * implementations must return the tokenizer's own array identity (shiki keys
 * the grammar state on it).
 */
export type StreamSliceTokenizer = (
  slice: string,
  state: GrammarState | undefined,
) => Promise<{ lines: ThemedToken[][]; state: GrammarState }>;

/**
 * Settled streaming state: token rows through the last completed line, plus
 * the grammar state that produced them. `settledSource` always ends at a
 * newline (or is empty). Theme is bound into the key: shiki grammar states
 * are per (language, theme) pair, so a theme switch invalidates them exactly
 * like a language switch does.
 */
export interface StreamCache {
  key: string;
  settledSource: string;
  stableLines: ThemedToken[][];
  grammarState: GrammarState | undefined;
}

export type StreamAdvance =
  /** Over a line-length guard or a rejected slice: render plain source. */
  | { kind: "plain" }
  /** Superseded mid-flight: touch neither tokens nor cache. */
  | { kind: "stale" }
  | { kind: "tokens"; cache: StreamCache; lines: ThemedToken[][] };

/** True when any physical line of `source` is at or over the line guard. */
function hasOverlongPhysicalLine(source: string): boolean {
  let start = 0;
  for (;;) {
    const nl = source.indexOf("\n", start);
    if ((nl === -1 ? source.length : nl) - start >= STREAM_HIGHLIGHT_LINE_CAP) return true;
    if (nl === -1) return false;
    start = nl + 1;
  }
}

/**
 * Split a newline-terminated slice into batches of at most
 * `STREAM_HIGHLIGHT_BATCH_CHAR_CAP` characters, cut only at newline
 * boundaries (so every batch ends complete-line-aligned and carries a full
 * grammar state at its end).
 */
function splitStableBatches(slice: string): string[] {
  const batches: string[] = [];
  let start = 0;
  let pos = 0;
  while (pos < slice.length) {
    const nl = slice.indexOf("\n", pos);
    pos = nl === -1 ? slice.length : nl + 1;
    if (pos - start >= STREAM_HIGHLIGHT_BATCH_CHAR_CAP || pos === slice.length) {
      batches.push(slice.slice(start, pos));
      start = pos;
    }
  }
  return batches;
}

/**
 * Whether the incremental path may run at all for `code`: under the stream
 * char cap and free of overlong physical lines. The line guard spans the
 * whole source because a long settled line would poison every later
 * batch's grammar state (HTML's embedded CSS/JS spans lines).
 */
export function streamHighlightEligible(code: string): boolean {
  return code.length < STREAM_HIGHLIGHT_CHAR_CAP && !hasOverlongPhysicalLine(code);
}

/**
 * One commit of the stream state machine. Appends reuse `cache` and tokenize
 * only the slice between the old settled source and the new last newline,
 * batched with yields; tail-only edits re-tokenize the tail alone from the
 * cached grammar state (the tail was never committed, so a correction there
 * cannot desync the state). A key mismatch or a correction inside the settled
 * prefix rebuilds from the initial state in the same bounded batches. The
 * current unterminated tail is always tokenized from the latest stable state
 * without advancing the cache. `isCurrent` gates every batch: a superseded
 * run stops before its next tokenizer call.
 *
 * The line guard runs on the region not yet settled when `cache` is reused
 * (cached lines passed it when they settled) and over the whole source on a
 * rebuild; an overlong physical line yields `plain` rather than letting
 * shiki skip it, because a skipped line in HTML would poison the grammar
 * state of every later embedded-CSS/JS line.
 *
 * Never renders stale colors for stale input: rebuild callers see plain
 * source until this resolves (the hook's key/cache checks are that
 * caller's decision).
 */
export async function advanceStreamHighlight(opts: {
  code: string;
  key: string;
  cache: StreamCache | null;
  isCurrent: () => boolean;
  tokenize: StreamSliceTokenizer;
}): Promise<StreamAdvance> {
  const { code, key, isCurrent, tokenize } = opts;
  const cache = opts.cache;
  const settled = code.lastIndexOf("\n") + 1;
  // Reuse means: same grammar+theme key, the new last newline reaches at
  // least as far as the old settled source, and nothing before that source
  // changed. A tail-only correction qualifies (the tail was never committed
  // to grammar state); an edit inside the settled prefix does not.
  let base = 0;
  let stable: ThemedToken[][] = [];
  let state: GrammarState | undefined;
  if (
    cache !== null &&
    cache.key === key &&
    settled >= cache.settledSource.length &&
    code.startsWith(cache.settledSource)
  ) {
    base = cache.settledSource.length;
    stable = cache.stableLines.slice();
    state = cache.grammarState;
  }
  // Only the region past the last settled line is new when reusing; cached
  // lines passed the length guard when they settled. On a rebuild the whole
  // source is checked.
  if (hasOverlongPhysicalLine(code.slice(base))) return { kind: "plain" };
  const batches = splitStableBatches(code.slice(base, settled));
  for (let i = 0; i < batches.length; i++) {
    if (!isCurrent()) return { kind: "stale" };
    const result = await tokenize(batches[i]!, state);
    state = result.state;
    // The batch ends at a newline; shiki's last row is the synthetic line
    // after it, which the tail step re-tokenizes as the real line.
    stable.push(...result.lines.slice(0, -1));
    if (i < batches.length - 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
      if (!isCurrent()) return { kind: "stale" };
    }
  }
  if (!isCurrent()) return { kind: "stale" };
  const tail = await tokenize(code.slice(settled), state);
  return {
    kind: "tokens",
    cache: { key, settledSource: code.slice(0, settled), stableLines: stable, grammarState: state },
    lines: stable.concat(tail.lines),
  };
}

/** The real `StreamSliceTokenizer`: one `codeToTokensBase` per slice with
 *  the grammar continued through `grammarState`. */
export function createShikiStreamTokenizer(lang: string, theme: Theme): StreamSliceTokenizer {
  return async (slice, state) => {
    const core = await getCore();
    await ensureLang(core, lang);
    ensureTheme(core, theme);
    const lines = core.codeToTokensBase(slice, {
      lang: lang as never,
      theme: `omp-${theme.id}`,
      grammarState: state,
    });
    const next = core.getLastGrammarState(lines);
    if (next === undefined) throw new Error(`shiki returned no grammar state for ${lang}`);
    return { lines, state: next };
  };
}

/**
 * Token lines for a live, append-growing code stream, or `null` (render the
 * raw source) while loading, rebuilding, over the incremental budget, or for
 * unknown languages. Same contract as `useHighlightTokens` for the caller;
 * the difference is cost: for appends, the tokenizer only ever sees newly
 * completed lines plus the current tail, never the settled prefix, and the
 * stable rows keep object identity so line-level React memoization skips
 * them on tail updates.
 */
export function useIncrementalHighlightTokens(
  code: string,
  lang: string | undefined,
  enabled: boolean,
): ThemedToken[][] | null {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const resolved = resolveLang(lang);
  const theme = useTheme();
  const cacheRef = useRef<StreamCache | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    const isCurrent = () => genRef.current === gen;
    const finish = (cache: StreamCache | null, lines: ThemedToken[][] | null) => {
      if (!isCurrent()) return;
      cacheRef.current = cache;
      setTokens(lines);
    };
    if (!enabled || resolved === null || !streamHighlightEligible(code)) {
      finish(null, null);
      return;
    }
    const key = `${resolved}\u0000omp-${theme.id}`;
    const cache = cacheRef.current;
    const reuse = cache !== null && cache.key === key && code.startsWith(cache.settledSource);
    // A rebuild must not leave old-theme (or old-grammar) colors on screen:
    // show the raw source until the batched rebuild lands.
    if (!reuse) setTokens(null);
    void advanceStreamHighlight({
      code,
      key,
      cache: reuse ? cache : null,
      isCurrent,
      tokenize: createShikiStreamTokenizer(resolved, theme),
    })
      .then((result) => {
        if (result.kind === "stale") return;
        if (result.kind === "plain") finish(null, null);
        else finish(result.cache, result.lines);
      })
      .catch(() => {
        // A failed grammar or engine load leaves the block as plain text.
        finish(null, null);
      });
    return () => {
      genRef.current += 1;
    };
    // Tokens carry their colour as an inline style, so a theme switch only
    // reaches the rendered block by re-tokenizing it — and by discarding the
    // grammar state, which shiki binds to the theme.
  }, [code, resolved, enabled, theme]);

  return tokens;
}

/**
 * Themes registered on the core, seeded with the one `getCore` builds it
 * with. A theme is only paid for once the user actually switches to it.
 */
const loadedThemes = new Set<string>([DEFAULT_THEME_ID]);

let corePromise: Promise<HighlighterCore> | null = null;

function getCore(): Promise<HighlighterCore> {
  corePromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [buildShikiTheme(resolveTheme(DEFAULT_THEME_ID))],
      langs: [],
      // Forgiving: a grammar pattern the JS engine can't translate degrades
      // that pattern, instead of throwing away the whole block's highlighting.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return corePromise;
}

/** Grammar loads already in flight or done, so each language loads once. */
const langLoads = new Map<string, Promise<void>>();

function ensureLang(core: HighlighterCore, lang: string): Promise<void> {
  let pending = langLoads.get(lang);
  if (!pending) {
    // The lazy-import thunk is itself a valid shiki LanguageInput.
    pending = core.loadLanguage(LANG_IMPORTS[lang] as never);
    langLoads.set(lang, pending);
  }
  return pending;
}
/** Load a theme onto the core once, mirroring the transcript hook's bookkeeping. */
export function ensureTheme(core: HighlighterCore, theme: Theme): void {
  if (!loadedThemes.has(theme.id)) {
    core.loadThemeSync(buildShikiTheme(theme));
    loadedThemes.add(theme.id);
  }
}

/** One settled tokenization: core, grammar, theme, then token lines.
 *  Rejections propagate; the caller owns its fallback. */
export async function tokenizeCode(
  lang: string,
  code: string,
  theme: Theme,
): Promise<ThemedToken[][]> {
  const core = await getCore();
  await ensureLang(core, lang);
  ensureTheme(core, theme);
  return core.codeToTokensBase(code, { lang: lang as never, theme: `omp-${theme.id}` });
}

/**
 * Token lines for a settled code block, or `null` while loading / for
 * unknown languages / while `enabled` is false (the caller passes false
 * during streaming so the growing tail isn't re-tokenized on every delta).
 */
export function useHighlightTokens(
  code: string,
  lang: string | undefined,
  enabled: boolean,
): ThemedToken[][] | null {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const resolved = resolveLang(lang);
  const theme = useTheme();

  useEffect(() => {
    if (!enabled || resolved === null) {
      setTokens(null);
      return;
    }
    let alive = true;
    void (async () => {
      const lines = await tokenizeCode(resolved, code, theme);
      if (alive) setTokens(lines);
    })().catch(() => {
      // A failed grammar or engine load leaves the block as plain text.
      if (alive) setTokens(null);
    });
    return () => {
      alive = false;
    };
    // Tokens carry their colour as an inline style, so a theme switch only
    // reaches the rendered block by re-tokenizing it.
  }, [code, resolved, enabled, theme]);

  return tokens;
}
