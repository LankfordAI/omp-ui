# Session references ride the prompt text as a leading block

> **Status:** Accepted, 2026-10-30 ([#984](https://github.com/LankfordAI/omp-ui/issues/984)).

To give one session context about another, the user had to paste text across
or ask the agent to dig through `~/.omp` for the right transcript. A
**Session reference** hands a saved session to another session's next
prompt: drag its sidebar row onto a native composer, or pick it from the
`@`-palette's *Sessions* rows. This ADR records what reaches the model and why
it is same-machine only.

omp 18.14.0's bundled `seance` task agent already reads a saved transcript
without resuming it: the `task` tool accepts `agent: "seance"` with
`sourceSession` set to a session id or a path, and its resolver
(`resolveSeanceSource` in the binary) stats a path argument directly but
resolves a bare id only against the *calling* session's own directory. omp-ui
pins every lineage to its own session dir (ADR-0003), so only an absolute path
reaches a session in another lineage. The rpc `prompt` frame has no field for
a referenced session, so omp-ui builds the prompt itself.

## Decision

**The wire is a leading `<session references>` block in the prompt text.**
Like the annotations block (ADR-0077), it is omp-ui-authored prose the
transcript derivation parses back into chips:

```
<session references>
The user referenced these other omp-ui sessions. … call the task tool with agent "seance" and sourceSession set to its path; in plan mode, read the file instead.
- title: Fix the deploy pipeline
  session: 019faeab-…
  machine: fw-desktop
  path: /home/u/.omp/agent/sessions/omp-ui--proj--…/…_019faeab-….jsonl
</session references>

<annotations>…</annotations>

the typed draft
```

The hint line is fixed and the parse requires it verbatim; every field is one
line with `<`, `>`, CR and LF removed from the title, so no body line can
close the block. omp masks tag sections before magic-keyword detection, so a
title containing `ultrathink` arms nothing. `splitSessionReferenceContext`
strips only a proven leading block; any lookalike stays prose.

**Order on the wire:** session references block, annotations block, prose,
resolved-mention blocks, attached-documents block, image routing suffix. The
one builder (`promptWireText`) serves `sendPrompt`, `abortAndPrompt`, and
`holdPrompt`, so the queue chip, Esc-restore, held-prompt cancel, rewind, and
the user bubble all split the same text.

**The owner resolves it.** A new tab-routed `session:reference` channel
returns the session id, title, the owning host's name (`os.hostname()`, the
fleet label), and the transcript path resolved fresh like
`session:transcriptPath` — omp gc relocates cold sessions (ADR-0003), so a
cached path would dangle. A live session is allowed; the path names the file
as of the prompt.

**Same-machine only.** A path is valid only on its owner. The renderer refuses
a reference whose session lives on a different instance than the target
(this app vs. a joined remote, or two remotes) with a notice naming the
machine, and never asks a host. Every draft reference carries its owning
instance, so the moves that change hosts — the Machine chip, a stashed draft
applied in another instance's session — drop it with the same notice instead
of sending a path that does not exist there. References parsed back out of a
tab's own wire text are owned by that tab's instance.

## Considered options

- **The bare session id (rejected)** — omp's seance resolver looks a bare id up
  only in the calling session's own dir, which omp-ui's per-lineage dirs make
  a different directory from the referenced one.
- **Pasting a summary (rejected)** — costs context, goes stale, and is what
  the user already did by hand. The agent consults the transcript only when
  the request needs it.
- **A hidden custom message (rejected)** — the same split-request and rewind
  correlation costs ADR-0077 names.
- **Cross-machine references by copying the transcript (deferred)** — a copy
  would need the session-migration pack path (#888) and goes stale; the issue
  scopes the first cut to one machine.

## Consequences

- A user bubble renders reference chips above annotation chips; the session
  file keeps the raw block.
- An omp-ui older than this release shows the block as prose in a transcript
  written by a newer one; nothing is lost.
- A plan-mode session cannot spawn `seance` (omp hides `sourceSession` while
  planning); the hint tells the model to read the file instead, which plan
  mode allows.
- A referenced transcript later deleted or swept leaves a path that no longer
  resolves; the agent's tool call reports it.
