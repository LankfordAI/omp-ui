# Agents add projects on this computer through a confirmation card

> **Status:** Accepted, 2026-11-18 ([#1228](https://github.com/LankfordAI/omp-ui/issues/1228)). Amends [ADR-0043](0043-host-tools-answer-what-the-main-process-owns.md), [ADR-0061](0061-fleet-dispatch-rides-the-spawn-request.md), [ADR-0062](0062-fleet-exec-runs-one-command-on-the-owners-shell.md), [ADR-0064](0064-sessions-provision-members-over-their-own-ssh.md), [ADR-0069](0069-fleet-results-wake-the-dispatching-session.md) and [ADR-0098](0098-agents-dispatch-cross-project-work-and-the-sidebar-tethers-it.md).

ADR-0098 told an agent to dispatch another repository's change, and to stop when that repository was not a registered omp-ui project. In practice the user then registered it by hand, or the agent cloned it with its own shell and left it unregistered. `omp-ui_fleet_project` already registered and cloned on fleet members behind rung 3 and declared roots. On this computer it refused.

## Decision

**Invariant.** Only an Allow on omp-ui's card registers or clones a project on this computer. No chat permission, approval mode, or omp approval prompt can stand in for it. A deny, a dismissal, a cancel, a session exit, or a stale answer has no side effect. The card is consent, not containment: an agent with a shell can still run code on this computer. It cannot use omp-ui to make a project of it without the user's Allow.

1. **The route.** `omp-ui_fleet_project` with machine `"this computer"` becomes a *project request*. `register` takes an existing checkout's absolute path. `clone` takes an https URL without credentials, an `ssh://` URL, or an scp-like `user@host:path`. The member branch is unchanged.
2. **Eligibility**, decided in main from the live entry and the record, whatever tools the session holds: fleet tool access `granted`, not private, not in Plan mode. `granted` already excludes agent-dispatched and webhook/MCP sessions. Chats are granted, so chats are eligible.
3. **Register checks**, run before the card and again after Allow: the path resolves (realpath). An already-registered realpath returns that project at once with no card. Refused when it is the filesystem root, the home folder or an ancestor of it, equal to, inside, or above omp-ui's data folder, omp's agent, sessions, or archive folders, the chats root, or the worktrees root, when it is inside a registered project, or when it has no `.git`. No declared project root is needed locally: the user is the one who answers.
4. **Clone destination.** The card proposes the session project's parent folder (the home folder for a chat) and offers *Choose folder…*. The destination `<parent>/<name>` must not exist when git starts, and must pass the register location checks. git runs with `GIT_TERMINAL_PROMPT=0` and `ssh -o BatchMode=yes`, so a passphrase or host-key prompt fails fast. A failure or cancel removes the partial destination, which the check had proved new.
5. **The card** shows the folder and its `origin`, or the repository and its destination, a warning that sessions in the project run its `.omp` extensions, hooks, tools, and MCP servers with the user's account and provider keys, and the executable-config paths found in the checkout. It reads the request from the session summary (`projectRequest`), so every client sees it. `project-request:answer` is tab-routed, so a joined instance's card is answered at its owner, and its folder picker browses the owner's filesystem.
6. **The held call.** The host call blocks while the card is open. `HostBridge` gives the answerer a control: `suspendWatchdog` clears the 60-second watchdog while a human answers, `rearmWatchdog` arms a fresh one for the work after Allow (60 s for a register, the 10-minute clone timeout plus 15 s for a clone), and `signal` aborts on `host_tool_cancel`, a tab exit, or a watchdog answer, which also kills a running clone. The wait counts as awaiting a human answer, so hibernation, the stall watchdog, and the summary see it.
7. **Limits.** One open request per tab; a second call is refused at once. At most 3 requests per agent run, and the count resets on `agent_start`.
8. **Register and clone share one gate.** A shell clone followed by a card-free register would bypass the user's choice of what becomes a project.

## Considered options (rejected)

- **Chat consent** (the agent asks in the transcript and the user says yes). The default approval mode resolves to yolo. omp's tool approval prompt shows no arguments (ADR-0048). Sessions can run unattended. Prompt injection can write the yes.
- **Local rung 3.** Raising this computer's own ceiling would also raise what joined dispatchers may do here.
- **Requiring `fleetProjectRoots` locally.** The roots exist because a member's owner is not there to answer. Here the user answers each request.
- **A non-blocking two-phase tool** (request now, poll for the answer). It makes the model poll; ADR-0069 removed polling from fleet results.

## Consequences

- **ADR-0043**: main stays the only answerer of host calls. The renderer sends a decision on its own channel, never a tool result.
- **ADR-0061** said omp-ui "adds no confirmation channel of its own". For project requests on this computer it now does.
- **ADR-0062**: rung 3 stays member-only. The local route is the card, not a rung.
- **ADR-0064**: `project:add` stays unexposed to agents. The agent route is `omp-ui_fleet_project` plus the card.
- **ADR-0069** objected to a tool that blocks on the user. The suspended watchdog answers that objection for this one call.
- **ADR-0098**: an unregistered repository can now be added. The dispatch guidance says how and tells the agent to dispatch by the returned path, because the repository key resolves asynchronously.
- In `write` and `always-ask` approval modes the user sees omp's argument-less prompt first and then the card. The double prompt is documented, not suppressed.
- SSH clone is allowed only on this computer, where the user's own keys and agent apply. Member clones stay https-only.
- The request lives in memory only and dies with the process.
