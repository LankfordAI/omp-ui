# HTML plans are authored directly, as the one and only plan file

Under plan format `html`, the agent writes exactly one file —
`local://<slug>-plan.html` — and that file is the plan: what the propose gate
resolves, what gets pinned as the session's plan reference, and what a fresh
implementation session is seeded with. The two-file design is deleted: no
canonical `-plan.md` is written under `html`, and there is no companion
rendition to keep in sync. This supersedes ADR-0007's consequence that "a
canonical HTML plan is unreachable without forking omp", and closes issue #116
without the upstream patch that issue requests. Plan format `md` is untouched
and still routes through omp's own resolver.

## What the binary actually does

Verified against omp 17.2.10 — the latest published `@oh-my-pi/pi-coding-agent`
— and its embedded source tree.

- **`xd://propose` dispatches to nothing but the installed proposal handler.**
  `tools/resolve.ts:303-311` is the entire dispatch: it looks up
  `session.peekPlanProposalHandler?.()`, throws when the handler is absent, and
  otherwise returns `await handler(body)` with the raw slug text. omp-ui installs
  that handler — `plan-extension.ts` calls `active.setPlanProposalHandler(...)` —
  so omp-ui's `onProposal` *is* the gate. There is no omp-side validation,
  normalization, or file lookup between the agent's write and omp-ui's code.
- **The `.md` lock lives in `resolveApprovedPlan`, and `onProposal` reaches it
  voluntarily.** The only reason a proposal has ever touched omp's markdown-only
  slug→file resolution is that `onProposal` chooses to call
  `active.preparePlanForReview(title)`. That method
  (`session/agent-session.ts:796-811`) is 15 lines that resolve a path and a
  title: no side effects, and no use of the plan body. Skipping the call under
  `html` costs nothing, and the extension resolves the `.html` artifact itself.
- **Every downstream consumer of a pinned plan path is format-agnostic.** The
  guard, the reference message, and the compaction protection all operate on
  paths and strings, never on `.md`:

|Downstream consumer|Location|HTML-safe?|
|---|---|---|
|Plan-mode write guard|`tools/plan-mode-guard.ts:82-155`|Yes — `targetsLocalSandbox` allows any file in `local://`; the `.md` in the rejection string is advisory text|
|Approved-plan reference message|`agent-session.ts:4507-4525` + `prompts/system/plan-mode-reference.md`|Yes — `resolveLocalUrlToPath` + `fs.access` on whatever path was pinned; the prompt just interpolates `{{planFilePath}}`|
|Compaction plan-read protection|`plan-mode/plan-protection.ts:25-30`|Yes — string-compares against `getPlanReferencePath()`|
|omp's per-turn "write a `.md` plan" mandate and end-of-turn reminder|`agent-session.ts:6455-6457` (`#enforcePlanModeDecisionAtSettle` gates on `this.#planModeState?.enabled`)|Never fires — ADR-0013's whole point is that omp-ui arms the guard by wrapping `getPlanModeState`, never the private field|
|`listPlanFiles` `/plan\.md$/i` scan|`plan-mode/plan-files.ts:30`|Only reached through `resolveApprovedPlan`, which the HTML path skips|

- **One `.md` mention survives where the agent can see it.** omp's `xd://propose`
  help string (`tools/resolve.ts:63`) still names a markdown plan, and the agent
  reads it only if it does `read xd://propose`. The `html` mode instruction
  explicitly overrides it.
- **No omp behaviour is depended on, so nothing needs probing.** Issue #116's
  "probe whether the running omp accepts an HTML slug" degradation path is
  unnecessary: under `html` the slug never reaches omp.

## Decision

Under plan format `html`, one file: `local://<slug>-plan.html`, written by the
agent on the mode instruction's own say-so. The extension resolves it itself —
slug reconstruction first, then a newest-`*-plan.html`-on-disk fallback — pins
it as the session's plan reference on execute, and embeds it, styles stripped by
`planSeedText`, into a fresh implementation session's seed prompt. Under `md`,
the proposal routes through `preparePlanForReview` and omp's resolver exactly as
before.

## Consequences

- **omp-ui replicates omp's slug normalization, and can drift from it.** About 20
  lines mirror `plan-mode/approved-plan.ts:21-48, 121-130`; an upstream change to
  that sanitizer would silently diverge. The mitigation is the
  newest-html-file-on-disk fallback, which does not depend on the slug at all.
- **The drift risk is confined to `html`.** The `md` format is unchanged and
  still runs entirely through omp's resolver, so a session on `md` behaves
  identically to one against an unpatched omp.
- **A fresh implementation session receives HTML rather than markdown.** That is
  more tokens per tag, but fewer than the two-file design cost in double
  authoring, and `planSeedText` removes the stylesheet before the seed prompt is
  built.
- **Two capability probes remain, both about omp-ui's own needs rather than omp's
  plan API.** `sendCustomMessage` — without it the agent never learns to write
  html — and `getArtifactsDir` — without it no `local://` path can be resolved or
  probed. Either one missing degrades the session to `md` with one warning.
- **The canvas is fixed and light, but not white: the guardrail paints
  `#e9ebee` / `#2b3036` (issue #375).** Agent-authored colours are still
  overridden, so the prompt's "explicit light canvas" wording remains the
  authoring contract while the rendered palette is omp-ui's.
