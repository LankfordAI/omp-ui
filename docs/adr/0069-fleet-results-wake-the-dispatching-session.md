# Fleet results wake the dispatching session

> **Status:** Accepted, 2026-10-28 ([#957](https://github.com/LankfordAI/omp-ui/issues/957), [#958](https://github.com/LankfordAI/omp-ui/issues/958), [#959](https://github.com/LankfordAI/omp-ui/issues/959)).

ADR-0061 lets an agent dispatch fleet work, but the dispatching session only
learns a child finished if it polls `omp-ui_fleet_status`, and it has no way
to tell a running child anything. Three gaps are closed here: a finished child
wakes the session that dispatched it, status can wait for a change instead of
being polled in a loop, and the dispatcher can send a follow-up to its child.

## Decision

**Watch, then stage, then deliver.** Each non-failed outcome
(`started` or `unknown`) of an agent dispatch writes one *watch* into the
dispatching session's fleet-wake ledger, keyed by `dispatchId`. Only watched
dispatches ever wake anything, so dispatches made before this shipped stay
silent. On every state broadcast — local and remote changes both funnel through
`MainBackend.broadcast()` — main checks each watched child:

- its first settle stages one **Fleet result** message (with the child's
  summary);
- each new wait on the user stages one **Fleet notice** (plan review or
  question), at most 3 per dispatch.

A staged message stays in the ledger until main sees its `message_end` frame
in the parent, then it is removed. On each spawn or resume, every message still
staged rides `initialCommands` as `/omp-ui-fleet-wake-<wakeId>`; a live parent
gets each staged message once per process, tracked on its `RpcLiveEntry`. A
dormant parent is resumed, at most one attempt per 60 s per tab, and receives
the messages through `initialCommands`.

**The settle rule** (`fleetChildSettled`) requires all of:

- `fleetSessionState` is `idle` or `dormant`;
- `live` is `live` or `dormant` — archived and missing children never wake;
- a live child reports `turnRunning !== undefined`, so an older remote is never
  guessed about;
- `sessionId !== null`;
- `status` is `complete`, `error`, `aborted`, or `interrupted`.

Before its first prompt is answered a child's transcript is unmaterialized or
`pending`, so a freshly spawned idle child never counts as settled.

**The bridge posts a visible custom message that starts a turn.** A generated
`-e` bridge, registered like the other rpc bridges (so warm-pool spawns get it
too), binds the root session by patching `AgentSession.prototype.prompt`, is
armed by the hidden slash command, and calls `sendCustomMessage` with
`{ customType: "omp-ui:fleet-wake", content, display: true, attribution:
"agent", details: card }` and `{ deliverAs: "followUp" }` while streaming or
`{ deliverAs: "nextTurn", triggerTurn: true }` while idle. Binary facts this
relies on (omp 18.13.1, probed by `strings` on the private `#jo`/`#no` and
`acp-client-bridge.ts`):

- while streaming, `deliverAs: "followUp"` calls `agent.followUp`; while idle,
  `deliverAs: "nextTurn"` with `triggerTurn: true` runs
  `agent.prompt(message)` and awaits it;
- the `deferAgentInitiatedTurns` gate is set only by the ACP client bridge, so
  an rpc session is never deferred;
- the message persists as a `custom_message` entry with its `details`, and
  `message_start`/`message_end` are emitted for it, which is how main sees
  delivery and the renderer draws a card;
- an extension slash command runs while the session is streaming, because the
  serial chain releases a prompt at admission;
- `rpcSend` lets `/omp-ui-` messages through a model hold.

**Exactly once.** The bridge walks the whole branch (not stopping at
compaction); if an entry already holds the `wakeId`, the message landed in an
earlier process, and the bridge publishes `{ wakeId }` on its status key so main
settles the ledger entry without posting twice. That covers a crash after omp
persisted the message but before main recorded delivery. An in-process set
drops a repeat arm in the same process.

**The ledger lives in app data**, one file per dispatching session at
`<dirname(registryFile)>/fleet-wake/<parentTabId>.json`, not in the parent's
lineage dir: archiving moves lineage dirs, and a late ledger write could
recreate a stray active one. A ledger whose tab has left the registry is
deleted on the next observe.

**Status can long-poll.** `omp-ui_fleet_status` gains `waitMs`, an integer
from 0 to `FLEET_STATUS_WAIT_MAX_MS` = 45 000, default 0. While a matched
session is working or has not finished its first run, or an outcome is
pending, the dispatcher waits on the next state broadcasts and answers as soon
as one of them settles or starts waiting on the user, or when `waitMs` runs
out. Worst case is 45 s of waiting plus the existing 5 s summary race, 50 s,
inside the 60 s host-answer watchdog.

**`omp-ui_fleet_send` rides an inbox rail.** Arguments are
`{ dispatchId, message, mode?: "queue" | "steer" }`, and only the session that
dispatched the work may send to it: the dispatcher pre-checks the requester,
the owner re-checks it, and a cross-instance send also needs the Dispatch rung
(`FleetServer.check`). It crosses on the new proxied channel `fleet:send` and
audits as `send`. The owner stages the text in the child's lineage inbox,
`fleet-inbox.json`, as `/omp-ui-fleet-send-<id>`, consumed on a success
response exactly like ADR-0061's `fleet-prompt.md`. A live child gets a plain
`prompt` with `streamingBehavior` `followUp` (queue) or `steer`, and the tool
answers once omp acknowledges it, waiting up to 15 s; a dormant child is
resumed and the inbox rides its `initialCommands`. A child waiting on the
user's answer, one whose model is held (#932), a terminal session, and a
caller other than the dispatcher are refused as plain text. The window between
omp accepting the prompt and main consuming the entry is at-least-once — a
crash there redelivers on the next resume — which matches the fleet prompt's
window in ADR-0061.

## Rejected alternatives

- **A blocking wait tool.** A tool call that waits until the child finishes
  would outlive the 60 s host-answer watchdog (ADR-0065), so it would need
  the detached poll shape anyway and still keep the parent's turn open. The
  bounded long-poll covers the short case; the wake covers the long one.
- **Timer nudges.** Periodically prompting the parent to re-check burns turns
  and tokens whether or not anything changed, and still lags the real settle.
- **Pi Durable as a second runtime.** Running dispatch orchestration on a
  durable-workflow runtime beside omp adds a second session model and state
  store for one notification edge the broadcast loop already sees.
- **Letting the parent answer a child's dialogs.** A child's plan review or
  question is owed to the user; the parent only gets a Fleet notice. Letting an
  agent approve another agent's plan would remove the human from Plan mode.

## Consequences

- A dispatching agent ends its turn after dispatch and is woken by the result,
  rather than polling.
- The renderer draws `omp-ui:fleet-wake` custom messages as cards, live and in
  history; every other custom type except advisor stays ignored.
- The fleet tool roster grows to eight with `omp-ui_fleet_send`.

## Fleet finish addendum (issue #978)

A dispatching session cleans up after each dispatched worktree session with
`omp-ui_fleet_finish { dispatchId }`. It follows the `omp-ui_fleet_send` route:
the dispatcher pre-checks the requester, the proxied channel `fleet:finish`
reaches the owner, a cross-instance call needs the Dispatch rung, the call
audits as `finish`, and the owner re-checks that the requester dispatched the
session.

- **Already landed only.** The owner refuses unless all of these hold: the
  recorded branch is in the destination resolved from the recorded base, the
  checkout is clean, and the checkout's HEAD is in that destination. HEAD
  matters because agents commit on working branches of their own. It also
  refuses while a turn runs, a human answer is pending, or another operation
  holds the tab. It never merges, pushes, or discards work: there is no new
  merge path.
- **Settle first, then release.** The order is settle (reap), re-check the
  landed facts (the process could commit until it died), then
  `releaseWorktree` with `mergedInto` set to the destination. A settled tab is
  dormant, so the release demotes and reclaims without a relaunch, and the
  row lands in Settled exactly like a merged finish from the dialog.
- **Working branches by reflog, deleted by ancestry.** The worktree's own HEAD
  reflog names every branch the checkout held. A branch whose own reflog
  starts strictly after the worktree's first HEAD entry was made there, and
  it is deleted only when `removeWorktreeBranch`'s ancestry check passes. Any
  other visited branch, or one with no reflog, is reported as kept, never
  deleted on a guess. The reflog dies with the checkout, so it is read before
  removal.
- **Rejected: let the child remove its own worktree.** `git worktree remove`
  from inside the session bypasses the registry: the record keeps a dead path
  and the session never settles.
- The fleet tool roster grows to nine with `omp-ui_fleet_finish`.
