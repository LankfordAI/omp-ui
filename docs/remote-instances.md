# Remote instances

A remote instance is another omp-ui app that this app has joined as a client. Its projects and sessions appear in this app's sidebar under a nickname you choose, and everything you do to them runs on that other app. Joining grants this app full control of the other app's sessions and files, so treat every connection URL and credential as full access to that host.

[Documentation home](README.md)

## Join a remote instance

The other app must have [remote access](remote-access.md) enabled and be reachable from this computer.

1. On the other app, open **Settings > Remote access**, turn on **Enable remote access**, and copy either the connection URL (password sign-in) or the token link.
2. On this app, open **Settings > Remote instances**.
3. Paste the URL into **Connection URL**. The URL must be `http://` or `https://` and may carry a port. A token link (`…/?t=TOKEN`) is accepted as-is: omp-ui takes the token from it and hides the password field.
4. Optionally enter a **Nickname**. Leave it empty to use the URL's host, for example `192.168.1.20:7432`. Nicknames are trimmed, are 1 to 32 characters, and must be unique among joined instances without regard to case.
5. If the URL did not carry a token, enter the other app's **Password** or paste its **Access token**.
6. Choose **Join**.

omp-ui signs in once, keeps the credential the sign-in derives, and connects. A rejected password, an unreachable address, a duplicate nickname, or a URL that cannot be parsed shows inline on the form and stores nothing.

## What the sidebar shows

Each joined instance is a collapsible group after the local projects, headed by its nickname, a status dot, and the connection URL. The group holds that instance's registered projects and their owned sessions, with activity read from the host's own turn and human-answer state: a native row shows *working* while a turn runs on that host and *answer needed* while a plan gate or a blocking dialog waits on a person, whether or not this app has the tab open, and a terminal row still reads *live* because a PTY carries no turn signal. A project may share its absolute path with a local project; the two are separate groups.

Opening a remote session opens a tab in this window that renders the other app's own stream — terminal bytes for a terminal session, the native transcript for a native session. The tab's label, the title bar, and the Session HUD carry the nickname in front of the session title, and the HUD shows a quiet nickname chip whose hover reveals the URL.

The group header offers **Register project on \<nickname\>** while the instance is joined, **Reconnect** while it is not, and a shortcut to the Remote instances settings page.

Once at least one instance is joined, the filter area above the list gains a host picker ([#507](https://github.com/LankfordAI/omp-ui/issues/507)) that defaults to **All hosts** — the whole stack exactly as described above. Choosing a host, or **This computer**, narrows the *list* only: hidden hosts stay joined, their sessions keep running and streaming in any open tab, and their signals still count in the footer's live and session totals. While one host is selected, a quiet rose dot on the picker means some hidden instance needs attention — unreachable, signed out, or incompatible. The search box ignores the picker: a query always spans this app's projects and every joined host, and clearing it restores the scoped view.

## What crosses and what does not

Registry and session lifecycle actions run on the remote instance: registering, removing, and reordering projects; new, resume, terminate, restart, hibernate, fork, move, and delete; mode switches; model and advisor changes; worktree sessions and branch actions; plan review; the capabilities viewer and its MCP, skills, and tool controls; the console shell; typing, resizing, and pasting images. Model choices follow the remote the same way: a remote session's model palette lists the models that host's session reports, its Favorites are that instance's own — a star you toggle there applies to every view of that instance, in this app and in its own window — and its project's default-model pins and advisor defaults are read and written on that host. Hibernation policy also follows the remote's viewed-tab rule, so a remote session you are looking at is exempt on that host just as a local one is here.

The browser pane crosses too. A remote session's pane streams its frames through this app and takes your clicks, typing, and navigation exactly as its terminal does; from this app's desktop window it also takes its size. The agent that drives that pane runs on the remote instance and reaches the page through an endpoint that exists only on that host — this app is never given that endpoint. While the instance is unreachable the pane keeps its last frame under the banner and holds your input; on rejoin it resubscribes and redraws.

The knowledge vault follows the session's owner. Vault tools run only on the instance that owns the session, the same app whose `HostBridge` answers the agent's other host calls, so a vault note is written to, and opened from, the machine where the vault lives. A joined app's Project settings show that project's knowledge home and let you change it on the owner, listing the owner's vault names but never their folders, and the "Vault notes" section of a remote session lists the same notes the transcript's vault cards show, since those cards arrive with the transcript itself. "Open in Obsidian" on a remote session copies the note's `obsidian://` link instead of opening Obsidian: pasted on a machine that has the same vault, the link opens the note there, by folder name, even when that copy of the vault lives at a different path.

Nothing is copied and no second omp process starts. Closing the tab hides it; the session keeps running on the remote instance. Quitting this app disconnects from every remote instance and leaves their sessions running, exactly as closing a browser view of that app would.
Deleting a host-owned session from a joined client removes that session's tab from every connected renderer when the host broadcasts its new state. Removing a registered project does the same for each session record removed by the cascade.

Host-local actions stay on their own host. Opening a project or file in VS Code, Files, or a terminal is not offered for a remote target, file paths in a remote transcript render as plain text, and the remote's own app preferences, updates, providers, remote-access settings, and diagnostics are never reachable from this app. Providers are no exception: a remote session whose host reports no models shows a note naming the instance instead of opening this app's Providers page — provider credentials live on that host, so configure them by opening Providers on the instance itself. Remote sessions raise no desktop notifications here.

The relation is directed. Joining B from A gives B no view of A, and a join never follows the remote's own joins: only the remote's own projects appear, never the instances it has joined itself. Joining this app's own connection URL is reported as *this app* and adds no group.

A browser connected to this app through remote access sees the joined instances too and can act on them, because the join belongs to this app's backend rather than to one window.

## Disconnect and rejoin

When the connection drops — the remote quits, the network fails, or its embedded server restarts after a settings change — the group stays in the sidebar with status *unreachable*, its projects dimmed. Open tabs stay mounted with a banner naming the instance and input disabled; keystrokes to a remote terminal are held back rather than lost into a dead socket. omp-ui retries with a growing delay from 1 second up to 30 seconds and keeps trying until the instance answers, you remove it, or you quit.

On rejoin, every open remote tab reloads its state from the remote: native tabs re-hydrate their transcript and terminal tabs redraw at their current size. A tab whose session no longer exists on the remote is removed. **Reconnect**, on the group header or the settings page, retries immediately from any status.

## Fleet

The fleet is this app plus every joined instance, seen as places new work can start ([ADR-0061](adr/0061-fleet-dispatch-rides-the-spawn-request.md)). Like the sidebar, it is one level deep: an instance's own joins are never part of this app's fleet. Open the **Fleet** view from the sidebar button beside the host picker or from the command palette. It lists each machine — **This computer** first, then each instance by nickname — with its status, omp-ui version, CPU and free memory, live sessions and running turns, and its placement preference. Both apps need an omp-ui version that has Fleet: an instance running an older one is listed as unsupported, with a note to update omp-ui on it, and is never chosen for work.

### Dispatch work

**Dispatch** opens the Fleet face of the **New session dialog**, the one form that starts work here or on the fleet; on this face it starts fresh native sessions with a prompt you write, on one machine or several at once:

- **Project** — a project registered on a ready machine. Machines are matched by repository (the checkout's `host/owner/repo` web remote), never by path, so the same repository at different paths on two machines counts as the same work. A project with no web remote can only run on its own machine.
- **Run on** — **Auto** with a number of copies (1 to 8, one per machine), or **Choose machines**, ticking machines that have the same repository and setting copies per machine.
- **Workspace** — **New worktree** (the default; each copy gets its own branch) or **Project checkout**, available only for a single copy per machine.
- **Mode** — Build (the default) or Plan.
- **Title** (optional) — empty uses the prompt's first line.
- **Prompt** — required.

The dialog's local face (**This computer**) starts a session on this app, optionally sending a first prompt — which may be left empty for an idle session — once the session is ready. When the chosen machines are on different commits, the form says so; each worktree starts from its own machine's checkout, and the dispatch is not blocked. Every dispatched session is a native session in that machine's sidebar, owned and run by that machine exactly like one you started there yourself; nothing moves or copies afterwards. The machine that owns the session sends the prompt itself, so once it has accepted the dispatch, closing this app or losing the connection does not lose the prompt. The session HUD shows *Dispatched from \<computer\>*, marked *agent* when an agent dispatched it, and the Fleet view groups the dispatches made together, newest first, with **Open** and **Stop** on each.

### Placement preferences

Each machine has a placement preference: **Prefer**, **Normal** (the default), **Less often**, or **Manual only**. Auto placement scores each machine that has the repository and a ready model provider by its preference weight × its CPU cores × its idle CPU share × its free-memory share, and picks the best distinct machines. A machine whose report is older than 15 seconds, whose CPU is at 95% or above, or whose free memory is 5% or less is skipped, and **Manual only** is never chosen automatically while staying available under **Choose machines**. A preference is a weight, not a share of the work. If fewer machines qualify than copies asked for, nothing starts and omp-ui says how many machines can take the work. Preferences are kept on this app; removing an instance forgets its preference.

### Unknown outcomes

If the connection to an instance drops while it is answering a dispatch, or it does not answer in time, this app cannot know whether the session started. That dispatch is listed under **Unresolved** as *outcome unknown* until a session with that dispatch appears in the instance's sidebar group after it reconnects, or until you dismiss it. omp-ui never retries on its own. **Retry** sends the same dispatch again; it is safe because the instance recognizes the dispatch and returns the session it already started instead of starting a second one. After this app restarts, the prompt is no longer held, so an unresolved row offers only **Dismiss**.

### Let agents dispatch fleet work

**Settings > Remote instances > Let agents dispatch fleet work** (off by default) gives agents three tools: list the fleet's machines, dispatch work, and check on a dispatch's sessions — their state and, once one stops working, its summary. The tools reach only sessions started or resumed after the setting is on, and every call runs at omp's `exec` host-tool approval tier, so your omp approval mode decides whether it asks first. A session an agent dispatched never gets the tools, so dispatched work cannot dispatch further. A session that a joined instance owns uses that instance's own setting and fleet: its tools list and dispatch from the instance's point of view, not this app's.

## Credentials, storage, and revocation

omp-ui stores the credential the sign-in derived — a password-derived credential or the access token — never the password itself. The credential is encrypted through the operating system credential store and written to `remote-instances.json` beside `registry.json`, readable only by your user. It never reaches a renderer, and the diagnostic bundle never reads the file. If the operating system has no secure credential store, omp-ui refuses to join rather than write the credential insecurely.

Revocation happens on the remote. Changing or clearing its password invalidates a password-derived credential; regenerating its access token invalidates a token credential. Either way this app's next connection attempt is rejected, the instance shows *sign-in required*, and omp-ui stops retrying until you choose **Edit** on the settings page and enter the new password or token. A stored credential that can no longer be decrypted — for example after the operating system keychain changed — is reported the same way.

**Remove** on the settings page forgets the connection and its credential and drops the group and its tabs from this app. The remote instance's sessions keep running.

## Trust

A joined instance grants this app, and every browser connected to this app, the same authority the remote's own desktop window has: reading and editing files, starting sessions, and running commands on that host. Join only instances you control, prefer HTTPS or a private network between them, and keep both embedded listeners off the public internet, as the [remote access](remote-access.md) guide describes.

## Related guides

- [Remote access](remote-access.md) configures the embedded server a remote instance joins.
- [Settings](settings.md) documents the Remote instances page and the rest of the Settings surface.
- [User guide](user-guide.md) explains the session controls shared by local and remote sessions.
- [Troubleshooting](troubleshooting.md) covers connection and authentication failures.
