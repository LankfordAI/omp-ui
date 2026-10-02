# Goal mode via omp's native rpc goal command

Resolves issue #712. Supersedes ADR-0024. Verified against omp 18.4.10 and
18.4.12.

## Findings

| Probe | Result |
|---|---|
| 18.4.10 `{ type: "goal", op: "get" }` | `Unknown command: goal`; `get_state` has no `goal` key. |
| 18.4.12 `get`, no goal | `{ goal: null, state: null }`; `get_state.goal === null`. |
| `create` with `objective`, `token_budget: 5000` | `data.state` is `{ enabled: true, mode: "active", goal: { id, objective, status: "active", tokenBudget: 5000, tokensUsed: 0, timeUsedSeconds: 0, createdAt, updatedAt } }`; the `goal` tool is added; a `goal_updated` event carries `{ goal, state }`. |
| `pause` / `resume` | `enabled` false / true, status `paused` / `active`. |
| `create` while active | `A goal is already active. Drop it before creating another.` |
| `drop` | Nulls; the last `goal_updated` reports status `dropped`. |
| `drop` / `pause` with no goal | Success, nulls. |
| `resume` with no goal | `No paused goal to resume.` |
| `token_budget: 0` | `token_budget must be a positive integer when provided` |
| Abort during a goal turn | The goal pauses. |
| No overlay (default `continuationModes: ["interactive"]`) | No turn after `create`. |
| Overlay `continuationModes: [interactive, rpc]` | A `goal-mode-context` then a `goal-continuation` `message_start`; omp drives the loop. 18.4.10 boots with the same overlay. |
| `omp config list --json` | `"goal.continuationModes": { value: ["interactive"], type: "array" }`, ~0.15 s. |
| Capabilities bridge tool mutation `{ name: "goal", enabled: true }` on 18.4.12 | `applied`; no bridge change needed. |

Upstream behaviour read from source: `create` refuses in plan mode, when
`goal.enabled` is false, and while a paused goal exists; startup reconcile
restores an active goal as paused; completion sets `complete`/`exiting`, then
clears without an event at `agent_end`; `goal` is not in
`BACKGROUND_COMMANDS`; token usage emits `goal_updated` live; the rpc goal path
ignores vibe mode.

Precedent: ADR-0045 (#713) moved subagent control off a generated bridge onto
native rpc verbs the same way.

## Decisions

1. Every goal action dispatches omp's `{ type: "goal", op }` command (`get`,
   `create`, `pause`, `resume`, `drop`) as a `SESSION_COMMANDS` entry with
   `lateAck: false`. Goal truth rides three frames: goal responses,
   `get_state.goal`, and `goal_updated`. Main mirrors the latest per live tab;
   the renderer parses the same frames. The generated goal bridge, its arm
   command, its `omp-ui:goal` status route, and its hidden prompt are deleted.
2. The floor is omp 18.4.11. There is no fallback: `Unknown command:` shows an
   update hint, and nothing retries through another path. omp's failure
   sentences show verbatim.
3. A budget is set only at creation: `/goal [--budget N] <objective>`.
   `/goal budget` is gone; it fails with a hint. `/goal set` over an enabled
   goal is `drop` then `create`; a failed `create` after the drop says so.
4. Continuation is omp's own loop. Each rpc-ui spawn reads the user's
   `goal.continuationModes` through `omp config list --json`; when it contains
   `"interactive"`, a per-spawn overlay (`omp-ui-goal.yml`) adds `"rpc"`. When
   the user removed `"interactive"`, or the read fails, no overlay is written
   and goals do not auto-continue. This narrows ADR-0036's rejection of
   "forcing values through overlays" for this one key: the overlay follows the
   user's setting into the mode omp-ui runs, it does not override it.
5. `/guided-goal` enables the `goal` tool through the capabilities bridge's
   tool toggle, then sends `guidedGoalPrompt` as a normal prompt. It refuses
   while vibe or plan mode is on, or while a goal owns the session.
6. The HUD goal chip opens a popover (objective, usage, elapsed, pause or
   resume, two-step drop) that dispatches the same `/goal` lines. It replaces
   the bridge's confirmation dialog. Vibe-mode refusal stays in the renderer,
   since omp's rpc goal path ignores vibe mode. PTY tabs keep omp's TUI.
