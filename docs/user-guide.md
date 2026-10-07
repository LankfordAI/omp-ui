# User guide

This guide covers day-to-day work in omp-ui. Start with [Getting started](getting-started.md) if the app or `omp` is not installed yet. Return to the [Documentation home](README.md) for the full guide index.

## Core concepts

A **project** is a working directory that you register in omp-ui. Registering one adds it to the sidebar; omp-ui does not scan every directory on your computer.

A **session** is an on-disk OMP transcript and its optional artifacts. A **live session** has an `omp` process owned by the running omp-ui instance. A **tab** is the renderer's view of that process. Switching tabs or hiding a tab does not stop the agent, and selecting the session in the sidebar brings its tab back.

omp-ui lists only **owned sessions**. These are sessions launched by omp-ui, including sessions produced in-process by an owned session through OMP's `/new` or `/branch`. Sessions launched by running `omp` in another terminal do not appear, even when their working directory is a registered project.

A **lineage** is the initial session plus any sessions that the same spawned process switches to in-process. They share one pinned lineage directory. This boundary matters when you delete: omp-ui removes the whole lineage directory from both the active and archive session roots, including every transcript and artifact in it.

omp-ui offers two ways to use an owned session:

- **Native mode** uses the rpc-ui protocol. It has a native transcript, composer, Session HUD, inspector rail, Plan mode, attachments, and a session console.
- **Terminal mode** embeds OMP's TUI in a terminal tab. OMP owns the interaction and display inside that tab.

Switching a live session between native and terminal mode kills its process and resumes the same session in the other mode. The transcript stays on disk. For a dormant session, switching modes only changes the mode used on its next resume. This is different from switching between Build and Plan, which happens in-process without a restart.

## Projects and sessions

### Register and organize projects

Use **Add project** in the title bar or sidebar, choose a directory, and add the resolved path. The picker's leaf segment fuzzy-matches the current directory's names: non-adjacent characters match, the best matches rank first with the matched characters emphasized, and selecting a result always browses or registers that directory's real path, never the typed text. The sidebar groups owned sessions under each project. Sessions keep their position until you move them: new sessions enter at their project's top, and running activity never reshuffles the list. Drag a session row's grip, or focus it and press `Alt+Up` or `Alt+Down`, to reorder; a plan-handoff tree moves with its planning row. Filter by session title or project name, collapse a project, drag project headers to reorder them, or focus a header's grip and press `Alt+Up` or `Alt+Down`.

Tab completes the path you are typing, like a shell: with no row selected, Tab on a leaf that matches exactly one directory descends into it; when several match, Tab inserts their longest common prefix and repeated Tab cycles the candidates (Shift+Tab cycles backwards). Tab on a selected row opens that row, as before. A completed or cycled name always lands on the directory's real path and casing, never on your query text.

When the candidates' common prefix would not extend what you typed — `~/al`
matching `alpha` and `axle`, which share only `a` — Tab cycles the candidates
immediately instead of inserting a prefix: the first Tab gives `~/alpha`, the
next `~/axle`; it never rewrites your text to the shorter `a`.

On a desktop-sized window, a project header exposes open, project-settings, new-session, and remove actions. The Open control's menu offers **VS Code** (when installed), **Files**, and **Terminal** (when a launchable system terminal is found); Terminal opens the host's terminal with its shell in the project root. All three start from the environment omp-ui was launched with, without the AppImage's own variables, so a terminal opened inside VS Code or the file manager behaves as a native one. Right-click the new-session control to choose a terminal or worktree session. In the compact shell, use the project's ellipsis button to open the [project actions sheet](#command-palette-and-compact-shell).

You must terminate a project's live sessions before removing the project. Removal deletes the project registration and all of its session records, then attempts to force-remove the recorded omp-ui worktree checkouts. Uncommitted changes in a removed checkout are lost, but its branch and commits survive. Removal does not delete transcripts, artifacts, or files in the registered project. A failed worktree cleanup does not stop record removal.

### Start, resume, and stop sessions

Use a project's plus button, the title-bar plus button, the command palette, `/new` in the native composer, or `Mod+Shift+N` to start a session in the app's Default session mode. The title-bar button and shortcut require a focused tab because they use that tab's project. `/new` opens a new live session in a new tab; it does not reset the current tab in place.

Choose **New terminal session** when you want OMP's TUI. Choose **New worktree session** when the work must run in a separate checkout. The [worktree sessions](#worktree-sessions) section explains its persistence and deletion rules.

Select a dormant or archived owned session to resume it. omp-ui restores an archived transcript before resuming. If an agent exits, use **Resume** in the sidebar or the session's exit screen. A session marked **missing** still has a record, but omp-ui cannot find its files, so its only available action is deletion.

**Terminate** and **Delete** have different effects:

- **Terminate agent** stops the owned process. The session record, transcript, artifacts, and worktree remain, so the session is resumable.
- **Delete session** stops a live agent, removes the record, and irreversibly erases the entire lineage from the active and archive roots. For a worktree session, deletion also attempts to force-remove its checkout; a worktree branch already in its base is deleted with the session, while an unmerged branch and its commits survive. Deleting a session that is the source of plan-implementation handoffs also deletes every session descended from it; the confirmation names them and their count before you confirm. With **Skip the delete confirmation** on, that family is erased at once unless one of its sessions runs in a worktree, which always asks.

Read the confirmation before deleting. Deleting one row may erase more than one transcript when OMP switched sessions inside that lineage. This cannot be undone.

## Native transcript workflow

The native transcript is derived from OMP's event stream. The session file remains the source of truth, and omp-ui does not rewrite it. The transcript renders user and assistant content, thinking, tool calls and results, advisor findings, notices, IRC activity, and lifecycle markers. A usage receipt under a completed assistant response starts with its requested model and, when OMP supplies it, names the routed upstream provider inline. It also shows tokens, cache reads, cost, time to first token, duration, and decode tokens/s (shown when both timings are present). Hover the receipt for the provider response ID when OMP supplies it. For `openrouter/auto`, OMP's event does not reveal the model OpenRouter selected, and omp-ui does not infer it. Scroll away from the bottom to pause following; return to the bottom or use **Jump to latest** to follow new output again.

### Use the Session HUD

The **Session HUD** runs across the top of a native tab. It shows liveness, a click-to-rename title, context use, total spend, and advisor context and cost when an advisor is active. A goal chip shows the session's OMP goal and its token use, and opens goal controls when clicked ([goal mode](#goal-mode)). A worktree chip names the effective branch. The controls let you compact context, toggle auto-compaction, open the console, export the transcript as HTML, open the Capabilities viewer, open the session tree ([rewinding and the session tree](#rewinding-and-the-session-tree)), branch the session, start a new session, refresh runtime state and statistics, and edit queue modes. A `fast` chip appears when OMP's fast mode is enabled or active; the modes popover and the compact session and prompt-options sheets carry the always-available fast-mode toggle. Fast mode asks OMP's provider for priority serving: when the provider declines it, the setting stays on and the control reads `on — provider declined` — one click retries the attempt. OMP's slow mode shows no chip: it is toggled with OMP's `/slow` command (omp 18.6.3 or newer, on models that support it). When your account is past its usage limit, a stage chip names the stage — `wrap-up` for the short allowance past the limit, `low-priority` for slow-lane serving — with the local reset time and remaining allowance in its tooltip; it disappears when the window resets and state refreshes.
While auto-compact is on, a notch in the context meter marks the token count where OMP auto-compacts — by default the window minus the larger of 15% of the window and the reserve — and hovering shows the exact value. The threshold is tunable in **Settings → omp → Context** via `compaction.thresholdPercent`, `compaction.thresholdTokens`, and `compaction.reserveTokens`; changing one moves the notch without restarting anything.

Manual compacting summarizes the current context. The transcript records it as a pair of markers: **compacting context** when the request goes out and **context compacted** when OMP confirms the new boundary. A large context can take minutes for that summary — the Session HUD reads *compacting* the whole time, and slow completions name their duration in the marker. If the Session HUD shows its command-timeout banner first, that is a budget notice, not a failure: the banner retires itself when OMP's confirmation lands. Auto-compaction lets OMP compact when the context window fills. Export writes an HTML transcript and adds a notice with the path. **Branch this session** copies the full transcript into a new lineage and opens it in a new tab; the source session and its process stay untouched.

The HUD's queue controls set separate policies for steering messages, follow-ups, and tool interruption. Steering and follow-ups can drain one at a time or all at once. Interruption can stop an in-flight tool immediately or wait for it to finish.

### Write in the composer

The composer controls what the next native turn receives:

- Pick the main model and thinking level next to the prompt. The thinking menu also offers `auto`: OMP then classifies each prompt with its judge model and runs the turn at the level that resolution picked. While `auto` is set the pill reads `auto`, the tooltip shows what the current turn resolved to, and the Session pane's thinking row reads `auto → level`. Changing the model keeps `auto`.
- When the current model has a priority-serving tier — including OpenRouter rows whose slug names an OpenAI (`openai/…`) or Gemini (`google/gemini…`) model ([#710](https://github.com/LankfordAI/omp-ui/issues/710)) — or the session already carries fast-mode state, a `fast` pill joins the composer's model/effort cluster ([#689](https://github.com/LankfordAI/omp-ui/issues/689)). Anthropic fast serving on OpenRouter is a separate `-fast` model slug — a pricier model switch, not this toggle — so the pill stays hidden on `anthropic/…` OpenRouter rows. In the prompt-options sheet the same toggle then sits beside model and effort; otherwise it stays in the sheet's session section as before. The Session HUD chip and modes popover are unchanged. A fast mode the provider declined still reads `on — provider declined` with one-click retry.
- Toggle the advisor, then choose its model and thinking level. Changing the advisor state, model, or thinking level restarts and resumes the session because OMP binds them at process startup. The session transcript remains intact.
- Switch between Build and Plan. This is an in-process change and keeps a half-written draft in place.
- Use the branch chip to inspect or switch local branches, pull a branch that is only behind its upstream, create a branch, or prepare a worktree before the first prompt.
- Add image **attachments** with the paperclip or by pasting an image. An image-only draft is valid. A text-only model shows a warning because OMP would drop the images.
- Dictate instead of typing with the microphone button (issue #647). Click, speak, click again — or wait for the 60-second cap — and the transcript lands at the caret of your draft, never sent: edit it and press Enter yourself. Escape while recording discards the take. Or hold `R` while focus is outside any text field or terminal to talk, release to transcribe; Escape or switching away discards the take (issue #707). Terminal (PTY) tabs are excluded — OMP's TUI keeps its own hold-Space. Enable the button under Settings → General → Voice input and choose the model under Dictation model; recordings are transcribed by that provider from the main process, so no key reaches the page.
- Type `@` to search files in the session's effective working tree. Pick a path to include it in the prompt. This also works for a steer or queued follow-up; omp-ui resolves the selected file content before sending those busy-session routes.
- Type one of OMP's magic keywords — `ultrathink`, `orchestrate`, `workflowz`, `jevify` — as a standalone word and the composer lights it with its own gradient: OMP will attach its hidden steering notice to the turn. The glow is honest — a word lights only when OMP will actually fire, i.e. its `magicKeywords.*` setting is on and the session has the tools it needs (`orchestrate`: `task`; `workflowz`: `task` and `eval`; `jevify`: `eval`). Toggling a tool in the Capabilities viewer updates the glow within about two seconds.
- Type `/` at the start of the draft to search OMP and omp-ui slash commands. The slash palette completes in two stages: while you type the command word it searches the whole roster; once the word is followed by a space, a command with subcommands — `/goal`, `/mcp`, `/todo`, `/compact`, `/memory`, and the rest OMP advertises — lists only those, filtered by what you type next. `Tab` or `Enter` accepts the selected row: a row that needs an argument completes the line and leaves the caret after it; any other row runs at once. Type an argument no subcommand matches and the palette steps aside so `Enter` runs the line as written. A slash-command line runs as a command, not as a prompt, and does not send attachments. omp-ui supplies `/new` and `/plan` as native actions, and runs the `/goal` family through OMP's native goal command rather than sending it as prompt text.
- While you type a word at the end of a native-session draft, omp may suggest the rest of it as dim ghost text. `Tab` takes it with a space (a following space or closing punctuation replaces that space), `→` takes it without one, and typing something else ignores it. omp learns from both. The engine follows omp's `spelling.autocomplete` setting; `off` disables it, and an omp older than 18.4.9 shows no ghost text.

A new native session gets an **auto-title** when its first substantive turn ends: omp-ui hands the naming to OMP's own `/rename`, which digests the conversation and proposes the name with the small model its config binds. Bare greetings and acknowledgements do not consume the title opportunity. When the session was seeded from an approved plan, the plan names it: the row reads the plan's title, never the implementation prompt that carried the plan. A session you already named — by hand or from a resumed listing — keeps that name.

**Re-titling** asks again what a session is about once its title has outgrown the work. Hover the Session HUD title for the retitle button, or run **Regenerate session title** in the command palette; either runs OMP's bare `/rename`, whose result row in the transcript reports what the engine decided. It needs a running session — a dormant or hibernated one answers with a notice; resume it first, then re-title. A title you typed by hand is never overwritten by the automatic path. Terminal tabs keep omp's own titles and offer no retitle action.

### Steer, queue, interrupt, and abort

When the agent is idle, `Enter` sends a new prompt. While it is running, `Enter` steers the current turn. Use `Mod+Enter` to queue a follow-up for the next clean turn, or `Mod+Shift+Enter` to abort the current turn and send the draft as a fresh prompt. `Escape` aborts a running agent without sending the draft; on OMP 18.6.3 or newer it also returns every queued message — steers and follow-ups, attachments included — to the composer draft, where you can edit and re-send them. Older runtimes abort plain.

The queue count covers all displayable queued work, not only user follow-ups. It can include steers, advisor cards, custom entries, and deferred items. After a user interrupt, follow-ups do not drain automatically; they remain **parked** until you send an explicit new prompt. The composer and Session pane label an idle non-empty queue `parked: N`.

On omp 18.4.6 or newer, clicking the queue chip lists the queued steering and follow-up messages. **Promote** moves a follow-up into steering: while the agent runs it is delivered at the next tool boundary, and while the agent is idle (including parked after an interrupt) it starts a turn right away. On omp 18.6.3 or newer every row also carries **edit**, which withdraws that one message from the queue and returns it to the draft — the turn keeps running. Advisor cards and deferred items are counted but not listed. In the compact shell the list sits in the prompt-options sheet.

### Rewinding and the session tree

Hover a prompt in a live native transcript and two chips appear under it: **rewind here** and **edit and resend** ([#680](https://github.com/LankfordAI/omp-ui/issues/680)). Rewinding returns the session to that prompt — the later turns stop being the current branch but stay in the session file as another branch, so nothing is deleted. **Edit and resend** rewinds and then puts the original prompt, with its images, back into the composer for you to change and send. The transcript reloads on the new branch and the session title stays. A rewind needs a live, idle native session: while a turn is running the affordances are disabled, because rewinding also clears the prompt queue. The confirmation names how many later turns leave the current branch; cancelling it moves nothing.

The **session tree** shows the whole shape of the lineage — every branch, including the ones earlier rewinds abandoned. Open it from the HUD's **tree** control or **Session tree** in the command palette. The current branch is marked, the live leaf is badged, and each row offers its jump: prompt rows rewind or edit-and-resend; any other row (an assistant turn, or an entry on an abandoned branch) moves the session's leaf there. Jumping to a non-prompt entry can optionally ask the model to summarize the turns you leave behind instead of just abandoning them — that option runs a model turn and takes longer. These surfaces are for native sessions; a terminal tab is omp's own TUI and omp-ui does not parse its screen.

A prompt row also offers **fork from here** on omp 18.4.11+ ([#717](https://github.com/LankfordAI/omp-ui/issues/717)): the tab moves to a new session file holding the transcript through that prompt (tool results included), the original file stays on disk unchanged, and the tab's sidebar row stays put. The button is hidden on older omp.

### Use the console

`Mod+J` opens a full-width login shell below the native composer and puts the cursor in it, so you can type right away; `Mod+J` closes it again even while the shell has focus. It runs in the session's effective working tree, including a worktree checkout. The shell starts from the environment omp-ui was launched with, without the AppImage's own variables, so commands behave as they do in a native terminal. Closing the console hides it without discarding its terminal instance. Terminal tabs do not have this separate console because the tab itself is already a terminal.

Type `!` at the start of a native composer draft to run a shell command through the session without spending a model turn: `!git status` executes immediately, its output lands in the transcript as its own row and in the model's context, and a non-zero exit shows on the row. While a command runs its row offers a **stop** control, which cancels every shell command running in that session. Commands run in the session's working tree; `cd` inside one command does not carry over to the next. The embedded TUI in terminal tabs keeps its own `!` handling, including cwd tracking.

To copy terminal output, select it with the mouse, right-click the selection, and choose **Copy**; terminal tabs offer the same menu. When a program captures the mouse, such as vim or OMP's TUI, hold `Shift` while dragging to select on Linux and Windows.

## Plan mode and review

**Build mode** allows working-tree writes and state-changing commands. **Plan mode** makes OMP explore read-only and answer in the same session. Plan mode does not require every response to produce a plan. A review begins only when your prompt asks for a plan and the agent submits a plan artifact.

Use the composer selector, `/plan`, or `Mod+Shift+P` to switch a native session between Build and Plan. OMP's own write guard enforces Plan mode. The switch happens in-process, so it does not respawn the session or clear your draft. The **Default agent mode** setting affects ordinary new native sessions only. It does not change live or resumed sessions, terminal tabs, or approved-plan implementation.

When a plan is proposed, the review docks in that session's view — the rest of the app stays usable — and you choose one response:

- **Execute** settles the proposal and dispatches implementation.
- **Refine** sends the planner back immediately. You can include revision notes and image attachments.
- **Not now** (or the review's close button) dismisses it without answering. The agent stays paused and the working tree stays read-only; the rest of the app remains usable, and the session's sidebar row keeps its "answer needed" state until the gate is answered.

Execution always begins in Build mode, regardless of the Default agent mode. Choose one of four implementation contexts:

1. **This session** sends the implementation prompt into the current session.
2. **This session, compacted** compacts the current context first, then implements there.
3. **Fresh session** opens a new session seeded with the plan.
4. **Worktree session** opens a new session seeded with the plan, running in a dedicated git worktree — a separate checkout on its own branch under omp-ui's app-data directory, leaving the project's working tree untouched. The branch name starts as an editable `<project>/…` mint — its first segment is the project's own slug, so a project called FeatherNote mints `feathernote/…` and is cut from the chosen base (default: the project checkout's current branch; the checkout's HEAD when it is detached), or from a new base branch *new branch…* creates from a chosen start point as part of the same operation (issue #405) — that branch becomes the session's recorded base, so diffs and merge-back target it rather than the trunk. A name no one has typed states its cut point — `<project>/<base>/<hash>` — and the mint keeps that hash for the whole life of the session (issue #428): the plan's generated name lands in the *new base* field only, and *new branch…* arrives prefilled with the plan's slug, then with the model's name; typed text is never overwritten. Offered on git projects only; the resulting session follows the usual [worktree session](#worktree-sessions) rules.

Before execution you can stage the model, thinking level, advisor, advisor model, git branch, and OMP's `ultrathink`, `orchestrate`, and `workflowz` magic keywords. A keyword switched off in OMP's `magicKeywords.*` settings shows as a disabled switch — OMP would ignore it anyway — and is never written into the implementation prompt. On a git project, keep the current branch, create and switch to a new one, or switch to an existing one; in the worktree session context, cut a new worktree branch instead, choosing the branch name and base. If another session in that project is mid-turn, omp-ui asks before switching to an existing branch. If Git rejects the checkout, the review stays pending and shows the error. Selected project branches are prepared before dispatch and passed to the implementer as fixed targets: implementation and commits stay on the branch shown in review. A plan authored in a worktree keeps that worktree for execution, preserving issue #316's checkout reuse; the review shows its branch as a locked target instead of offering an unrelated project-checkout switch. When an advisor reviewed the plan turn, **Address advisor concerns** folds those findings into the implementation prompt; this option starts on.

The Plans pane keeps the pending plan first and settled plans dimmed below it. **Review** restores the same gate, **Request changes** refines without notes, and **Not now** leaves the gate unanswered.

## Goal mode

A **goal** is an objective the session keeps working toward across turns until it
is met, dropped, or runs out of budget. Goals are OMP's own runtime feature: the
chip's status, token use, and elapsed time are OMP's accounting, and OMP starts
the continuation turns itself. Goal mode needs omp 18.4.11 or later; an older
omp answers every goal command with an update hint.

Type `/goal` in the composer, or click the goal chip in the Session HUD:

| Command | Effect |
|---|---|
| `/goal [--budget N] <objective>` | Sets the objective and starts working toward it. `--budget N` caps the goal's **total** tokens; at or over it, the goal becomes budget-limited and stops continuing. A budget is set only when the goal is created. |
| `/goal set [--budget N] <objective>` | Sets the objective, replacing an active goal. |
| `/goal`, `/goal show` | Objective, status, token accounting, and elapsed time. |
| `/goal pause` | Stops starting new turns; an in-progress turn may still finish. |
| `/goal resume` | Continues a paused goal. |
| `/goal drop` | Drops the goal immediately; a running turn finishes on its own. |
| `/guided-goal [rough objective]` | Enables OMP's goal tool and asks the agent to shape the objective with you before it creates the goal. |

The chip shows the goal's status with its token use, and dims when the goal is
paused or budget-limited. Click it for the objective, usage, elapsed time, and
**Pause** or **Resume** and **Drop** buttons. Drop takes two clicks: the first
turns it into **Confirm drop**, and closing the popover cancels. A goal that
ends — met, dropped, or exhausted — leaves no chip behind.

Automatic continuation follows OMP's `goal.continuationModes` setting: it is on
by default, and off if you removed `interactive` from that list. With it off, a
goal still tracks usage but OMP starts no further turns on its own.

While a goal is active, omp-ui keeps it to itself: an unfinished goal blocks
entering Plan mode until you drop it, and the advisor-reply and
stall-auto-continue prompts stand down, so nothing automatic restarts a goal you
paused or exhausted. The session's process also stays awake rather than
hibernating, because hibernation would kill the loop doing the work. A paused or
budget-limited goal applies neither veto.

OMP pauses a goal on its own when you abort a turn while the goal is working;
`/goal resume` or the chip's **Resume** continues it. A resumed session restores
an active goal as paused.

## Inspector rail

The **inspector rail** is the right-hand icon strip in a native tab. It has six panes. Selecting an icon opens one pane; selecting the active icon again closes it. The selected pane is remembered per tab, and badges show open todo, subagent, pending-plan, and answered side-question counts.

- **Todos** shows OMP's todo phases and task states for the focused session.
- **Agents** lists live and settled subagents. Select one to open the **subagent view** in the main transcript area. That read-only view backfills the subagent's own transcript and renders its thinking, tool cards, and usage receipts. Its banner names the agent and status and returns to the main agent. While the subagent runs, the banner and its Agents-pane row carry **steer** (send it a message as its user) and **kill** (abort it; its transcript stays readable); both need omp 18.4.9 or later. There is no composer: the subagent view is not a chat surface. The main session keeps running behind the view.
- **Session** opens with **Vault notes**, the Vault notes this session touched with a link to each note's card (see [Knowledge vault](#knowledge-vault)), then shows the session ID and file, model and thinking level, queue configuration, context, message and tool counts, token totals, cost, and premium requests. On compact screens, choosing a Vault notes row closes the sheet.
- **Side questions** holds your `/btw` exchanges: quick questions asked against this session's context that never enter the transcript or any later turn. Type `/btw <question>` in the composer (it opens the pane) or use the pane's ask box; bare `/btw` just opens the pane. Only one side question runs at a time — Cancel stops it. Select an answered topic to read it and ask a follow-up, which sees only that topic's earlier turns plus the session. Topics are stored as OMP's own `btw-history/` files beside the session, so they return after the session hibernates or resumes. Terminal tabs keep OMP's own `/btw` overlay and history.
- **Plans** shows proposed plans and the actions for a pending review.
- **Diffs** shows every tracked and untracked working-tree change on the effective git branch. This is a branch diff, not a per-session edit history, so it can include changes made outside the focused session. For a branch off the default branch, it also shows this branch's commits since the cut point, and the header chip names the base. On the default branch itself it shows commits you have not pushed yet, measured from the branch's upstream. The pane header shows the file count and total `+`/`−` lines, with **expand all** / **collapse all**. Each file card expands to every row with line numbers, syntax highlighting, and word-level marks inside changed lines; renamed files show `renamed` and the old path, and binary files show `binary`.

On compact screens, the inspector opens as a right-side sheet with the same five panes.

## Browser pane

The **browser pane** is a live web page inside a native tab that you and the agent share. Open it with the globe in the Session HUD or the *Toggle browser pane* palette action; it appears as a resizable split beside the transcript. Type an address (only `http` and `https` pages load) or ask the agent to open a page — it learns the pane's endpoint automatically and the pane opens on its own when the agent connects; a pane the agent opened closes on its own when the agent disconnects at the end of its work, and a pane you opened yourself stays open until you close it. Both of you can click, scroll, and type at any time; an **agent connected** badge shows while the agent holds the page and pulses while it acts. **Attach page to prompt** puts a screenshot of the current frame and the page URL into the composer for your next message. **Attach an element to the prompt** lets you click one element in the page and hands the composer a cropped screenshot plus a selector the agent can act on. Settings → Advanced → **Clear browser pane data** signs you out of every site you logged into inside the pane; open pages are closed and reopened at their last address. The fullscreen control gives the page the whole transcript column with the composer kept; on compact screens the pane is a bottom sheet. Closing the pane on any view closes it on every view of the session — and it only stops the stream: the page and the agent's connection stay until the session hibernates, is deleted, or switches to terminal mode. Remote-access browsers and joined instances see the same pane and can drive it; only the desktop window sets its size. The pane rasterizes at your screen's true pixel density (up to 2×), so text stays sharp on scaled or fractional-scaled displays; transcript zoom (Ctrl +/−) never rescales it, and an agent viewport override sent over the endpoint reverts about a quarter-second after the agent stops insisting — your resize always wins. Camera, microphone, location, notifications, and downloads are always refused inside the pane, and pages you open there are untrusted input to the agent, exactly like files it reads.

The agent doesn't reach for the pane first for everything: it prefers configured CLIs and APIs for structured service work and reserves the pane for rendered interaction, browser state, browser-only authentication, and pages you explicitly ask it to look at — no permission prompt appears either way, and you can always ask it to open a page.

## Knowledge vault

The **Knowledge vault** is where the agent files decisions, lessons, and write-ups that should outlive a session but do not belong in a repository: one or more Obsidian vaults you register on the **Knowledge vault** Settings page ([Settings](settings.md#knowledge-vault)). Registering a vault binds it: a native session started afterwards gets seven `omp-ui_vault_*` tools for the registered vaults; terminal sessions do not. omp-ui stays thin — it writes the notes, shows what it wrote, and hands each note to Obsidian, which remains the reader.

The agent may search, list, and read a whole vault, but it writes only inside each vault's **Home folder** (default `omp-ui/`) unless that vault allows writes outside it. A new project note lands under `omp-ui/<Owner>/<Repo>/<Title>.md`, named after the project's git remote, or under plain `omp-ui/<project>/` when the project has no remote. It starts with a **Provenance stamp** (frontmatter recording omp-ui, the project, the session, and the date) and is linked from the project's **Index note**. When the agent writes a note for a project, omp-ui moves the notes it created in that project's older `omp-ui/` folders into the new folder and fixes links that point to them by path. Notes omp-ui did not create stay where they are, as do notes whose name is already taken in the new folder and, when writes outside the Home folder are off, notes linked by path from outside it. The agent can also append to a note, and it can replace a note's body or add a wikilink to it after reading the note's current version. There is no delete or rename tool.

Each project has a **Knowledge home**: where the agent files the decisions, lessons, and write-ups it keeps for that project. Set it in **Project settings → Knowledge**. **Repo docs** keeps them in the repository's `docs/`. **Vault** writes Vault notes to a registered Obsidian vault. **Both** writes the full note in `docs/` plus a short vault note with its title, a one-line gist, and the repo path. With two or more vaults registered, pick a vault for the project or follow the Default write vault. **Clear** returns the project to the routing default. Routing then chooses repo docs when the folder is not a git repository, has no remote, or its remote's owner is an account the GitHub CLI is signed into on this computer, which is read offline from `hosts.yml`. Otherwise it chooses the Default write vault. Vault and Both need a registered vault (**Settings → Knowledge vault**). If the project's vault is removed, the tab says so, and the agent writes no vault notes until you pick another. When the home includes a vault, a native session is told so when it starts. Changes apply to sessions started afterwards.

Every vault create, append, edit, or link renders as its own card in the transcript, open by default: the note's title, a **Created**, **Appended**, or **Edited** chip (a link counts as an edit), the vault and note path, and what changed — the stamp and body of a new note, the appended text, or a line diff for an edit or link. A write into a note omp-ui did not create — one without a Provenance stamp — gets a copper border and a **Not created by omp-ui** chip. Searches, reads, and listings keep the ordinary tool card.

The inspector rail's **Session** pane opens with **Vault notes**: every note this session touched, once each, in the order first touched, with the latest action's chip. A create that updated the project's Index note lists the Index note too. Select a note's title to scroll the transcript to its card.

**Open in Obsidian** on a card or a Vault notes row opens the note in Obsidian on this computer. Where this app cannot open it — a session owned by a joined remote instance, or a browser client — the button copies the note's `obsidian://` link instead and reads **Link copied** for two seconds; paste the link on a machine that has the same vault. If the clipboard refuses, the card shows the link under its button so you can copy it by hand.

In a native tab, an assistant's explicit Markdown note link displays an underlined title. Click it, or focus it and press Enter or Space, to open the exact Markdown file in Obsidian on the owning desktop. Vault tools supply the registered vault name and full resolved path, so notes with the same title in different folders remain distinct. This reply guidance also reaches native sessions whose Knowledge home is Repo docs.

In a browser client, a joined-instance tab, or a tab whose owner cannot be resolved, activating the title copies a portable `obsidian://` link instead. The title stays unchanged; adjacent **Link copied** feedback lasts two seconds. If copying fails, a selectable URI appears beside the title for manual copying. Rendering or restoring a reply never opens a note.

Only explicit Markdown note links participate. Literal paths, `[[wikilinks]]`, bare Obsidian URI text, standalone unscoped Markdown, and sandboxed HTML plans do not become note actions. Vault note bodies and Index note entries still use Obsidian wikilinks; existing session files are not rewritten.

Ask the agent in any native session for a note of everything worked on today, and it writes one **Day write-up** into the vault: `omp-ui/<YYYY-MM-DD> Day Write-up.md`, stamped without a project and linked from no Index note. It lands in the project's vault, or in the Default write vault when the project names none. The agent builds it from omp-ui's own session records: the day's sessions across every project, each with its title, mode, branch, and the agent's last reply. Your messages are never passed to it. Ask again the same day and it replaces that note's body instead of writing a second note. Any native session can do this once a vault is registered, whatever the project's Knowledge home. Your own Obsidian daily notes are untouched.

Plan mode does not protect the vault: OMP's write guard covers the working tree, not omp-ui's host tools, so an agent in Plan mode can still write vault notes. Every vault tool runs at OMP's `exec` approval tier, so with **Tool approval** set to `write` or `always-ask` each vault call, reads included, asks for approval first. Subagents cannot call the vault tools, and a call the agent makes from inside its own eval kernel shows as that eval call; neither produces a vault card, and neither appears under Vault notes.

## Share a terminal session live

**Share live** hands one running **terminal session** to teammates as a live **Collab room** ([#686](https://github.com/LankfordAI/omp-ui/issues/686)): they watch the session as it runs from a link and, with a control link, steer it — prompt, interrupt, and answer its approvals. OMP hosts the room through its `/collab` command; omp-ui opens it, shows the links and the guest count, and retires them when the room ends. It is terminal-tab only: native sessions do not expose the command, and the dialog says so.

Open it from the command palette (**Share live**) on a terminal tab. Choose **full** or **view-only** and start sharing; omp types `/collab` into the session itself, and the share is confirmed when omp's registry shows the room. A full room publishes a **control link** (with a QR code) and a separate read-only **view-only link**; a view-only room publishes its one read-only link. While the room is up the tab carries a `live` chip, the dialog tracks guests and relay state, and **stop sharing** closes the room. `/new`, `/resume`, and a branch switch end the room and rotate the key, so links you handed out stop working — the intended revocation path, along with stop and closing the session.

The trust model matters before the first share: a link is secret material (the room key rides in its fragment, invisible to the relay), full-access guests drive a session that runs tools on this machine, and everything said while guests watch is visible to them. The dialog and [Live session sharing](collab-sharing.md) state this at every step.

## Worktree sessions

A **worktree session** runs OMP in a dedicated git worktree on its own branch. The checkout lives under omp-ui's app-data directory and shares the project's git object store. The registered project remains its project for sidebar grouping and remembered session parameters, but the worktree is its effective working tree — including for project-scope MCP configuration, which omp-ui resolves and writes through a `.omp` link in the checkout that points at the project's own directory.

Start one from **New worktree session**, choose a branch name and base, then create the session. The base names an existing branch (or the checkout's HEAD), or the trailing *new branch…* option creates it first (issue #405): omp-ui runs `git branch <name> <start point>`, cuts the session branch from it, and records it as the base — so diffs, *sync worktree*, and finish-time merge-back target the new branch, never the trunk it was cut from. A minted session branch names the project it belongs to and states its cut point: `<project>/<base>/<hash>` — the first segment is the project's own slug, so the omp-ui checkout mints `omp-ui/main/<hash>` and a project called FeatherNote mints `feathernote/main/<hash>`. The base defaults to the checkout's active branch; only a detached HEAD or a repository with no branches yields the two-segment `<project>/<hash>`. editing the base recomposes an untouched mint while keeping its hash. A session's minted branch is never renamed on its own; auto-naming lives at merge back, where the finish dialog prefills the keep-branch *rename* field and a *new branch…* destination's name from the session (issue #428). You can also create an ordinary native session, open the branch chip before its first prompt, choose **Worktree**, and send the first prompt. The plan review's worktree-session execution context produces worktree sessions too, seeded with the approved plan. omp-ui cuts the checkout before sending; if git rejects the operation, the draft and selection remain in place with the error.

The effective checkout controls the branch chip, `@` file picker, branch diff pane, console shell, and Capabilities viewer scope. Resume, advisor restart, native or terminal mode restart, and Build or Plan switches all keep the same checkout because its path is stored on the session record.

The worktree chip on the Session HUD offers a **merge-back** when the session has a recorded base; the branch chip menu offers the same action for the focused worktree session, and the delete confirmation offers it as a merge-first option. It merges the worktree branch into that base inside the project checkout, always as a merge commit — never a fast-forward — whose message lists the folded commits' subjects and repeats every `Fixes #N` reference they carry; the subject is the single folded commit's own subject, or `Merge work into <base> (N commits)` — never the worktree branch name, so the landing commit reads the same on every machine — and the base branch's history records that a worktree session landed. Only committed work on the branch is merged; uncommitted changes in the worktree are not included. The merge is local: nothing is fetched or pushed, so the referenced issues close when you push the base branch yourself. A successful merge-back **returns the session to that base branch**: its agent restarts in the project checkout with its transcript, tab, and lineage intact — the project checkout is already on the base branch, because the merge requires it — while the worktree checkout is removed (uncommitted changes there are lost) and the branch is deleted. Another session running in the same checkout — a fork, or a plan handoff that reused it — keeps the checkout and its branch alive until the last one leaves; both confirmations say so before you act. A conflicted merge stops both the merge and the return, leaving the session on its branch in its checkout and its files in the project checkout; resolve them there with `git merge --continue` (the generated merge message is already staged) or abort with `git merge --abort`. The action is disabled with a reason when it cannot run: the recorded base no longer resolves, no local branch matches it, the destination is not checked out in the project, the worktree branch was deleted, or a merge is already in progress. When the branch is already merged into the destination, the chips instead offer a **return to `<base>`** action, which performs the same return without a merge.

Deleting a worktree session first erases its lineage, then attempts to force-remove its checkout. If the checkout is removed, any uncommitted changes in it are lost. A worktree branch already in its base is deleted with the session; a branch that cannot be deleted — unmerged, its base no longer resolving, or git refusing the plain `git branch -d` — keeps the branch and its commits in the original git repository, with a warning logged. Checkout cleanup failure leaves the checkout on disk but does not stop deletion of the session record. If the checkout disappears outside omp-ui, resume fails instead of silently falling back to the project's main working tree.

## Capabilities viewer

The **Capabilities viewer** is one modal with three sections: **MCP servers** — the effective config OMP resolves for one fixed scope — and **Skills** and **Tools**, the rosters a live native session publishes through its capabilities bridge. Open it from the Session HUD's **Capabilities** control, the command palette's **View capabilities**, `/mcp` in the composer, or **Settings → omp**. Each tab shows a visible/total count; the search box filters the open category, weighing names above descriptions; per-category capsules narrow by configuration state, by listed or hidden skill, or by a tool's enabled state and origin; an effective MCP row's **N registered tools** action jumps to the Tools section filtered to that server; and a **details** disclosure reveals each row's path and provenance. An unavailable section says why; it is never rendered as an empty list.

The MCP section shows the servers OMP resolves for one fixed scope:

- Working-tree scope uses the session the viewer was opened from — its worktree checkout when it has one, otherwise its project root. The header names that directory and the session, and a worktree session's header also names its branch and the project the write lands in.
- Global scope shows user-level sources only and applies changes to new sessions in every project.

Each row shows the server name, transport, redacted endpoint, source, scope, effective state, and any shadowing or disabling source. Redaction happens before data reaches the renderer. Environment values, headers, auth, OAuth data, and raw connection errors are absent; HTTP and SSE URLs omit user information, query strings, and fragments.

During native-session startup, supported OMP versions report truthful live connection state. A failed server produces a warning notice in the derived transcript, a rose failure count on the Session HUD's Capabilities control, and an authentication- or connection-failed chip on the matching effective row. The signal belongs to that one live process: repeated snapshots do not duplicate the notice, and restarting clears the active badge and row state before the replacement process reports its result. A plugin-owned server that the config resolver does not enumerate can still contribute to the notice and HUD count; the viewer does not invent a config row for it.

A project-scoped toggle writes only project configuration or a project-only override. It never changes user-level state, with one forced exception: a row the user-level allowlist force-enables can only be turned off by clearing that pin, because OMP reads its override lists from the user file alone. When the server's global-scope definition lives in a file omp-ui may write, the toggle enables it there first so the pin becomes redundant and no other project loses the server; when that definition is tool-owned, omp-ui will not mutate another tool's config and the row's tooltip says the disable turns the server off everywhere. A server disabled at the user level is pinned off in project scope; change it in the global viewer instead. Global toggles use OMP's user-level write rules.

Changes affect the **next session spawn** in that scope. When you open the viewer from a live session, **Reload MCP in this session** applies them now: OMP disconnects its MCP servers, rediscovers them from the current config, and rebinds the session's tools without starting an agent turn. The process, transcript, lineage, and worktree all survive. On a native tab the reload waits for a running turn to finish; on a terminal tab the command is typed into that tab's OMP TUI. A worktree session resolves and writes project configuration through its checkout's `.omp` link, so a project-scoped change reaches it without living in the worktree's branch.

For a failed effective HTTP or SSE row in a live native session, choose **Authenticate**. The console drawer replaces its shell with OMP's real TUI, stages `/mcp reauth <server>`, and waits for you to press **Send**. Complete the provider's browser consent, return to the TUI, run `/quit`, then use **Restart session** in the handoff banner. The restart creates a fresh live omp process that can load the new credential; the `--no-session` authentication TUI creates no extra session or lineage. Stdio, shadowed, global-scope, terminal-tab, dormant, and hibernated rows do not receive this OAuth action.

OMP versions that do not emit `mcp:connection-status`, and sessions with OMP's own `startup.quiet` enabled, provide no truthful runtime status. omp-ui degrades silently instead of parsing command prose or presenting configured servers as connected.

The viewer stays pinned to what it was opened from; moving focus elsewhere does not retarget it. If the pinned session's working tree moves — a merge-back that returns the session to its base checkout does exactly that — the viewer keeps the config rows it captured and detaches the live rosters and session commands, with a banner explaining why, until you close and reopen it. While the viewer is open on a live native session, the bridge samples that session roughly every two seconds, so snapshots update by themselves; **refresh** re-reads the config from disk and asks the session for a fresh snapshot. Refresh never runs `/mcp reload` and never sends a prompt to the model — reload and authentication stay explicit clicked actions, and browsing the viewer starts no agent turn.

Skills and Tools describe the loaded roster of the selected live native session, not a machine-wide catalog. Skills lists what that session loaded — including skills hidden from its model listing, which carry a **hidden** chip — and reports whether skill slash commands are enabled in the session; skill files the session did not load are not represented, and loaded means the roster includes a skill, not that any turn invoked it. Tools lists every tool the session registered, enabled or not, with truthful access facts: **Direct** where the model can call it, plus **xd://** and **Eval** chips where those bridges reach the tool. Other sessions' tools and skills are not shown, and a listed or enabled tool is not a permission — Plan mode and approvals still gate its use.

Tools rows are also controls. Each registered tool row whose enabled state OMP reports carries the same switch the MCP rows use. One click changes that one tool's enabled membership in that live session at runtime: it writes no configuration, restarts nothing, and starts no agent turn. The switch follows the state OMP publishes in the session's next snapshot rather than an optimistic guess, so a refused or unconfirmed toggle leaves the row on what the session reports. Changes apply to this live session only. Restarting the session or switching to another session resets tool selection, and an OMP settings change or **Reload MCP in this session** may change it again. Coverage stays runtime-only: a registered tool may be disabled here, while a tool the session never registered is not listed and cannot be installed from the viewer.

A toggle is rejected rather than queued while the session is busy — a running turn, a queued prompt, an abort, an unresolved human-answer request, a session lifecycle operation, or another tool toggle still settling. A prompt you send immediately after an accepted toggle waits for that toggle. Disabling `write` is refused while Plan mode is on: the row says `write` is required to write plan artifacts while Plan mode is on, entering Plan adds it only when you had it off, and exiting removes only that borrowed addition, so every other selection you made during Plan survives. Note that current OMP runtimes keep `write` enabled no matter what any session asks — a Build-mode attempt to disable it reports that the runtime retained it, and there is nothing for Plan to borrow. The switch controls enabled membership only: **Direct**, **xd://**, and **Eval** remain independent observed facts, and changing membership can legitimately re-partition which paths reach a tool, which the viewer then reports as OMP confirmed it. MCP tools can be toggled individually without touching server configuration or connection state; `/mcp reload` or an OMP settings change may re-enable a server's tools, which stays the MCP manager's contract. An older bridge whose snapshots predate tool control still lists the roster but shows no switches.

### Advisor roster

omp can run several advisors from a `WATCHDOG.yml` (global in `~/.omp/agent`,
project at the repository root). Click the `adv` readout in the Session HUD to
see each advisor's status, model, tools, context, and spend. **Edit roster…**
opens the project settings **Advisors** tab, where you can edit the Project or
Global file. Entries without a model follow the advisor model from the composer;
the composer's advisor switch turns every entry off. Saved changes apply when a
session restarts (the panel offers a **Restart** button); comments in the file
are not preserved, and files with syntax errors or unknown keys are read-only.

For provider and other app configuration, see [Settings](settings.md).

## Command palette and compact shell

Press `Mod+K` to open the command palette. Search is fuzzy across sessions, projects, and actions. Use it to focus a non-missing owned session, start a session in a named project, add a project, terminate the focused agent, switch the focused session to native or terminal mode, run **View capabilities** — MCP servers, skills, tools for the focused session's working tree — open **Session tree** for the focused native session ([rewinding and the session tree](#rewinding-and-the-session-tree)), **Share live** a terminal session ([live sharing](#share-a-terminal-session-live)), check app or OMP updates, or open Settings. `Down` and `Ctrl+N` select the next result; `Up` and `Ctrl+P` select the previous result. Selection wraps at either end. Press `Enter` to run the selected action or `Escape` to close the palette.

Below 900 pixels, omp-ui uses the **compact shell**. The top-left control opens projects and sessions, the title opens the same sheet, and the top-right inspector control opens the inspector sheet for a native tab. Native session actions move into a bottom sheet. The prompt's model, effort, advisor, mode, branch, queue, and interrupt controls move into the prompt-options sheet.

Each compact project header has an ellipsis button that opens the **project actions sheet**. It shows the project's name and full path, followed by **New session**, **New terminal session**, **New worktree session**, **Project settings**, and **Remove project**. Desktop-only actions that open VS Code, the host file manager, or a system terminal do not appear in the compact shell.

For connecting a phone or another browser to the compact shell, see [Remote access](remote-access.md).

## Shortcuts

**Mod** means `Command` on macOS and `Ctrl` on Linux and Windows.

### App shortcuts

| Shortcut | Action |
| --- | --- |
| `Mod+K` | Open the command palette. |
| `Mod+Shift+N` | Start a session in the Default session mode in the focused tab's project. Does nothing without a focused tab. |
| `Mod+Shift+P` | Switch the focused native session between Build and Plan in-process. |
| `Mod+J` | Show or hide the focused native session's console. |
| `Mod+=` or `Mod+Shift+=` | Increase native transcript text size. |
| `Mod+-` | Decrease native transcript text size. |
| `Mod+0` | Reset native transcript text size. |
| `Mod+,` | Open Settings. |
| `Alt+Up` / `Alt+Down` | Move a focused project header or session row when desktop reordering is available (session rows move their whole handoff tree). |

### Composer shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send when idle; steer when running; run a slash command on a command line. |
| `Shift+Enter` | Insert a line break. |
| `Mod+Enter` | Queue a follow-up after the current turn. |
| `Mod+Shift+Enter` | Abort the current turn and send the draft as a fresh prompt. |
| `Escape` | Abort a running agent; queued messages return to the draft on OMP 18.6.3 or newer. When a slash or `@` picker is open, close that picker first. |
| `Up` / `Down` | Recall sent composer text when the draft is empty, or navigate an open slash or `@` picker. |
| `Tab` | Accept the selected row of an open slash or `@` picker. |

In the plan review's revision box, `Enter` sends the refinement and `Shift+Enter` inserts a line break.

See [Troubleshooting](troubleshooting.md) when a session cannot resume, a worktree is missing, MCP changes do not appear, or a native session reports a process failure.

## Related guides

- [Documentation home](README.md)
- [Getting started](getting-started.md)
- [Settings](settings.md)
- [Remote access](remote-access.md)
- [Live session sharing](collab-sharing.md)
- [Troubleshooting](troubleshooting.md)
