# Remote instances

A remote instance is another omp-ui host that this one has joined as a client. Its projects and sessions appear in this app's sidebar under a nickname you choose, and everything you do to them runs on that instance. Joining grants this host full control of that instance's sessions and files, so treat every connection URL and credential as full access to the machine it runs on.

[Documentation home](README.md)

## Join a remote instance

The other omp-ui must have [remote access](remote-access.md) enabled and be reachable from this computer.

1. On the other omp-ui, open **Settings > Remote access**, turn on **Enable remote access**, and copy either the connection URL (password sign-in) or the token link.
2. On this app, open **Settings > Remote instances**.
3. Paste the URL into **Connection URL**. The URL must be `http://` or `https://` and may carry a port. A token link (`…/?t=TOKEN`) is accepted as-is: omp-ui takes the token from it and hides the password field.
4. Optionally enter a **Nickname**. Leave it empty to use the URL's host, for example `192.168.1.20:7432`. Nicknames are trimmed, are 1 to 32 characters, and must be unique among joined instances without regard to case.
5. If the URL did not carry a token, enter the other app's **Password** or paste its **Access token**.
6. Choose **Join**.

omp-ui signs in once, keeps the credential the sign-in derives, and connects. A rejected password, an unreachable address, a duplicate nickname, or a URL that cannot be parsed shows inline on the form and stores nothing.

## What the sidebar shows

Each joined instance is a collapsible group after the local projects, headed by its nickname, a status dot, and the connection URL. The group holds that instance's registered projects and their owned sessions, with activity read from that instance's own turn and human-answer state: a native row shows *working* while a turn runs there and *answer needed* while a plan gate or a blocking dialog waits on a person, whether or not this app has the tab open, and a terminal row still reads *live* because a PTY carries no turn signal. A project may share its absolute path with a local project; the two are separate groups.

Opening a remote session opens a tab in this window that renders the other app's own stream — terminal bytes for a terminal session, the native transcript for a native session. The tab's label, the title bar, and the Session HUD carry the nickname in front of the session title, and the HUD shows a quiet nickname chip whose hover reveals the URL.

The group header offers **Register project on \<nickname\>** while the instance is joined, **Reconnect** while it is not, and a shortcut to the Remote instances settings page.

## What crosses and what does not

Registry and session lifecycle actions run on the remote instance: registering, removing, and reordering projects; new, resume, terminate, restart, hibernate, fork, move, and delete; mode switches; model and advisor changes; worktree sessions and branch actions; plan review; the capabilities viewer and its MCP, skills, and tool controls; the console shell; typing, resizing, and pasting images. Model choices follow the remote the same way: a remote session's model palette lists the models that instance's session reports, its Favorites are that instance's own — a star you toggle there applies to every view of that instance, in this app and in its own window — and its project's default-model pins and advisor defaults are read and written on that instance. Hibernation policy is that instance's too, with the tab you are viewing here reported to it so it stays exempt while you watch.

Nothing is copied and no second omp process starts. Closing the tab hides it; the session keeps running on the remote instance. Stopping this host disconnects from every remote instance and leaves their sessions running, exactly as closing a browser view of that instance would; closing this desktop window disconnects nothing, because the join belongs to the host.

Client effects stay on the machine whose screen you are looking at, and instance-local state stays on its instance. Opening a project or file in VS Code, Files, or a terminal is not offered for a remote target, file paths in a remote transcript render as plain text, and the remote's own app preferences, updates, providers, remote-access settings, and diagnostics are never reachable from this app. Providers are no exception: a remote session whose instance reports no models shows a note naming the instance instead of opening this app's Providers page — provider credentials are instance-local, so configure them by opening Providers on that instance itself. Remote sessions raise no desktop notifications here.

The relation is directed. Joining B from A gives B no view of A, and a join never follows the remote's own joins: only the remote's own projects appear, never the instances it has joined itself. Joining this host's own connection URL is reported as *this app* and adds no group.

A browser connected to this host through remote access sees the joined instances too and can act on them, because the join belongs to the host rather than to one window.

## Disconnect and rejoin

When the connection drops — the remote host stops, the network fails, or its remote-access listener restarts after a settings change — the group stays in the sidebar with status *unreachable*, its projects dimmed. Open tabs stay mounted with a banner naming the instance and input disabled; keystrokes to a remote terminal are held back rather than lost into a dead socket. omp-ui retries with a growing delay from 1 second up to 30 seconds and keeps trying until the instance answers, you remove it, or the host stops.

On rejoin, every open remote tab reloads its state from the remote: native tabs re-hydrate their transcript and terminal tabs redraw at their current size. A tab whose session no longer exists on the remote is removed. **Reconnect**, on the group header or the settings page, retries immediately from any status.

## Credentials, storage, and revocation

omp-ui stores the credential the sign-in derived — a password-derived credential or the access token — never the password itself. The host encrypts it under its own key, held by the operating system credential store (Secret Service, Keychain, or DPAPI), and writes it to `remote-instances.json` beside `registry.json` in the data root, readable only by your user. It never reaches a renderer, and the diagnostic bundle never reads the file. While the credential store is unavailable the host reports a degraded credential backend and refuses to join rather than write the credential insecurely.

Revocation happens on the remote. Changing or clearing its password invalidates a password-derived credential; regenerating its access token invalidates a token credential. Either way this host's next connection attempt is rejected, the instance shows *sign-in required*, and omp-ui stops retrying until you choose **Edit** on the settings page and enter the new password or token. A stored credential that can no longer be decrypted — for example after the operating system credential store changed — is reported the same way.

**Remove** on the settings page forgets the connection and its credential and drops the group and its tabs from this app. The remote instance's sessions keep running.

## Trust

A joined instance grants this host, and every browser connected to this host, the same authority the remote's own desktop window has: reading and editing files, starting sessions, and running commands on that machine. Join only instances you control, prefer HTTPS or a private network between them, and keep both remote-access listeners off the public internet, as the [remote access](remote-access.md) guide describes.

## Related guides

- [Remote access](remote-access.md) configures the listener a remote instance joins.
- [Settings](settings.md) documents the Remote instances page and the rest of the Settings surface.
- [User guide](user-guide.md) explains the session controls shared by local and remote sessions.
- [Troubleshooting](troubleshooting.md) covers connection and authentication failures.
