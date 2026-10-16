# Background jobs ride a generated bridge; kill rides a hidden command

Resolves issue #835. omp keeps background jobs (async `bash`, background
`task` subagents, eval agents, advisor work) in an in-process async job
manager. No rpc-ui frame carries them: `get_state` only reports
`hasPendingAsyncWork`. Verified against the managed binary `omp/18.8.9`
(linux-x64). Re-check on every managed-binary bump.

## Findings

- `AgentSession` exposes `getAsyncJobSnapshot({ recentLimit })` →
  `{ running, recent, delivery }`, `inspectAsyncJob(id)` →
  `{ command, cwd, pids, exitCode, output, artifactId }`, and
  `cancelAsyncJob(id)` → boolean. omp's own `/jobs`, `/jobs kill`, and the TUI
  jobs sheet call exactly these three methods.
- An extension slash command sent as an rpc `prompt` runs inside
  `AgentSession.prompt` before the streaming check. It therefore executes
  mid-turn without `streamingBehavior`, because omp's rpc serial chain
  releases a prompt at admission rather than at turn end.
- Named `bash` services (`bash name=…`) are daemon-supervised. They never
  enter the async job manager and stay outside this decision.

## Decision

1. A per-lineage generated bridge (`omp-ui-async-jobs.ts`) captures the root
   session through the `AgentSession.prototype.prompt` hook, the same way the
   limits bridge does. Once armed, it polls every 1.5 s and publishes a
   digest-gated, revisioned `AsyncJobsSnapshot` on
   `setStatus("omp-ui:async-jobs")`.
2. Kill is `/omp-ui-async-jobs kill <json>`, sent with no
   `streamingBehavior`. The request carries `processKey` and the target job's
   `startTime`, because omp reuses `bg_N` ids after eviction. The outcome rides
   the next snapshot's `result`, correlated by `requestId`.
3. Degradation is by method presence, not by version string. A missing API
   publishes `available: false` with the reason, or clears
   `canInspect`/`canCancel`.

## Consequences

- No new IPC channel and no main-process tracker. A late or remote renderer
  re-arms at boot, and the arm force-republishes.
- Supervised services need their own transport (`omp ps`). That would be a
  separate change.

## Addendum (issue #868): the v2 envelope carries the agent tree

Re-verified against `omp/18.11.1`. The binary adds
`getAsyncJobTree({ recentLimit })` → `{ running, recent, rootId, agents }`
with every job serialized with `ownerId`, where `getAsyncJobSnapshot` is
owner-scoped and hides subagent jobs from a top-level session entirely.

- The published envelope becomes `version: 2`: `AsyncJob` gains
  `ownerId: string | null` and the snapshot gains `rootId` plus the agent
  roster (`{ id, parentId }`). The parser still accepts v1 payloads — an
  older bridge's snapshot maps to a flat v2 (`rootId: null`, empty roster).
- Collection prefers `getAsyncJobTree` by method presence, per finding 3;
  the flat snapshot path stays the fallback and publishes the empty tree.
- The pane's layout is omp's own `/jobs` ordering (its `mP`, ported to core
  as `buildAsyncJobRows`): each agent node features one task job, other jobs
  hang off their owner's node, siblings sort branchiest-first. A cycle in the
  untrusted roster falls back to the flat order.
