# Artifact Refresh now runs in a background session

> **Status:** Accepted, 2026-11-09 ([#1132](https://github.com/LankfordAI/omp-ui/issues/1132)). Amends [ADR-0090](0090-session-authored-artifact-library-and-scoped-data.md) §"Human publication and session-mediated refresh". The draft-path wording of §5 and of that amendment is further amended by [ADR-0092](0092-artifact-refresh-requests-ride-the-prompt-as-a-parsed-block.md).

Under ADR-0090, refreshing a kept artifact's data took several manual steps. The user picked datasets and a destination; preparation added a reference and an editable request to that session's draft; then the user opened the session and sent it. Choosing a new destination created an unseeded session that sat idle until the user found it. The common case, "fetch this data again the way you did last time", asked for more work than it needed.

**Refresh now** starts that refresh in one click. The library creates an ordinary background session, prepares the request against it, and sends the request as its first prompt. Collection is still the OMP agent repeating its recorded recipe with its own tools, access and mode permissions. The artifact store, capture tool, binding and Apply contracts do not change.

## Decision

1. **Destination.** If the artifact's origin project is still registered locally (present in `state.projects`), the run is a new session in that project, in Plan mode. Otherwise the run is a new Chat, in Build mode per [ADR-0059](0059-chats-run-in-app-data-scratch-dirs.md). This includes an origin project that exists only as a retained label. The picker names the destination: "A new background session in {project}" or "A new background Chat".
2. **The click approves the send.** Choosing Refresh now is the human approval to send. The prepared text and its artifact reference go out as the run's first prompt. A capture the run produces is staged, never applied; **Apply captured data** stays a human action.
3. **The run session is kept.** It is an ordinary session titled `Refresh: <artifact title>`. The user deletes it when its transcript is no longer useful.
4. **No one-at-a-time lock.** An awaiting refresh request never ends by itself: under ADR-0090, a turn with no capture remains Awaiting captured data. A lock would therefore need manual clearing. Overlapping runs are safe without one, because `applyCapture` rechecks `expectedDatasetHeads` and refuses a capture whose selected heads have moved.
5. **Clean cutover of new destinations.** Refresh now replaces the draft-only "new Chat" and "new session in project" refresh options. Choosing an existing session still adds an editable request to its draft and sends nothing, so a refresh that needs steering keeps that path.
6. **Orchestration lives in the renderer store.** `runArtifactRefresh` sits beside `launchSession` in the lifecycle slice. It reuses the background spawn (`newChat`/`newSession` with `background: true`), the launch seed (`deliverLaunchSeed`) and the background-seed-failure toast. If preparation is rejected, the run that was just spawned is erased while it still has no native session ID, and the error reaches the picker. After the request is prepared, the library switches to its Data panel, and each refresh-request row offers **View run** while its target tab exists.

## Amendment to ADR-0090

ADR-0090 said an explicitly new destination is unseeded and that preparation sends nothing. For Refresh now this changes: the explicitly started run is seeded, and the human click sends it. The existing-session path still sends nothing. Dormant preflight, binding on the actual send, capture completeness, Apply's rechecks and the absence of connectors, guest networking and scheduling are unchanged.

## Considered Options

- **Delete the run automatically after capture (rejected).** The transcript is the evidence of how the capture was produced, and the user needs it to judge the capture before Apply. There is also no user-facing archive action to use instead: archiving is `omp gc` moving cold sessions, not something the user requests.
- **Allow one refresh in flight per artifact (rejected).** An awaiting request has no terminal state, so the lock would never release by itself. `applyCapture`'s head check already makes overlapping runs safe.
- **Launch the run from main (rejected).** It would duplicate `launchSession`'s seed delivery and its background-seed-failure toast, which already live in the renderer store.
- **A scheduler or connector platform (rejected).** Still out of scope under ADR-0090. Refresh runs only when a human starts it.

## Consequences

- A refresh that needs no steering takes one click. The user reviews the staged capture in the library and applies it.
- Each Refresh now leaves a session behind. Repeated refreshes accumulate sessions until the user deletes them.
- A run in the origin project starts in Plan mode, so Plan mode's restrictions apply to the recipe's tools there. A Chat run starts in Build mode in its scratch directory, like every other Chat.

## Amendment: the request is a chip, not prose (2026-11-10, issue #1139)

[ADR-0092](0092-artifact-refresh-requests-ride-the-prompt-as-a-parsed-block.md) amends §5 and the §"Amendment to ADR-0090" wording: preparing against an existing session "adds an editable request" — it now adds a removable reference and a removable refresh chip, structural entries the composer renders and the user removes rather than prose whose editing could corrupt the binding the send depends on. Sending is unchanged: the chip-removed send carries no refresh block, and main's admission refuses a refresh that lost its paired grant instead of silently skipping it. The Refresh-now seed sends the same grammar as its first prompt; captures, Apply's rechecks and the kept run are untouched.
