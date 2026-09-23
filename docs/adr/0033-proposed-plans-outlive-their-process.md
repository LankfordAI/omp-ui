# Proposed plans outlive their process; the review gate does not

> **Status:** Accepted, 2026-09-23 ([#636](https://github.com/LankfordAI/omp-ui/issues/636)).

A plan review gate lives in `PlanGateTracker`'s in-memory map and dies with the
omp child, deliberately: the agent's blocked `xd://propose` call dies with it.
But everything else about a proposal died too. The proposed plans pane read a
renderer-only list reset on every boot, and `historyToItems` rebuilds no plan
card. An app restart during a review erased every trace of the plan except its
artifact on disk. The only recovery was asking the agent to present it again:
a full model turn that, under the plan-mode rule to write a plan file before
proposing, rewrote the reviewed file first (observed 2026-09-23).

## Decision

- **The record persists; the gate does not.** Each owned session record
  carries `proposedPlans` (key, title, status), written by main's
  `PlanGateTracker` on proposal, verdict, invalidation, and dismiss. A
  malformed entry drops only itself, never the session record.
- **Interrupted is derived.** A `pending` record with no live gate for its key
  is an interrupted plan. Nothing is written on exit, so an app crash reads
  exactly like a clean quit.
- **Re-present raises a real gate.** The plan extension's command gains
  `review <planFilePath> [title]`, which calls the same `onProposal` as
  `xd://propose` with the file named explicitly, outside the toggle chain.
  Preflight, the source hash, the acknowledged answer, the reference pin, and
  the mode exit are the agent path's own. The request carries
  `represented: true`, and three things follow from answering no tool call:
  execute announces the plan-mode exit retraction, the renderer does not wait
  for an advisor review that no turn will produce, and refine notes name the
  plan file.
- **Dismiss** is the tab-routed `plan:dismiss`, refused for a live gate.

## Considered options

- **Persist and replay the gate.** Rejected: the select belonged to a dead
  process; a replayed frame id answers nothing.
- **Execute an interrupted plan from the renderer without a gate.** Rejected: a
  second execution path that skips preflight, the #312 hash check, and the
  extension's reference pin and mode exit.
- **Ask the agent to re-propose.** Rejected: a model turn per recovery, a forced
  rewrite of the reviewed file, and a model free to edit approved text.
- **Persist in the renderer.** Rejected: per client, so remote clients
  disagree; #215 made plan state main-owned.

## Consequences

- One registry write per proposal and per verdict.
- The diagnostic bundle's `registry.json` carries plan titles and `local://`
  slugs, as it already carries session titles.
- An older remote host sends no `proposedPlans`. Its live gate still shows,
  synthesized from `pendingPlan`, and it never offers re-present (its extension
  predates the verb).
- A re-presented review validates the file's current bytes, not the bytes
  first proposed.
- One review at a time per session: the extension refuses a proposal while a
  re-presented review is open.
- The transcript still shows no plan card for an interrupted plan; the pane is
  the persistent surface.
