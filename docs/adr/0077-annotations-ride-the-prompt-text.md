# Annotations ride the prompt text as a leading block

> **Status:** Accepted, 2026-10-30 ([#983](https://github.com/LankfordAI/omp-ui/issues/983)).

To comment on one sentence of a reply or one line of a tool result, the user
had to copy it, paste it into the composer, quote it by hand, and write the
comment. An **Annotation** is a quoted selection plus a comment, collected as
a chip in the draft and sent with the next prompt. This ADR records how it
reaches the model and comes back as a chip.

omp 18.14.0 ships `/annotate`, but its entry refuses to run without the TUI
(`hasUI` false: "Text annotation requires the interactive UI") and its result
is pasted into omp's own editor (`ui.pasteToEditor`). Over rpc-ui there is
nothing to call, so omp-ui builds the prompt itself.

## Decision

**The wire is a leading `<annotations>` block in the prompt text.** The rpc
`prompt` frame has no annotation field, so — like the attached-documents block
(ADR-0044) — the annotations are omp-ui-authored prose the transcript
derivation parses back out:

```
<annotations>
> quoted line
> another quoted line
the comment

> a second quote
</annotations>

the typed draft
```

It leads, ahead of the draft, so the model reads the quotes before the request
about them. Quote lines start with `>`; comment lines follow and never start
with `>`, `<`, or `\` (those get a `\` escape); a blank line separates entries.
`splitAnnotationContext` strips only a proven leading block whose body parses;
any lookalike stays prose.

**Order on the wire:** annotations block, prose, resolved-mention blocks,
attached-documents block, image routing suffix. One builder in the store
(`promptWireText`) serves `sendPrompt`, `abortAndPrompt`, and `holdPrompt`, so
every route, the queue chip, Esc-restore, held-prompt cancel, rewind, and the
user bubble all split the same text.

**A quoted keyword never arms.** omp masks HTML-like tag sections before magic
keyword detection (18.14.0's markdown-prose masking, ported in core
`magic-keywords.ts`), so `ultrathink` inside a quote stays inert while the
typed draft still arms normally. Quoted `@path` tokens are split off before the
mention parse, so they never count as the prompt's own mentions.

**The draft owns annotations like Attachments.** `useImageDraft` carries them
for both the composer and the plan review's refine box. The transcript's
Comment… action and every restore path queue them through `composerQueue`.
A send omp rejects (or a refused tab) returns text, Attachments, and
annotations to the draft. Slash commands, `!` commands, and dialog answers
are not prompts; the chips stay.

**The plan review reads its own frame.** An HTML plan renders in an iframe.
The review dock's frame gets `sandbox="allow-same-origin"` — still no
`allow-scripts` token — so the dock can read the reviewer's selection and own
its context menu. ADR-0022's probe frame established the same one-way
parent-to-child channel. The plan CSP (`script-src 'none'`), the guardrail,
and the main process's `will-frame-navigate` denial are unchanged; the
transcript PlanCard and message frames keep the empty sandbox.

## Considered options

- **A trailing block (rejected)** — mirrors the documents block, but the model
  would read the request before the passages it is about, and the mention
  splitter anchors at end-of-text.
- **A hidden custom message (rejected)** — the user's prompt is what the model
  should see; a second message splits one request across two turns and breaks
  rewind's one-row-one-entry correlation.
- **Copying omp's `/annotate` template (rejected)** — its `# Feedback on …`
  headings are markdown, which omp does not mask, so a quoted keyword would
  arm, and it is built for one source per prompt.
- **Selection relay by postMessage from the plan frame (rejected)** — needs
  `allow-scripts`, which ADR-0007 rules out.

## Consequences

- A user bubble renders its annotation chips above the prose; the session
  file keeps the raw block, unchanged.
- An omp-ui older than this release shows the block as prose in a transcript
  written by a newer one; nothing is lost.
- The review frame is same-origin with the renderer. With no script token and
  a `script-src 'none'` CSP it can neither run code nor reach the parent.
