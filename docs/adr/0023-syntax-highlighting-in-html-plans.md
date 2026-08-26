# Syntax highlighting for code blocks in HTML plans: renderer tokenizes at review

ADR-0014 made the HTML file the one and only plan, and its code blocks render
as unhighlighted plain monospace text in the plan review — while the native
transcript has highlighted identical content since issue #27 (shiki). The
review is where plans are judged, and plans are code-dense: every step,
signature, and command block is harder to scan as a wall of single-colour text
than it needs to be. Issue #319.

## Decision

The agent never writes token markup. A code block is highlighted when its
`<code>` element (or its parent `<pre>`, when the code carries no class) is
classed `language-<lang>` — highlight.js spelling, matching markdown fence
tags. `preparePlanDocument` tokenizes each block in the trusted renderer
process at review time through the existing shiki integration (issue #27's
core, grammar table, and runtime-theme build), and the sandboxed plan iframe
(`sandbox=""`, unchanged — ADR-0007's posture is intact: the host app, not the
document, does the tokenizing) receives only inert `<span class="tk-N">`
spans plus a renderer-generated rule per (colour, font-style) pair.

- **No new dependency.** `shiki` + `@shikijs/langs` already ship as
  `packages/desktop` dependencies; the plan path reuses the transcript's lazy
  core, curated grammar set, and `omp-<theme-id>` theme build, so a plan with
  highlighted code costs nothing beyond its first tokenization. ADR-0002 is
  intact: only `packages/core`'s prompt *string* gains the language-class
  contract — all rendering lives in desktop.
- **Token colours survive the guardrail by specificity, not by negation.**
  ADR-0020 found the guardrail's `:not(svg, svg *)` negation is not honored
  by every CSS parser and gave diagrams an explicit carve-out. The token rule
  `.omp-ui-hl .tk-N { color: … !important; }` (specificity 0-2-0) beats the
  universal `color: inherit !important` rule (0-0-1) at equal `!important`
  tier in any parser, so the guardrail stays the final stylesheet and no
  inline-`!important` fighting is needed.
- **Idempotent by consumption.** The first prepare pass drops the
  `language-*` token from the element (re-emitting the block with
  `class="omp-ui-hl"`), so a second prepare pass over the prepared document
  finds no language classes and returns the bytes unchanged.
- **Plain is the fallback, with no callout.** Mermaid gets an error callout
  because the SVG *is* the content; here the plain text is the content, so an
  unrecognized language, an over-cap block (same 20,000-character cap as the
  transcript), or a failed grammar/engine load simply leaves the block plain —
  "highlighting is an enhancement, never a gate."
- **Live theme.** `usePreparedPlanDocument` takes the current `useTheme()`
  into its effect deps, so a theme switch re-prepares the plan in the new
  palette — mirroring `useHighlightTokens`'s theme dep.
- **Code plane follows the theme.** The plan canvas stays light (ADR-0014's
  explicit light canvas; `svg text` is forced `#111`), but the guardrail
  paints every `pre`/`code` on the active theme's `--color-sunken` plane
  with `--color-ink` foreground — the same plane the transcript's code
  blocks occupy — so the runtime-theme token palette has the surface it was
  derived against. The declaration rides in the guardrail stylesheet (last
  in the head, `!important`) where plan-authored code styling cannot
  displace it, and re-derives live on theme switch through the existing
  prepare pass.

Rejected: hand-authored highlighted spans in the plan HTML (fragile,
token-bloated, and pushes tokenization onto the model — the same failure class
ADR-0020 rejected for hand-placed SVG geometry), a highlighter script inside
the plan iframe (violates the no-scripts plan rule and ADR-0007's empty
sandbox), a new highlighting dependency (shiki already ships and is tuned to
the runtime themes), and CSS-heuristic pseudo-highlighting (wrong for the same
reason ADR-0020 rejected eyeballed geometry: the model would be doing
lexical analysis it is bad at).

## Consequences

- **`preparePlanDocument` and `preparePlanForReview` gain a `theme`
  parameter** (default: the applied theme), threaded from
  `usePreparedPlanDocument`, whose hook signature is unchanged — no caller
  edits in the PlanReview dock or the transcript PlanCard.
- **The guardrail stylesheet gains a renderer-generated section** (token
  colour rules) when a plan contains highlighted code; with no highlighted
  blocks it is byte-identical to before, so unclass'd plans prepare exactly
  as they do today.
- **The prompt contract grows one sentence**: the language-class convention
  and the recognized grammar/alias list, which must stay in lockstep with the
  curated `LANG_IMPORTS`/`ALIASES` tables in `highlight.ts`.
- **The implementation seed is untouched**: `planSeedText` strips
  style/script/comments from the raw *authored* plan, so token spans never
  ride into the seed prompt.
- **A new verification reason**: a surviving `<!--omp-ui-highlight-N-->`
  placeholder fails structural verification, in parity with the
  diagram-placeholder check (issue #312).
- **The guardrail stylesheet becomes theme-scoped**: the const becomes
  `guardrailStylesheet(theme)`, called from `preparePlanDocument` with the
  theme it already receives — no new parameter threading, no caller edits.
