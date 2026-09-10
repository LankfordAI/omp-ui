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
An owned session with a running `omp` process owned by this host's
`HostApplication` (one authority per data root — the persistent host;
ADR-0030).
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
belong to a remote instance: it renders that instance's stream, its
`instanceId` names the owner, and its label carries the nickname in front of
the title.
_Avoid_: window, pane

**Project**:
A working directory the user has explicitly registered in the sidebar, stored
in omp-ui's own config. Owned sessions attach to the project they were
launched in. A project with zero sessions is valid (fresh repo, nothing run
yet).
_Avoid_: repo, folder, workspace

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
and the host hibernates it only when a safety probe finds no turn, queue, stream, or
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
`notice`, `irc`, `marker`, or `command`. Items are derived state — the session
file stays the source of truth, and an unknown event type adds nothing rather
than breaking the transcript.
_Avoid_: message, bubble, row

**Marker**:
A hairline lifecycle rule in the transcript (`agent started`, compaction,
retry). Turn boundaries deliberately emit none: one live prompt produced eight
of them, burying the actual content.
_Avoid_: divider, separator, system message

**Usage receipt**:
A dim, quiet one-line receipt under an assistant message. It starts with the
requested model and may name OMP's routed upstream provider inline, followed by
in/out tokens, cache reads, cost, ttft, and duration from `message_end.usage`.
Its hover detail may include the provider response ID when OMP supplies it. It
is a receipt, not telemetry.
_Avoid_: stats line, metrics, footer

**Signal accent**:
The mint token reserved for agent liveness and success (ADR-0004). Spending it
on chrome destroys the property that a glance answers "is it working?".
_Avoid_: primary colour, brand colour, green

**Inspector rail**:
The right-hand icon strip in an rpc-ui tab, with five panes behind it —
Todos, Agents, Session, Plans, Diffs. The strip is the permanent posture:
pressing an icon opens just that one pane beside it, re-pressing the active
icon (or the pane's close control) dismisses it, and badge counts live on
the strip icons. Remembers its selected pane per tab.
_Avoid_: right sidebar, panel, drawer

**Project actions sheet**:
The bottom sheet a compact-shell project header's ⋯ button opens: the
project's name and full path, then New session, New terminal session,
*New worktree session, Project settings, and Remove project. It
replaces the cluster below 900px. The desktop open targets (VS Code, Files, Terminal) are
deliberately absent: a compact shell is usually a phone talking to a
remote omp-ui, where opening on the machine that owns the sessions answers a question nobody asked.
_Avoid_: project context menu, overflow menu, kebab menu

**Subagent view**:
The rpc-ui tab's main pane while a subagent is selected in the Agents
pane: the full transcript surface — tool cards, thinking, usage receipts —
rendered read-only from that subagent's own event stream, backfilled from
its transcript file (`get_subagent_messages`) so the whole run shows, not
just what streamed since the click. A banner names the agent and its
status and leads back to the main agent; the composer disappears because
a subagent cannot be prompted or steered. It is a view onto the same live
session, never a separate session or tab.
_Avoid_: subagent tab, agent window, subagent chat

**Session HUD**:
The status bar atop an rpc-ui tab: liveness, click-to-rename title, context
meter, spend, and the session controls (compact, auto-compact, export, branch,
new, refresh, queue modes). While auto-compact is enabled, the context meter
carries a notch at the compaction threshold — the token count where omp
auto-compacts. Model, thinking level, and the advisor live in the
composer instead, next to the text they affect. With the advisor enabled, a
second, quieter `adv` readout sits beside the main usage. Its context meter and
model describe the parent advisor; its spend and token total include advisor
activity in every spawned descendant. The parent switch is a ceiling: an
advisor-off parent disables descendant advisors, while an advisor-on parent
still leaves each descendant's own opt-in authoritative. A generated `-e`
extension delivers the values (ADR-0008), never a text parse.
_Avoid_: toolbar, header, status bar

**Session parameter memory**:
The five composer parameters — main model, main thinking level, advisor on/off,
advisor model, and advisor thinking level — are remembered per project and
seed the next session. Each live session also records its own main model and
thinking level, so the advisor's required relaunch reapplies them instead of
falling back to a different model. Advisor model + level remain one omp
`model[:level]` selector; a null selector defers to `modelRoles.advisor` and is
never the empty string. The advisor state itself remains session-scoped; the
project fields are only last-used defaults for a new session. A separate app
preference, **Default advisor** (Settings → General, off by default), decides
whether a new session with no per-project memory starts with the advisor on;
it supersedes omp's own config for that one decision, while the advisor model
still falls back to omp config.
A project may also pin a **Default model** and **Default advisor model** for
fresh sessions. A pin is a standing choice, not last-used memory: composer
changes continue to update the `last*` fields without moving either pin.
Clearing a pin restores the last-used chain. The advisor pin is model-only;
advisor on/off keeps its existing last-used → app default → omp config chain,
so the pinned advisor model is dormant while that chain resolves off.
_Avoid_: resetting model on advisor toggle

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
as bare base64; in a terminal tab it cannot ride the PTY at all, so it becomes
a scratch file whose path is handed to omp's TUI as a bracketed paste
(ADR-0006). omp re-encodes on ingest, so what returns in the transcript is
omp's mime type, not the clipboard's.
_Avoid_: upload, file, media

**Auto-title**:
The name a new session gets from its first substantive prompt, in two phases.
Phase one, at prompt time: a mechanically derived title from the prompt is
pushed immediately with `set_session_name`, so the session is named before any
model round trip. For a session seeded from an approved plan, the plan titles
it — both the derived name and the model's payload come from the record's
`planTitle`, never from the seed text that carried the plan. Phase two, in the
background: omp-ui asks omp's own small model — a stateless `omp -p` run on the
`tiny`/`commit`/`smol` role its config binds, over a bounded payload, since
the one-shot rides a single OS argument — and, when it answers with a
different title, upgrades the name with a second `set_session_name`; a
user-sourced rename overwrites a user title (only omp's own "auto" titling is
latched out once a "user" one exists), which is what makes the upgrade
possible. A greeting is not substantive: titling defers rather than latch.
When the model declines or is unreachable, the derived name simply stands.
_Avoid_: session name generation, summary, label

**Re-titling**:
A user-requested second look at a session's title, from a digest of its
transcript plus the title on the row. It replaces Auto-title's answer, never
the user's own rename; it needs a live session, and a declined answer leaves
the row untouched.
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
immediately. Both keep the working tree read-only. The pending plan gate itself is owned by the host —
the proposal frame is recorded as the session's `pendingPlan` on its summary,
and a verdict as `planSettle` (issue #215) — so a renderer that joins late (a
remote client) hydrates the review from the record and settles a verdict
another client already made; the gate never outlives the session process.
An HTML gate carries the `sourceHash` the host's preflight validated: answering
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
The host-side validation an HTML plan must pass before a plan review can
exist at all (issue #312 follow-up, ADR-0022 amended): the proposal's
`select` request is claimed at the session's frame edge — before observers,
clients, notifications, or the pending-plan record — the artifact is read
through the confined plan reader, and the same parser, transforms, and real
layout probe every surface uses runs in the host's headless, script-less
Chromium verifier. A passed proposal is delivered once with a host-authored
`sourceHash`; a failed or unavailable one answers the agent directly with
bounded, source-located diagnostics as the proposal tool result, so the
agent repairs the reported ranges of the existing artifact instead of the
user discovering a broken document in review. `unavailable` is honest: an
inconclusive verification never presents a plan, and never claims one is
fine. Application failures say "omp-ui could not verify" and stop — they
must never send the agent to rewrite valid source.
_Avoid_: plan lint, plan validation prompt, renderer check

**Magic keyword**:
One of omp's three prose keywords — `ultrathink`, `orchestrate`, `workflowz` —
which, submitted as standalone prose, make omp append a hidden system notice
steering the turn (and, for `ultrathink` under auto-thinking, resolve the turn
to the model's highest thinking level). The composer paints each with its own
gradient exactly as omp's editor does; the plan review stages them as
switches that lead the implementation prompt in omp's notice order. omp's own
config (`magicKeywords.*`) can disable each one, which makes the word inert
literal text — omp-ui mirrors typing, so it neither detects nor overrides that.
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
The OS notification the desktop client posts (Electron `Notification`) when an
owned native session reaches an attention state while the user is not looking
at that tab in the desktop window — the window is unfocused, or it is focused
but showing a different tab (issue #271): a turn finished, a plan review is
pending, or stall auto-continue paused at its cap. One per tab, replaced
rather than stacked; the post is delayed 3 s and re-gated at fire time so a
turn that auto-resumes never blinks. A remote renderer's viewed tab never
suppresses or acknowledges the banner — it is a different screen. Clicking
focuses the window and resurfaces the session through the ordinary openSession
path. A Settings → General switch, default on. Terminal sessions are never
announced — the host has no turn signal in a PTY — and remote browser clients
receive none; their story is web push and stays a separate feature.
_Avoid_: toast, system alert, reminder, popup

**Parked message**:
A queued item omp still holds while the live session is idle. omp's
`queuedMessageCount` counts all displayable queued work — user follow-ups and
steers, but also advisor cards, agent-authored custom entries, and deferred
messages — and queued follow-ups only drain at a clean turn end: after a user
interrupt they park until an explicit new prompt. The composer therefore labels
the count `parked: N` whenever the agent is not running, since nothing drains
while idle (issue #181).
_Avoid_: stuck queue, ghost message

**Proposed plans pane**:
The inspector rail pane (ADR-0004 vocab) that lists the focus session's plan
history — the pending plan first, with review / request changes / not now
actions, then settled plans dimmed by verdict. The pending plan is one per
session and is the same object the plan review shows: clicking it or the
review action restores the review in that tab, request changes answers
`refinePlan` without notes, and not now calls `deferPlanReview`. Only the
focused tab's review renders; a background session's pending plan surfaces
here (its sidebar row reads "answer needed") instead of stacking review on review.
_Avoid_: plan inbox, plan queue, plan history

**Branch diff pane**:
The inspector rail pane that shows every working-tree change on the focus
session's project git branch — the tracked diff plus new untracked files read
as creates, one `DiffViewer` per file. It is a repo view, not a session view:
the rail asks the host (`core/branch-diff.ts`, the git-only
`getBranchDiff` channel) and renders the parsed result, so "all changes on
the current branch" is what the user reads regardless of which session
produced them. For a worktree session the pane diffs the working tree against
`merge-base(base, HEAD)` — the branch's cut point — so committed session work
stays visible instead of vanishing at the first commit; a "since <base>" chip
marks that reading. Sessions without a recorded base show the plain
`git diff HEAD`.
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
worktrees root, and on a conflict offers to sync the destination into the
worktree, so the owning session resolves it in the checkout that holds the
change rather than in the project checkout. A checkout with uncommitted
changes cannot be returned — the host enforces it, and the delete dialog is the
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
_Avoid_: sandbox session, isolated session, branch session, close the
worktree, merge & close, merge & return as the sole exit

**Finish worktree**:
The single dialog that settles a worktree session's destination, outcome
and session — where the work goes, whether it lands as a merge commit or a
kept branch, and whether the session returns to the project checkout or
stays in its worktree. Finish settles local state only — publishing or pushing
the destination is a separate explicit step.
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
four stacked sections — the project's MCP servers (the same resolved list,
per-server toggles, per-source provenance, and per-file errors the MCP manager
renders, project-scoped with no pinned tab), the project's **capability
catalogs** for Skills and Tools (issue #383: the same panels the global viewer
uses, scoped to this project, their switches writing `.omp/config.yml` in
place), and the project's default-model pins (main-model and advisor-model
with their pickers and Clear actions).
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

**Update card**:
The small non-modal card in the lower-right corner announcing an available
update. There are three, one per thing that updates: the host card (a staged
host release is offered from the host's `latest-host-<platform>.yml` feed,
with Apply now / Defer while the bounded countdown runs; every client sees the
same countdown), the desktop client card (AppImage, NSIS, and macOS installs —
the staged ZIP applies through Squirrel.Mac — stage through `electron-updater`
before it appears, offering Restart now / Install when I quit / Later; present
only in the desktop client, through the desktop adapter), and the omp binary
install/update card (Update now / Later, or Install / Later when omp is not
installed at all). Dismissal is remembered per offered version and dropped once
the running/installed version catches up to it — a dismissal only ever
suppresses that exact offer, so a caught-up entry is dead state. Background
failures stay silent. When several show they share one corner stack.
_Avoid_: toast, notification, popup, updater dialog

**Settings surface**:
The modal with nine pages — General, Appearance, Updates, Remote access,
Remote instances, Providers, Memory, omp, About — reached from the sidebar
gear, the command palette, or `mod+,`. Deliberately not a tab: preferences
are not sessions, so they stay out of the tab/lineage model entirely.
omp-ui's own preferences persist in the registry; the omp and Memory pages
are views onto omp's own config, written through `omp config set` to the
global layer only, with each value's layer shown. Memory configures omp's
memory keys and summarizes the resolved bank locations for a focused
project; it does not claim to show what was injected into a session.
_Avoid_: preferences dialog, options window, config panel

**Remote instance**:
Another omp-ui host whose remote exposure this host has joined as a client,
saved with a nickname, its connection URL, and a credential. Its projects
and owned sessions appear in the sidebar under the nickname; opening one
renders that instance's own stream, and every action on it runs on that instance's
registry and processes — nothing is copied and no second omp process starts.
Model choice follows the owner: a remote tab's model catalog, favorites,
project model pins, and advisor defaults are that instance's — starring a
model or pinning a project default runs on that instance, a rejected favorite
toggle is reported rather than written here, and the same favorites show in
every view of that instance. Provider administration stays instance-local: a
remote tab with no models shows guidance naming the instance instead of
opening this app's Providers page, because its provider credentials live on
that instance. The relation is directed: joining B from A gives B no view of A,
and a join never follows the remote's own joins. Stopping this host
disconnects remote instances; their sessions keep running, exactly as closing
a browser view does. The nickname is optional (defaults to the URL's host),
unique among joined instances, and is how every surface labels the instance.
_Avoid_: remote server (the exposure listener this host runs), remote host,
that host, peer, connection (the `HostSurface` seam keeps its symbol name and is
called "the `HostSurface` seam", never "the host")

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
tool tries first. It is OMP's `providers.webSearchOrder` global value written one
provider deep — unlisted providers keep OMP's own fallback order afterward — and
the provider list comes from the installed OMP binary, never transcribed into
omp-ui (ADR-0027). `web_search.enabled` only gates whether the tool exists at all;
a value badged `project` belongs to that project's `.omp/config.yml`, not to this
choice.
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
continuation turns, and its pause reasons are OMP's; omp-ui reads them through a
per-lineage generated extension and never keeps a parallel goal record, meters
tokens, or asks a model to role-play one. Offered in native sessions only — a
terminal tab forwards `/goal` to OMP's own TUI.
_Avoid_: objective (for the feature; the objective is the goal's text), todo list,
long-running prompt, autonomous mode

**Goal snapshot**:
The reduced, monotonic view of one session's goal that the generated extension
publishes over the existing extension-status frame: availability plus its reason,
OMP's goal with status and token use, the continuation state, the pause reason, and
any correlated command result. Keyed in the host by the process that answered, not the
tab, so a replaced process's goal cannot be shown by its successor; a stale or
malformed publish leaves the last good snapshot standing.
_Avoid_: goal status (a field of the snapshot), goal cache, goal mirror

**Persistent host** (short: **host**):
The long-running, display-independent omp-ui process that is the single
authority for exactly one data root — its registry, every live `omp` child and
shell, local control, remote exposure, attention, plan files, plan gates and
preflight, OMP resolution and updates, its own updates, and credential
decryption. Its code is `HostApplication` in `@omp-ui/host` (ADR-0029), and
`omp-ui serve` is the only process that constructs it; no Electron runs in that
process. "This host" is this installation's; a joined app is never "the host".
_Avoid_: daemon, backend process, headless app, main process (which names the
Electron client's own process only), host for a joined instance (say "that
instance")

**Desktop client**:
The optional Electron application that presents the shared renderer. It owns
windows, chrome, and client effects, and owns no authoritative state; it
connects to the local host over local control with the desktop credential —
the renderer over one WebSocket, Electron main over a second one of its own
for the notifier — so closing, updating, crashing, or relaunching it changes
only its own view: live sessions, listeners, and other clients are untouched.
Where no host is running its host bootstrap starts one, detached and reaped by
the platform supervisor, never as its own child.
_Avoid_: the app (when a browser client is also meant), Electron backend

**Browser client**:
A generic authenticated renderer reaching the host over the WebSocket
transport, local or remote. Same role and the same host-owned channels
everywhere; nothing is desktop-only except client effects, which it lacks and
replaces with truthful behaviour rather than faking.
_Avoid_: web client (collides with the desktop's own web contents), remote
renderer as a role name

**Instance client**:
The client role this host's join presents to another host's remote exposure
— one socket per joined instance, dialled with the joined-instance header and
a `hello` naming `clientRole: "instance"`. It is how a remote instance is
joined; the user-facing term for the joined app stays *remote instance*, and
in prose that app is "that instance", "the joined instance".
_Avoid_: peer, remote host, bare "instance" for a running process

**Local control**:
The host's always-on loopback endpoint (`127.0.0.1`, ephemeral port) plus the
connection record that advertises it. It exists whether or not remote exposure
is on, requires the `hello` handshake from every client, and is unaffected by
enabling, disabling, or rotating exposure credentials. Restarting the host
rotates both of its credentials.
_Avoid_: management endpoint, admin port, local server

**Remote exposure**:
The optional network-facing listener governed by the Settings → Remote access
page and its password or token. Enabling, disabling, or rotating it affects
exposed clients only; it still accepts a legacy client whose first frame is a
request rather than a `hello` (implicit protocol 1) until that bridge is
retired (ADR-0029).
_Avoid_: remote server as the concept (it is the listener), remote access
for the endpoint itself (that is the settings page)

**Client role**:
The host-side classification of one authenticated connection — browser
client, desktop client, or instance client — decided by the credential
presented at the HTTP upgrade and the listener it arrived on (local or
exposed, with or without control), never by a renderer-supplied id. The role
selects which channels that connection's table contains; a gated channel is
absent, not denied.
_Avoid_: trust level, client type, permission

**Client effect**:
An observable action only a UI client can perform on its own machine:
desktop notifications, revealing or opening paths in VS Code, Files,
Explorer, or a terminal, native save dialogs, safe external-link opening,
window chrome, and applying an update to the client's own artifact. The host
never performs one; a desktop client performs it through the desktop adapter
beside `window.ompBackend`, and a browser client gets truthful replacement
behaviour — never a silent skip or a fake.
_Avoid_: desktop action (narrower, remote-instance prose), native action,
host action, host-local (say client-local or instance-local)

**Data root**:
The one directory a persistent host owns: `<dataHome>/omp-ui`, or
`omp-ui-dev` / `omp-ui-dev-server` by build flavour (`$XDG_DATA_HOME` or
`~/.local/share`, `~/Library/Application Support`, `%LOCALAPPDATA%`),
replaced whole by `OMP_UI_DATA_DIR`, blind to `OMP_PROFILE`, and never nested
inside another flavour's root. It holds the registry, credential stores,
`oauth-login/`, `worktrees/`, `logs/`, `updates/`, the managed omp, and the
host's own `host.lock`, `host.json`, `migration.json`, and
`runtime/children.json`. Electron's `userData` keeps client state only — the
Chromium profile, `window-state.json`, client-local logs.
_Avoid_: userData, app data (when the client's profile is meant), profile
directory, registry path

**Authority claim**:
How a host becomes the one owner of a data root (ADR-0030): it publishes its
own owner record by hard link as `host.lock`, refuses when a live host answers
the probe or the recorded owner is alive or unverifiable, and takes over only
on proof that the recorded owner is gone — another boot, or a dead pid or
different start time on this boot. The result is the `AuthorityToken`, the
only route to `Registry.load` and the resume seam. `omp-ui serve` exits 5 on a
refusal; a pre-cutover desktop build that finds claim evidence in the root
refuses to start with the same code.
_Avoid_: single-instance lock (Electron's, scoped to `userData`), lease,
heartbeat, lock file for `host.json`

**Migration journal**:
`<dataRoot>/migration.json`: the durable, ordered record of every one-shot
change to the authoritative stores, one step per frozen id
(`relocate-authority-stores-v1`, `credential-handoff-v1`), each item's
evidence written before the file system is touched, so a replay after a
crash can tell "never started" from "moved but unrecorded" and stop when disk
and evidence disagree. An unknown step fails closed.
_Avoid_: migration log, upgrade marker, migration flag

**Children ledger**:
`<dataRoot>/runtime/children.json`: every `omp` or shell child the host
spawned, recorded with pid, process group, boot id, start time, kind, tab,
and lineage dir before the spawn is reported, removed on reap. The next
authority reconciles it before it loads the registry — drops the dead,
terminates the identified survivors, and stops the boot by pid over anything
it cannot prove dead — so a crash leaves exactly one resumer.
_Avoid_: pid file, orphan list, process table

**Connection record**:
`<dataRoot>/host.json`, mode 0600: the host's endpoint, version, protocol
range, pid and start time, incarnation, and the two local credentials —
desktop and control. It is how a desktop client or the CLI finds and
authenticates to the running host; its presence never proves liveness — an
authenticated probe does — and it is not the lock. A clean stop deletes it.
_Avoid_: lock file, pid file, discovery file

**Control channel**:
A backend channel declared with `gate: "control"` — `host:status`,
`host:stop`, `host:pair` — present only in a connection table whose grant
carries `control`, which the local-control credential alone confers; a
connection without it sees no such channel. They are the verbs the `omp-ui`
CLI drives. Not a fourth client role: the CLI connects as a browser client
with control.
_Avoid_: admin channel, management API, CLI role

**DEK**:
The host's 32-byte data encryption key, one per data root, the only secret the
OS credential store holds. Every stored credential is an AES-256-GCM envelope
under it (`0x02 || nonce || ciphertext || tag`), so a slow or locked keyring
costs one bounded lookup at boot rather than one per credential. Read once on
a worker with a 5 s deadline; with ciphertext on disk a missing DEK is
*key-lost*, never a fresh key.
_Avoid_: master password, encryption key (unqualified), safeStorage key

**Credential protector**:
The platform adapter that files the DEK in the OS store — Secret Service on
Linux, Keychain on macOS, DPAPI over `<dataRoot>/master.key` on Windows — with
no keyutils or plaintext fallback. When it cannot answer, the host opens a
degraded cipher that fails closed: it reports its backend and reason, injects
no stored provider key, and refuses stored-key writes and credential joins
while the rest of the host keeps serving.
_Avoid_: keyring (as the omp-ui concept), safeStorage, secret store backend

**Credential handoff**:
The journalled migration step that re-encrypts `provider-keys.json` and
`remote-instances.json` from Electron `safeStorage` ciphertext into host
envelopes, per value: a host envelope is kept, a readable blob is
re-encrypted, a locked keyring leaves the bytes and the step open for a later
run, and an unreadable blob drops a provider key by name or marks a joined
instance *sign-in required*. Runs under the authority claim before the
registry loads; plaintext never touches disk. The legacy `safeStorage` readers
it needs stay in the host until two later minor releases and twelve months
after the cutover have both passed.
_Avoid_: key migration, re-keying, credential import

**Cutover handoff**:
`<dataRoot>/runtime/cutover-handoff.json`, mode 0600: the one-use note a
pre-cutover desktop client writes — its pid and start time, its Electron
`userData`, the target root, a nonce — while it is still running and before it
submits the host start, so the supervisor-started host can prove that exact
process still holds Chromium's `SingletonLock` and adopt its stores through the
migration journal. The host renames the note to a consumed name before it
migrates; a stale, foreign, or unverifiable note migrates nothing. The handoff
grants no authority.
_Avoid_: migration marker, upgrade token, handover file

**Desktop adapter**:
`window.ompDesktop`: the separately named in-process seam beside
`window.ompBackend` through which the renderer performs client effects and
reports this window's viewed tab, built from `DESKTOP_CHANNELS` over preload
IPC. Present only in the desktop client; `null` in a browser client, which is
how the renderer knows to gate path effects on `desktop !== null` and a local
tab. It is not `OmpBackend` and never reaches the host.
_Avoid_: desktop backend, native bridge, IPC backend

**Host bootstrap**:
`window.ompHostBootstrap`: the desktop client's preload surface, beside the
desktop adapter, through which the renderer obtains its local endpoint and
desktop credential. Electron main finds a compatible live host (connection
record plus authenticated probe), else installs the embedded seed as the
`current` host, submits the supervisor's on-demand start, and polls until the
host answers — reporting `probing`, `installing`, `starting`, `ready`, or
`failed` with the data root, both log directories, and the supervisor kind.
Its `retry`, `stop`, and `rollback` verbs drive the recovery surface the
renderer shows before React loads. Absent in a browser client; it never opens
an authoritative store and never constructs a backend.
_Avoid_: launcher, backend starter, host manager

**Attention level**:
The neutral per-tab state the host publishes for an owned native session —
`turn-complete`, `plan-pending` (with the plan's title), or `stall-paused`,
stamped with the moment it arose — carried on the session summary and on
`attention:changed`. Authored only by host observers (agent start and end,
proposal, verdict, invalidation, process exit, the stall cap); a pending plan
outranks a finished turn, a new turn clears it, PTY tabs never hold one, and
no viewed report changes it. A desktop notification is one client's
translation of it.
_Avoid_: notification (the client effect), alert, unread state

**Attention transition**:
One change of a tab's attention level, broadcast to every client. Transitions
are global: they begin and end a tab's attention for everyone; a client that
has already bannered a level's stamp never re-banners it.
_Avoid_: notification event, ping

**Viewed report** (connection-qualified):
A connection's statement of the one tab it currently shows (`tab:viewed`,
null for none), kept per connection by the host, dropped when that connection
closes, and stale after fifteen minutes. It protects that tab from idle
hibernation and gates only that connection's own client effects; it never
begins or ends attention, and no other connection's report suppresses this
client's banner — a remote renderer's viewed tab is a different screen. The
desktop client reports its own window's tab through the desktop adapter as
well, for its banner gate.
_Avoid_: viewed tab (unqualified — say whose connection reports it viewed),
focused tab, active tab, acknowledgement

