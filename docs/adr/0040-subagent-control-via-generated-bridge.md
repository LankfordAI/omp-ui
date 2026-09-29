# Subagent control (steer/kill/revive) via a generated bridge

Resolves issue #684. Verified against omp 18.4.2.

## Findings

- omp's rpc surface reads the roster (`get_subagents`) but has no verb that
  steers, kills, or revives one subagent. The control APIs —
  `AgentLifecycleManager.ensureLive`/`release` and the `AgentRegistry`'s live
  session refs (`session.abort`) — are in-process only: the rpc dispatch
  switch has no case for them, and Agent Hub and the collab host are their
  only callers (verified against the managed binary). Per ADR-0007/0024 that
  makes this one more per-lineage generated bridge.
- `get_state` carries no `subagentCount` in 18.4.2. The field appears only in
  the TUI status-bar renderer, never in the rpc response. The hibernation
  veto therefore reads `hasPendingAsyncWork` instead: a foreground child
  keeps the root `isStreaming`, and a background (queued or running) child is
  an asyncJobManager job, which that flag covers.
- The kill sequence Agent Hub performs is `session.abort({ reason:
  "Interrupted by user" })` first, then
  `lifecycle.release(id, ref, { tombstone: true })` — `release` alone leaves a
  running session mid-request. The tombstone keeps the row and its
  `history://` transcript readable.
- Refusal sentences (no such agent, a completed agent cannot be steered, a
  running agent must be killed first before revive-style ensureLive, …) are
  omp's own; the bridge quotes them verbatim rather than rewriting them.

## Decisions

1. Route: a generated per-spawn extension (`subagent-control-extension.ts`,
   ADR-0007/0024), beside the goal/tree/side-questions/capabilities bridges.
   It binds the managers through the literal subpaths
   `@oh-my-pi/pi-coding-agent/registry/agent-registry` and
   `.../agent-lifecycle` (computed specifiers never resolve through omp's
   shim) via their static `.global()`; a failed import degrades every verb to
   a `missing-api` refusal, never a crash.
2. The wire contract is the pure `subagent-control.ts`, imported by the
   renderer directly as a dependency-free subpath (ADR-0002); the generator
   interpolates the same constants, so the two sides cannot drift.
3. Transport: a hidden quiet prompt (`/omp-ui-subagent tool <json>`, the
   goal/btw precedent, issue #680) in, `ui.setStatus` on
   `omp-ui:subagent-control` out — correlated by `requestId`. The prompt's
   ack proves only dispatch; the result arrives when the verb settles.
4. Results are transient chrome, not roster truth: `get_subagents` stays the
   read side. Results ring-cap at 16; a snapshot past 64 KiB drops the oldest
   results, and one that still does not fit publishes
   `available: false, reason: "payload-too-large"` rather than a truncated
   payload. The parser is total: a malformed frame keeps the last good
   snapshot standing.
5. Gating mirrors the bridge's refusals: live statuses (`running`/`active`/
   `pending`/`queued`) steer and kill; `parked` revives and kills; everything
   else offers nothing. One verb per agent at a time.
6. PTY tabs keep omp's own TUI subagent UX: the hidden frame cannot ride a
   terminal, so the controls render only over an rpc-ui tab.
7. Hibernation interlock: the tracker vetoes the kill on
   `hasPendingAsyncWork` (or `isStreaming` / parked messages). The probe
   parses `{ queuedMessageCount, isStreaming, hasPendingAsyncWork }` strictly;
   a missing field — a stale omp without it — is "cannot verify" and rearms
   instead of killing.
