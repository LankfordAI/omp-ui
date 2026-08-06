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

**Tab**:
The renderer's view onto a live session's PTY — one xterm.js instance per
live session. Tabs hide rather than close; focus/dedupe keys on the tab,
which exists from spawn — before the session has an id or file.
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
to omp-ui, even under registered projects.
_Avoid_: tracked session, managed session

**Lineage**:
The sequence of sessions one spawned `omp` process produces: the initial
session plus every `/new` and `/branch` it switches into (omp replaces the
session file in-process). A lineage shares one pinned session dir.
_Avoid_: tab history

**Render item**:
One entry in the native transcript, reduced from the `AgentSessionEvent`
stream by `lib/transcript.ts`: `user`, `assistant`, `tool`, `advisory`,
`notice`, `irc`, or `marker`. Items are derived state — the session file stays
the source of truth, and an unknown event type adds nothing rather than
breaking the transcript.
_Avoid_: message, bubble, row

**Marker**:
A hairline lifecycle rule in the transcript (`agent started`, compaction,
retry). Turn boundaries deliberately emit none: one live prompt produced eight
of them, burying the actual content.
_Avoid_: divider, separator, system message

**Usage receipt**:
The dim one-line footer under an assistant message — model, in/out tokens,
cache reads, cost, ttft, duration — lifted from `message_end.usage`. It is a
receipt, not telemetry: one line, quiet, hover to raise contrast.
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

**Session HUD**:
The status bar atop an rpc-ui tab: liveness, click-to-rename title, context
meter, spend, and the session controls (compact, auto-compact, export, branch,
new, refresh, queue modes). Model, thinking level, and the advisor live in the
composer instead, next to the text they affect. With the advisor enabled, a
second, quieter `adv` context/cost readout sits beside the main usage — it is
delivered by a generated `-e` extension (ADR-0008), never a text parse.
_Avoid_: toolbar, header, status bar

**Session parameter memory**:
The five composer parameters — main model, main thinking level, advisor on/off,
advisor model, and advisor thinking level — are remembered per project and
seed the next session. Each live session also records its own main model and
thinking level, so the advisor's required relaunch reapplies them instead of
falling back to a different model. Advisor model + level remain one omp
`model[:level]` selector; a null selector defers to `modelRoles.advisor` and is
never the empty string. The advisor state itself remains session-scoped; the
project fields are only last-used defaults for a new session.
_Avoid_: global advisor setting, resetting model on advisor toggle

**Attachment**:
An image on an outgoing prompt. In rpc-ui it rides the prompt frame's `images`
as bare base64; in a terminal tab it cannot ride the PTY at all, so it becomes
a scratch file whose path is handed to omp's TUI as a bracketed paste
(ADR-0006). omp re-encodes on ingest, so what returns in the transcript is
omp's mime type, not the clipboard's.
_Avoid_: upload, file, media

**Auto-title**:
The name a new session gets from its first substantive prompt. rpc-ui mode
never titles itself, so omp-ui asks omp's own small model — a stateless
`omp -p` run on the `tiny`/`commit`/`smol` role its config binds — and pushes
the answer with `set_session_name`. A greeting is not substantive: titling
defers rather than latch, because `set_session_name` writes source `"user"`
and omp refuses every later title. When the model declines or is unreachable,
a mechanically derived title from the prompt stands in.
_Avoid_: session name generation, summary, label

**Plan mode**:
A session state in which omp explores read-only and drafts an execution spec
instead of editing. omp's rpc protocol cannot express it at all, so omp-ui
drives it through an extension generated into the lineage dir and passed as
`-e` at spawn (ADR-0007). It toggles in-process — unlike the advisor pin, it
never respawns the session. The read-only guarantee is omp's own write guard,
not omp-ui's.
_Avoid_: planning mode, read-only mode, plan-first

**Plan review**:
The gate between drafting and implementing. The agent submits by writing its
plan's slug to `xd://propose`, which blocks it until the user answers execute
or refine. Execute lands a single verdict and the renderer dispatches the
implementation into a chosen context — the same session, the same session
after compacting its context, or a freshly spawned session seeded with the
plan — as a normal prompt. Refine sends the agent back to revise the draft,
optionally carrying the user's revision notes (text + images). Abandoning the
pane — Escape, scrim-click, or "not now" — is the third, non-answering verdict:
`deferPlanReview` dismisses it without resolving the gate, so the agent stays
paused on its proposal and the plan stays pending in the rail's proposed
plans pane until the user returns. Defer encodes "ignore for the time being";
refine is the only verdict that revises immediately. Both keep the working
tree read-only. Because the advisor reviews a turn only after it ends, the
plan turn's review can outlive the gate — so on execute, a session with a
configured advisor answers the verdict first, waits (bounded) for that review
to land, then folds its concerns into the implementation prompt in every
context; refine stays immediate because the planner revises in situ, where the
advisor's notes already land. The fold is a per-review switch, default on.
_Avoid_: plan approval dialog, confirmation, plan prompt

**Proposed plans pane**:
The inspector rail pane (ADR-0004 vocab) that lists the focus session's plan
history — the pending plan first, with review / request changes / not now
actions, then settled plans dimmed by verdict. The pending plan is one per
session and is the same object the review modal shows: clicking it or the
review action restores the modal, request changes answers `refinePlan`
without notes, and not now calls `deferPlanReview`. Only the focused tab's
review modal renders; a background session's pending plan surfaces here
instead of stacking modal on modal.
_Avoid_: plan inbox, plan queue, plan history

**Branch diff pane**:
The inspector rail pane that shows every working-tree change on the focus
session's project git branch — the tracked `git diff HEAD` plus new untracked
files read as creates, one `DiffViewer` per file. It is a repo view, not a
session view: the rail asks the main process (`core/branch-diff.ts`, the
git-only `getBranchDiff` channel) and renders the parsed result, so "all
changes on the current branch" is what the user reads regardless of which
session produced them.
_Avoid_: per-session diff log, file edit history

**Update card**:
The small non-modal card in the lower-right corner announcing an available
update. There are two: the omp-ui release card (on AppImage it appears only
after the verified update is staged, offering Restart now / Install when I
quit / Later) and the omp binary install/update card (Update now / Later, or
Install / Later when omp is not installed at all). Dismissal is remembered
per offered version and dropped once the running/installed version catches up
to it — a dismissal only ever suppresses that exact offer, so a caught-up
entry is dead state. Background failures stay silent. When both show they
share one corner stack, the omp-ui card on top.
_Avoid_: toast, notification, popup, updater dialog

**Settings surface**:
The modal with seven pages — General, Appearance, Updates, Remote access,
Providers, omp, About — reached from the sidebar gear, the command palette, or
`mod+,`. Deliberately not a tab: preferences are not sessions, so they stay out
of the tab/lineage model entirely. omp-ui's own preferences persist in the
registry; the omp page is a view onto omp's own config, written through
`omp config set` to the global layer only, with each value's layer shown.
_Avoid_: preferences dialog, options window, config panel

**Provider key**:
One API credential omp-ui supplies to every omp it launches, named by the
environment variable omp reads for it (`OPENROUTER_API_KEY`, …). Resolved from
four sources in priority order — stored in-app, inherited from the environment,
captured from the user's login shell, or reported from a project `.env` that omp
loads itself — because a `.desktop`/AppImage launch inherits no shell exports and
leaves omp with no catalog at all (ADR-0010). Stored keys are encrypted by the OS
credential store; the renderer only ever sees a masked tail.
_Avoid_: secret, token, API config, credential vault

**Theme**:
A curated token set covering all three consumers of the palette at once — the
`@theme` custom properties, the xterm ITheme, and the shiki code theme —
switched at runtime by writing CSS variables on the document root. Every theme
keeps the signal accent reserved for agent liveness (ADR-0004); a theme is a
fixed set, never a free-form colour picker.
_Avoid_: color scheme, skin, palette
