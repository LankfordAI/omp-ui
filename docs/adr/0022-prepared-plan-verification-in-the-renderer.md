# Prepared plan documents are verified in the renderer before presentation

An HTML plan is verified after preparation and before it reaches a review
surface (issue #312). The pipeline runs entirely in the trusted renderer:
`preparePlanDocument` (diagram substitution plus guardrail injection), then a
structural pass over the prepared bytes with `DOMParser` — no surviving
diagram placeholder, the guardrail stylesheet present as a `<style>` element,
a body that parses to visible content — then an authoritative layout pass
that loads the prepared document into a hidden, throwaway probe iframe and
measures that the body laid out visible content. A failed verification never
presents a blank frame: the surface shows a named failure reason and the raw
plan source as escaped text, with the execute, refine, and defer controls
still live.

The probe iframe grants `sandbox="allow-same-origin"` but never
`allow-scripts`: the framed document cannot execute, so the same-origin grant
is a one-way parent-to-child measurement channel. The frame is offscreen,
hidden, and removed as soon as the probe resolves or its timeout fires. The
*presented* iframes keep their empty `sandbox=""` token list unchanged
(ADR-0007). Only a definitive "loaded and measured empty" verdict fails; a
probe timeout, a measurement error, or a layout-less environment (jsdom in
tests) resolves inconclusive and passes the document through — the probe must
never false-positive-block a valid plan or hang a test.

## Considered Options

- **Main-process BrowserWindow probe (rejected)** — the app has remote
  browser clients (the web build; late-join hydration, issue #215). A probe
  in desktop main leaves those clients unverified and needs a new IPC
  round-trip to ship the verdict. The renderer-local probe runs wherever the
  surface mounts, is deterministic on the same prepared bytes, and needs no
  change to the main-process pending-plan record.
- **Prompt-only fixes (rejected)** — instructing the planner to author
  renderable HTML cannot catch a preparation rejection or a parse that
  swallows the body; the one gate where the user must trust what they see
  needs a mechanical check.
- **Raw-source default view (rejected)** — always showing plan source
  discards the authored document that ADR-0014 made the sole plan artifact;
  the source is the fallback, not the review surface.

## Consequences

- **No new IPC, channel, or record field.** Every client — desktop or remote
  — computes the same verification state independently from the same
  prepared bytes (#215).
- **The presented sandbox posture is unchanged.** `sandbox=""` on the review
  and transcript iframes stays exactly as ADR-0007 left it; the probe frame
  is the only same-origin frame, and it is script-less and short-lived.
- **This is a blank-frame catch, not a rendering guarantee.** Inconclusive
  probes pass through, and readability concerns such as unreadable contrast
  remain prompt-guardrail territory (#176, #284) — the injected guardrail
  stylesheet already forces dark-on-white at render time.
- **A failed plan is still reviewable.** The raw source shown in the
  fallback is the artifact the execute verdict dispatches, so reviewing it
  as text remains a real review; refine sends the planner back to rewrite.
