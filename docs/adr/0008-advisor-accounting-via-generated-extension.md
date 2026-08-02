# Advisor accounting, delivered by a second generated extension

When a session runs with the advisor enabled, the Session HUD shows a second,
quieter context/cost readout beside the main model usage: an `adv` tag, a
compact context meter, the fill percent, and the advisor's spend so far. That
data reaches the renderer the same way plan mode does — an **omp extension
omp-ui generates into the session's lineage dir** (ADR-0003) and passes as `-e`
at spawn (ADR-0007). It publishes a reduced view of omp's own advisor
accounting, so no client-side token/pricing reimplementation exists.

## Why not the obvious routes

Verified against omp 17.1.8:

- **No rpc surface reports advisor accounting.** `get_session_stats` returns a
  `SessionStats` with no advisor breakdown, and `get_state`'s `RpcSessionState`
  reports neither advisor cost nor context (ADR-0005). The TUI's
  `$2.67 (sub) + $0.41 (adv)` status line is computed in-process, not exposed.
- **`/advisor status` is not structured.** Its grammar is
  `[on|off|status|dump [raw]|configure]`, and its output is prose. omp-ui never
  regresses a numeric readout into a text parse.

## What is actually reachable

The live `AgentSession` carries the whole advisor read as public methods —
`getAdvisorStats()`, `getAdvisorCost()`, `getAdvisorStatusOverview()`. The
extension hooks `AgentSession.prototype.prompt` (the same unsupported surface
ADR-0007 uses) to capture the live session, then publishes a reduced view over
the rpc protocol's existing `ui.setStatus` key — no new frame type is invented.

## The wire contract

`setStatus` key `omp-ui:advisorStats` carries JSON reduced from
`getAdvisorStats()`: `configured`, `active`, `model`, `contextWindow`,
`contextTokens`, `cost`, `totalTokens`. When the surface is unreachable the
extension publishes `available: false` with a reason and the HUD omits the
element rather than fake a zero.

Small enough to live in the renderer via the `@omp-ui/core/advisor-stats`
subpath (the `ADVISOR_STATS_KEY` / `ADVISOR_STATS_COMMAND` constants and the
`parseAdvisorStats` reducer), mirroring `core/plan.ts`.

## Timing

- **Turn boundaries.** `getAdvisorStats()` re-tokenizes the advisor transcript,
  so the extension publishes after each `AgentSession.prompt()` resolves,
  gated behind the cheap `getAdvisorStatusOverview().configured` check so an
  advisor-off session pays nothing per turn. omp runs the advisor's review
  async to the primary loop (`waitForCatchup` is headless-only), so the review
  of a turn typically lands one publish later — the readout trails at most one
  review and catches up at the next boundary or on a manual refresh. That is
  fine for a spend/context HUD, and it never reads stale data as current.
- **Never mid-stream.** Publishing happens inside omp, so the renderer never
  sends a slash prompt while a turn is running (which could be steered into or
  reach the model as literal text). The HUD's manual refresh skips the advisor
  fetch while `status === "running"` or `isStreaming` is true.
- **Boot arm.** One slash call at tab boot sets the extension's `ui` channel,
  without which its auto-publish is a no-op; a resumed session displays advisor
  stats from its first new turn onward.
