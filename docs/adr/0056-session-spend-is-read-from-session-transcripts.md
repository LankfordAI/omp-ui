# Session spend is read from the session's transcripts

Resolves issue #866. The Session HUD spend readout, the compact sheet's Spend
row, and the inspector rail's stats rendered `get_session_stats.cost` and
`.tokens.total`. omp's `SessionStatsTracker.getSessionStats()` sums only
`agent.state.messages`, the live LLM context. Verified against the managed
binary `omp/18.10.4` and the npm sources for 18.8.8, 18.9.0, and 18.10.0.

## Findings

- Compaction calls `agent.replaceMessages(summary + kept tail)`, so every
  earlier assistant message leaves the sum. A long goal run showed roughly the
  spend since its last compaction (one real session: $0.1987 shown, $0.7196
  actually spent).
- Async `task` results (the rpc default) and eval pool agents carry no
  `details.usage` on the root. Their spend exists only in their own
  transcripts at `<artifactsDir>/<id>.jsonl`, nested ones one directory deeper.
- `sessionManager.getUsageStatistics()` does survive compaction and exposes
  `cost` and `subagentCost` on every version from 18.8.8 through 18.10.4. It has
  no subagent token split and no reasoning total.
- omp appends journal entries synchronously, so an incremental tail read sees
  each entry once `appendMessage` returns.

## Decision

1. A per-lineage generated bridge (`omp-ui-session-spend.ts`) captures the root
   session through the `AgentSession.prototype.prompt` hook. The hidden
   `/omp-ui-session-spend` command arms it, and it publishes a digest-gated,
   revisioned `SessionSpendSnapshot` on `setStatus("omp-ui:session-spend")`.
2. It computes spend by tailing the root session file plus every `*.jsonl`
   under its artifacts dir (`sessionFile` minus `.jsonl`, omp's own rule),
   recursively, keeping a byte offset per file.
3. The counting rule: assistant `message` entries and `model_usage` entries
   with a `usage` object, at or after the file's `session` header timestamp.
   `toolResult` usage is never counted, because a sync task's `details.usage`
   re-reports its own transcript. Advisor transcripts (`__advisor.jsonl`,
   `__advisor.*.jsonl`) are excluded because the `adv` readout owns them.
4. The renderer prefers the snapshot when `available`. Otherwise it falls back
   to `get_session_stats`, which keeps the rail's message counts, context
   usage, and the compaction usage refresh.

## Rejected

- **`get_session_stats`:** context-scoped by construction.
- **`getUsageStatistics()`:** the cost is correct, but with no token split,
  subtracting sync-task usage from it would count tokens twice.
- **Renderer-side summing of `subagent_*` frames:** it loses agents that
  finished before the tab opened and needs the tab mounted to accrue.

## Consequences

- Spend only rises across compaction, subagent runs, and relaunches; a fresh
  process rescans the files and reproduces the total.
- The bridge runs inside omp on whichever host owns the process, so joined
  remote instances need no new IPC (ADR-0028). An older remote omp-ui without
  the bridge falls back to `get_session_stats`.
- The first scan of a large goal journal reads it once; lines carrying neither
  `"usage"` nor `"type":"session"` are skipped without `JSON.parse`.
- The rule depends on omp's journal shape (`session` header, `usage` on
  assistant messages and `model_usage` entries) and its artifacts-dir layout.
  Re-check on every managed-binary bump.
