# Remote instances

A remote instance is another omp-ui app that this app has joined as a client. Its sessions appear in this app's sidebar labelled with a nickname you choose, its projects appear in the project quick-open, and everything you do to them runs on that other app. Joining grants this app full control of the other app's sessions and files, so treat every connection URL and credential as full access to that host.

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

A joined instance's sessions sit in the same sidebar list as this app's own ([ADR-0067](adr/0067-sidebar-lists-sessions-not-projects.md)): its live sessions among the running ones, newest activity first, and the rest under **Settled**. A session stays pinned to the instance that owns it; its row names that machine as a quiet chip with the nickname. Activity is read from the host's own turn and human-answer state: a native row shows *working* while a turn runs on that host and *answer needed* while a plan gate or a blocking dialog waits on a person, whether or not this app has the tab open, and a terminal row still reads *live* because a PTY carries no turn signal. The search box matches machine names too.

The instance's projects appear in the project quick-open (**New session** in the sidebar header), merged into a unified project view keyed on repository identity ([ADR-0063](adr/0063-unified-project-view-keys-on-repository-identity.md)): one row per repository key (the checkout's `host/owner/repo` web remote, the same key Fleet placement matches machines on), whichever machine each checkout lives on. A merged row's subline names every machine holding a checkout, this computer first. To start on another machine, open a session from the row and pick that machine from the composer's machine chip before sending the first prompt ([#936](https://github.com/LankfordAI/omp-ui/issues/936)); the session moves there with its draft, and a machine whose instance is not connected is listed but disabled. A checkout with no web remote has no key and never merges — it stays its own row on the instance where it is registered, even when a checkout on another machine shares its path. To register a project on a joined instance, choose its **Register project on \<nickname\>** row at the bottom of the quick-open.

Opening a remote session opens a tab in this window that renders the other app's own stream — terminal bytes for a terminal session, the native transcript for a native session. The tab's label, the title bar, and the Session HUD carry the nickname in front of the session title, and the HUD shows a quiet nickname chip whose hover reveals the URL.

## What crosses and what does not

Registry and session lifecycle actions run on the remote instance: registering and removing projects; new, resume, terminate, restart, hibernate, fork, and delete; mode switches; model and advisor changes; worktree sessions and branch actions; plan review; the capabilities viewer and its MCP, skills, and tool controls; the console shell; typing, resizing, and pasting images. Model choices follow the remote the same way: a remote session's model palette lists the models that host's session reports, its Favorites are that instance's own — a star you toggle there applies to every view of that instance, in this app and in its own window — and its project's default-model pins and advisor defaults are read and written on that host. Hibernation policy also follows the remote's viewed-tab rule, so a remote session you are looking at is exempt on that host just as a local one is here.

The browser pane crosses too. A remote session's pane streams its frames through this app and takes your clicks, typing, and navigation exactly as its terminal does; from this app's desktop window it also takes its size. The agent that drives that pane runs on the remote instance and reaches the page through an endpoint that exists only on that host — this app is never given that endpoint. While the instance is unreachable the pane keeps its last frame under the banner and holds your input; on rejoin it resubscribes and redraws.

Live voice works on a remote native session too ([#968](https://github.com/LankfordAI/omp-ui/issues/968)). The call's microphone and speakers are this computer's: the call's audio connection runs from this app's window, and only its setup and talk/stop commands cross to the remote instance, which keeps the session and stores the spoken turns with it. Closing or reloading this window ends its call.

The knowledge vault follows the session's owner. Vault tools run only on the instance that owns the session, the same app whose `HostBridge` answers the agent's other host calls, so a vault note is written to, and opened from, the machine where the vault lives. A joined app's Project settings show that project's knowledge home and let you change it on the owner, listing the owner's vault names but never their folders, and the "Vault notes" section of a remote session lists the same notes the transcript's vault cards show, since those cards arrive with the transcript itself. "Open in Obsidian" on a remote session copies the note's `obsidian://` link instead of opening Obsidian: pasted on a machine that has the same vault, the link opens the note there, by folder name, even when that copy of the vault lives at a different path.

Nothing is copied and no second omp process starts. Closing the tab hides it; the session keeps running on the remote instance. Quitting this app disconnects from every remote instance and leaves their sessions running, exactly as closing a browser view of that app would.
Deleting a host-owned session from a joined client removes that session's tab from every connected renderer when the host broadcasts its new state. Removing a registered project does the same for each session record removed by the cascade.

Host-local actions stay on their own host. Opening a project or file in Files or a terminal is not offered for a remote target, file paths in a remote transcript render as plain text, and the remote's own app preferences, updates, providers, remote-access settings, and diagnostics are never reachable from this app. VS Code is the one exception, and it opens on this computer rather than on the host: see [Open a remote checkout in VS Code](#open-a-remote-checkout-in-vs-code). Providers are no exception: a remote session whose host reports no models shows a note naming the instance instead of opening this app's Providers page — provider credentials live on that host, so configure them by opening Providers on the instance itself, or copy this computer's keys there with [Roll out Provider keys](#roll-out-provider-keys). Remote sessions raise no desktop notifications here.

The relation is directed. Joining B from A gives B no view of A, and a join never follows the remote's own joins: only the remote's own projects and sessions appear, never the instances it has joined itself. Joining this app's own connection URL is reported as *this app* and adds nothing.

A browser connected to this app through remote access sees the joined instances too and can act on them, because the join belongs to this app's backend rather than to one window.

## Disconnect and rejoin

When the connection drops — the remote quits, the network fails, or its embedded server restarts after a settings change — the instance's sessions stay in the sidebar list, dimmed and without a context menu, and the sidebar footer shows an **N unreachable** chip that opens **Settings > Remote instances**. Open tabs stay mounted with a banner naming the instance and input disabled; keystrokes to a remote terminal are held back rather than lost into a dead socket. omp-ui retries with a growing delay from 1 second up to 30 seconds and keeps trying until the instance answers, you remove it, or you quit.

On rejoin, every open remote tab reloads its state from the remote: native tabs re-hydrate their transcript and terminal tabs redraw at their current size. A tab whose session no longer exists on the remote is removed. **Reconnect**, on the instance's panel in **Settings > Remote instances**, retries immediately from any status. While an instance is joined, the same panel's **Refresh state** re-reads its session list now, for when a row looks stale.

## Fleet

The fleet is this app plus every joined instance, seen as places new work can start ([ADR-0061](adr/0061-fleet-dispatch-rides-the-spawn-request.md)). Like the sidebar, it is one level deep: an instance's own joins are never part of this app's fleet. Open the **Fleet** view from the **Fleet** button in the sidebar footer, shown while at least one remote instance is saved, or from the command palette. It lists each machine — **This computer** first, then each instance by nickname — with its status, its omp-ui and omp version chips ([Update a member's versions](#update-a-members-versions)), CPU and free memory, live sessions and running turns, its placement preference, its address with the SSH target and whether SSH answered, and its operating system (hover it for the package managers found there). Both apps need an omp-ui version that has Fleet: an instance running an older one is listed as unsupported, with a note to update omp-ui on it, and is never chosen for work.

### Access rungs

Every member decides for itself how far each dispatcher may go, on a ladder of five rungs ([ADR-0062](adr/0062-fleet-exec-runs-one-command-on-the-owners-shell.md), [ADR-0084](adr/0084-fleet-terminal-is-a-leased-pty-above-full-control.md)): **Observe** (read the machine's report), **Dispatch** (start sessions and send follow-ups to them with `omp-ui_fleet_send`, and clean up an already-landed worktree session with `omp-ui_fleet_finish` — what joining already grants, and the default for every instance with no explicit grant), **Manage projects** (clone a repository into a folder you declared under **Fleet project roots**, or register an existing checkout there), **Full control** (run one bounded command on that machine's shell — see [Fleet exec](#fleet-exec)), and **Terminal** (open an interactive shell on that machine from the Fleet view — see [Open a terminal on a member](#open-a-terminal-on-a-member)). Each rung includes the ones below it. **Fleet exec ceiling** caps what any dispatcher may hold on this machine (default Dispatch, which keeps every rung above it unreachable). On the member, **Settings > Remote instances > Fleet access** lists every dispatcher that has reached it under **Dispatchers on this computer**, where you set or reset each one's rung directly. From the dispatching app, **Request access** on a joined instance asks that member for Manage projects, Full control, or Terminal; it requires re-typing the member's password or access token, and the member checks it against its own credential and ceiling before granting. The **Fleet** view shows each ready member's effective rung.

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

If the connection to an instance drops while it is answering a dispatch, or it does not answer in time, this app cannot know whether the session started. That dispatch is listed under **Unresolved** as *outcome unknown* until a session with that dispatch appears among the instance's sessions after it reconnects, or until you dismiss it. omp-ui never retries on its own. **Retry** sends the same dispatch again; it is safe because the instance recognizes the dispatch and returns the session it already started instead of starting a second one. After this app restarts, the prompt is no longer held, so an unresolved row offers only **Dismiss**.

### Let agents dispatch fleet work

**Settings > Remote instances > Let agents dispatch fleet work** (off by default) gives agents nine tools: list the fleet's machines (each ready member carries its effective access rung, and each ready row prints a `versions:` line and a `favorites:` line), dispatch work — to joined members or to this computer's own projects, in Build mode or, with `planMode`, in read-only Plan mode, on a chosen `model` and `thinkingLevel` (by default the machine's first runnable favorite); a dispatch that names no machine and asks for one session starts on this computer whenever it has the project with a ready model provider and is not **Manual only**, and is placed automatically otherwise —, check on a dispatch's sessions — their state and, once one stops working, its summary, optionally waiting up to 45 s (`waitMs`) for a working session to change state — run one command on a member ([fleet exec](#fleet-exec)), check on or cancel a detached exec it started (`omp-ui_fleet_exec_poll`), manage projects on a member (**clone** or **register**, see [access rungs](#access-rungs)), ask a member to update its own omp or omp-ui versions ([`omp-ui_fleet_update`](#update-a-members-versions)), and send a follow-up message — queued or as a steer — to a session it dispatched (`omp-ui_fleet_send`), and clean up a dispatched worktree session whose work already landed on its base — settle it, remove its worktree, and delete its fully merged branches, refusing anything unlanded, dirty, working, or waiting on you (`omp-ui_fleet_finish`). When a dispatched session finishes its first run, a **Fleet result** with its summary appears in the session that dispatched it and starts a turn there, so the agent need not poll; a dispatched session waiting on you posts a Fleet notice instead, and you still answer it yourself ([ADR-0069](adr/0069-fleet-results-wake-the-dispatching-session.md)). A **Chat** always has these tools, whatever the setting says; the setting decides only for project sessions. The tools reach only sessions started or resumed after the setting is on, and every call runs at omp's `exec` host-tool approval tier, so your omp approval mode decides whether it asks first. A session an agent dispatched never gets the tools, so dispatched work cannot dispatch further. A session that a joined instance owns uses that instance's own setting and fleet: its tools list and dispatch from the instance's point of view, not this app's. Wherever the member's ladder says no, exec, project, and update calls answer with the refusal as plain text — which rung was missing and why — instead of an error, so the agent does not retry.

### Fleet exec

**Full control**, the fourth rung of the [access rungs](#access-rungs), lets a dispatcher ask a member to run one command on its own shell. The member picks the interpreter (`/bin/sh -c` on POSIX, PowerShell on Windows, falling back to `cmd`), waits for the command to exit, and answers with the exit code plus stdout and stderr — each capped at 65,536 bytes, a long-running command killed (with its whole process tree) after 30 seconds and answered with partial output. There is no stdin, no PTY, and no streaming; this is not a remote terminal, and a member never execs on itself — an agent's own tools serve its own machine. Nothing runs unless the member's owner opened every gate: **Settings > Remote instances > Allow fleet exec** (the master switch, off by default), a **Fleet exec ceiling** of Full control or higher, and a Full control (or higher) grant to that dispatcher — which re-presents the instance's credential. Every accepted or refused command, project manage, and grant raise is written to `fleet-audit.log` beside the other main-process logs and shown under **Activity** in the **Fleet** view on that machine, so each member can answer what ran there while its owner was away.

A command that needs longer than 30 seconds, such as a package install or a toolchain build, runs as a **detached exec** ([#905](https://github.com/LankfordAI/omp-ui/issues/905), [ADR-0065](adr/0065-machine-upkeep-rides-detached-exec-and-member-sealed-keys.md)). The agent sets `detach` on `omp-ui_fleet_exec`; the member starts the command under the same shell and gates, answers at once with an exec id, and lets it run for up to 30 minutes (the agent may ask for less, never more). The agent then calls `omp-ui_fleet_exec_poll`, which waits up to 25 seconds for the command to finish and answers with its state, exit code, and output: the last 4 KiB of each stream while it runs, the last 64 KiB once it has finished. Earlier output is dropped and the answer says so. Only the app that started a detached exec can poll or cancel it. A member runs at most 4 detached execs at once and refuses a fifth. The member kills the process and its whole tree when the 30 minutes run out, when the agent cancels it, when omp-ui on the member quits, or when the owner withdraws access by turning **Allow fleet exec** off or lowering the ceiling or that dispatcher's grant below Full control. A withdrawn command reads *revoked*, and its final output stays pollable. Activity on the member lists each detached start, refusal, and finish; polls are not listed. If omp-ui on the member crashes rather than quits, a running detached command is left behind and runs to its own end with no cap.

### Open a terminal on a member

You can open an interactive shell on a member without leaving omp-ui — to watch `btop`, follow a log, or work there as you would over ssh ([#991](https://github.com/LankfordAI/omp-ui/issues/991), [ADR-0084](adr/0084-fleet-terminal-is-a-leased-pty-above-full-control.md)). It works from a browser connected through remote access too, including a phone.

1. On the member, turn on **Settings > Remote instances > Allow fleet exec**, set **Fleet exec ceiling** to **Terminal**, and grant this app **Terminal** under **Dispatchers on this computer** — or ask for it from this app with **Request access**, re-typing the member's password or access token. Nothing below Terminal opens a shell: **Full control** runs one bounded command and never an interactive one.
2. In the **Fleet** view, choose **Terminal** on the member's row. The button stays disabled until this app's grant on that member reads Terminal.

The terminal takes the main pane in place of the tabs and runs the member user's login shell in their home directory. **Back to Fleet** hides it and keeps it running; the Fleet view lists it under **Terminals**, where **Show** brings it back. **Close terminal** ends the shell. Nothing is written on the member and no shell outlives the terminal: the member also ends it when the shell exits, when this app quits, when it has heard nothing from this app for 45 seconds (a lost connection or a crash), or when its owner withdraws access by turning **Allow fleet exec** off or lowering the ceiling or this app's grant below Terminal. A member runs at most 8 fleet terminals at once.

While the member is not connected, the terminal says so and drops your keystrokes; output the member writes during the outage is not kept. Activity on the member lists each terminal opened or refused and each one that ended, with why; what you type and what the shell prints are never logged. An agent can never open a fleet terminal.

### Provision a member over SSH

An agent can set a member up for a repository it has never seen — ask it something like *"provision studio with github.com/acme/app"* ([#904](https://github.com/LankfordAI/omp-ui/issues/904)). The agent reads the member's `ssh:` line from `omp-ui_fleet_machines` — the login user and address (`user@address`), whether port 22 answered, the member's platform, and its declared project roots — then connects with its own `ssh -o BatchMode=yes user@address`, runs `git clone` into one of those project roots, runs the repository's own setup there, and registers the checkout with `omp-ui_fleet_project`. The registered project shows up in the project quick-open with its repository key, so dispatch and placement can use it right away.

omp-ui never opens the SSH connection, stores or syncs a key, or runs setup itself; it only reports the target ([ADR-0064](adr/0064-sessions-provision-members-over-their-own-ssh.md)). Before you ask, set up the member:

- **Your key on the member.** This computer's SSH public key must be in the member's `~/.ssh/authorized_keys`. On Windows, an account in the Administrators group reads `C:\ProgramData\ssh\administrators_authorized_keys` instead.
- **The member's host key on this computer.** Agents connect with `BatchMode`, which never answers a host-key prompt, so `ssh` to the member once by hand to put its host key in `known_hosts`.
- **Git credentials on the member.** The clone runs on the member as its login user, with whatever git credentials that machine already has; nothing is forwarded from this computer.
- **An SSH server on the member.** Linux: `sshd` running. macOS: **System Settings › General › Sharing › Remote Login**. Windows: **Settings › System › Optional features › OpenSSH Server**, then start the `sshd` service; its default shell is `cmd`.
- **A project root and the Manage projects rung.** The member declares at least one folder under **Fleet project roots** and grants this app **Manage projects** (its **Fleet exec ceiling** at least Manage projects), as [access rungs](#access-rungs) describes, and **Let agents dispatch fleet work** is on here.

The reachability check is only a TCP connect to port 22 from this computer. A member whose SSH server listens on another port shows *closed*; give it a `Host` entry with that `Port` in `~/.ssh/config` so the agent's `ssh` still reaches it. A member that is not connected shows only its address.

### Open a remote checkout in VS Code

You can open the code a remote session works on in VS Code on this computer, connected to the member over Remote-SSH ([#995](https://github.com/LankfordAI/omp-ui/issues/995), [ADR-0083](adr/0083-remote-checkouts-open-in-local-vs-code-over-the-users-ssh.md)). Turn on **Settings › Remote instances › Open remote projects in VS Code over SSH** (off by default). Then **Open in VS Code** appears on a remote project's page in the project quick-open and in a remote session's title menu, which opens that session's worktree checkout when it has one. VS Code opens a new window on `ssh-remote+<user>@<address>` at that path.

The row is enabled only when the member sent its host report and port 22 answered this computer; otherwise it stays disabled and says why, for example *SSH port 22 did not answer on studio.tailnet*. It is hidden when this computer has no VS Code, and in the compact shell.

omp-ui opens no SSH connection and holds no key: VS Code's **Remote - SSH** extension connects with your own `~/.ssh/config` and ssh agent, exactly as a connection you start by hand, and installs VS Code Server on the member under that account. So the member needs your key in its `authorized_keys` and an SSH server, as for [provisioning](#provision-a-member-over-ssh). A missing Remote - SSH extension, an unknown host key, or a failed login is reported by VS Code in its own window. A member reached on another port or through a jump host needs a matching `Host` entry in your `~/.ssh/config`; the port-22 check still decides whether the row is enabled.

omp-ui opens only paths the member itself reported for a project, session, or worktree. The address is always the host of the URL you joined the member at; the login user is the one the member reports, and omp-ui refuses a host or user with characters ssh or a URL could misread.

### Copy a project to a member

You can copy one of this computer's projects onto a member yourself, without an agent ([#992](https://github.com/LankfordAI/omp-ui/issues/992), [ADR-0076](adr/0076-project-copy-clones-on-the-member-and-carries-gitignored-files.md)). The member must declare at least one folder under **Fleet project roots** and grant this app **Manage projects**, as [access rungs](#access-rungs) describes.

1. Open the project quick-open (`Mod+Shift+N`), drill into the project's page (→ or the row's actions button), and choose **Copy project to…**. The action shows for this computer's own checkouts while at least one remote instance is joined.
2. Pick the member. A member that is not connected, lacks Manage projects, or declares no project roots is listed but cannot be picked, with the reason.
3. Optionally turn on **Also copy gitignored files** (off by default). The dialog lists this checkout's gitignored files, each ticked, with its size; untick any you want to keep here. Under **Not copied** it names what it left out and why: files over 1 MB, anything past 8 MB or 500 files in total, symlinks, ignored folders with more than 50 files (such as `node_modules` or a virtualenv), and any file that names a [Provider key](settings.md#providers) variable such as `OPENROUTER_API_KEY`. Provider keys move only by [Roll out Provider keys](#roll-out-provider-keys).
4. Choose **Continue**, read the confirmation, and choose **Copy project**.

The member clones the repository's remote over HTTPS into the first of its project roots that has no folder with the repository's name, and registers it, so it appears in the project quick-open with its repository key. Then this computer sends the files you ticked, and the member writes them into the new checkout readable only by its user. A file never replaces one the clone already has. The notice names the new path and how many files were written; a file that could not be written is reported by name with the reason.

The member clones with no credentials of its own. A private repository, or one this checkout reaches only over SSH, fails to clone, and the dialog and the error say to ask an agent to [provision the member over SSH](#provision-a-member-over-ssh) instead. A checkout with no web remote cannot be copied this way at all.

Files travel over the join connection like Provider keys: encrypted over an `https://` join, in plaintext over `http://`, and the confirmation says which before anything is sent. File contents never reach a renderer, a log, or the audit line; Activity on the member shows one *manage* entry for the clone and one for the files written.

### Machine upkeep

An agent can install software and set up toolchains on a member that grants this app Full control ([#905](https://github.com/LankfordAI/omp-ui/issues/905)). Each member reports its operating system and the package managers found on it. `omp-ui_fleet_machines` prints them on a `system:` line under the member's `ssh:` line:

```text
  system: Fedora Linux 44 (Workstation Edition); package managers: dnf, flatpak, brew at /home/linuxbrew/.linuxbrew/bin/brew
```

A manager that is installed but missing from the PATH omp-ui runs commands with is listed with its absolute path, so the agent can call it by that path. The Fleet view shows the operating system as a chip on the machine row, with the package managers in its tooltip. A member running an older omp-ui reports neither: the line reads *not reported* and the chip is hidden.

Ask in plain words, for example *"install ripgrep on studio"* or *"create a Python 3.12 virtualenv in ~/venvs/ml on studio"*. The agent picks the package manager from the system line, writes the command, and runs anything longer than 30 seconds as a [detached exec](#fleet-exec) that it polls until it finishes. omp-ui has no install commands of its own; the agent composes each one.

Commands get no stdin, so anything that prompts fails or waits until its cap. Agents use non-interactive flags: `dnf -y`, `apt-get -y`, `zypper -n`, `pacman --noconfirm`, `brew` with `NONINTERACTIVE=1`, `winget --accept-source-agreements --accept-package-agreements --disable-interactivity`, `choco -y`.

Privileges are for the member's owner to set up. omp-ui never asks for, stores, or sends a password.

- **Linux.** System packages need root. The agent runs `sudo -n`, which fails at once unless the member's owner has allowed passwordless sudo for the user omp-ui runs as. A `sudoers` rule limited to the package manager is enough.
- **macOS.** Homebrew refuses to run as root, so `brew` installs as the member's login user without sudo.
- **Windows.** `winget` installs user-scope packages without elevation. Machine-scope installers and Chocolatey need administrator rights, which a command has only when omp-ui itself runs elevated on the member.

Anything interactive, such as a password prompt, an installer wizard, or a license screen, belongs on SSH: connect to the member yourself, as [Provision a member over SSH](#provision-a-member-over-ssh) describes.

### Roll out Provider keys

You can copy this computer's [Provider keys](settings.md#providers) to a member, so its sessions see the same models ([#905](https://github.com/LankfordAI/omp-ui/issues/905), [ADR-0065](adr/0065-machine-upkeep-rides-detached-exec-and-member-sealed-keys.md)). The member must grant this app Full control: on the member, **Allow fleet exec** on, a **Fleet exec ceiling** of Full control, and a full grant to this app.

1. Open the **Fleet** view and choose **Roll out keys** on the member's row. The button stays disabled until this app's grant on that member reads Full control.
2. The dialog lists the keys this computer has stored in-app, inherited from its environment, or captured from your login shell, each ticked. Untick any you want to keep off the member. A key set here only in a project `.env` is not offered.
3. Choose **Continue**, read the confirmation, and choose **Roll out keys**.

The member stores each key in its own OS credential store, replacing any stored key with the same name. The notice says how many keys were stored. A key the member could not store, for example on a Linux member with no keyring, is reported by name with the reason. Sessions already running on the member keep their old keys until you restart them.

Keys travel over the join connection. Over an `https://` join they are encrypted in transit. Over `http://` they cross the network in plaintext, and the confirmation says so before anything is sent; prefer HTTPS or a private network, as [Trust](#trust) advises.

Key values never reach a renderer, an agent, a log, or the audit line. Activity on the member shows a *Provider keys* entry naming which keys were installed or failed. Agents have no tool for this; only you can start a rollout.

### Update a member's versions

Each machine row carries chips for what it runs ([#905](https://github.com/LankfordAI/omp-ui/issues/905), [ADR-0066](adr/0066-fleet-members-update-themselves.md)): an **omp-ui** chip with its version, and an **omp** chip whose hover names the install path and says *pinned* when `OMP_UI_OMP_PATH` pins the binary. A member whose omp sits below the version this app requires badges *below the floor*; one with an omp-ui update downloaded badges *update staged*, and one with a newer release published badges *update available*.

**Update versions…** on a member's row asks that member to update itself — its managed omp binary, its own omp-ui install, or both ([ADR-0066](adr/0066-fleet-members-update-themselves.md)). Nothing ships from this computer: the dialog sends an instruction, and the member downloads from its own network through its own verified updater — core's omp installer (which runs `omp --version` on the downloaded binary before replacing anything) or electron-updater for the app. The button needs the same gates as fleet exec: this app holds **Full control** on the member, and on the member **Allow fleet exec** is on with its **Fleet exec ceiling** at Full control, as [access rungs](#access-rungs) describes. An agent can start the same maintenance with `omp-ui_fleet_update`.

- **omp updates land when the job finishes.** The member verifies and swaps the binary in its managed path; sessions already running there keep the binary they spawned with until their next spawn, exactly as on [this computer's Updates page](settings.md#omp-binary). A binary pinned with `OMP_UI_OMP_PATH` refuses until the pin is cleared or installed into the managed path.
- **omp-ui updates are staged, never forced.** A fleet request NEVER restarts a member — quitting would kill every session running there — so the job stages the update and arms *Install at next quit*: the staged version applies on the member's next normal app exit. Apply it sooner yourself on the member's Updates page (**Restart now**). While live sessions run, the member refuses to arm unless you say otherwise; the refusal names the session count.
- **Package formats.** Only packages that can apply their own update — AppImage, the Windows installer, the macOS zip builds — stage an app update over the fleet. A member installed as a deb, rpm, or flatpak package answers with its package manager pointer (*update it with its package manager*), and a member whose install omp-ui cannot identify says to update it manually. No member gets a half-applied foreign package.
- **One job at a time.** While an update runs on the member, a second request refuses until the first finishes; a job that runs past 10 minutes is settled failed. The member's Activity log keeps the finished records.
- **A member too old to answer has to be updated by hand once.** An omp-ui older than this feature has no update handler, and refuses with *\<name\> runs an omp-ui without fleet updates; update omp-ui there*. Update that machine once as its guide describes — the same route [Provision a member over SSH](#provision-a-member-over-ssh) uses, or its own Updates page — and from then on it maintains itself.

**Update all**, at the top of the Machines section, runs the same update on every member at once ([#990](https://github.com/LankfordAI/omp-ui/issues/990)): after one confirmation, each member this app holds Full control on installs the newest omp binary and then stages its omp-ui update, armed to install at that member's next quit. Accepting the confirmation is the *Install when I quit* choice for members with live sessions, which keep running until that machine quits. A progress row per member shows the step in flight and each step's outcome — *current*, updated, skipped, or failed, with the member's own reason on hover. Members that are unreachable or below Full control are skipped without being asked; a member whose **Allow fleet exec** is off refuses the first check and is listed as skipped with that reason. A pinned omp or a package-manager install shows only that step as skipped. One run goes at a time, and this computer is never part of it: its own update stays on **Settings → Updates**.

## Credentials, storage, and revocation

omp-ui stores the credential the sign-in derived — a password-derived credential or the access token — never the password itself. The credential is encrypted through the operating system credential store and written to `remote-instances.json` beside `registry.json`, readable only by your user. It never reaches a renderer, and the diagnostic bundle never reads the file. If the operating system has no secure credential store, omp-ui refuses to join rather than write the credential insecurely.

Revocation happens on the remote. Changing or clearing its password invalidates a password-derived credential; regenerating its access token invalidates a token credential. Either way this app's next connection attempt is rejected, the instance shows *sign-in required*, and omp-ui stops retrying until you choose **Edit** on the settings page and enter the new password or token. A stored credential that can no longer be decrypted — for example after the operating system keychain changed — is reported the same way.

**Remove** on the settings page forgets the connection and its credential and drops that instance's sessions and tabs from this app. The remote instance's sessions keep running.

## Trust

A joined instance grants this app, and every browser connected to this app, the same authority the remote's own desktop window has: reading and editing files, starting sessions, and running commands on that host. Join only instances you control, prefer HTTPS or a private network between them, and keep both embedded listeners off the public internet, as the [remote access](remote-access.md) guide describes.

## Related guides

- [Remote access](remote-access.md) configures the embedded server a remote instance joins.
- [Settings](settings.md) documents the Remote instances page and the rest of the Settings surface.
- [User guide](user-guide.md) explains the session controls shared by local and remote sessions.
- [Troubleshooting](troubleshooting.md) covers connection and authentication failures.
