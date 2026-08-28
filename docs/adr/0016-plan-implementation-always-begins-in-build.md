# Plan implementation always begins in Build mode

An approved plan's implementation runs in Build mode in every execution
context, regardless of the Default agent mode preference. The Default agent
mode keeps controlling ordinary new native sessions only.

## Problem

When the Default agent mode was Plan, a reviewed plan executed in a freshly
spawned session inherited that default: the implementation session started
with plan mode armed, so omp's plan-mode write guard rejected every
working-tree write and the implementation could not proceed (issue #165).
The same-session and compacted contexts only worked by accident — the
extension exits plan mode in-process as part of the execute verdict, and
nothing verified Build before dispatching the implementation prompt.

## Decision

`SpawnRequest`'s discriminated rpc-ui arms carry an optional `planMode`
override (`packages/core/src/types.ts`). Omitted on a fresh session, the
configured Default agent mode decides; omitted on a resume or mode switch,
the persisted session mode is retained. The renderer's plan-execution path
passes `false`, so the implementation session is born in Build and no arm
prompt ever runs. The pty arms cannot carry `planMode` at the type or wire
parser boundary.

Enforcement points:

- **Fresh context** — `spawnFreshImplementation` passes `planMode: false` in
  an explicit `{ origin: "new", mode: "rpc-ui" }` request to
  `backend.spawnSession` (`packages/desktop/src/renderer/src/store.ts`); the
  main process parses the wire shape and honors it in `SessionManager.spawn`
  (`packages/desktop/src/main/session-manager.ts`).
- **Same-session / compacted contexts** — the store's `ensureBuildMode`
  helper waits (bounded, 15 s) for the extension's exit status frame
  (`plan.enabled === false`). In the healthy path the verdict-time,
  in-process exit publishes that frame, so the wait resolves without adding a
  mode turn to the transcript. If no frame ever surfaces — e.g. a throw
  inside the proposal handler before `exitPlanMode` — the helper drives the
  mode off directly with `/omp-ui-plan off` (fire-and-forget, so a failed or
  dead session cannot delay or abort dispatch) and waits a further 5 s before
  dispatching the implementation prompt regardless.
- **Extension unchanged** — the generated plan extension already exits plan
  mode on execute (`packages/core/src/plan-extension.ts`, "Accepted" branch).
  That in-process exit stays the fast path.

## Consequences

- Implementation begins in Build in every execution context, whatever the
  Default agent mode says; the Default agent mode still controls ordinary new
  native sessions (pinned by main-process tests).
- A genuinely stuck session costs at most 15 s + 5 s of gate time before the
  implementation prompt dispatches; a dead tab's prompt no-ops as before.
- If the extension's proposal handler ever throws before its exit runs, the
  renderer's forced `/omp-ui-plan off` is the backstop that keeps the
  implementer writable.