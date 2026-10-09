# omp-ui

A cross-platform desktop GUI for the `omp` coding agent: a project sidebar and
an embedded OMP TUI (Phase 1), with optional native transcript rendering
(Phase 2) and ACP integration (Phase 3).

## Language

**Session**:
An on-disk OMP transcript: one `<timestamp>_<uuidv7>.jsonl` file plus its
optional sibling artifacts directory, identified by the UUID in its header.
omp-ui reads and resumes sessions; it never edits their contents. The one write
it performs is destructive and explicit: a user-confirmed delete that erases the
whole lineage dir from the active and archive roots.
_Avoid_: conversation, chat, thread

**Live session**:
An owned session with a running `omp` process owned by the omp-ui instance
(the app is single-instance; the registry lives in the one main process).
Its tab may be visible or hidden — closing a tab hides it (the process keeps
running); clicking the session resurfaces the tab. omp-ui never spawns a
second process for the same session, because omp has no cross-process session
lock (v17.1.8).
_Avoid_: open session, active session, running session

**Hibernated session**:
An owned session whose `omp` process omp-ui stopped itself after the session
sat idle beyond the *Hibernate idle sessions* window while no renderer was
viewing its tab and it was not its project's most recently active session
(issue #246; viewed-tab exemption #266; last-active exemption #304), or after
it handed an approved plan to a fresh implementation session and passed the
same live-work safety probe (issue #283).
A hibernated session is dormant — transcript and worktree on disk, no process — and wakes
through the ordinary resume path; the sidebar shows it as dormant and its tab
offers resume. The distinction from a plain dormant session is causal: dormant
lost its process because the app quit, hibernated lost it on purpose while idle.
The last-active exemption uses the sidebar recency key
(`cachedModified ?? launchedAt`, ties to the earlier registry record) across
all of a project's owned sessions, and like the viewed-tab exemption it
applies to idle hibernation only, never to a plan handoff.
_Avoid_: suspended session, parked session, sleeping session

**Tab**:
The renderer's view onto a live session's PTY — one xterm.js instance per
live session. Tabs hide rather than close; focus/dedupe keys on the tab,
which exists from spawn — before the session has an id or file. A tab may
belong to a remote instance: it renders that host's stream, its
`instanceId` names the owner, and its label carries the nickname in front of
the title.
_Avoid_: window, pane

**Project**:
A working directory the user has explicitly registered in the sidebar, stored
in omp-ui's own config. Owned sessions attach to the project they were
launched in. A project with zero sessions is valid (fresh repo, nothing run
yet).
_Avoid_: repo, folder, workspace

**Sidebar group**:
A user-named, collapsible sidebar section holding zero or more of this app's
own projects. Each project sits in at most one group; membership, group order,
and collapsed state are stored in the registry. Joined remote instances'
projects are never grouped, and removing a group never removes its projects.
_Avoid_: folder, workspace, team, project group (collides with the
`ProjectGroup` project-plus-sessions type)

**Owned session**:
A session whose file lives in an omp-ui lineage dir (ADR-0003) — launched by
omp-ui or produced in-process by such a session (`/new`, `/branch`). The only
sessions the sidebar tracks. Sessions from terminal `omp` use are invisible
to omp-ui, even under registered projects. Its sidebar position is explicit:
the registry's persisted session order (issue #274); activity refreshes
titles and statuses in place, new owned sessions enter at their project's
top, and reordering is a user action (drag or keyboard), never a side effect
of running.
_Avoid_: tracked session, managed session

**Lineage**:
The sequence of sessions one spawned `omp` process produces: the initial
session plus every `/new` and `/branch` it switches into (omp replaces the
session file in-process). A lineage shares one pinned session dir.
_Avoid_: tab history

**Plan handoff**:
A persistent, one-way relation from a fresh implementation session to the
planning session whose approved plan seeded it. After the fresh session
acknowledges that seed, the renderer suppresses automatic prompts on the source
and main hibernates it only when a safety probe finds no turn, queue, stream, or
blocking human-answer request. A declined reap leaves the source live but still
handed off until a human prompts or resumes it. Deletion runs one way:
deleting the planning session deletes the
implementation sessions it spawned, and every session descended from
them, with it (issue #309). Deleting an implementation session never
deletes its planning session or its siblings.
_Avoid_: lineage, parent session

**Render item**:
One entry in the native transcript, reduced from the `AgentSessionEvent`
stream by `lib/transcript.ts`: `user`, `assistant`, `tool`, `advisory`,
`notice`, `irc`, `marker`, `command`, or `shell`. Items are derived state — the session
file stays the source of truth, and an unknown event type adds nothing rather
than breaking the transcript.
_Avoid_: message, bubble, row

**Shell command**:
A composer draft prefixed `!`, dispatched as OMP's concurrent `bash` RPC and
recorded in the session without a model turn; its output is visible to the
model. Renders as a `shell` item.
_Avoid_: bang command, exec row

**Marker**:
A hairline lifecycle rule in the transcript (`agent started`, compaction,
retry). Turn boundaries deliberately emit none: one live prompt produced eight
of them, burying the actual content.
_Avoid_: divider, separator, system message

**Usage receipt**:
A dim, quiet one-line receipt under an assistant message. It starts with the
requested model and may name OMP's routed upstream provider inline, followed by
in/out tokens, cache reads, cost, ttft, duration, and the decode rate (generated
tokens over the post-ttft window) from `message_end.usage`.
Its hover detail may include the provider response ID when OMP supplies it. It
is a receipt, not telemetry.
_Avoid_: stats line, metrics, footer

**Signal accent**:
The mint token reserved for agent liveness and success (ADR-0004). Spending it
on chrome destroys the property that a glance answers "is it working?".
_Avoid_: primary colour, brand colour, green

**Inspector rail**:
The right-hand icon strip in an rpc-ui tab, with six panes behind it —
Todos, Agents, Session, Plans, Diffs, Side questions. The strip is the permanent posture:
pressing an icon opens just that one pane beside it, re-pressing the active
icon (or the pane's close control) dismisses it, and badge counts live on
the strip icons. Remembers its selected pane per tab.
_Avoid_: right sidebar, panel, drawer

**Side question**:
An OMP `/btw` exchange asked against the live session's context without
entering the main transcript or any later turn. A native tab shows them in the
**Inspector rail**'s _Side questions_ pane (one running at a time, follow-ups on
an answered topic, history kept in the session's own `btw-history/` files so it
survives hibernation); a terminal tab's TUI keeps OMP's own `/btw`.
_Avoid_: side chat, tangent, btw thread

**Project actions sheet**:
The bottom sheet a compact-shell project header's ⋯ button opens: the
project's name and full path, then New session, New terminal session,
*New worktree session, Experiments, New experiment, Project settings, Move to
group (local projects only), and Remove project. It
replaces the cluster below 900px. The desktop open targets (VS Code, Files, Terminal) are
deliberately absent: a compact shell is usually a phone talking to a
remote omp-ui, where opening on the host answers a question nobody asked.
_Avoid_: project context menu, overflow menu, kebab menu

**Subagent view**:
The rpc-ui tab's main pane while a subagent is selected in the Agents
pane: the full transcript surface — tool cards, thinking, usage receipts —
rendered read-only from that subagent's own event stream, backfilled from
its transcript file (`get_subagent_messages`) so the whole run shows, not
just what streamed since the click. A banner names the agent, its status,
and its steer/kill controls — steer sends it a message as its user, kill
aborts and tombstones it
([ADR-0045](docs/adr/0045-subagent-control-via-native-rpc-verbs.md)) — but
there is no composer: it is not a chat surface and its transcript cannot be
appended to. It is a view
onto the same live session, never a separate session or tab.
_Avoid_: subagent tab, agent window, subagent chat

**Subagent model**:
The model one agent (`scout`, `task`, …) spawns with, chosen per agent at
three scopes where the narrowest wins (ADR-0031): Global
(`~/.omp/agent/config.yml`), Project (`<cwd>/.omp/config.yml`), and Session
(a per-lineage `--config` overlay) — all three carried by omp's own
`task.agentModelOverrides` record, which omp deep-merges per agent name. A
choice is a single selector string: `"*"` (the session's own model), a
concrete `provider/id[:level]`, or an `@role` alias; an absent key is omp's
default (the agent's frontmatter model, else the session model), never `""`.
Session choices are live — omp re-reads the overlay before every subagent
spawn — and are edited in the Agents pane; Global and Project choices live in
Settings → omp and apply to sessions started afterwards. With no session
choice at all, the **Subagents inherit the session model** preference (on by
default) expands the roster into `"*"` entries at spawn.
_Avoid_: cheap model setting, agent model pin

**Browser pane**:
A live web page inside an rpc-ui tab that the user and the agent share. The
main process owns the page (an offscreen renderer in its own partition),
streams it to every view as frames, takes the user's clicks and typing, and
lets the agent drive the same page over a host-local endpoint it learns from
a hidden message. It opens as a resizable split beside the native transcript
and can take the transcript's whole column (fullscreen) with the floating
composer kept; on compact screens it is a bottom sheet. It is a view onto the
same live session, never a **Tab**, and not one of the **Inspector rail**'s
panes. "Attach page to prompt" hands the composer a screenshot **Attachment**
plus the page URL as ordinary text. Closing it only stops the stream; the page
lives until the session hibernates, is deleted, or switches to a terminal.
_Avoid_: browser tab, web tab, sixth pane, webview, embedded browser

**Browser clock**:
A per-project switch (Project settings → Browser) that shows the date and
time in a strip atop the **Browser pane** and stamps it as a corner badge onto
every pane screenshot: the camera hand-back, element picks, and screenshots
the agent takes through the pane's endpoint. It exists for evidence that must
carry a timestamp. Stamps change only the image, never the page.
_Avoid_: timestamp overlay, watermark, system tray clock

**Session HUD**:
The status bar atop an rpc-ui tab: liveness, click-to-rename title, context
meter, spend, and the session controls (compact, auto-compact, export, share,
branch, new, refresh, queue modes). While auto-compact is enabled, the context
carries a notch at the compaction threshold — the token count where omp
auto-compacts. Model, thinking level, and the advisor live in the
composer instead, next to the text they affect. With the advisor enabled, a
second, quieter `adv` readout sits beside the main usage. Its context meter and
model describe the parent advisor; its spend and token total include advisor
activity in every spawned descendant. The parent switch is a ceiling: an
advisor-off parent disables descendant advisors, while an advisor-on parent
still leaves each descendant's own opt-in authoritative. A generated `-e`
extension delivers the values (ADR-0008), never a text parse; while OMP's
autoresearch mode is on, an `autoresearch` chip sits beside the goal chip and
opens the **Lab** on that experiment (ADR-0030).
_Avoid_: toolbar, header, status bar

**Advisor roster**:
The set of advisors omp resolved from `WATCHDOG.yml` for a live session (user
and project files, merged by name); the legacy single advisor is a one-entry
roster named `default`. The composer's advisor switch stays the ceiling over
every entry, and the advisor model pin is the fallback for entries with no
`model:` of their own. Edits apply when the session relaunches.
_Avoid_: advisor list, watchdog, advisor team, multi-advisor mode

**Reviewer roster**:
The set of reviewers omp-ui resolved from its own app state for `/code-review`
(a per-project document, else a global one, imported once from the legacy
`REVIEW.yml` files; with nothing set anywhere, one default entry on the session
model). Each entry may pin a `model` selector and narrow the target kinds it
reviews. `/code-review` launches the enabled entries as one batch of background
subagents; results return as async-result wake turns. The roster and
`/code-review` sit behind the Settings → Experimental flag; edits apply when the
session relaunches.
_Avoid_: review team, critic list, code-review agent

**Session parameter memory**:
The five composer parameters — main model, main thinking level, advisor on/off,
advisor model, and advisor thinking level — are remembered per project and
seed the next session. A remembered main thinking level is a concrete level
word or the `auto` selector (see **Auto thinking**). Each live session also
records its own main model and thinking level, so the advisor's required
relaunch reapplies them instead of
falling back to a different model. Advisor model + level remain one omp
`model[:level]` selector; a null selector defers to `modelRoles.advisor` and is
never the empty string. The advisor state itself remains session-scoped; the
project fields are only last-used defaults for a new session. A separate app
preference, **Default advisor** (Settings → General, off by default), decides
whether a new session with no per-project memory starts with the advisor on;
it supersedes omp's own config for that one decision, while the advisor model
still falls back to omp config. The thinking analogue is a separate app
preference, **Auto thinking** default (Settings → General, on by default):
it decides whether a new session with no per-project thinking memory starts on
the auto selector (see **Auto thinking**), sitting below last-used memory and
above omp config.
A project may also pin a **Default model** and **Default advisor model** for
fresh sessions. A pin is a standing choice, not last-used memory: composer
changes continue to update the `last*` fields without moving either pin.
Clearing a pin restores the last-used chain. The advisor pin is model-only;
advisor on/off keeps its existing last-used → app default → omp config chain,
so the pinned advisor model is dormant while that chain resolves off.
Subagent models (ADR-0031) are deliberately NOT part of this memory: a
session's `subagentModels` map is a standing session-scoped choice that never
updates the project's last-used fields, and there is no project "default
subagent models" pin — the project layer for subagents is omp's own
`.omp/config.yml`, not a registry field.
_Avoid_: resetting model on advisor toggle

**Auto thinking**:
omp's automatic thinking selector: instead of one static level, omp classifies
each user prompt with its judge model and runs the turn at the level that
classification resolved, clamped into the model's effort ladder. The composer
pill and the records show the *selector* — `auto` — while it is on; the pill's
tooltip and the Session rail's thinking row show the turn's *resolved* level
(`auto → xhigh`). Switching the model keeps the selector. Spawning a session
under it applies omp's `defaultThinkingLevel: "auto"` settings overlay — the
`model:level` selector grammar has no `:auto` suffix.
_Avoid_: treating the resolved level as "the" thinking level while auto is on

**Fast mode**:
omp's per-session serving preference: the *setting* is what `/fast` toggles
(`fastModeEnabled`), the *active* state (`fastModeActive`) is whether priority
serving is actually live. The two can disagree — a provider can decline
`speed: "fast"`, leaving the setting on while nothing is active, and a
provider-level tier can keep serving active while the session setting is off.
omp-ui's native control shows the truth and switches the setting; terminal
tabs stay on omp's own `/fast`.
_Avoid_: turbo, priority mode as a UI label — `fast` is the wire word

**Share live**:
Exposing one running **terminal session** to teammates as a live **Collab
room** through omp's `/collab`. omp hosts the room from inside the session's
TUI; omp-ui opens it, reads its state from omp's local registry, and closes it.
Terminal tabs only: the command lives in the TUI, and the RPC protocol exposes
no collab surface, so a native session's dialog reads as unavailable. It is
distinct from the HUD's **share** control, which uploads an encrypted static
snapshot, and from **remote access**, which reaches whole-instance omp-ui users.
_Avoid_: live share (as a noun), collab (as a verb), mirror, broadcast

**Collab room**:
The live room omp hosts for one session's current **generation**, reached from
a join link whose URL fragment carries the room key (so the relay never sees
plaintext). It follows the session, not the tab: `/new`, `/resume`, and a
branch switch end the room and rotate the key, so a stale link stops working —
the intended revocation path, alongside stop and closing the session. Full
rooms publish a **control link** (the chosen access) and a separate read-only
**view-only link**; a view-only room publishes only the read-only one. A room
omp-ui surfaces is always one of its own PTY children, matched by OS pid — a
foreign host started outside omp-ui is never shown.
_Avoid_: session link, invite, share link (that is the snapshot's), stream

**Guest**:
A teammate who joins a **Collab room** from a link — in a browser at
`my.omp.sh` or another `omp` with `omp join`. A full room's guest can prompt,
interrupt, and answer approvals (their turns land in the transcript like the
local user's); a view-only guest watches only. Everything a guest drives runs
tools on the host machine, so full access is a keyboard handoff.
_Avoid_: viewer, collaborator, remote user (that is the browser transport's)

**Subscription sign-in**:
Signing in to a model provider's subscription plan (currently ChatGPT,
provider id `openai-codex`) from Settings → Providers, under a
**Subscriptions** group separate from the API-key rows. The sign-in runs in a
short-lived, bare, session-less omp process (no tools, extensions, LSP, or
skills): omp opens the provider's browser page, receives the callback (or a
pasted redirect URL the user submits through the sign-in panel), and stores
the credential in omp's own auth broker. omp-ui never sees a token — it renders
the flow's phase, the provider's identity strings (e.g. account emails), and
the success or failure. Accounts are shared with terminal omp; sign-out runs
`omp auth-broker logout`. With no API key stored, a signed-in subscription
satisfies the fresh-session provider gate, and its models appear as
`openai-codex/…` in the composer picker of sessions started after sign-in.
_Avoid_: OAuth key, subscription key, login provider

**Attachment**:
An image on an outgoing prompt. In rpc-ui it rides the prompt frame's `images`
as bare base64, alongside an omp-ui-generated suffix that names the exact
one-based `attachment://N` handles for that prompt; native transcript derivation
removes the suffix while retaining the Attachment preview. In a terminal tab it
cannot ride the PTY at all, so it becomes a scratch file whose path is handed to
omp's TUI as a bracketed paste (ADR-0006). omp re-encodes on ingest, so what
returns in the transcript is omp's mime type, not the clipboard's.
_Avoid_: upload, file, media

**Document Attachment**:
A PDF on an outgoing prompt (ADR-0044). omp's rpc protocol carries no document
field, so the bytes ship to the machine that owns the session — local or joined
remote — and materialize as a scratch file under the OS temp dir; the prompt
text then ends with an `<attached documents>` block naming each display name and
absolute path, where omp's `read` tool converts the PDF to text. Native
transcript derivation parses the block back into chips; a rewind or refine
re-attaches by path, with no byte re-upload. A terminal tab delivers the same
scratch path as a plain paste.
_Avoid_: upload, media, doc

**Dictation**:
The composer's speech-to-text path (issue #647, ADR-0034): capture runs in
the renderer's memory (no MediaRecorder/Blob); each phrase closes at a pause and
is transcribed in the main process against the model discovered from omp's STT
catalog while capture continues, and each transcript is inserted at the caret
of the draft in spoken order — never submitted. Gated app-wide by the Voice
input setting.
_Avoid_: voice typing, speech recognition, push-to-talk

**Voice Recording Reference**:
The address of one turn's audio in a live voice session:
`v1/<sessionId>/<connectionId>/<role>/<turn>` — the owned session, the UUID one
live connection minted at connect (omp's turn numbers restart each connection,
so the connection id is what keeps two connections' turn 0 apart), the role, and
the turn number (issue #809, ADR-0049). A reference is not a promise: bytes live
in the lineage's `live-audio/` dir only if something wrote them, and omp's
current rpc surface exposes no assistant output audio, so a reference honestly
answers `unavailable` until a capture source exists.
_Avoid_: audio id, clip id, recording url

**Armed**:
The per-session live voice intent (issue #811): the user wants to talk in this
session. A successful `live_start` sets it; only an explicit stop or the plan
hand-off's carry-over clears it. Parking never clears it — the microphone went
quiet because the tab left the view, not because the user asked.
_Avoid_: enabled, connected, on

**Parked**:
Armed with no realtime call open, because the session's tab is not the viewed
tab (issue #811). The call closed on leaving — omp records audio per session,
so an unviewed tab must not listen at all; closing is the honest mute. The
session keeps its *voice recap*; returning to the tab opens a fresh call whose
instructions carry it, plus any *pending voice feedback*.
Not the *Hibernated session* sense its _Avoid_ list warns about: a parked
session's process runs on; only its realtime call is closed.
_Avoid_: muted, paused, suspended, backgrounded

**Pending voice feedback**:
The text of a live-delegated turn's final answer that the voice never spoke:
the turn ended while the session was *parked*, or an open call never heard the
spoken request the answer belongs to (the orphan rule, issue #811). Order is
kept — the next resume's instructions carry every entry, oldest first — and
the call's first final assistant transcript proves delivery and clears them.
_Avoid_: missed message, unread reply, backlog

**Voice recap**:
The rolling per-tab text transcript of earlier spoken turns (issue #811),
appended from the snapshot's turns at every park; a turn the call closed
mid-sentence rides marked as cut off. The resume's `live_start` instructions
carry it (bounded, oldest trimmed first) so the model hears the conversation
the closed call had.
_Avoid_: history, summary, chat log

**Auto-title**:
The name a new session gets from omp's own renamer, dispatched over the
prompt channel: when the first substantive prompt's turn admits its user
`message_start` — the frame that proves omp holds the message — omp-ui
sends the bare `/rename`, and omp's in-process generator digests the
conversation, walks the `tiny`/`commit`/`smol` role chain, and names the
session itself while the first turn is still streaming (issue #795,
matching the TUI). The prompt's ack alone never fires the shot: omp's
digest reads the session's message history, which only holds the prompt
from that frame. The first untitled `agent_end` is the safety net and
retry rung, not the trigger: it fires the shot when the turn never
admitted a user message, and otherwise drives the bounded retry ladder
(issue #791).
A live voice request reaches omp as an agent-attributed `live-delegation`
custom message, not a user prompt, and omp's digest skips it: the renderer
that started live voice arms the shot from the spoken text and fires it at the
first assistant `message_end` carrying text or thinking — the earliest frame
whose digest has something to read — with the turn end as its safety net
(issue #803).
omp-ui keeps only the gates: a session whose record already carries a title is
latched out at prompt time — a `set_session_name` write is user-sourced, and
omp refuses every later "auto" title once a "user" one exists — and a greeting
defers rather than latching the one shot. For a session seeded from an
approved plan, the plan titles it from the record's `planTitle`, never the
seed text that carried the plan. One shot per session: a declined generation
retries at later turn ends, then leaves the row prompt-titled until a manual
path names it. The title reaches the UI through the watcher, like every other
engine-side session-file change; the engine's settlement notice is the visible
signal.
_Avoid_: session name generation, summary, label, two-phase titling

**Re-titling**:
A user-requested second look at a session's title: the HUD's retitle button or
the palette's **Regenerate session title** runs the bare `/rename` through the
normal command row, so the command row plus its settlement notice are the
feedback. It replaces Auto-title's answer, never the user's own rename; it
needs a live session — a dead process cannot title itself, and omp-ui does not
write session files.
_Avoid_: thread renaming, title regeneration, re-summary

**Build mode**:
A session state with full working-tree write access and state-changing commands
allowed; the complement of Plan mode. Selecting Build lifts omp's plan-mode
guard in-process. It grants permission to edit but does not require every
answer to edit.
_Avoid_: plan off, normal mode, write mode

**Plan mode**:
A session state in which omp explores read-only and answers in place. The
read-only guarantee is omp's own plan-mode write guard, not omp-ui's; a plan
artifact is drafted and gated on plan review only when the user's own prompt
asks for one — the mode itself mandates no plan. omp's rpc protocol cannot
express it at all, so omp-ui drives it through an extension generated into
the lineage dir and passed as `-e` at spawn (ADR-0007, ADR-0013). Switching
between Build and Plan happens in-process; it never respawns the session.
_Avoid_: planning mode, plan-first

**Default agent mode**:
The app preference that chooses whether a new native session starts in Plan or
Build. It does not change live or resumed sessions and does not apply to terminal
tabs. The default appears first in every mode selector and stays visually quiet;
the alternate receives the stronger selection accent and is the only mode named
in the Session HUD when active. It never controls plan implementation: every
execution context of an approved plan begins in Build (issue #165).
_Avoid_: default session mode, startup plan mode

**Default compaction method**:
The Settings → General preference that chooses the first compaction method omp
attempts for a fresh native session. The installed omp binary supplies the
available methods. Null defers entirely to omp. A fresh native session captures
the preference on its owned-session record and reuses it on later resumes;
terminal-origin sessions never capture or apply it. The per-lineage overlay
keeps omp's effective configured fallback order after the selected method.

**Plan review**:
The gate between drafting and implementing, rendered as a non-modal panel
docked in the session's tab so it never locks the rest of the app. The agent
submits by writing its plan's slug to `xd://propose`, which blocks it until the
user answers execute or refine. Execute lands a single verdict and the renderer
dispatches the implementation into a chosen context — the same session, the
same session after compacting its context, a freshly spawned session seeded
with the plan, or a freshly spawned worktree session seeded with the plan and
running in a dedicated checkout on its own branch — as a normal prompt.
Implementation always begins in Build mode,
whatever the Default agent mode says (issue #165). Refine sends the agent back
to revise the draft, optionally carrying the user's revision notes (text +
images). Abandoning the pane — "not now" or the pane's close button — is the
third, non-answering verdict: `deferPlanReview` dismisses it without resolving
the gate, so the agent stays paused on its proposal and the plan stays pending
in the rail's proposed plans pane until the user returns. Defer encodes
"ignore for the time being"; refine is the only verdict that revises
immediately. Both keep the working tree read-only. The pending plan gate itself is owned by the main process —
the proposal frame is recorded as the session's `pendingPlan` on its summary,
and a verdict as `planSettle` (issue #215) — so a renderer that joins late (a
remote client) hydrates the review from the record and settles a verdict
another client already made; the gate never outlives the session process.
An HTML gate carries the `sourceHash` main's preflight validated: answering
execute re-checks the artifact's bytes before anything dispatches, and a
gate whose artifact changed settles as `invalidated` — not a user verdict,
no implementation, no advisor fold (issue #312 follow-up).
Because the advisor reviews a turn only after it ends, the
plan turn's review can outlive the gate — so on execute, a session with a
configured advisor answers the verdict first, waits (bounded) for that review
to land, then folds its concerns into the implementation prompt in every
context; refine stays immediate because the planner revises in situ, where the
advisor's notes already land. The fold is a per-review switch, default on.
_Avoid_: plan approval dialog, confirmation, plan prompt

**Plan preflight**:
The main-process validation an HTML plan must pass before a plan review can
exist at all (issue #312 follow-up, ADR-0022 amended): the proposal's
`select` request is claimed at the session's frame edge — before observers,
clients, notifications, or the pending-plan record — the artifact is read
through the confined plan reader, and the same parser, transforms, and real
layout probe every surface uses runs in a hidden, script-less Chromium
verifier. A passed proposal is delivered once with a main-authored
`sourceHash`; a failed or unavailable one answers the agent directly with
bounded, source-located diagnostics as the proposal tool result, so the
agent repairs the reported ranges of the existing artifact instead of the
user discovering a broken document in review. `unavailable` is honest: an
inconclusive verification never presents a plan, and never claims one is
fine. Application failures say "omp-ui could not verify" and stop — they
must never send the agent to rewrite valid source.
_Avoid_: plan lint, plan validation prompt, renderer check

**Approval card**:
The transcript card that answers one of omp's tool-approval prompts — an
`extension_ui_request` whose title begins `Allow tool: ` and whose options are
exactly Approve and Deny (issue #681, ADR-0038). The frame router splits it
out of the generic extension dialog queue so the card renders its tool name,
origin, policy reason, and argument details directly; the main process keeps
counting the frame as an ordinary blocking dialog, so awaiting-answer, the
stall guard, and remote hydration behave unchanged. Answering sends exactly
`"Approve"` or `"Deny"` — omp's runner compares only against `"Approve"`, and
no session-wide "always allow" verb exists over rpc. Closing the card or
pressing Escape answers Deny: a dropped dialog is a refusal, never a silent
approval.
_Avoid_: approval dialog, permission prompt, tool gate card

**Approval mode**:
A session's pinned omp `tools.approvalMode` tier — `always-ask` (every tool
waits), `write` (mutating tools wait), `yolo` (nothing waits) — or *inherit*,
meaning no pin and omp resolves its own global/project config (where an
absent key means yolo). omp binds the mode at process start, so the pin rides
a `--config` overlay written at spawn and changing it relaunches the session
(ADR-0005 rail, ADR-0038). The mode governs the session's own tool loop only:
subagents run under the user's `tools.approval` policy regardless, and a
terminal session's prompts appear in its own embedded TUI, never as an
approval card. Defaults live in omp's own config (ADR-0025), never in a
second store.
_Avoid_: permission mode, tool policy setting, auto-approve flag

**Magic keyword**:
One of omp's four prose keywords — `ultrathink`, `orchestrate`, `workflowz`,
`jevify` — which, submitted as standalone prose, make omp append a hidden
system notice steering the turn (and, for `ultrathink` under auto-thinking,
resolve the turn to the model's highest thinking level). Draft keyword paint
previews omp's matcher, settings, and required tools (`orchestrate`: `task`;
`workflowz`: `task`+`eval`; `jevify`: `eval`); unknown capabilities allow all
keywords in that preview. The running composer's border instead reflects the
keywords omp actually activated for the input it consumed, persisting through
model and tool work until another input is consumed or execution ends. Inputs
consumed together share their combined keyword gradient; ordinary input uses
the copper indicator. Editing the next draft or accepting a queued input does
not change the running border. The plan review stages the first three as switches that lead
the implementation prompt in omp's notice order, and disables any the
`magicKeywords.*` settings switch off. Prompts omp-ui builds for the user —
plan seeds, advisor notes, branch names, file blocks, one-shots — never arm
a keyword from text the user did not type.
_Avoid_: reserved word, hotword, slash command

**Slash palette**:
The inline list above the composer that completes a slash-command draft, in
two stages. While the command word is being typed it fuzzy-searches the
roster omp advertises plus omp-ui's own entries, nesting each command's
subcommands under it. Once whitespace follows the word, the word is resolved
exactly and only that command's subcommands are offered, matched by name
against everything typed after the word; with nothing to offer — no such
command, no subcommands, or an argument no name matches — the palette hides
and Enter runs the line as written. Tab and Enter accept the selected row: a
row that needs an argument completes the line, any other runs it. Escape
dismisses the palette for that exact draft only.
_Avoid_: autocomplete dropdown, command menu, suggestions

**Ghost completion**:
omp's word engine suggesting the rest of the prose word ending the native
composer's draft, painted dim after the caret. Tab takes it with a provisional
space, → without; typing past it is reported to omp as a rejection so the
engine adapts. Native transcript only — terminal tabs show omp's own.
_Avoid_: autocomplete, inline AI completion, suggestion chip

**Plan format**:
How the agent is asked to author a plan for review, set once in Settings →
General and carried when Plan mode is selected: `html` (default) or `md`. Under
`html` the agent writes exactly one file, `local://<slug>-plan.html` — a
self-contained document (inline CSS, no external resources, no scripts) that
the plan review renders in a `sandbox=""` iframe. The review paints the
document's canvas and ink from the active theme, discarding plan-authored
page and element colours (ADR-0014, amended by #384). That file is the plan: it is
what the propose gate resolves, what gets pinned as the session's reference,
and what the implementer executes. There is no markdown companion and nothing
is authored twice. omp's own slug→file resolution is markdown-only, but omp-ui
never reaches it under `html`: `xd://propose` dispatches straight to the
extension's proposal handler, which resolves the html artifact itself
(ADR-0014). A session that cannot carry the hidden format instruction, or that
exposes no artifacts dir, degrades to `md` with one warning; an agent that
writes markdown anyway is still reviewed, through omp's resolver.
_Avoid_: plan rendition, plan theme, plan template, rich plan, plan export

**Advisor reply**:
The follow-up prompt omp-ui dispatches into a live rpc-ui session when advisor
findings land in its transcript while the session is idle, so a review that
arrived after the turn closed is answered instead of sitting unread. Findings
are batched over a short settle window and folded into one prompt through the
same collector the plan-execute fold uses (ADR-0012). Consecutive replies are
capped, and reaching the cap posts a `notice` in the transcript saying a prompt
re-arms it; any non-reply prompt resets the count. The fold is a per-session
switch in the composer's advisor control, default on. Terminal tabs are
excluded — a PTY carries no prompt channel to inject into.
_Avoid_: advisor loop, auto-prompt, advisor echo

**Stall auto-continue**:
The follow-up prompt omp-ui dispatches into a live rpc-ui session when its
turn ends with a stall-classified stream error (stopReason "error" plus the
timeout errorId bit or the provider's stall message), or when omp-ui's own
stream-stall watchdog aborted the turn (its tagged abort notice), so a
session whose model stream died resumes instead of sitting idle. Bounded:
two consecutive auto-continues per session, after which a warn notice pauses
it until any user prompt re-arms the count. App-level switch (Settings →
General), default on; terminal tabs are excluded — a PTY carries no prompt
channel. The stall diagnostic notice (issue #100) posts at the error turn-end
whether or not the continue fires (ADR-0019).
_Avoid_: auto-resume, session revive, stream retry

**Desktop notification**:
The OS notification the main process posts (Electron `Notification`) when an
owned native session reaches an attention state while the user is not looking
at that tab in the desktop window — the window is unfocused, or it is focused
but showing a different tab (issue #271): a turn finished, a plan review is
pending, or stall auto-continue paused at its cap. One per tab, replaced
rather than stacked; the post is delayed 3 s and re-gated at fire time so a
turn that auto-resumes never blinks. A remote renderer's viewed tab never
suppresses or acknowledges the banner — it is a different screen. Clicking
focuses the window and resurfaces the session through the ordinary openSession
path. A Settings → General switch, default on. Terminal sessions are never
announced — main has no turn signal in a PTY — and remote browser clients
receive none; their story is web push and stays a separate feature.
_Avoid_: toast, system alert, reminder, popup

**Parked message**:
A queued item omp still holds while the live session is idle. omp's
`queuedMessageCount` counts all displayable queued work — user follow-ups and
steers, but also advisor cards, agent-authored custom entries, and deferred
messages — and queued follow-ups only drain at a clean turn end: after a user
interrupt they park until an explicit new prompt. The composer therefore labels
the count `parked: N` whenever the agent is not running, since nothing drains
while idle (issue #181). A parked follow-up can be *promoted* from the queue
chip, which moves it into steering and, since the session is idle, starts a
turn (issue #714). A parked or steering message can also be *restored* to the
draft — en masse by Escape or the stop control while a turn runs, or one row at
a time by the queue chip's edit action (issue #776).
_Avoid_: stuck queue, ghost message

**Proposed plans pane**:
The inspector rail pane (ADR-0004 vocab) that lists every plan the focus
session has proposed — the live pending plan first, with review / request
changes / not now actions, then interrupted plans with re-present / dismiss,
then settled plans dimmed by verdict. The list is main-process owned and
persisted on the owned session record (ADR-0033), so it survives an app
restart; the gate behind a pending plan does not. The live pending plan is one
per session and is the same object the plan review shows: clicking it or the
review action restores the review in that tab, request changes answers
`refinePlan` without notes, and not now calls `deferPlanReview`. Only the
focused tab's review renders; a background session's pending plan surfaces
here (its sidebar row reads "answer needed") instead of stacking review on review.
_Avoid_: plan inbox, plan queue, plan history

**Interrupted plan**:
A proposed plan still awaiting a verdict whose plan review gate ended with its
session process — an app restart, a crash, or a relaunch — so no agent is
blocked on it (ADR-0033). The proposed plans pane offers re-present, which
raises a real plan review for the same file through the plan extension without
an agent turn (preflight runs again on the file's current bytes, and the
session enters Plan mode first if it left it), and dismiss, which stops
tracking it; the file stays on disk. It never blocks the session, raises no
notification, and does not make the sidebar row read "answer needed".
_Avoid_: orphaned plan, stale plan, lost plan, abandoned plan

**Branch diff pane**:
The inspector rail pane that shows every working-tree change on the focus
session's project git branch — the tracked diff plus new untracked files read
as creates, one `DiffViewer` per file. It is a repo view, not a session view:
the rail asks the main process (`core/branch-diff.ts`, the git-only
`getBranchDiff` channel) and renders the parsed result, so "all changes on
the current branch" is what the user reads regardless of which session
produced them. For a worktree session the pane diffs the working tree against
`merge-base(base, HEAD)` — the branch's cut point — so committed session work
stays visible instead of vanishing at the first commit; a "since <base>" chip
marks that reading. Sessions without a recorded base diff against the repo's
default branch — again `merge-base(default, HEAD)`, the chip naming it — when
the checkout sits on a different named branch. On the default branch itself,
or when no default resolves, the pane diffs against the branch's upstream
(`merge-base(upstream, HEAD)`, the chip reading "since origin/main"), so
unpushed commits stay visible. Committed work in a plain checkout therefore
never vanishes at the first commit. The plain `git diff HEAD` reading remains
for a detached HEAD and for a branch with neither a different default nor a
resolvable upstream.
_Avoid_: per-session diff log, file edit history

**Worktree session**:
A session whose omp process runs in a dedicated git worktree of its project —
a separate checkout on its own branch, minted at spawn under omp-ui's app-data
worktrees root, sharing the repo's object store. While the session still sits
at its empty-transcript hero, the cut is offered directly: the composer's
branch chip worktree section, whose create button mints the checkout on
demand, or the first prompt does. `projectCwd` still names the
project (sidebar grouping, parameter memory); the worktree is the
session's effective working tree, so the branch diff pane, branch chip,
@-picker, console shell and MCP manager all read it. omp resolves
project-scope config from its cwd, so the checkout carries a `.omp` symlink
to the project's own directory (issue #325) — one source of truth, no copy to
drift. The record also carries what the
branch was cut from (`base`: the picked ref, or the project checkout's
branch at creation (its HEAD commit when detached)), which the branch diff
pane and the HUD's worktree chip read; records from before this field show
plain HEAD diffs. Finishing goes through one **Finish worktree dialog**: the
HUD's worktree chip and the composer's branch chip (first row of its menu
while a worktree session is focused) open it; the delete confirmation pairs
with it from its own side, offering the merge into the resolved base first,
before deleting. The dialog carries three independent decisions (issues
#385–#389): where the work goes — the branch resolved from the recorded
base by default, any local branch, or a new branch cut from a chosen start
point; how it lands — one merge commit, whose message records the folded
commits' subjects and the issues they close, or the branch kept, optionally
renamed; and whether the session returns to the project checkout or stays
in its worktree. It previews the merge with `git merge-tree`, runs merges
into a destination checked out nowhere in a scratch worktree under the
worktrees root, and offers to sync predicted conflicts into the worktree
for its owning session to resolve. Scratch conflicts are aborted. A stopped
merge in the project checkout instead offers **Resolve with agent**, including
when Finish is reopened: the original live native session receives the task
in Build mode, explicitly targeting the project checkout rather than its
worktree. Terminal, dormant, or exited sessions explicitly offer a fresh
native resolution session there (issue #727). Resolution verifies and completes
only that existing merge; it never publishes, returns, or removes the worktree.
A checkout with uncommitted
changes cannot be returned — main enforces it, and the delete dialog is the
one surface that offers the loss explicitly. Returning **releases the
worktree**: the record, its transcript, its tab and its lineage survive back
at the project checkout; the checkout is removed, and the branch is deleted
only once omp-ui has verified it fully merged into a candidate destination
— a kept branch is not deleted, an unmerged one is kept; returning switches
the project checkout onto a destination it does not already hold (issue #431).
Deleting the session removes the checkout; an unmerged branch and its commits
survive in the repo, while a branch already in its destination is deleted too.
Resume, restart and mode switches keep the worktree — it lives on the session
record. A
record's checkout may be shared — forking a worktree session, and a plan
handoff from a worktree planning session (issue #316), give the new record
the same `path`/`branch`/`base`, and the last record deleted removes the
checkout.
The composer's branch chip also resolves the git state it shows: a checkout
diverged from its upstream or stopped on merge conflicts offers a
resolve-with-an-agent row that spawns a session in that checkout seeded with
the resolution playbook (issue #675); the row's click is consent, and push is
never implied.
_Avoid_: sandbox session, isolated session, branch session, close the
worktree, merge & close, merge & return as the sole exit

**Finish worktree**:
The single dialog that settles a worktree session's destination, outcome
and session — where the work goes, whether it lands as a merge commit or a
kept branch, and whether the session returns to the project checkout or
stays in its worktree. Finish settles local state only — publishing or pushing
the destination is a separate explicit step.
An existing project-checkout merge remains actionable regardless of the chosen
future destination or outcome. Agent resolution preserves the original native
context when usable, discloses the fresh fallback otherwise, and leaves Finish
and worktree return as later user decisions; busy sessions and pending human
answers block the handoff rather than silently replacing its context (#727).
_Avoid_: closing the worktree, merge & close

**Publish**:
The first push of a local branch — `git push -u` creates the branch on the
remote and binds its upstream. The chip says *publish* for that first push and
*push* for every later one; both are explicit user actions, never part of
merge-back (issue #414).
_Avoid_: release (worktrees are released, branches published), upload, share

**MCP manager**:
The capabilities viewer's MCP tab listing every MCP server omp resolves
for one scope — a session's own working tree (from its Session HUD, the
command palette, the /mcp command, or Settings → omp; a worktree session's
checkout, else its project root) or global (user-level sources only) —
with toggles that run omp's own
enable/disable write algorithm in core. Toggles take effect on the next
session spawn; while opened from a live tab the viewer also offers `/mcp
reload`, which rebinds that session's MCP tools in place; http/sse rows in a
live native tab hand http/sse reauth to omp's own TUI. The DTO is redacted at
the core boundary (issue #17, #36, #220, #325, #327).
_Avoid_: MCP settings page, integrations panel, server browser

**Capability catalog**:
What the scope views of the capabilities viewer and project settings show for
Skills and Tools: config truth — `SKILL.md` roots and the settings layers
resolved at one **scope** (global, i.e. the user's omp config; or project,
i.e. one registered project's `.omp/config.yml` beside the global layer),
labeled "what omp *can* load". Scope is also the routing rule for writes:
a global switch flips the global layer through `omp config set`; a project
switch edits that project's config file in place; a switch never crosses
scopes (issue #383, ADR-0025). It is not what any session loaded — that is
the roster — and omp's embedded curated skills are not enumerable from it.
_Avoid_: machine-wide roster, skill list, tool browser

**Capabilities viewer**:
The modal with three tabs — MCP servers, Skills, and Tools — opened from the
Session HUD, the command palette, Settings → omp, or /mcp. Its MCP tab is the
MCP manager, contract unchanged; Skills and Tools have two sources that never
imitate each other: with a pinned live native session they are that session's
**roster** — the skills it loaded and every tool it registered, delivered by
a generated `-e` extension (ADR-0008), never by a parse or a prompt — and
without a pin (the HUD button and palette now always open it unpinned, at
global scope) they are the **capability catalog** for that scope. In the
pinned view the Tools tab can also change one registered tool's enabled
membership in that live session at runtime — session-local, never a config
write, never a restart, and confirmed only by the snapshot omp publishes.
Scope and session are captured at open and never retargeted by focus, and
the roster describes the main session even while a subagent view is shown.
It is a viewer, not a package manager, and not an inspector rail pane. A
catalog row states which layer its switch flips. The roster's coverage is
runtime-only: skill files the session never loaded, and tools registered
only by other sessions, are not represented, while a loaded skill hidden
from the model stays listed and marked. A registered tool is listed
even when not enabled, with its access facts (model-direct, `xd://`, the eval
bridge); enabled is omp's enablement state, not a permission grant — plan
mode and approvals still gate use, and changing membership can legitimately
re-partition those facts, which the viewer then reports as omp confirmed them.
The switch cannot disable `write` while plan mode is on: entering the mode
borrows `write` only when it was off, and exiting returns exactly that
borrowed addition, so every other choice made during plan mode survives.
_Avoid_: capabilities panel, plugin manager, tool browser

**Project settings**:
The modal the project header's settings button (desktop cluster) and the
compact sheet's "Project settings…" row open: one dialog for the project with
eight sections behind a tab strip — one visible at a time, the active tab
dialog-local and resetting to MCP servers on each open (issue #564) — the
project's MCP servers (the same resolved list,
per-server toggles, per-source provenance, and per-file errors the MCP manager
renders, project-scoped with no pinned tab), the project's **capability
catalogs** for Skills and Tools (issue #383: the same panels the global viewer
uses, scoped to this project, their switches writing `.omp/config.yml` in
place), and the project's default-model pins (main-model and advisor-model
with their pickers and Clear actions), and the project's **Knowledge home**.
Toggles write through core's mcp-config and capability modules; pins through
setProjectDefaultModel / setProjectDefaultAdvisorModel; all take effect on
the next session spawn. Session-scoped control keeps the capabilities
viewer's pinned tab: the palette's "Capabilities for this session", /mcp,
and Settings → omp; the Session HUD's Capabilities button itself opens the
global catalog, badge and all.
_Avoid_: project preferences, per-project settings page, project options

**Memory settings**:
The Settings → Memory surface configures omp's memory backend and recall
behavior and summarizes resolved bank locations for the focused project. It is
the only memory surface omp-ui has: there is no memory browse or edit surface
at all, only that resolved-bank summary. The inspector rail deliberately
exposes no Memory pane while omp has no narrow, typed runtime surface for the
memories injected into a session; omp-ui neither substitutes the project/global
bank view nor parses the full system prompt. The browse and edit channels were
removed in #330, leaving `memory:overview` as the sole memory channel.
_Avoid_: memory manager, knowledge base, memory browser tab

**Knowledge vault**:
The curated, human-readable store of decisions, lessons, and write-ups that
outlive a **Session**: one or more registered Obsidian vaults that the agent
reads whole and writes only inside each vault's **Home folder**, through
omp-ui host tools. omp-ui's surface is thin: binding, cards, hand-off.
Obsidian is the reader.
_Avoid_: knowledge base, notes vault, brain

**Vault registry**:
The global list of the Obsidian vaults omp-ui may use; one vault is the
normal case. Each entry names a folder, carries a **Home folder**, and exactly
one entry carries the **Default write vault** marker. It lives on its own
Settings page, labelled "Knowledge vault", right after Memory.
_Avoid_: vault list, vault manager

**Home folder**:
The folder inside a vault (default `omp-ui/`) where every omp-ui write lands.
The whole vault is readable; the home folder is the write boundary, so the
user's own notes are never edited.
_Avoid_: vault root, write folder

**Default write vault**:
The one registry entry a project writes to when its **Knowledge home** names
no vault.
_Avoid_: primary vault, active vault

**Knowledge home**:
A **Project**'s standing choice of where the agent files its notes: repo
`docs/`, a named vault, `both`, or not set, which applies the routing default.
It is the last tab of **Project settings**, labelled "Knowledge".
_Avoid_: knowledge routing, docs home, vault target

**Vault note**:
A markdown note inside a registered vault, whichever hand wrote it. One the
agent wrote carries a **Provenance stamp**; an edit of a note it did not
create is marked as such. The inspector rail's Session pane lists the Vault
notes touched this session under "Vault notes".
_Avoid_: page, doc, entry

**Provenance stamp**:
The frontmatter block omp-ui writes into every note the agent creates,
recording omp-ui, the project, the session, and the date. It is what lets a
card and the rail tell an omp-ui note from the user's.
_Avoid_: metadata, signature

**Index note**:
The one note per project that links the project's omp-ui notes and wikilinks
the relevant notes the user wrote; the project's entry point into the vault.
It carries the **Project key**.
_Avoid_: hub note, table of contents

**Project key**:
The lowercased owner/repo path of a project's git remote, recorded in its
Index note's Provenance stamp; how omp-ui finds the project's vault folder on
any machine.
_Avoid_: project id, repo id

**Day write-up**:
A cross-project note of everything worked on that day, written by the agent
from omp-ui's session records. Not an Obsidian daily note; the user's own
`YYYY-MM-DD` notes stay untouched.
_Avoid_: daily note, journal, log

**Update card**:
The small non-modal card in the lower-right corner announcing an available
update. There are two: the omp-ui release card (AppImage, NSIS, and macOS
installs — the staged ZIP applies through Squirrel.Mac — stage through
`electron-updater` before it appears, offering Restart now / Install when I quit
/ Later; unsigned NSIS is the Windows preview path) and the omp binary
install/update card (Update now / Later, or Install / Later when omp is not
installed at all). Dismissal is remembered per offered version and dropped once
the running/installed version catches up to it — a dismissal only ever
suppresses that exact offer, so a caught-up entry is dead state. Background
failures stay silent. When both show they share one corner stack, the omp-ui
card on top.
_Avoid_: toast, notification, popup, updater dialog

**Getting started checklist**:
The first-run overlay that tracks the four gates of a fresh install — the
managed omp binary, a provider credential, a registered project, and a first
owned session — reading each from live backend state and marking itself seen
(`gettingStartedSeen`) when dismissed. It auto-opens once, only on the desktop
shell, and re-opens from the command palette or the empty-state button. It is
per-renderer visibility over the one persisted flag, never a second store of
user progress.
_Avoid_: onboarding wizard, tour, coach marks

**Update train**: The user's choice of which omp-ui release line the update check follows — stable (the default: tagged GitHub releases) or nightly (the rolling `nightly` prerelease, built on demand from the trunk). Set in Settings → Updates; one setting, not per-install. _Avoid_: channel, ring, track.

**Settings surface**:
The modal with twelve pages — General, Appearance, Updates, Remote access,
Remote instances, Providers, Memory, Knowledge vault, omp, Experimental,
Advanced, About — reached from the sidebar gear, the command palette, or
`mod+,`. Deliberately not a tab: preferences are not sessions, so they stay
out of the tab/lineage model entirely.
omp-ui's own preferences persist in the registry; the omp and Memory pages
are views onto omp's own config, written through `omp config set` to the
global layer only, with each value's layer shown. Memory configures omp's
memory keys and summarizes the resolved bank locations for a focused
project; it does not claim to show what was injected into a session.
_Avoid_: preferences dialog, options window, config panel

**Remote instance**:
Another omp-ui app whose embedded server this app has joined as a client,
saved with a nickname, its connection URL, and a credential. Its projects
and owned sessions appear in the sidebar under the nickname; opening one
renders that host's own stream, and every action on it runs on that host's
registry and processes — nothing is copied and no second omp process starts.
Model choice follows the owner: a remote tab's model catalog, favorites,
project model pins, and advisor defaults are that instance's — starring a
model or pinning a project default runs on that host, a rejected favorite
toggle is reported rather than written here, and the same favorites show in
every view of that instance. Provider administration stays host-local: a
remote tab with no models shows guidance naming the instance instead of
opening this app's Providers page, because its provider credentials live on
that host. The relation is directed: joining B from A gives B no view of A,
and a join never follows the remote's own joins. Quitting this app
disconnects remote instances; their sessions keep running, exactly as closing
a browser view does. The nickname is optional (defaults to the URL's host),
unique among joined instances, and is how every surface labels the host.
_Avoid_: remote server (the embedded listener this app hosts), remote host
(the `RemoteHost` seam), peer, connection

**Provider key**:
One API credential omp-ui supplies to every omp it launches, named by the
environment variable omp reads for it (`OPENROUTER_API_KEY`, …). Resolved from
four sources in priority order — stored in-app, inherited from the environment,
captured from the user's login shell, or reported from a project `.env` that omp
loads itself — because a `.desktop`/AppImage launch inherits no shell exports and
leaves omp with no catalog at all (ADR-0010). Stored keys are encrypted by the OS
credential store; the renderer only ever sees a masked tail.
_Avoid_: secret, token, API config, credential vault

**Web search order**:
The Settings → Providers choice naming which provider OMP's native `web_search`
tool tries first. On OMP ≥ 18.2.x its value is the `web` role of `modelRoles` —
an OMP selector `web/<provider>` — and on older binaries the global
`providers.webSearchOrder` value written one provider deep; unlisted providers
keep OMP's own fallback order either way, and the provider list comes from the
installed OMP binary, never transcribed into omp-ui (ADR-0027, ADR-0035,
ADR-0036). `web_search.enabled` only gates whether the tool exists at all;
a value badged `project` belongs to that project's `.omp/config.yml`, not to
this choice.
_Avoid_: search provider picker, search backend, engine, fallback list

**Theme**:
A curated token set covering all three consumers of the palette at once — the
`@theme` custom properties, the xterm ITheme, and the shiki code theme —
switched at runtime by writing CSS variables on the document root. Every theme
keeps the signal accent reserved for agent liveness (ADR-0004); a theme is a
fixed set, never a free-form colour picker.
_Avoid_: color scheme, skin, palette

**UI locale**:
The Settings → General choice that selects the language of omp-ui's own
application chrome. It applies immediately to desktop and remote renderers and
persists in the registry; unknown saved ids fall back to English. Session
content, PTY bytes, plan content, code and paths, names, backend errors, and
rendered technical output remain exactly as produced rather than being
translated.
_Avoid_: language mode, content locale, session language

**Font family**:
The Settings → Appearance choice between the app's own typeface (Bricolage
Grotesque for display, Instrument Sans for text, JetBrains Mono for code) and
the Ubuntu family (Ubuntu for display and text, Ubuntu Mono for code). Both
families place bundled Pretendard Variable after their Latin sans face so
Korean chrome uses a consistent local fallback without changing monospace
content. The choice persists in the registry like the theme id and repoints
the `--font-display`, `--font-sans`, and `--font-mono` tokens on the document
root, so every font utility, code block, and xterm surface (terminal tabs,
console drawer) follows one switch without a CSS rebuild. A fixed set of
choices, never a free-form picker.
_Avoid_: font switch, typeface theme, font skin

**Transcript width**:
The Settings → Appearance step (Comfortable 56rem / Wide 72rem / Full uncapped)
that caps the native transcript column, the composer card, and the hero column
together. Prose keeps a readable measure at each step (70/80/88ch) while tool
cards, code, and diffs take the whole column. It persists in the registry like
the theme id and repoints `--transcript-max` and `--prose-max` on the document
root.
_Avoid_: chat width, layout density, zoom

**Hanging speaker label**:
The "you"/"assistant" micro-label hung in the transcript's side gutter —
assistant left, user right — whenever the centred column leaves at least 128px
of slack per side; otherwise it stacks above its run as before. Measured, not
queried: the transcript's own resize observer decides.
_Avoid_: margin note, sidebar label, avatar

**Glass chrome**:
The Settings → Appearance step (Off / Subtle / Frosted) that lets chrome
planes — title bar, sidebar, inspector rail, composer card, sheets, modals —
composite at reduced opacity with a backdrop blur over an achromatic wash
under the app. Text is never filtered; the transcript's reading plane and
xterm hosts stay opaque (ADR-0026). The composer is the one glass plane with
live content moving behind it: the transcript scrolls under the floating
composer.
_Avoid_: transparency mode, acrylic, vibrancy, glassmorphism

**Floating composer**:
The bottom-anchored stack a desktop rpc-ui tab floats over its transcript —
the pending extension dialog card and the composer card — lifted clear of the
pane's bottom edge. The native transcript runs the full height of the session
column beneath it and reserves the stack's measured height as tail clearance,
so the newest row always scrolls clear of the card while older content passes
behind its glass. Measured, never assumed: the tab publishes the reserve as a
custom property the transcript reads. In flow instead of floating in the
compact shell, at the fresh-session hero, in the subagent view, and while the
plan review owns the column.
_Avoid_: input bar, bottom panel, sticky composer, floating toolbar

**Goal**:
An objective a *live session*'s OMP runtime keeps working toward across turns,
with OMP's own token accounting and an optional budget. Its state, its
continuation turns, and its pause reasons are OMP's; omp-ui reads them over
OMP's native rpc goal command and events and never keeps a parallel goal record,
meters tokens, or asks a model to role-play one. Offered in native sessions
only — a terminal tab forwards `/goal` to OMP's own TUI.
_Avoid_: objective (for the feature; the objective is the goal's text), todo list,
long-running prompt, autonomous mode

**Goal state**:
OMP's goal-mode state as its latest goal response, `get_state`, or
`goal_updated` reported it; mirrored in main per live tab, absent when no live
process reported.
_Avoid_: goal snapshot (retired with the bridge), goal cache

**Vibe mode**:
OMP's director mode: the model of a *live session* spawns and steers worker
sessions through OMP's own `vibe_*` tools. The mode, its workers, their tiers,
and their screens are OMP's; omp-ui invokes those tools' implementations through
a per-lineage generated extension and never keeps a parallel roster of its own
or asks a model to role-play a director. Offered in native sessions only — a
terminal tab leaves `/vibe` to OMP's own TUI.
_Avoid_: agent mode, swarm, multi-agent mode (for the feature; the workers are
the agents), director (for the mode; the director is the root session inside it)

**Worker**:
One OMP session a *vibe mode* director spawned through `vibe_spawn`, identified
by OMP's friendly name and reported with its state, tier, and turn count. A
worker killed explicitly stays killed — the bridge tombstones the kill instead
of resurrecting it; a worker whose transcript survived a process replacement
but whose screen did not is reported `parked`.
_Avoid_: subagent (omp-ui's `task` delegation is the subagent; a worker is
spawned by the session's own model in vibe mode), background job, screen (the
screen is the runtime surface a worker lives on)

**Vibe snapshot**:
The reduced, monotonic view of one session's vibe mode that the generated
extension publishes over the existing extension-status frame: availability plus
its reason, whether the mode is on, the worker roster, and any correlated
command result. Keyed in main by the process that answered, not the tab; a
stale or malformed publish leaves the last good snapshot standing.
_Avoid_: vibe status (a field of the snapshot), worker list (a section of the
snapshot), vibe cache

**Experiment**:
One row of OMP's autoresearch `sessions` table — its goal, metric, direction,
branch, baseline, segments, notes, and runs — not an omp-ui record. It is
linked to an owned session by that session's effective working tree plus its
branch, so it keeps existing while the session is dormant and outlives the
process that wrote it. omp-ui's own record of a launch is provenance only:
what the user asked for before `init_experiment` made the row.
_Avoid_: run (a run is one benchmark execution inside an experiment), trial,
autoresearch session

**Lab**:
The main-pane surface that lists every project's **Experiments** with progress
cards, and shows one experiment's runs, notes, and controls in a detail view.
Deliberately not a **Tab** and not one of the **Inspector rail**'s panes:
opening it hides the tab column, and activating any tab closes it. Reached from
the sidebar project cluster, the command palette, the Session HUD's
autoresearch chip, or `/autoresearch lab`.
_Avoid_: dashboard, experiments tab, research panel

**New experiment**:
The dialog whose fields are exactly `init_experiment`'s parameters (plus the
agent's optional brief, which rides the kickoff only). It spawns
an rpc-ui session in a fresh worktree checkout on a minted
`autoresearch/<slug>/<hash>` branch, arms OMP's mode with bare `/autoresearch`,
and sends one kickoff prompt — so the experiment is created by OMP's own tools,
never by an omp-ui write. Where there is no Git checkout it launches at the
project checkout with no branch isolation, and a jj-only workspace is refused.
Its fields can be proposed by the agent: an **experiment interview** in a
native session ends in the agent's `propose_experiment` call, which opens this
dialog prefilled; Launch is still the only way anything starts.
_Avoid_: experiment wizard, autoresearch setup

**Experiment proposal**:
The agent's pending `propose_experiment` call — a blocked select the New
experiment dialog answers with launch or revise. Never launched by the agent
itself. Closing the dialog is `revise`, not a deferral.
_Avoid_: experiment draft, auto-configure, wizard step

**Stats view**:
The global cross-session usage surface — totals, per-day and per-model
rollups, Projects, and per-session cost — read from omp's stats database,
opened from the command palette. It takes the main pane in place of the
tabs and is deliberately not a **Tab**: it is not a view onto a session.
Reads only; the database belongs to omp.
_Avoid_: stats tab, usage dashboard, analytics page
