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
  stylesheet already forces the theme's ink onto the theme's canvas at render time.
- **A failed plan is still reviewable.** The raw source shown in the
  fallback is the artifact the execute verdict dispatches, so reviewing it
  as text remains a real review; refine sends the planner back to rewrite.

**Amended 2026-09-08 (#312 follow-up): main owns the submission gate.** The
rejected option above assumed a main-process probe would *replace* remote
verification; it does not — it *precedes* it. An HTML plan proposal is now
validated by the main process before a review gate exists for any client
(see `plan-preflight.ts`, `plan-verifier.ts`, and the *Plan preflight* entry
in CONTEXT.md): the select frame is claimed ahead of observers, fan-out,
notifications, and the pending-plan record, a hidden script-less Chromium
verifier window runs the SAME parser, transforms, structural checks, and
layout probe described here, and a failed or inconclusive outcome answers
the agent with located diagnostics through the proposal tool result instead
of opening a review. Renderer-local preparation stays exactly as specified
here as the final check of each actual display surface (review dock,
transcript card, remote browsers), and displayed frames keep `sandbox=""`.
The placeholder-survival checks this ADR introduced are gone with the
placeholder protocol (see the ADR-0023 amendment): verification queries the
parsed structure for the generated guardrail and CSP instead of scanning
prose for marker text. A Chromium preflight is a claim about the app-owned
pipeline, not about every remote browser's precise pixels; "verification
could not conclude" is reported as `unavailable`, which never presents and
never passes.
