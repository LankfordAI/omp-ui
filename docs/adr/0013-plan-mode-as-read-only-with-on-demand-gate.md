# Plan mode is the read-only mode, with the plan gate on demand

Plan mode (ADR-0007) keeps its two toggle positions, but "on" now means
read-only-first rather than plan-authoring: omp's write guard is enforced, no
per-turn planning mandate is injected, and no review gate exists until a plan
is actually written. The default turn under the mode is exploration answered in
place; a plan artifact appears only because the user's own prompt asked for
one, and once a proposal arrives the review pane, refine, defer, execute, and
the rail's proposed-plans pane behave exactly as they do today. This supersedes
ADR-0007's "What is actually reachable" section — the plan API is reached the
same way, but `setPlanModeState` is no longer how the mode is entered — and
implements issue #112.

## What the binary actually does

Verified by reading the embedded source of the installed omp 17.2.10
`--mode=rpc-ui` binary. Six findings decide the design:

- **The write guard reads only the public method.** `enforcePlanModeWrite`
  calls `getPlanModeState?.()` on the session; when the state is not enabled it
  returns, otherwise it rejects working-tree writes, deletes, and renames while
  allowing any path inside the session's local sandbox — the `local://` carve-out
  a plan artifact needs.
- **The plan-authoring mandate reads a private field.** The per-turn
  `plan-mode-context` injection ("you MUST write the canonical plan… your turn
  ends ONLY by ask or `xd://propose`") and the end-of-turn plan-mode-decision
  nudge both read `this.#z` directly. `#z` is a true private field, unreachable
  from outside the class. **This is the load-bearing point: the guard reads the
  public method, the authoring mandate reads the private field, so
  `setPlanModeState` — which sets `#z` — cannot separate the two.** Any design
  that arms real state re-couples read-only enforcement to a mandatory plan.
- **The propose gate also dispatches through the public method.**
  `preparePlanForReview` validates through `this.getPlanModeState()`, so slug →
  on-disk plan validation proceeds normally under a wrapper that reports
  enabled, and `xd://propose` still blocks on the installed proposal handler.
- **Every other public consumer is benign or beneficial.** The task tool's
  preflight strips subagent isolation, apply, and merge controls in plan mode,
  which keeps in-process subagents read-only too; the ask tool drops its
  timeout; autolearn skips capture. The ACP-mode and `plan.defaultOnStartup`
  consumers are unreachable in rpc-ui.
- **The method lives on the prototype and facades delegate dynamically.**
  Because it reads `#z` it cannot be an instance arrow, and the session facades
  forward through `() => this.getPlanModeState()`. Wrapping
  `AgentSession.prototype.getPlanModeState` therefore intercepts the session
  instance, every facade, and every in-process subagent session at once.
- **Post-execute reference injection is unaffected.** `setPlanReferencePath`
  pins the plan and the `plan-mode-reference` context fires on a later turn when
  the mode is off, a reference is set, and it has not been sent — exactly the
  state after an execute verdict, so the renderer-dispatched implementation
  prompt still receives the plan reference.

## The design

The generated per-lineage extension wraps
`AgentSession.prototype.getPlanModeState`, next to and with the same discipline
as its existing `prototype.prompt` patch. While the mode is on, the wrapper
returns `{ enabled: true, planFilePath, workflow: "parallel" }` whenever the
real state is absent; real state always wins, so any omp-internal path that
arms plan mode behaves precisely as it does today. `setPlanModeState` is never
called to enter the mode — only `setPlanModeState(undefined)` survives, as a
defensive no-op on exit against some future internal arming path. The
extension's own reads of plan state go through the unwrapped method captured at
load, so it never observes its own fake and the toggle's published state stays
truthful.

With omp's per-turn plan-mode context no longer injected, the steering it
carried becomes the extension's own single hidden instruction
(`omp-ui:plan-mode`), delivered once on entry through `sendCustomMessage`: the
session is read-only and enforced by omp's guard, the default is to answer in
place, a plan is written to `local://<slug>-plan.md` and proposed only when the
user asks, and a plan that is asked for is always proposed. That instruction is
steering, not enforcement. The guard is the guarantee, so a session whose omp
lacks `sendCustomMessage` stays armed and warns rather than disarming or
running half-protected.

_Amended after issue #117: the instruction is not delivered once, it is delivered on
both edges. omp's own plan-mode context was ephemeral — re-derived per turn from the
private field — so clearing the state cleared the model's view of the mode. A hidden
custom message is not: it is appended to the conversation and stays there, while
`appendModeChange("none")` only writes a transcript entry the model never sees. So
entry states that it supersedes every earlier plan-mode and plan-format instruction,
and exit delivers a matching `omp-ui:plan-mode-exit` retraction. The retraction is
steering like the instruction it cancels — the guard is already down when it is sent,
so a delivery failure is silent and the next entry supersedes the stale copy. The
execute path is the one exception: its `ToolResult` already tells the agent plan mode
exited, and the agent is blocked mid-turn inside its own proposal._

## Risk

ADR-0007's unsupported-surface note now covers two wrapped prototype methods
rather than one, and the second carries the read-only guarantee itself. The
contract is unchanged and fail-closed: a missing or renamed method publishes
`unavailable`, which disables the toggle with the reason in its tooltip, so no
session ever runs half-protected — the feature degrades to absent, never to
partially enforced. The concrete future-omp changes that would trip it are
narrow and detectable: the write guard or the `xd://propose` dispatch moving off
the public `getPlanModeState`, or the method being renamed. Either surfaces as a
disabled toggle on the first spawn against the new binary, not as a session that
believes it is read-only while writes land.

## Consequences

- **The default turn writes nothing and plans nothing.** Exploration is answered
  in place; no plan artifact is produced unless the prompt asked for one.
- **The gate is unchanged, just on demand.** A requested plan is proposed and
  reviewed exactly as before — execute, refine, defer, the proposed-plans pane,
  and the advisor fold (ADR-0009) all behave identically once a proposal exists.
- **Subagents inherit the guard.** In-process subagent sessions read the same
  wrapped prototype method, and omp's task-tool preflight strips their
  isolation, apply, and merge controls, so a delegated turn cannot write either.
- **The end-of-turn propose nudge goes away with `#z`.** A plan the user asked
  for whose turn ends without a `xd://propose` write stays unreviewed on disk.
  It self-heals on a follow-up — "submit that plan" — and the extension's
  instruction already tells the agent to always propose a plan it was asked to
  write, so no mechanism is added to force it.
- **If plan quality degrades against omp's own template, the fallback is text.**
  Expand the extension's instruction; never reach back for `setPlanModeState`,
  which would restore the per-turn mandate this ADR exists to remove.
