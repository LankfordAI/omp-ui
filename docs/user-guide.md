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

Use **Add project** in the title bar or sidebar, choose a directory, and add the resolved path. The sidebar groups owned sessions under each project. Sessions keep their position until you move them: new sessions enter at their project's top, and running activity never reshuffles the list. Drag a session row's grip, or focus it and press `Alt+Up` or `Alt+Down`, to reorder; a plan-handoff tree moves with its planning row. Filter by session title or project name, collapse a project, drag project headers to reorder them, or focus a header's grip and press `Alt+Up` or `Alt+Down`.

On a desktop-sized window, a project header exposes open, MCP, new-session, and remove actions. The Open control's menu offers **VS Code** (when installed), **Files**, and **Terminal** (when a launchable system terminal is found); Terminal opens the host's terminal with its shell in the project root. Right-click the new-session control to choose a terminal or worktree session. In the compact shell, use the project's ellipsis button to open the [project actions sheet](#command-palette-and-compact-shell).

You must terminate a project's live sessions before removing the project. Removal deletes the project registration and all of its session records, then attempts to force-remove the recorded omp-ui worktree checkouts. Uncommitted changes in a removed checkout are lost, but its branch and commits survive. Removal does not delete transcripts, artifacts, or files in the registered project. A failed worktree cleanup does not stop record removal.

### Start, resume, and stop sessions

Use a project's plus button, the title-bar plus button, the command palette, `/new` in the native composer, or `Mod+Shift+N` to start a session in the app's Default session mode. The title-bar button and shortcut require a focused tab because they use that tab's project. `/new` opens a new live session in a new tab; it does not reset the current tab in place.

Choose **New terminal session** when you want OMP's TUI. Choose **New worktree session** when the work must run in a separate checkout. The [worktree sessions](#worktree-sessions) section explains its persistence and deletion rules.

Select a dormant or archived owned session to resume it. omp-ui restores an archived transcript before resuming. If an agent exits, use **Resume** in the sidebar or the session's exit screen. A session marked **missing** still has a record, but omp-ui cannot find its files, so its only available action is deletion.

**Terminate** and **Delete** have different effects:

- **Terminate agent** stops the owned process. The session record, transcript, artifacts, and worktree remain, so the session is resumable.
- **Delete session** stops a live agent, removes the record, and irreversibly erases the entire lineage from the active and archive roots. For a worktree session, deletion also attempts to force-remove its checkout; a worktree branch already in its base is deleted with the session, while an unmerged branch and its commits survive. Deleting a session that is the source of plan-implementation handoffs also deletes every session descended from it; the confirmation names them and their count before you confirm.

Read the confirmation before deleting. Deleting one row may erase more than one transcript when OMP switched sessions inside that lineage. This cannot be undone.

## Native transcript workflow

The native transcript is derived from OMP's event stream. The session file remains the source of truth, and omp-ui does not rewrite it. The transcript renders user and assistant content, thinking, tool calls and results, advisor findings, notices, IRC activity, and lifecycle markers. A usage receipt under a completed assistant response shows its model, tokens, cache reads, cost, time to first token, and duration. Scroll away from the bottom to pause following; return to the bottom or use **Jump to latest** to follow new output again.

### Use the Session HUD

The **Session HUD** runs across the top of a native tab. It shows liveness, a click-to-rename title, context use, total spend, and advisor context and cost when an advisor is active. A worktree chip names the effective branch. The controls let you compact context, toggle auto-compaction, open the console, export the transcript as HTML, open the MCP manager, branch the session, start a new session, refresh runtime state and statistics, and edit queue modes.
While auto-compact is on, a notch in the context meter marks the token count where OMP auto-compacts — by default the window minus the larger of 15% of the window and the reserve — and hovering shows the exact value. The threshold is tunable in **Settings → omp → Context** via `compaction.thresholdPercent`, `compaction.thresholdTokens`, and `compaction.reserveTokens`; changing one moves the notch without restarting anything.

Manual compacting summarizes the current context. Auto-compaction lets OMP compact when the context window fills. Export writes an HTML transcript and adds a notice with the path. **Branch this session** copies the full transcript into a new lineage and opens it in a new tab; the source session and its process stay untouched.

The HUD's queue controls set separate policies for steering messages, follow-ups, and tool interruption. Steering and follow-ups can drain one at a time or all at once. Interruption can stop an in-flight tool immediately or wait for it to finish.

### Write in the composer

The composer controls what the next native turn receives:

- Pick the main model and thinking level next to the prompt.
- Toggle the advisor, then choose its model and thinking level. Changing the advisor state, model, or thinking level restarts and resumes the session because OMP binds them at process startup. The session transcript remains intact.
- Switch between Build and Plan. This is an in-process change and keeps a half-written draft in place.
- Use the branch chip to inspect or switch local branches, pull a branch that is only behind its upstream, create a branch, or prepare a worktree before the first prompt.
- Add image **attachments** with the paperclip or by pasting an image. An image-only draft is valid. A text-only model shows a warning because OMP would drop the images.
- Type `@` to search files in the session's effective working tree. Pick a path to include it in the prompt. This also works for a steer or queued follow-up; omp-ui resolves the selected file content before sending those busy-session routes.
- Type `/` at the start of the draft to search OMP and omp-ui slash commands. A slash-command line runs as a command, not as a prompt, and does not send attachments. omp-ui supplies `/new` and `/plan` as native actions.

A new native session gets an **auto-title** from its first substantive prompt. Bare greetings and acknowledgements do not consume the title opportunity. omp-ui asks OMP's configured small model first, then derives a short title from the prompt if that model is unavailable or declines.

### Steer, queue, interrupt, and abort

When the agent is idle, `Enter` sends a new prompt. While it is running, `Enter` steers the current turn. Use `Mod+Enter` to queue a follow-up for the next clean turn, or `Mod+Shift+Enter` to abort the current turn and send the draft as a fresh prompt. `Escape` aborts a running agent without sending the draft.

The queue count covers all displayable queued work, not only user follow-ups. It can include steers, advisor cards, custom entries, and deferred items. After a user interrupt, follow-ups do not drain automatically; they remain **parked** until you send an explicit new prompt. The composer and Session pane label an idle non-empty queue `parked: N`.

### Use the console

`Mod+J` opens a full-width login shell below the native composer. It runs in the session's effective working tree, including a worktree checkout. Closing the console hides it without discarding its terminal instance. Terminal tabs do not have this separate console because the tab itself is already a terminal.

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
4. **Worktree session** opens a new session seeded with the plan, running in a dedicated git worktree — a separate checkout on its own branch under omp-ui's app-data directory, leaving the project's working tree untouched. The branch name mints to an editable `omp-ui/…` name and is cut from the chosen base (default: the project checkout's current branch; the checkout's HEAD when it is detached). Offered on git projects only; the resulting session follows the usual [worktree session](#worktree-sessions) rules.

Before execution you can stage the model, thinking level, advisor, advisor model, git branch, and OMP's `ultrathink`, `orchestrate`, and `workflowz` magic keywords. On a git project, keep the current branch, create and switch to a new one, or switch to an existing one; in the worktree session context, cut a new worktree branch instead, choosing the branch name and base. If another session in that project is mid-turn, omp-ui asks before switching to an existing branch. If Git rejects the checkout, the review stays pending and shows the error. When an advisor reviewed the plan turn, **Address advisor concerns** folds those findings into the implementation prompt; this option starts on.

The Plans pane keeps the pending plan first and settled plans dimmed below it. **Review** restores the same gate, **Request changes** refines without notes, and **Not now** leaves the gate unanswered.

## Inspector rail

The **inspector rail** is the right-hand icon strip in a native tab. It has five panes. Selecting an icon opens one pane; selecting the active icon again closes it. The selected pane is remembered per tab, and badges show open todo, subagent, and pending-plan counts.

- **Todos** shows OMP's todo phases and task states for the focused session.
- **Agents** lists live and settled subagents. Select one to open the **subagent view** in the main transcript area. That read-only view backfills the subagent's own transcript and renders its thinking, tool cards, and usage receipts. Its banner names the agent and status and returns to the main agent. There is no composer because a subagent cannot be prompted or steered. The main session keeps running behind the view.
- **Session** shows the session ID and file, model and thinking level, queue configuration, context, message and tool counts, token totals, cost, and premium requests.
- **Plans** shows proposed plans and the actions for a pending review.
- **Diffs** shows every tracked and untracked working-tree change on the effective git branch. This is a branch diff, not a per-session edit history, so it can include changes made outside the focused session.

On compact screens, the inspector opens as a right-side sheet with the same five panes.

## Worktree sessions

A **worktree session** runs OMP in a dedicated git worktree on its own branch. The checkout lives under omp-ui's app-data directory and shares the project's git object store. The registered project remains its project for sidebar grouping, MCP scope, and remembered session parameters, but the worktree is its effective working tree.

Start one from **New worktree session**, choose a branch name and base ref, then create the session. You can also create an ordinary native session, open the branch chip before its first prompt, choose **Worktree**, and send the first prompt. The plan review's worktree-session execution context produces worktree sessions too, seeded with the approved plan. omp-ui cuts the checkout before sending; if git rejects the operation, the draft and selection remain in place with the error.

The effective checkout controls the branch chip, `@` file picker, branch diff pane, and console shell. Resume, advisor or MCP restart, native or terminal mode restart, and Build or Plan switches all keep the same checkout because its path is stored on the session record.

The worktree chip on the Session HUD offers a **merge-back** when the session has a recorded base; the branch chip menu offers the same action for the focused worktree session, and the delete confirmation offers it as a merge-first option. It merges the worktree branch into that base inside the project checkout — fast-forward when history allows, otherwise a merge commit. Only committed work on the branch is merged; uncommitted changes in the worktree are not included. Merge-back is terminal: the confirmation says a successful merge closes the worktree, and the merge and the close then run as one operation — the session is deleted, the checkout is removed, and the branch is deleted from the project. A conflicted merge stops both the merge and the close, leaving the worktree open and its files in the project checkout; resolve them there with `git merge --continue`, or abort with `git merge --abort`. The action is disabled with a reason when it cannot run: the recorded base no longer resolves, no local branch matches it, the destination is not checked out in the project, the worktree branch was deleted, or a merge is already in progress. When the branch is already merged into the destination, the chips instead offer a **close the worktree** action, which performs the same deletion without a merge.

Deleting a worktree session first erases its lineage, then attempts to force-remove its checkout. If the checkout is removed, any uncommitted changes in it are lost. A worktree branch already in its base is deleted with the session; a branch that cannot be deleted — unmerged, its base no longer resolving, or git refusing the plain `git branch -d` — keeps the branch and its commits in the original git repository, with a warning logged. Checkout cleanup failure leaves the checkout on disk but does not stop deletion of the session record. If the checkout disappears outside omp-ui, resume fails instead of silently falling back to the project's main working tree.

## MCP manager

The **MCP manager** shows the effective MCP servers that OMP resolves for one fixed scope:

- Project scope uses the focused session's project or the project whose MCP action you opened.
- Global scope shows user-level sources only and applies changes to new sessions in every project.

Each row shows the server name, transport, redacted endpoint, source, scope, effective state, and any shadowing or disabling source. Redaction happens before data reaches the renderer. Environment values, headers, auth, OAuth data, and raw connection errors are absent; HTTP and SSE URLs omit user information, query strings, and fragments.

During native-session startup, supported OMP versions report truthful live connection state. A failed server produces a warning notice in the derived transcript, a rose failure count on the Session HUD's MCP control, and an authentication- or connection-failed chip on the matching effective manager row. The signal belongs to that one live process: repeated snapshots do not duplicate the notice, and restarting clears the active badge and row state before the replacement process reports its result. A plugin-owned server that the config resolver does not enumerate can still contribute to the notice and HUD count; the manager does not invent a config row for it.

A project-scoped toggle writes only project configuration or a project-only override. It never changes user-level state. A server disabled at the user level may therefore be pinned off in project scope; change it in the global manager instead. Global toggles use OMP's user-level write rules.

Changes affect the **next session spawn** in that scope. They do not reconfigure a running process because OMP has no MCP runtime command or config watcher. When you open the manager from a live session, **Restart session to apply** kills and resumes that same session in place with the new MCP configuration. The transcript, lineage, and worktree remain. A project-scoped change reaches a worktree session only when that config change exists in the worktree's branch.

For a failed effective HTTP or SSE row in a live native session, choose **Authenticate**. The console drawer replaces its shell with OMP's real TUI, stages `/mcp reauth <server>`, and waits for you to press **Send**. Complete the provider's browser consent, return to the TUI, run `/quit`, then use **Restart session** in the handoff banner. The restart creates a fresh live MCP manager that can load the new credential; the `--no-session` authentication TUI creates no extra session or lineage. Stdio, shadowed, global-manager, terminal-tab, dormant, and hibernated rows do not receive this OAuth action.

OMP versions that do not emit `mcp:connection-status`, and sessions with OMP's own `startup.quiet` enabled, provide no truthful runtime status. omp-ui degrades silently instead of parsing command prose or presenting configured servers as connected.

For provider and other app configuration, see [Settings](settings.md).

## Command palette and compact shell

Press `Mod+K` to open the command palette. Search is fuzzy across sessions, projects, and actions. Use it to focus a non-missing owned session, start a session in a named project, add a project, terminate the focused agent, switch the focused session to native or terminal mode, open its MCP manager, check app or OMP updates, or open Settings. `Down` and `Ctrl+N` select the next result; `Up` and `Ctrl+P` select the previous result. Selection wraps at either end. Press `Enter` to run the selected action or `Escape` to close the palette.

Below 900 pixels, omp-ui uses the **compact shell**. The top-left control opens projects and sessions, the title opens the same sheet, and the top-right inspector control opens the inspector sheet for a native tab. Native session actions move into a bottom sheet. The prompt's model, effort, advisor, mode, branch, queue, and interrupt controls move into the prompt-options sheet.

Each compact project header has an ellipsis button that opens the **project actions sheet**. It shows the project's name and full path, followed by **New session**, **New terminal session**, **New worktree session**, **MCP servers**, and **Remove project**. Desktop-only actions that open VS Code, the host file manager, or a system terminal do not appear in the compact shell.

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
| `Escape` | Abort a running agent. When a slash or `@` picker is open, close that picker first. |
| `Up` / `Down` | Recall sent composer text when the draft is empty, or navigate an open slash or `@` picker. |

In the plan review's revision box, `Enter` sends the refinement and `Shift+Enter` inserts a line break.

See [Troubleshooting](troubleshooting.md) when a session cannot resume, a worktree is missing, MCP changes do not appear, or a native session reports a process failure.

## Related guides

- [Documentation home](README.md)
- [Getting started](getting-started.md)
- [Settings](settings.md)
- [Remote access](remote-access.md)
- [Troubleshooting](troubleshooting.md)
