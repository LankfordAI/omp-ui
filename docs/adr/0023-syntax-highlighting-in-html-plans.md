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
  unrecognized language, an over-cap block, or a failed grammar/engine load
  simply leaves the block plain — "highlighting is an enhancement, never a
  gate." One-shot HTML plan code blocks and non-streaming transcript slabs
  retain the 20,000-character cap; live append-only tool drafts (issue #369)
  instead run the incremental grammar-state path with a 100,000-character
  budget plus a 4,000-character physical-line guard, so each delta pays only
  for its newly completed lines.
- **Live theme.** `usePreparedPlanDocument` takes the current `useTheme()`
  into its effect deps, so a theme switch re-prepares the plan in the new
  palette — mirroring `useHighlightTokens`'s theme dep.
- **Code plane follows the theme — and since issue #384 amended ADR-0014,
  the canvas follows the theme too.** The guardrail paints every
  `pre`/`code` on the active theme's `--color-raised` plane with
  `--color-ink` foreground so the runtime-theme token palette has the
  surface it was derived against, and the canvas itself now comes from
  `--color-surface` / `--color-ink` — so `raised` sits one step above the
  canvas in both directions (graphite `#1a1e23` over `#14171b`, light
  `#ffffff` over `#fafbfc`), the relationship issue #375 asked for. The
  declaration rides in the guardrail stylesheet (last in the head,
  `!important`) where plan-authored code styling cannot displace it, and
  re-derives live on theme switch through the existing prepare pass.
  Retuned to `--color-raised` on the then-fixed light canvas (issue #375):
  the sunken plane on paper white read as black-on-white with no
  mid-tones.
  Split again (issue #380): only block code (`pre, pre code`) keeps the plane.
  Inline prose chips carry no tokens, so they ride a tint one step off the
  canvas (`--color-hover`) with inherited ink — the dark plane under a light
  canvas read as black pills (#375 lifted the block well and left the chips
  with it).

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
- **The guardrail stylesheet is theme-scoped**: the const is
  `guardrailStylesheet(theme)`, called from `preparePlanDocument` with the
  theme it already receives — no new parameter threading, no caller edits.
  Issue #384 completed the scoping: the canvas, ink, chip tint, link, and
  code plane all derive from `theme`, not only the code plane.

**Amended 2026-09-08 (#312 follow-up): the placeholder protocol is replaced
by source-range composition.** The pipeline no longer swaps blocks through
`String.replace` with replacement strings — an authored `$'`, `$&`, or
backtick-dollar sequence in code text could substitute document text through
the replacement-pattern grammar (issue #412) — and an authored comment that
looked like a marker was indistinguishable from the pipeline's own.
`parsePlanSource` (parse5, source locations on) now classifies blocks and
carries their original ranges; transforms return splice lists; the composer
interleaves original slices with generated strings exactly once. Unchanged
bytes survive byte-for-byte, transformed code keeps its browser-decoded
text, the reconstruction check before accepting a token stream stands, and
"highlighting is an enhancement, never a gate" still holds — a grammar load
failure leaves the block plain and passes preflight. The
`<!--omp-ui-highlight-N-->` verification reason dies with the protocol;
structural verification queries the parsed result instead. The
language-class consumption rule lives on as attribute-range splices, and
the "never re-prepare generated HTML" rule is now enforced by the
authored-source-only input contract rather than by byte-idempotence.
