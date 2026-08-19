# Advisor accounting, delivered by a second generated extension

The Session HUD shows a quiet `adv` readout beside main model usage. Its meter
and model describe the parent advisor. Its spend and token total cover advisor
activity in the parent and every task descendant. An omp extension generated
in the session's lineage dir publishes these values. No renderer code parses
advisor prose or recalculates provider pricing.

## Why the extension owns this

Verified against omp 17.3.7:

- `get_session_stats` includes primary-agent task usage in `SessionStats.cost`,
  but it has no advisor breakdown. Advisor accounting must stay separate from
  the main usage receipt.
- `get_state` reports neither advisor cost nor advisor context.
- `/advisor status` returns prose.
- Each live `AgentSession` exposes `isAdvisorEnabled()`,
  `setAdvisorEnabled(boolean)`, `getAdvisorStats()`, `getAdvisorCost()`, and
  `getAdvisorStatusOverview()`.

The generated extension is the one in-process point that sees the root
`AgentSession` and every task descendant. It patches
`AgentSession.prototype.prompt`, as the plan extension does, and publishes over
the existing `ui.setStatus` channel.

## Parent-gated descendants

OMP resolves a task agent's advisor choice independently from its parent.
omp-ui narrows that rule for native sessions:

`child advisor enabled = parent advisor enabled AND child per-agent opt-in`

The first patched prompt binds the parent. Before each later session prompt
reaches OMP, the extension reads the parent's advisor state. If the parent is
off and the child is on, it calls `child.setAdvisorEnabled(false)`. If the
parent is on, the extension leaves the child's resolved setting and model
untouched. Every non-root `AgentSession` in that process follows the same rule,
including nested task agents.

If the parent-off guard is missing or throws, the extension publishes
`available: false` with the method failure. It still invokes the original
prompt. Protecting the HUD must not abort user work, and an unenforced guard
must not produce a false zero-cost claim.

## Identity and lifetime

`RpcClient` sends the extension's boot-arm command before it forwards `ready`,
so the first prompt belongs to the parent. Descendants are keyed by
`sessionManager.getSessionId()`:

- repeated prompts reuse one entry;
- a new object with the same session id replaces the old object;
- an object whose session id changes moves to the new key;
- a changed parent session id clears every descendant and cached snapshot.

Each descendant entry keeps its last successful cost and token snapshot. If a
completed child has been disposed and later stats reads fail, its accumulated
usage remains in the receipt. A revived object replaces that snapshot when its
stats become readable.

## Stable wire contract

The `omp-ui:advisorStats` JSON shape does not change. Its fields have asymmetric
semantics:

- `configured`, `model`, `subscription`, `contextWindow`, and `contextTokens`
  describe the parent advisor;
- `active` is true when any advisor runtime in the current session tree is
  active;
- `cost` and `totalTokens` are cumulative parent-plus-descendant totals.

An OAuth subscription remains a parent display fact. A nonzero aggregate cost
always renders as a number, even when the parent model uses subscription
billing.

## Publishing and polling

`getAdvisorStats()` re-tokenizes advisor transcripts. The extension avoids that
work unless a prompt ends, a manual refresh runs, or the cheap poll changes.
The 2-second unref'd poll sums `getAdvisorCost()` and advisor-message counts for
the parent and all tracked descendants. It performs the full tree walk only
when that aggregate probe moves. This catches advisor reviews that finish after
the primary prompt resolves, including zero-cost subscription activity.

Publishing remains in-process. The renderer never sends a stats slash command
mid-stream, where OMP could treat it as steering or literal prompt text. The
boot-arm command only supplies the `ui` channel and starts the poll.
