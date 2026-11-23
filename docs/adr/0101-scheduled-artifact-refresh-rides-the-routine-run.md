# Scheduled artifact refresh: a Routine fire prepares its own ADR-0092 refresh ask

> **Status:** Accepted, 2026-11-23 ([#1303](https://github.com/LankfordAI/omp-ui/issues/1303)). Amends [ADR-0100](0100-routines-scheduled-sessions-with-compiled-tool-policy.md) (tool-policy force-allow; new run reason code). Builds on [ADR-0091](0091-artifact-refresh-now-runs-in-a-background-session.md) and [ADR-0092](0092-artifact-refresh-requests-ride-the-prompt-as-a-parsed-block.md).

Refresh now (ADR-0091/0092) is one click per click: an artifact's recorded Refresh recipes only run when a human clicks. Users asked to keep an artifact's data current on a schedule. A **Routine** may be bound to one kept, managed artifact: at every fire omp-ui itself prepares an Artifact refresh request for the run's own session and sends it as the run's first prompt; the agent repeats each dataset's recorded recipe and stages a capture with `omp-ui_artifact_capture`; the user reviews staged captures in the Artifacts library and clicks Apply — exactly today's Refresh now, on a schedule ([#1303](https://github.com/LankfordAI/omp-ui/issues/1303)).

## Decision

1. **The binding is human-only.** A `RoutineRecord.artifact` (`RoutineArtifactBinding`: `artifactId`, `datasetIds` 1..32 unique, `autoApply`) is authored only in the RoutineEditor — the artifact picker lists managed records, the dataset checkboxes come from the accepted code's definition. `RoutineInput`, `RoutinePatch` and the store carry it (legacy records backfill `null` at load, the #1283/#1290/#1294 pattern). The agent host tools `omp-ui_routines_create` / `omp-ui_routines_update` gain no `artifact` key at all: their strict unknown-key rejection, not UI caution, is what keeps an agent from binding an artifact or setting `autoApply`. This mirrors ADR-0100's rule that an agent may author a routine but only a human arms one.

2. **The fire rides the ADR-0092 grammar unchanged; nothing new reaches the wire.** At dispatch the scheduler pins the binding into `SessionRoutine.artifact` (and onto the owned session record), and the compiler force-allows `omp-ui_artifact_capture` while bound (amendment below). At boot, inside the existing fleet-prompt block, `ArtifactService.prepareRoutineRefresh` — a host-internal call, never a renderer channel — mints the request against current heads (`autoApply`, `scheduledBy: <routine name>` recorded on it), and the staged fleet prompt is wrapped with the exact renderer recipe: `withArtifactRefreshContext(withArtifactReferenceContext(promptText, [reference]), [entry])`. The wrapped command rides the same `commandsAtReady` list whose admission loop already parses leading blocks and binds refresh lineage (`bindRefresh: true`), so there is zero new wire state — exactly what ADR-0092 exists to guarantee. A second bare prompt was rejected: omp queues one behind the fleet turn inconsistently (wake messages deliberately ride `follow_up`, ADR-0069), while one first message admits through the existing loop.
   - `hasPreparedRefreshFor(tabId)` is the durable one-shot guard: once the tab owns a refresh row, no respawn or resume re-asks. A stale selection between the fire's preflight and the boot wrap throws, logs, and the run proceeds as a plain routine.

3. **Preflight fails the row; capture and apply stay untouched.** Before catalog or dispatch, the scheduler asks the live library whether the binding still resolves (kept, managed, every dataset id on the current definition); otherwise it records a `failed` run with the new `artifact-missing` reason code and posts the routine's `onFail` notification, spawning nothing. A binding that survives into fires after the artifact is deleted shows an "artifact missing" warning in the editor and fails the same way.
   - The capture path (`host-bridge` routing, `stageCapture`, the tool schema) does not change: a routine tab is an ordinary local native target. Non-autoApply fires end exactly like Refresh now — capture staged, Apply is the user's click. A run that ends with no capture leaves its request Awaiting, as today.

4. **`autoApply` is a per-routine explicit opt-in that keeps every store fence.** When the bound routine set it and the staged request carries `autoApply`, `ArtifactService.stageCapture` — after staging succeeds — attempts `applyCapture` with the request's own acceptance fences (exact code revision, exact expected dataset heads). Every existing recheck still runs: moved heads, a dismissed request, an already-applied capture, or the active-byte cap leaves the capture staged for review; the applied snapshot records `cause: "refresh"` and stays restorable through snapshot history. The renderer's prepare channel cannot set `autoApply`/`scheduledBy`; only the host-minted path can.

## Tool-policy amendment (ADR-0100 §4)

The fire-time compiler takes `allowArtifactCapture`; while a routine is bound it emits `omp-ui_artifact_capture: allow` beside the existing `omp-ui_notify` exception (#1294), so staging the run's own capture never parks the unattended run on an Approval card. A policy **deny** of that tool still wins, and Dry run shows the injected entry because it shares the compiler. Routine fire rows gain one reason code: `artifact-missing` ("Artifact or datasets unavailable").

## Rejected

- Agent-authored bindings (host-tool surfaces stay key-free); connector/scheduler platforms inside artifacts (ADR-0091's rejection stands — the Routine *is* the scheduler); fleet-dispatched or remote refreshes (routine dispatch and the artifact library are both local-owner-gated already); a second scheduled-prompt-style wire state for the ask.

## Addendum (2026-11-23, #1311): agent-authored bindings

§1's "human-only" rule superseded: `omp-ui_routines_create` /
`omp-ui_routines_update` now carry the `artifact` key (create accepts a binding
or omits it; update accepts a binding or an explicit null to clear). Bindings
still validate through `parseArtifactBinding` on both paths — artifact UUID,
1..32 unique dataset keys, boolean `autoApply` — and every fire-time fence
(preflight, store fences on `autoApply` apply) is unchanged. The renderer
picker remains the human route; strict unknown-key rejection still refuses a
malformed binding.
