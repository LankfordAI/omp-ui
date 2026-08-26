# Plan-handoff descendants are deleted with their source

Deleting an owned session erases its complete `planImplementationSource`
descendant closure (issue #309): the source session, every implementation
session it seeded, and every session seeded by those, however deep the
handoff chain runs. The closure is computed in main by walking the
registry's `planImplementationSource` links from the deleted `tabId`; it
never inspects transcripts or sidebar state. The delete recomputes the
closure at delete time, so a handoff registered between the preview and the
confirmation still joins it.

Each tab in the closure — the source first — is removed through the
ordinary per-session delete path, one operation behind its own tab's
operation queue: live-child reap, lineage removal from the active and
archive roots, then registry-record removal. A per-session file-delete
failure keeps that session's record visible and retryable and does not undo
the deletions that succeeded. Because the confirmation names every session
it will erase, a cascading delete always stages the confirmation even when
skip-confirmation is on — the same precedent as a worktree session
(ADR-0018). A read-only preview channel answers with the closure's titles
and liveness before the delete runs.

## Considered Options

- **Orphan the descendants (rejected)** — leaving implementation sessions
  standing when their planning session is deleted strands the provenance:
  the sidebar link dangles, the snapshot points at a missing session, and
  the user must find and delete each descendant by hand. The relation is
  one-way and app-owned; nothing in the transcripts needs the descendants
  to outlive the source.
- **Ask per descendant (rejected)** — one confirmation per descendant turns
  a single intent, "delete this plan and everything it spawned," into a
  click chain, and cancelling mid-chain leaves a partial closure that is no
  longer the thing the user confirmed.
- **Cascade with the source, always confirmed (chosen)** — one decision,
  one confirmation that lists every session it will erase, marks the ones
  still running, and counts the total in the confirm button. The delete
  stays per-session underneath, so failure isolation and the
  retryable-record contract are unchanged.

## Consequences

- **Deleting a planning session deletes more than one session.** The
  confirmation is the only warning: it lists the descendant titles, marks
  the running ones, and counts the total including the source.
- **The preview and the delete must agree.** Both compute the closure from
  the registry in main with the same walk; the renderer never computes it.
- **Skip-confirmation no longer covers a session with descendants.** It
  still covers a plain leaf delete, as before.
- **A failed descendant delete is a partial cascade, by design.** The
  failed session stays in the registry, still linked, still deletable; the
  rest of the closure is gone.
- **A worktree descendant loses its checkout like any other worktree
  session** — but the merge-back offer belongs to the source session's
  confirmation; a descendant's branch is deleted without a prompt.
