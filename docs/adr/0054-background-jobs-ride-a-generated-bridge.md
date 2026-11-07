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

## Addendum (issue #1017): the v4 envelope carries purpose and caption

Re-verified against `omp/18.15.0`. The job projection behind `getAsyncJobTree`
and `getAsyncJobSnapshot` gains two fields: `intent`, the purpose the model gave
for the call (absent for task jobs and on older omp), and `caption`, the widget
registry's one-line caption.

- omp writes a caption with the `widget` model role only when `async.widgets` is
  on, the job is `bash`, it has run for at least 15 s, its widget view has been
  read (`shown`), and the command is longer than 60 characters or contains a
  newline, `;`, `|`, `&`, a backtick, or `$(`. The bridge's `inspectAsyncJob`
  poll already reads the view, so captions are authored for omp-ui sessions
  without any extra call; the bridge never calls `requestJobCaptions()`, which
  would author captions for jobs nobody looks at.

Decision:

- The envelope becomes `version: 4`. Every job states `intent` and `caption`,
  each cleaned, clipped like `label`, and `null` when absent or empty. A missing
  key is malformed. v1–v3 payloads parse with nulls; an older envelope that
  carries a v4 key is malformed. Reads go by key presence, not by version.
- The byte rungs drop captions before they drop widgets; the purpose stays.
- The Jobs pane names a row by `intent`, falling back to `label`, and keeps the
  label as the hover title; the caption is a muted line under the row header.

## Addendum (issue #1077): the v5 envelope carries the nested-cancel capability

Re-verified against `omp/18.17.0`. The bug: since #868 the Jobs pane nests a
subagent's own jobs under its task row and put a Kill button on every running
row. A kill aimed at such a nested row could never land — the pane showed
`Could not cancel background job bg_N.` forever.

- `AgentSession.cancelAsyncJob(id)` is root-owner-only. In the binary it is
  `Qme(manager, this.agentId, id)`: it looks the job up, then refuses when
  `job.ownerId !== agentId`, so a subagent-owned job is always refused for the
  root session.
- The refusal sits *above* the manager, not inside it. `Qme` ends in
  `manager.cancel(id, { ownerId: job.ownerId })` — an owner-guarded verb that
  takes any owner. omp itself cancels other sessions' jobs through exactly this
  call (its security-scan and workpool code pass their own agent id), and on
  the worker-thread layout (`task.workerThreads`, #1070) a worker session's
  `asyncJobManager` is a proxy to the one main-thread manager omp hands every
  spawn. So the root's public `asyncJobManager.cancel(id, { ownerId })` cancels
  exactly one subagent-owned job — the job named — and never its owner.
- The v2 tree still lists those jobs, which is why the row renders at all.

Decision:

- Cancellation gets two routes, each aimed only at what it can reach: a job the
  root owns goes through `cancelAsyncJob` (unchanged); a subagent-owned job
  goes through `asyncJobManager.cancel(id, { ownerId })` with that row's own
  `ownerId`. Never the owning task job as a stand-in — cancelling the owner
  would silently reap siblings the user did not ask to kill.
- The envelope becomes `version: 5` with one snapshot-level boolean,
  `canCancelNested`: the manager's `cancel` is reachable, so a nested row may
  offer Kill. Presence of the method decides it, per finding 3. v1–v4 payloads
  parse to `canCancelNested: false` — an older bridge never cancelled a nested
  job — and a pre-v5 envelope carrying the key is malformed, the hybrid rule.
- A kill for a nested row that arrived at a bridge without the route fails with
  its own sentence naming the owning task, instead of the generic refusal;
  `kill all` cancels rows deepest-owner-depth first — a grandchild before its
  nested parent task, a bash job before its owning task at every level — so
  every row it stops reports its own cancellation rather than dying silently
  under an owner at any tree level. The walk is over the published agent
  roster; a malformed roster cycle keeps the walked depth instead of hanging.
- The Jobs pane hides Kill on a subagent-owned row unless both `canCancel` and
  `canCancelNested` hold, and the store's `killAsyncJob` refuses such a request
  outright, so a stale render can never send a doomed prompt. Root-job
  cancellation, `kill all`, and the nested tree layout are unchanged.

## Consequences of #1077

- A Kill on a nested row now cancels one job: the subagent keeps running with
  its remaining jobs, which is what the row claims. Cancelling the owner remains
  the way to stop the whole subtree.
- `canCancel` still means "this build cancels at all"; the nested capability is
  separate so an old pane against a new bridge (or vice versa) degrades to no
  button, never a button that lies.
