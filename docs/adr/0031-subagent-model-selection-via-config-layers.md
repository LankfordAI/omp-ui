# Subagent model selection via omp's config layers

Subagent model selection is spelled as **one logical value — agent name →
`model[:level]` selector — edited at three scopes**, where the narrowest scope
wins: Global (`~/.omp/agent/config.yml`), Project (`<cwd>/.omp/config.yml`),
and Session (a per-lineage `--config` overlay). omp's own config layer order
already implements Global < Project < Session and deep-merges
`task.agentModelOverrides` per key, so omp-ui adds no precedence engine — only
a writer and a picker for each layer, plus an agent roster.

The default ships **on**: a session with no explicit choices writes `"*"` for
every roster agent, so every subagent runs on the session's own base model
rather than on omp's frontmatter tiers (`scout`/`sonic` bind `@smol`). The
umbrella is only ever written into the per-lineage overlay — a layer that is
omp-ui's own and disposable; Global and Project stay empty until the user
deliberately writes them.

## Verified omp behaviour (v18.2.4)

All facts below were measured against the shipped binary, not inferred:

- **Resolution order for one spawn** (`resolveAgentModelSelection` /
  `resolveModelSelectionChain`): caller-supplied model →
  `task.agentModelOverrides[<agentName>]` (exact, case-sensitive key) → agent
  frontmatter `model:` → the parent session's active model, then
  `modelRoles.default`. Unlisted `task`, `reviewer`, and `security-reviewer`
  all ran on the parent model.
- **`"*"` means "the parent session's model".** It is omp's
  `DEFAULT_MODEL_ROLE_ALIAS`; used as an entry value it resolved to the
  parent's `--model`, not to `modelRoles.default`. It is the literal spelling
  of "inherit the base model".
- **There is no wildcard key.** `{"*": <model>}` left `sonic` on the parent
  model; `{"sonic": <model>}` moved it. The umbrella therefore expands to
  agent names at spawn, which is what the roster is for.
- **Layers deep-merge per key.** An overlay carrying only
  `task.agentModelOverrides.task` left an unrelated global `task.agentAdvisor`
  entry and sibling keys intact — a session overlay never restates the other
  layers.
- **The overlay file is re-read before every spawn.** Subagent preflight calls
  `settings.reloadFromDisk()`, which re-reads the `--config` layer. Measured
  on a live `--mode rpc` process: spawn 1 ran on the parent model, the overlay
  was rewritten between turns with no restart, spawn 2 ran on the pinned
  model. Session scope is live; it needs no respawn — unlike the advisor
  (ADR-0005). The `subagent-model-live.test.ts` suite keeps this proven.
- **`omp config get/list` ignores `--config` overlays**, so the overlay's
  effect is read back from the session record, never from the CLI.

## Why not the obvious routes

- **No rpc verb.** There is no command to set `task.agentModelOverrides`
  in-process, and `get_subagents` does not report the resolved model — so the
  UI shows the configured value and its winning layer, never a claimed actual.
- **No `-e` runtime override.** An extension calling `settings.override`
  would mutate omp internals for no gain over the file omp already re-reads
  per spawn (ADR-0008 reserves extensions for *reading* omp state).
- **No new model-role id.** `OMP_MODEL_ROLE_IDS` stays omp's list; an
  omp-ui-invented `subagent` role would silently rewrite what `smol`, `tiny`,
  prewalk, and auto-title resolve to.
- **No upstream wildcard request** (AGENTS.md): the roster expansion is a
  faithful local substitute.

## Consequences

- **Session scope is live; the advisor still respawns.** Two overlays written
  by the same `writeSessionOverlays` path now have different change semantics,
  and the UI copy says so in each place.
- **The umbrella rebinds `scout`/`sonic` off `@smol` at Session scope only.**
  A user who prefers omp's cheap scout/sonic turns the General setting off and
  gets exactly the pre-change behaviour; a fresh registry with the switch on
  leaves `~/.omp/agent/config.yml` byte-identical.
- **The first explicit session choice replaces the umbrella outright.** The
  umbrella fills the roster only while `record.subagentModels === null`; one
  explicit entry makes the session map the whole overlay. Coarse but
  deliberate: the untouched state and the chosen state never blend silently.
- **Global edits are REPLACE-not-merge** (verified: `omp config set` replaces
  the record), so the UI merges one edit against the *global-layer* record —
  exposed as `OmpSettingEntry.globalValue` — never against the effective
  value, which would bake project entries into the global file.
- **Project edits go one entry at a time** through the line-scoped writer's
  third-level map API, so hand-written sibling keys, comments, and unrelated
  blocks survive byte-for-byte. A shape the grammar cannot see (flow mapping,
  anchor, duplicate key, deeper nesting) reports `unsupported` with file and
  line, and the UI refuses to edit rather than reformatting the user's config.
- **The roster is refreshed on demand, never at spawn.** `agents:refreshRoster`
  runs `omp agents unpack --dir <mkdtemp>` plus the user and registered
  project agent dirs and persists names to the registry; spawn reads the
  registry synchronously and never spawns a helper process.
- **A hibernated session's display does not depend on a stale artifact**: the
  session layer shown in the UI comes from `record.subagentModels`, and
  `writeSessionOverlays` regenerates the file on every launch.
- **`task.agentModelOverrides` is allowlisted but not in `OMP_SETTING_GROUPS`**:
  a record renders as a read-only JSON span on the omp page, so the page
  carries a dedicated "Subagent models" section with per-agent rows — the same
  reason the web-search keys live outside the groups.
