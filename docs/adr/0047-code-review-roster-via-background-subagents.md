# Code review as a batch of background subagents

Resolves issue #728. Verified against omp 18.6.0.

## Decision

`/code-review` and the model-callable `omp-ui_code_review` tool are an rpc-ui
extension bridge (`omp-ui-code-review.ts`, generated into the lineage dir and
passed with `-e` like every other bridge). The bridge never launches agents
itself: it reads the reviewer roster (`REVIEW.yml`, user + project scope,
same discovery shape as WATCHDOG.yml), gathers the git target, composes one
`task` **batch** invocation — one `tasks[]` item per enabled reviewer, each
carrying its pinned `model` selector when set — and hands it to the session
model with `pi.sendMessage(..., { deliverAs: "nextTurn", triggerTurn: true })`
as an inert-fenced instruction. The model makes the batch call; omp spawns the
reviewers as background subagents; their results arrive later as
`customType: "async-result"` wake turns, which the existing subagent UI
(steer/cancel, ADR-0045) and the hibernation veto already cover. A small
always-written `--config` overlay (`omp-ui-review.yml`) restates
`async.enabled: true` and `task.batch: true` so a user who turned either off
globally still gets review under rpc-ui; both are already rpc defaults, so the
overlay is idempotent. Rpc-only: PTY tabs neither load the bridge nor take the
overlay.

Reviewers are the `task` agent with per-item model pins; there is no dedicated
reviewer agent type, and the extension registers no launcher tool of its own
beyond `omp-ui_code_review`.

## Probe findings (omp 18.6.0, real binary, rpc-ui)

| Probe | Result |
|---|---|
| `task.batch` / `async.enabled` defaults | Both `protocolDefault: ["rpc"]` — on under rpc-ui; the overlay only defends against a user opt-out. |
| Batch schema | `{ context, tasks: [{ name?, agent?, task, model?, effort? }] }`; the per-item field is `task` (not "assignment"); names unique case-insensitively; per-item `model` validated against the registry. |
| Extension command ctx | No `callTool`; `ctx.invokeTool` is `undefined` on the command ctx (and root-binding `AgentSession.prototype` hooks are unnecessary). `pi.sendMessage` is the only launch primitive the api exposes. |
| `sendMessage` idle + `triggerTurn: true` | Starts the turn via the same path as a user prompt (`#yn`); mid-stream it queues with the trigger flag and fires on the next turn boundary. The custom message lands in the transcript (`display: false`) before the turn. |
| Model-driven batch call | Proven end-to-end: model emits one `task` batch call → `Spawned 2 background agents` → both complete → `customType: "async-result"` custom message in the parent transcript with both `<task-result>` blocks. |
| Per-item model | `probe-a` with `model: "litellm/Qwen3.8-Flash-Next"` produced a transcript whose `model_change` records exactly that selector while `probe-b` (no pin) followed the session model. |
| Name collision | The bundled command is `review`; `code-review` was free. Extension commands dispatch before builtins. |
| `available_commands_update` | Extension-registered commands appear in the frame, so a hermetic live test can prove the bridge loads without any model turn. |

## Rejected alternatives

- **Extension-side launcher tool calling `task` directly.** No extension ctx
  in 18.6.0 exposes `callTool`/`invokeTool` on the command or tool path, so
  the bridge cannot spawn; only the model can.
- **Hooking `AgentSession.prototype.prompt` to capture the root session** as
  a fallback launcher. Worked in a probe but reaches into binary internals
  the api already covers with `pi.sendMessage`; kept neither.
- **A dedicated reviewer agent definition.** Per-item model pins plus the
  shared playbook in each `tasks[].task` cover what an agent type would; an
  agent type could not vary the model per roster entry.
- **PTY support.** The launch primitive and batch/async defaults are rpc
  behavior; a terminal tab already gives the user the same model-facing path
  without the bridge.
- **Parsing REVIEW.yml in the bridge with `Bun.YAML.parse`.** Keeps
  validation in two places and needs a Bun stand-in under the Node test
  harness.

**Amended 2026-10-04 (#729, #732, #733):** the roster is a spawn-time
snapshot written by main (`omp-ui-review-roster.json` in the lineage dir,
validated by the same `readReviewRoster` Settings uses), not parsed by the
bridge — the bridge's own YAML subset was a second dialect that diverged from
Settings. Roster edits therefore apply on the next session relaunch. The
bridge resolves the target once and passes the concrete commit ids to every
reviewer. PR review requires `gh`; there is no git-fetch fallback.

**Amended 2026-10-04 (#738):** roster storage moved from `REVIEW.yml` files to
omp-ui's own state — a `reviewRoster` document on each `ProjectRecord` and a
global `RegistrySettings.reviewRoster`, resolved project → global → default,
edited in Settings → Reviewers. A one-time boot pass (`importReviewRosters`,
gated by the `reviewRosterImported` marker) copies the old user and project
`REVIEW.yml` files into that state without modifying or deleting them; the
files stop being read once the marker is set. The snapshot contract to the
bridge is unchanged. Accepted loss: per-project review config is no longer
git-shared or hand-editable, and CI/headless runs outside the app get the
global (or default) roster.
