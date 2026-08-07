# Plan mode, driven by a per-lineage generated extension

Plan mode is offered in rpc-ui tabs as a HUD toggle plus a native review pane.
It is delivered by an **omp extension omp-ui generates into the session's
lineage dir** (ADR-0003) and passes as `-e` at spawn — the same per-lineage
delivery ADR-0005 uses for the advisor overlay. State and approval ride two
frame types the rpc-ui protocol already has (`setStatus` and `select`), so no
new protocol surface is invented.

## Why not the obvious routes

Verified against omp 17.1.8 by driving a real `--mode=rpc-ui` process:

- **No rpc command exists.** The `RpcCommand` union
  (`src/modes/rpc/rpc-types.ts:28-92`) has no plan variant, exactly as with the
  advisor.
- **`get_state` reports no mode.** Its payload is `model`, `thinkingLevel`,
  `isStreaming`, `isCompacting`, the three queue modes, `sessionId`,
  `sessionFile`, `autoCompactionEnabled`, `messageCount`,
  `queuedMessageCount`, `todoPhases`, `systemPrompt`, `dumpTools`,
  `contextUsage`. omp-ui can never read plan state back, so — as with the
  advisor — the UI's own record is the source of truth.
- **`/plan` is TUI-only.** `builtin-registry.ts:400` defines `handleTui` with no
  `handle`, and `executeAcpBuiltinSlashCommand` skips specs without `handle`.
  Sent over rpc it is not a command at all: it reaches the model as literal
  prompt text and starts an agent turn.
- **`plan.defaultOnStartup` is ignored in rpc-ui.** Only `InteractiveMode`
  (`:1062`) and `print-mode` (`:119`) read it; `rpc-mode.ts` never does. A
  `--config` overlay setting it true produced no `plan-mode-context` message.
- **`--plan-yolo` arms but does not gate.** It *does* inject plan mode under
  rpc-ui, then auto-approves on the model's first proposal — the opposite of a
  review gate.

## What is actually reachable

`AgentSession` carries the whole plan API as public methods —
`setPlanModeState`, `setPlanProposalHandler`, `preparePlanForReview`,
`setPlanReferencePath`, `setActiveToolsByName`. An extension can drive all of
it. The one catch is getting a reference: `ExtensionContext` exposes
`sessionManager` (a `ReadonlySessionManager` whose 20 picked methods contain no
plan API) but never the `AgentSession`. The extension therefore patches
`AgentSession.prototype.prompt` to capture `this`.

**That is unsupported surface, and it is the load-bearing risk of this ADR.**
It is contained rather than hidden: the patch is wrapped, the captured object is
checked for every method the flow calls, and any failure publishes
`unavailable`, which disables the toggle with the reason in its tooltip. The
feature degrades to absent, never to half-working.

## The channel

Two existing rpc-ui frames carry it, so the renderer's frame router grew no new
cases — only a claim ahead of the generic extension handling:

- `ui.setStatus("omp-ui:plan", <json>)` publishes `PlanStatus`. Claimed as
  state; it never reaches the HUD's status chips.
- `ui.select("omp-ui:plan-review:<json>", ["execute","refine"])` requests
  the verdict. Claimed by the review pane instead of the generic select dialog.
  `execute` is a single admission: it pins the plan as the reference and tells
  the agent to stop and wait, and the renderer then dispatches the actual
  implementation as a normal prompt — same session, same session after
  compacting, or a freshly spawned session seeded with the plan. `refine` sends
  the agent back to revise, optionally with the user's revision notes (which
  arrive as a follow-up steer, images included).

The constants live in `core/src/plan.ts` — pure, no imports, imported directly
by the renderer via the `@omp-ui/core/plan` subpath exactly like `types.ts`.
The generator (`core/src/plan-extension.ts`) consumes those same constants, so
the two ends of the channel cannot drift; a test asserts they appear in the
emitted source.

## Consequences

- **The agent blocks on the verdict.** `xd://propose` does not resolve until the
  renderer answers. Every *answering* exit lands `execute` or `refine`; the
  third exit — Escape, scrim-click, or the "not now" button — is `deferPlanReview`,
  which dismisses the pane **without** answering, so the agent stays paused on
  its proposal and the plan stays pending in the rail's plans pane until the
  user returns. Defer and refine alike keep the working tree read-only, and the
  paused gate is always resumable from the proposed-plans pane, so deferring an
  ill-timed proposal is never destructive. This is the same discipline
  `ExtensionDialogHost` already follows, for the same reason — the dialog host
  answers automatically, while the plan pane may deliberately hold.
- **Read-only is omp's guarantee, not ours.** `enforcePlanModeWrite`
  (`tools/plan-mode-guard.ts`) rejects working-tree writes while the mode is on;
  omp-ui neither re-implements nor weakens it. Verified: an explicit "just
  overwrite the file, no planning" instruction left the file untouched and
  produced a plan artifact instead.
- **No respawn.** Unlike the advisor, plan mode toggles in-process at any time,
  which is why it earns a HUD button rather than a relaunch.
- **The plan file is read off disk, path-confined.** It lives at
  `<lineage>/<session>/local/<slug>-plan.md`. The `plan:read` IPC channel
  resolves and confines every request to the session's own lineage dir, so a
  crafted `local://` name cannot turn it into an arbitrary file reader.
- **The `plan` model role is deliberately not applied.** omp's TUI swaps to the
  `plan` role on entry and restores on exit
  (`plan-mode/model-transition.ts`); omp-ui runs plan mode on whatever model the
  composer shows. Revisit if planning quality on a small model disappoints —
  the transition module is pure and portable if so.
- **The HTML review rendition is a companion file, not a plan format.** Issue
  #109 asked for HTML plans. omp 17.2.10 hardcodes `local://<slug>-plan.md`
  across the plan-mode context template, the `xd://propose` tool description,
  the write guard's error, and the slug→path derivation, so a canonical HTML
  plan is unreachable without forking omp. Instead the markdown plan stays
  mandatory — it is what the propose gate validates, what reference pinning
  points at, and what seeds a fresh implementation session — and under the
  `html` plan format the extension asks the agent, via one hidden
  `sendCustomMessage`, to also maintain `local://<slug>-plan.html`. The review
  request carries its confined absolute path (`planHtmlAbsPath`, null under
  `md`), read over the same `plan:read` channel, so the modal renders it and
  silently falls back to the markdown when it is absent. An omp without
  `sendCustomMessage` degrades the session to `md` with one warning rather than
  promising a rendition nothing will write.
- **Agent-authored HTML renders under an empty sandbox, and cannot navigate.**
  The modal embeds it as `srcDoc` in `<iframe sandbox="">` — zero tokens, so no
  scripts, no same-origin access, no forms, no popups, no top navigation; the
  file never becomes a `file://` URL, keeping the read on the confined channel.
  Verified in the app: a `<script>` the planner was asked to embed sits in the
  frame's DOM without ever running. An empty sandbox still permits the frame to
  navigate *itself*, which would replace the reviewed plan with a remote page
  off a model-chosen URL, so the main process denies every subframe navigation
  (`will-frame-navigate`) and routes web URLs to the system browser through the
  same `openExternalSafe` policy `window.open` already uses (issue #101).
