# Mermaid diagrams in HTML plans: agent authors source, omp-ui renders at review

ADR-0014 made the HTML file the one and only plan, and the plan-mode prompt
grew a band-aid for the agent's worst habit inside it: hand-placed inline SVG.
The model kept botching the geometry math — text straddling shape edges, labels
clipped by the viewBox, elements overlapping — and successive prompt
instructions (budget width by character count, reserve non-overlapping boxes)
did not fix it, because the failure is inherent: the model is doing layout
arithmetic it is bad at. Issue #285.

## Decision

The agent never computes a coordinate. In an HTML plan, a diagram is authored
as source in a fenced block — `<pre class="mermaid">…</pre>` — and omp-ui
renders it to SVG inside the trusted renderer process at review time, in
`preparePlanDocument`, before the document reaches the sandboxed plan iframe
(`sandbox=""`, unchanged — ADR-0007's posture is intact: the host app, not the
document, runs the renderer).

- **Renderer: mermaid, bundled as a `packages/desktop` dependency.** Mermaid is
  the diagram DSL the model writes most fluently; shiki/katex/xterm already
  ship as heavy renderer deps through electron-vite, and a dynamic
  `import("mermaid")` keeps it out of the initial chunk so plans without
  diagrams never load it. ADR-0002 is intact: only `packages/core`'s prompt
  *string* changes — the rendering lives entirely in desktop.
- **Untrusted content.** Plan documents are agent-authored. Mermaid initializes
  once with `startOnLoad: false, securityLevel: "strict"` (no HTML labels, no
  click handlers); output is plain SVG contained by the guardrail stylesheet
  inside an iframe whose subframe navigations `index.ts` already denies.
- **Failure containment.** A block that fails to render is replaced by a small
  error callout showing the original source; the rest of the plan is
  unaffected.
- **Containment carve-out.** The guardrail stylesheet's
  `:where(*:not(svg, svg *))` negation is not honored by every CSS parser, so
  rendered diagrams get an explicit `.omp-ui-diagram svg` rule (max-width 100%,
  height auto, display block) rather than relying on the negation.

Rejected: `@viz-js/viz` (graphviz WASM — agents botch `dot` more than mermaid),
a custom mini-DSL (we would own layout quality *and* a private syntax), and
mermaid inside the plan iframe at runtime (violates the no-scripts plan rule
and ADR-0007's empty sandbox).

> **Correction (2026-08-25):** `securityLevel: "strict"` sanitizes HTML-label
> content; it does not disable HTML labels. Under strict alone, diagrams still
> emit `<foreignObject>` labels, which re-wrap at the column-scaled width and
> clip. Root-level `htmlLabels: false` (issue #303) is what renders labels as
> pure SVG text, making this ADR's original "no HTML labels" intent true.

## Consequences

- **`preparePlanDocument` is async.** The one callsite-visible change; both
  plan surfaces (PlanReview dock, transcript PlanCard) consume it through
  `usePreparedPlanDocument`, which keeps the previous document on screen while
  a re-render is in flight.
- **~1 MB renderer chunk, deferred.** Mermaid + dagre load behind the dynamic
  import on the first plan containing a diagram; block-free plans resolve in
  the same microtask and never pay for it. Acceptable for a desktop app.
- **Sequential render.** Blocks render one at a time — mermaid's `render()` is
  not re-entrant-safe across concurrent calls on one instance; plans contain
  few diagrams, so latency is a non-issue.
- **Prompt contract replaces geometry instructions.** The SVG placement
  band-aid in `HTML_PLAN_BODY` is deleted; the agent is told to write mermaid
  source, escape HTML entities in labels, and keep prose able to stand alone in
  case a diagram fails to render. The general anti-overlap rule stays for
  non-diagram content.
- **Markdown plans unaffected.** The transform runs only on the HTML render
  path; `md` plans route through `Markdown` as before.
