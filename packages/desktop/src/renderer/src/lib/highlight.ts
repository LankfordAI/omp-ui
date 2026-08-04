import { useEffect, useState } from "react";
import type { HighlighterCore, ThemedToken, ThemeRegistrationRaw } from "shiki/core";

/**
 * Syntax highlighting for transcript code blocks (issue #27).
 *
 * Everything here is lazy: the shiki core, the JS regex engine, and each
 * grammar arrive as their own dynamic chunks, so a session that never shows a
 * rust block never downloads the rust grammar. Until the highlighter resolves
 * the caller renders plain text — highlighting is an enhancement, never a
 * gate on seeing the code.
 *
 * The theme is built from the design tokens in style.css rather than a stock
 * shiki theme, so highlighted code sits on the same graphite planes as the
 * rest of the transcript. The signal mint is deliberately absent (ADR-0004):
 * strings lean copper, keywords iris, and the cool blues/teals are new hues
 * that read as content, not liveness.
 */
const GRAPHITE: ThemeRegistrationRaw = {
  name: "omp-graphite",
  type: "dark",
  colors: {},
  settings: [
    // Default foreground = ink: code is primary reading content (issue #29).
    { settings: { foreground: "#e8ecf1" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#5f6b7c", fontStyle: "italic" },
    },
    {
      scope: ["string", "punctuation.definition.string", "string.template"],
      settings: { foreground: "#e0b184" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character",
        "constant.other.symbol",
      ],
      settings: { foreground: "#e39db5" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier", "keyword.operator.new"],
      settings: { foreground: "#9d8cf5" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call entity.name"],
      settings: { foreground: "#7fb8e8" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.type",
        "support.class",
      ],
      settings: { foreground: "#6fc7d4" },
    },
    {
      scope: ["variable.other.property", "support.type.property-name", "meta.object-literal.key"],
      settings: { foreground: "#a8c5e8" },
    },
    {
      scope: ["entity.name.tag"],
      settings: { foreground: "#9d8cf5" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#6fc7d4" },
    },
    {
      scope: ["keyword.operator", "punctuation"],
      settings: { foreground: "#a8b2bf" },
    },
    {
      scope: ["markup.inserted"],
      settings: { foreground: "#8fd4b8" },
    },
    {
      scope: ["markup.deleted"],
      settings: { foreground: "#f2748c" },
    },
  ],
};

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
function resolveLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const key = lang.toLowerCase();
  const canonical = ALIASES[key] ?? key;
  return canonical in LANG_IMPORTS ? canonical : null;
}

let corePromise: Promise<HighlighterCore> | null = null;

function getCore(): Promise<HighlighterCore> {
  corePromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [GRAPHITE],
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

  useEffect(() => {
    if (!enabled || resolved === null) {
      setTokens(null);
      return;
    }
    let alive = true;
    void (async () => {
      const core = await getCore();
      await ensureLang(core, resolved);
      const lines = core.codeToTokensBase(code, { lang: resolved as never, theme: "omp-graphite" });
      if (alive) setTokens(lines);
    })().catch(() => {
      // A failed grammar or engine load leaves the block as plain text.
      if (alive) setTokens(null);
    });
    return () => {
      alive = false;
    };
  }, [code, resolved, enabled]);

  return tokens;
}
