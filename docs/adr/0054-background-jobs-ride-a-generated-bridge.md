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

## Addendum (issue #954): the v3 envelope carries live job widgets

Re-verified against `omp/18.13.2`. omp 18.12.3 added live job widgets
(`async.widgets`, default on). The `widget` model role writes one spec per
running background job, and omp then computes every update from the job's output.

- `getAsyncJobTree` still serializes jobs through the same nine-field
  projection. `inspectAsyncJob(id)` now also returns `widget`: the widget
  registry's rendered view `{ title, headline?, stage?, blocks, state,
  updatedAt }`, not the model's spec.
- Reading a view has a side effect. It marks the job as shown, and once the job
  has run for 15 s omp may author a spec. The bridge's `inspectAsyncJob` poll has
  done this since 18.12.3. `async.widgets: false` turns off both authoring and
  views inside omp.
- A running task job's `completionPercent` and `stage` live on the job
  manager's job (`latestDetails.progress`, the entry for the job's agent). The
  bridge reaches them through the public `AgentSession.asyncJobManager.getJob(id)`,
  the same read omp's `wait` tool makes. omp fills them from its subagent
  completion probe, which runs only in interactive mode. An rpc-ui session never
  probes, so these fields stay empty in omp-ui sessions on this binary. So do
  task-job widgets, because authoring one needs the probe's `watch`.

Decision:

- The envelope becomes `version: 3`. Every job carries three fields, each
  `null` when absent: `widget` (live views only, reduced and capped by the
  bridge), `completionPercent` (an integer from 0 to 100), and `stage`. v1 and v2
  payloads parse with nulls. An older envelope that carries a v3 key is malformed.
- The widget comes from `inspectAsyncJob`. The bridge asks
  `asyncJobManager.widgets.view(job)` only when that result has no `widget` key,
  so no poll reads a view twice. Every read is decided by method and key presence,
  not by version.
- The byte rungs gain one step: before it gives up, the bridge drops widgets
  and keeps the estimate and stage.
