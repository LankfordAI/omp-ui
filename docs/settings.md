# Settings

Use Settings to change omp-ui preferences, update behavior, remote access, provider credentials, and the configuration that omp reads. Open it from the sidebar gear, the command palette, or `mod+,`.

The pages below follow the order in the app. Pay attention to the timing notes. Some controls update the current app immediately, while session defaults wait for a new session or the next omp process spawn.

## General

| Setting | What it changes | When it takes effect |
| --- | --- | --- |
| Language | Selects English or 한국어 for omp-ui's application chrome. Session content, terminal output, plans, code, paths, names, and backend errors are never translated. | Immediately in desktop and remote renderers; remembered for the next launch. |
| Default session mode | Opens new sessions in the native transcript or embedded terminal. | New sessions only. Existing sessions keep their mode. |
| Default agent mode | Starts a new native session in read-only Plan mode or write-enabled Build mode. | New native sessions only. |
| Default compaction method | Chooses the first compaction method attempted by new native sessions. Each method is listed with a one-line description of what it does. Available methods come from the installed omp binary; “omp configured default” supplies no override. | Captured by a fresh native session and preserved across later resumes. It does not change live sessions or terminal-origin sessions. |
| Plan format | Asks the agent to author either one self-contained HTML plan for the review modal or a Markdown plan. | Immediately for the next plan request. It does not rewrite an existing plan. |
| Hibernate idle sessions | Stops a quiet native session's omp process after this window; the transcript stays on disk and resuming wakes it. The tab a renderer is currently viewing, each project's most recently active session, and terminal tabs are never hibernated. | Immediately; the next quiet window applies it. |
| Stream-stall watchdog | Aborts a running turn after this much model-stream silence while a model request is in flight. Local tool execution suspends the clock; tool completion, compaction, retry backoff, and human answers restart a full window. Off disables it. | Immediately, at the next 15-second sweep. |
| Stall auto-continue | After a turn dies to a stream stall — omp's provider watchdog or omp-ui's own — sends a bounded continue prompt (max 2 in a row; any prompt re-arms). | Immediately. |
| Advisor auto-reply | Automatically answers an advisor comment that arrives after the main turn ends. When off, the comment remains in the transcript. | Immediately, including live sessions. |
| Default advisor | Starts the advisor for a new session that has no remembered project choice. A project's last-used advisor state wins. The advisor model still falls back to omp's configuration. | New sessions without a per-project advisor choice. |
| Skip the delete confirmation | Removes the warning shown before deleting a session and its whole lineage directory. | Immediately. |
| Transcript text size | Changes text in native transcripts without scaling the rest of the app. | Immediately. |

## Appearance

Choose a theme from the fixed theme grid. The choice updates the app chrome, terminal colors, and code highlighting immediately, and omp-ui remembers it for the next launch. Themes are curated sets rather than user-editable color controls. Every set reserves the signal color for agent liveness.

The application and Ubuntu families both use bundled Pretendard Variable after their Latin sans face for Korean chrome. Code, paths, terminal text, and other monospace content keep their selected monospace face.

## Updates

The two update sections are independent. Each has its own current version, status, launch check, manual check, dismissed version, and **Re-offer** action. Downloads always require a click.

### omp-ui

- **Check now** runs an update check immediately. **Check on launch** changes whether the check runs on the next app launch.
- A Linux AppImage can download and stage its update in the app. The Windows installer and macOS ZIP preview builds use the same staged flow. **Restart now** exits and restarts the omp-ui process into the staged version. **Install when I quit** waits for the next normal app exit.
- If the current package cannot apply its own update, omp-ui opens the release or download and can reveal the downloaded file instead of claiming it can self-update.
- Dismissing an offer hides only that version. **Re-offer** clears that dismissal and checks again.

Linux AppImage is the supported desktop package. Windows and macOS remain previews.

### omp binary

- **Check now** checks immediately. **Check on launch** controls the check at the next omp-ui launch.
- If omp is missing, **Install** downloads it. If a newer version is available, **Update now** installs it.
- An installed omp update does not replace a running session's process. New sessions and restarted sessions use the new binary on their next spawn.
- Dismissing an offer hides only that omp version. **Re-offer** clears the dismissal and checks again.

## Remote access

Remote access is off by default. A connected client has the same authority as the desktop app, including editing files and running commands. See [Remote access](remote-access.md) for setup and network guidance.

- **Enable remote access** starts or stops the embedded server.
- **Bind address** chooses localhost or the local network. Localhost limits the listener to this computer. Local-network binding uses plain HTTP, so traffic is not encrypted. Anyone on that network who has the password or a token link can drive the agent.
- **Port** accepts a whole number from 1024 through 65535.
- **Password** is the primary sign-in method. omp-ui trims leading and trailing whitespace when it saves the password. The result must contain at least 8 characters and no more than 512 UTF-8 bytes. omp-ui stores only a salted hash, so it can change or clear the password but cannot reveal it.
- The access token remains a full-access fallback while a password is set. You can reveal or copy it. Regenerating the token restarts the running server and drops every current connection. Old token links, bearer tokens, and token-derived cookies stop working; password-derived cookies remain valid and can reconnect.
- While the server is listening, the page shows copyable connection URLs and a pairing QR code. Without a password, the primary URL and QR include the token. With a password, they use the bare sign-in URL, and a separate token link remains available as a fallback. Local-network binding also lists other reachable IPv4 addresses below the primary URL.

A remote-setting change does not restart omp-ui or any omp session process. When remote access is running, changing the bind address, port, password, or token restarts only the embedded server. Enabling remote access starts the server, and disabling it stops the server. Running sessions continue. Localhost provides the full browser app. A local-network URL works as a responsive web app, but browsers require a secure origin for installation and offline support. Plain `http://<lan-ip>` does not qualify. Put the server behind your own HTTPS endpoint if you need those browser features.

## Providers

The page groups model-provider and web-search credentials and shows the environment variable that omp reads. It resolves each credential in this order:

1. A key stored by omp-ui.
2. A value inherited from omp-ui's environment.
3. A value captured from the user's login shell.
4. A value from the focused project's `.env` or `.env.local`, reported as `project .env`.

The first available source wins. Within the project source, `.env.local` overrides `.env`. A stored key therefore overrides an inherited or shell value. Removing it reveals the next available source. omp loads a project's dotenv files itself, so omp-ui reports that source but does not inject it.

Keys saved in omp-ui are encrypted through the operating system credential store. Stored plaintext is never returned to the renderer. Provider-status reads contain only a fixed mask and the last four characters, and the edit field is never prefilled. omp-ui supplies the resolved credential to the omp processes it launches. If the operating system has no secure credential store, omp-ui refuses to save a key rather than write it insecurely. Export the environment variable from your shell profile instead.

omp reads provider credentials when its process starts. A saved or removed key affects the next session spawn, not an already running process; to apply it to an existing session, stop its agent from the Session HUD or sidebar and open the session again.

Under **Subscriptions**, a provider's subscription plan (currently ChatGPT, provider id `openai-codex`) signs in through its own browser flow. The page tracks the flow's phase: starting, waiting on the browser omp opened, and — only when the provider asks — a field for the pasted redirect URL. Sign-in runs in a short-lived, session-less omp process; the credential lands in omp's own auth broker, shared with terminal omp, and omp-ui stores nothing. A signed-in row lists the provider's identity (account email) and offers **sign out**. New sessions can pick `openai-codex/…` models after a sign-in; a running session needs a restart. With no API key stored, a signed-in subscription also satisfies the provider gate for new sessions.

## Memory

Memory configures omp's durable recall behavior and summarizes the banks resolved for the focused project. For the memory keys in omp-ui's curated allowlist, the installed omp version supplies descriptions, value types, allowed choices, values, and effective layers. If that omp version does not report an allowlisted key, the page omits it.

Focus a session to see its resolved backend and scoping, base directory, global bank, and project bank when one applies. The paths describe the stores that omp resolved. They do not show which memories omp injected into a live or historical session, and this page does not browse or edit individual memory entries.

Edits run through `omp config set` and write only omp's global configuration. A focused project's `.omp/config.yml` has higher precedence, so a value marked `project` can continue to override the global edit. Values marked `global` come from omp's global file; unbadged values are omp defaults. omp rewrites the global YAML when it saves, which drops comments from that file.

Memory configuration applies to sessions started after the change. Existing omp processes keep the configuration they started with.

## omp

This page is a schema-driven view over omp-ui's curated allowlist of omp configuration keys. The installed omp version supplies each reported key's description, value type, enum choices, validation, value, and effective layer. If that version does not report an allowlisted key, omp-ui omits it. The page groups the available controls under model roles, advisor, context, providers, and display.

With a session focused, the page resolves values as that project would see them. With no focused session, it shows global configuration. A `project` badge means the focused project's `.omp/config.yml` supplies the effective value. A `global` badge means omp's global file supplies it. Defaults remain unbadged.

Every edit runs through `omp config set`, uses omp's own validation, and writes only the global layer. Project configuration still wins. omp regenerates its global YAML on write, so comments in that file are dropped. Model-role and advisor values bind when the omp process starts; they take effect on the next session spawn, or on an existing session after you stop its agent and open it again. For other settings, follow the timing in the description supplied by the installed omp version.

**MCP servers** opens the manager pinned to the focused session's own working tree — its worktree checkout when it has one, otherwise its project root — and is unavailable without a focused session. **Global MCP servers** opens the list that applies to every project. Opening either manager closes Settings.

## About

About reports exactly these runtime facts:

- `omp-ui version`
- `omp version`
- `omp path`, the resolved omp executable path
- `omp config dir`, the omp configuration directory

A dash means the value is not available, for example when omp is not installed.

## Related guides

- [Documentation home](README.md)
- [Getting started](getting-started.md)
- [User guide](user-guide.md)
- [Remote access](remote-access.md)
- [Updates and releases](releases.md)
- [Troubleshooting](troubleshooting.md)
