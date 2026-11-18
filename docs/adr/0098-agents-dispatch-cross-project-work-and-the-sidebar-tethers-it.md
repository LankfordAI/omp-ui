# Agents dispatch cross-project work, and the sidebar tethers it

> **Status:** Accepted, 2026-11-18 ([#1226](https://github.com/LankfordAI/omp-ui/issues/1226)). Amends [ADR-0067](0067-sidebar-lists-sessions-not-projects.md): a dispatch tether repeats child sessions under the dispatching session. Extends [ADR-0060](0060-ask-chats-pin-context-as-a-hidden-message.md) with an opt-in content-aware dedupe. Relates to [ADR-0061](0061-fleet-dispatch-rides-the-spawn-request.md) and [ADR-0069](0069-fleet-results-wake-the-dispatching-session.md).

One session edited two repositories, so its diff mixed both, even though `omp-ui_fleet_dispatch` could already start a session in any project registered on this computer. Nothing told the agent to keep its changes in its own checkout, and nothing in the sidebar showed which sessions a session had dispatched. This record adds project scope guidance and dispatch tethers.

## Decision

**1. Project scope guidance.** A hidden-context bridge, `omp-ui:project-scope`, built by the ADR-0060 generator, tells a native project session to make repository changes only inside its own checkout. Its text is decided at protocol readiness from the same fleet tool access value that registers the fleet tools, read from the record as it is then:

| Session | Text |
| --- | --- |
| Chat | none |
| Access `granted`, not private | *dispatch*: hand another repository's change to `omp-ui_fleet_dispatch` once per repository, with a self-contained prompt; end the turn and wait for the Fleet result instead of polling |
| Access `granted`, private | *report-to-user*: a dispatched child is never private, so a private session must not hand its context to one |
| Access `agent-recursion` | *report-to-parent*: begin the final reply with the other repository's name and change, because the Fleet result forwards only the first 2,000 characters of the first run |
| `setting-off`, `external-sender` | none |

The arm rides ahead of `set_event_filter`, the host tool registration, and the fleet prompt. The text never lists other projects; the agent finds them with `omp-ui_fleet_machines`. It is guidance, not enforcement.

**2. Content-aware dedupe.** The generator gains `dedupe: "content"`: on every arm and resend the bridge compares the target text with the *latest* message of its custom type on the current branch, back to the last compaction or reset boundary, and sends only when that message is absent or differs. Every text opens by saying it replaces any earlier project scope message. A worktree conversion or release relaunches the same tab with a new checkout, a fork copies the transcript with `fleet: null`, and a migration moves it to another project, so the text changes without a new transcript; the content check re-pins it. The Ask pin and the restart carryover keep the `customType`-only dedupe: they are snapshots.

**3. Plan mode.** A mode switch needs no respawn, so the dispatch text carries the rule: while in Plan mode, describe the other repository's change in the plan instead of dispatching implementation, and dispatch planning sessions (`planMode: true`) only when the user asks.

**4. One derivation.** The renderer derives parent ↔ child links from `fleet.requestedBy` with `kind === "agent"` (`resolveDispatchLinks`), cached per `BackendState`, shared by the sidebar, the attention cards and the Session HUD. No new persisted field, no new IPC channel:

- R1: the universe is every local project session and chat plus every non-self remote instance's project sessions (remote chats are never projected).
- R2: a tabId seen more than once takes part neither as parent nor as child.
- R3: a child is agent-dispatched with a non-empty `sourceTabId` that is not its own tabId; `user`, `webhook` and `mcp` (whose `sourceTabId` is a client id) are skipped.
- R4: its parent is the unique universe session with that tabId, not `missing`.
- R5: children sort by `fleet.dispatchedAt`; an unparseable date sorts last.
- R6: only tabIds with a parent or a child get an entry.

**5. The tether.** A dispatching session's tile, or its Needs attention card, lists its children: a collapsible summary line (count, *waiting on you* in iris, *working* in copper), one line per unsettled child (at most 4 before *+N more*), settled children folded behind *+N settled*. On a tile it renders as a sibling of the row's draggable, context-menu container, so a line never drags the parent or opens its menu; on a card it is a sibling of the card's button. Collapse, expand and settled state are in memory, per dispatching tab. Settled (slim) rows show no tether.

**6. The child's side.** A child's project line carries a non-interactive ↳ marker with the parent's monogram; its hover cluster gains *open dispatching session*; a slim row says *↳ dispatched*. Hovering a tether line rings the child's row; hovering the marker rings the parent's row, and leaving it restores the row's own hover. The Session HUD's provenance chip becomes a button, *↩ Dispatched by …*, that opens the parent whenever R1–R6 resolve one, and stays the plain chip otherwise.

## Considered options (rejected)

- **A capsule in the Session HUD** (prototype A). Visible only inside the parent; the sidebar still could not show which sessions belong together.
- **A Sessions tab in the inspector rail** (prototype B). Another place to look, and closed by default.
- **Inline cards with a composer dock** (prototype C). Puts other sessions' state into the transcript the user is reading.
- **An enforced path guard.** Outside Plan mode omp offers no write fence an extension can rely on; it needs omp support.
- **Persisted per-tab collapse state.** A view preference that dies with the tab; not worth a registry field.
- **Dispatching from private sessions.** The child is never private, so the session's private context would leave it.
- **`--append-system-prompt`.** Replaces the user's `APPEND_SYSTEM.md`.

## Consequences

- Section membership and open-order sorting (ADR-0067, `launchedAt` newest first; pinned by pin time) are unchanged; a child appears both in its own section and on its parent's tether. Only tether lines use dispatch time.
- ~~The rule is opt-in: it arms only where *Let agents dispatch fleet work* is on and the session is not a Chat.~~ Superseded by the amendment below: every native session gets it.
- One level only: an agent-dispatched session never gets the fleet tools (ADR-0061), so it reports back.
- ~~The other repository must be a registered omp-ui project.~~ Superseded by [ADR-0099](0099-agents-add-projects-on-this-computer-through-a-confirmation-card.md): the agent can ask to add it.
- A child dispatched by a Chat on a joined instance keeps the plain chip and shows no ↳ marker.
- When a parent is deleted, its children lose the marker and the HUD falls back to the plain chip.
- ~~Turning the setting off arms nothing on the next spawn~~; it now arms the `no-dispatch` text (amendment below). An earlier project scope message stays in the transcript until the content dedupe replaces it.

## Amendment (2026-11-18): files outside every repository

[#1227](https://github.com/LankfordAI/omp-ui/issues/1227). The council's review found that the guidance covered repository changes only, and only where the setting was on. A session could still edit shell startup files, `~/.config`, omp's agent folder (which runs in every session), or omp-ui's own data with no rule at all. Every native session now carries the guidance:

| Session (fleet tool access + record) | Text |
| --- | --- |
| Project, `granted`, not private | *dispatch*, now also telling the agent to add an unregistered repository through `omp-ui_fleet_project` on `"this computer"` (ADR-0099) |
| Project, `granted`, private | *report-to-user* (also: do not add projects) |
| Project, `agent-recursion` | *report-to-parent* |
| Project, `setting-off` or `external-sender` | new *no-dispatch*: finish your own part and tell the user what the other repository needs |
| Chat (always `granted`) | a chat opening (*belongs to no project; edit no repository*), then *dispatch*, or *report-to-user* when private |

**Outside-files paragraph.** Every role ends with one paragraph on files outside the checkout that belong to no repository or project: judge a path by its realpath; change other files only when the user's request names them or clearly needs them; ask before changing omp's agent folder; never edit omp-ui's data folder, omp's session and archive folders, or omp's auth and history databases; change root-owned files only with `sudo -n`; list every such change in the final reply; in Plan mode, put them in the plan. The paragraph is not role-free. A dispatched child cannot ask its user, so its variant allows only the files its dispatch prompt names, tells it to report the agent-folder need instead of asking, and puts the list near the start of the final reply, inside the 2,000 characters the Fleet result forwards.

**Length tiers.** The paragraph names the real paths (agent dir, userData, sessions root, archive root), so the text can outgrow `PROJECT_SCOPE_TEXT_MAX` (4,000), and the bridge silently drops an arm above that cap. The text is built in three tiers and the first that fits wins: the full location with named paths; the generic location with named paths; the generic location with generic path names. The third tier measures 3,503 characters for *dispatch*, and every other role stays under 2,250.

Still guidance, not a fence.
