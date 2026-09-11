# Settings

Use Settings to change omp-ui preferences, update behavior, remote access, remote instances, provider credentials, and the configuration that omp reads. Open it from the sidebar gear, the command palette, or `mod+,`.

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

Transcript width chooses the column the native transcript, the composer card, and the hero column share: Comfortable (56rem), Wide (72rem, the default), or Full (uncapped). Prose keeps a readable measure at every step while tool cards, code, and diffs take the whole column. The choice applies immediately and is remembered for the next launch.

Glass chrome lets the sidebar, inspector rail, title bar, composer card, sheets, and modals show a soft backdrop through them: Off (opaque, as before), Subtle (the default; light blur), or Frosted (stronger blur; costs a little GPU). Text is never blurred and terminals, transcripts, and dialogs' reading surfaces stay opaque ([ADR-0026](adr/0026-glass-chrome-via-backdrop-filter.md)). The choice applies immediately and is remembered for the next launch.

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

## Remote instances

Remote instances joins other omp-ui apps that have remote access enabled, so their projects and sessions appear in this app's sidebar under a nickname. A joined instance grants this app full control of that host's sessions and files. See [Remote instances](remote-instances.md) for what crosses, what does not, and how reconnection works.

The **Join** form takes:

- **Connection URL** — the other app's `http://` or `https://` address, with a port when it has one. A pasted token link (`…/?t=TOKEN`) is accepted as-is; omp-ui takes the token from it and hides the secret field.
- **Nickname** (optional) — the label every surface uses for that instance. Empty defaults to the URL's host, for example `192.168.1.20:7432`. Trimmed, 1 to 32 characters, unique among joined instances without regard to case.
- **Password** or **Access token** — the other app's remote-access credential, chosen with the **Sign in with** toggle. Not shown when the URL carried a token.

A rejected password, an unreachable address, a duplicate nickname, or an unparsable URL shows inline on the form and stores nothing.

Each joined instance is a panel showing its nickname, URL, status, the remote's omp-ui version, and the last error, with three actions:

- **Reconnect** drops any current connection and retries immediately, from any status.
- **Edit** changes the nickname, the URL, or the credential inline. A nickname change applies without reconnecting; a URL or credential change signs in again and reconnects.
- **Remove** asks for confirmation, then forgets the connection and its credential and drops the group and its tabs from this app. The remote's sessions keep running.

Statuses:

| Status | Meaning |
| --- | --- |
| `connecting` | omp-ui is dialing or signing in. |
| `joined` | Connected; the instance's projects are live in the sidebar. |
| `unreachable` | The connection failed or dropped. Projects stay listed but dimmed, tabs stay open with input disabled, and omp-ui retries with a growing delay from 1 to 30 seconds. |
| `sign-in required` | The remote rejected the stored credential (its password changed or its token was regenerated), or the credential could not be decrypted. omp-ui stops retrying until you **Edit** the instance and sign in again. |
| `this app` | The URL is this app's own remote-access address. No group is added and nothing is retried. |
| `incompatible version` | The remote omp-ui is older than this app and cannot be joined. |

omp-ui stores the credential that the sign-in derived — a password-derived credential or the access token — never the password. It is encrypted through the operating system credential store and written to `remote-instances.json` beside `registry.json`, readable only by your user; it never reaches a renderer, and the diagnostic bundle never reads it. Without a secure credential store, omp-ui refuses to join rather than store the credential insecurely.

## Providers

The page groups model-provider and web-search credentials and shows the environment variable that omp reads. It resolves each credential in this order:

1. A key stored by omp-ui.
2. A value inherited from omp-ui's environment.
3. A value captured from the user's login shell.
4. A value from the focused project's `.env` or `.env.local`, reported as `project .env`.

The first available source wins. Within the project source, `.env.local` overrides `.env`. A stored key therefore overrides an inherited or shell value. Removing it reveals the next available source. omp loads a project's dotenv files itself, so omp-ui reports that source but does not inject it.

Keys saved in omp-ui are encrypted through the operating system credential store. Stored plaintext is never returned to the renderer. Provider-status reads contain only a fixed mask and the last four characters, and the edit field is never prefilled. omp-ui supplies the resolved credential to the omp processes it launches. If the operating system has no secure credential store, omp-ui refuses to save a key rather than write it insecurely. Export the environment variable from your shell profile instead.

omp reads provider credentials when its process starts. A saved or removed key affects the next session spawn, not an already running process; to apply it to an existing session, stop its agent from the Session HUD or sidebar and open the session again.

Under the **Web search** credentials, **Preferred provider** chooses which provider omp's native `web_search` tool tries first. It writes omp's `providers.webSearchOrder`, one provider deep: providers you do not list stay available in omp's own order afterward, so **Automatic — omp's default order** means an empty order, not a disabled tool. The choices are the provider ids the installed omp itself publishes, so they are accurate for that version rather than a list omp-ui maintains; a provider omp does not recognise is still listed, labelled as outside omp's list. Like a credential, the choice applies to sessions started after the change. A value badged `project` comes from the focused project's `.omp/config.yml`, which outranks the global file, and choosing here writes omp's global config only.

Under **Subscriptions**, a provider's subscription plan (currently ChatGPT, provider id `openai-codex`) signs in through its own browser flow. The page tracks the flow's phase: starting, waiting on the browser omp opened, and — only when the provider asks — a field for the pasted redirect URL. Sign-in runs in a short-lived, session-less omp process; the credential lands in omp's own auth broker, shared with terminal omp, and omp-ui stores nothing. A signed-in row lists the provider's identity (account email) and offers **sign out**. New sessions can pick `openai-codex/…` models after a sign-in; a running session needs a restart. With no API key stored, a signed-in subscription also satisfies the provider gate for new sessions.

## Memory

Memory configures omp's durable recall behavior and summarizes the banks resolved for the focused project. For the memory keys in omp-ui's curated allowlist, the installed omp version supplies descriptions, value types, allowed choices, values, and effective layers. If that omp version does not report an allowlisted key, the page omits it.

Focus a session to see its resolved backend and scoping, base directory, global bank, and project bank when one applies. The paths describe the stores that omp resolved. They do not show which memories omp injected into a live or historical session, and this page does not browse or edit individual memory entries.

Edits run through `omp config set` and write only omp's global configuration. A focused project's `.omp/config.yml` has higher precedence, so a value marked `project` can continue to override the global edit. Values marked `global` come from omp's global file; unbadged values are omp defaults. omp rewrites the global YAML when it saves, which drops comments from that file.

Memory configuration applies to sessions started after the change. Existing omp processes keep the configuration they started with.

## omp

This page is a schema-driven view over omp-ui's curated allowlist of omp configuration keys. The installed omp version supplies each reported key's description, value type, enum choices, validation, value, and effective layer. If that version does not report an allowlisted key, omp-ui omits it. The page groups the available controls under model roles, advisor, context, providers, and display.

The web-search provider order is not on this page: it is edited on **Providers**, beside the credentials it depends on.

With a session focused, the page resolves values as that project would see them. With no focused session, it shows global configuration. A `project` badge means the focused project's `.omp/config.yml` supplies the effective value. A `global` badge means omp's global file supplies it. Defaults remain unbadged.

Every edit runs through `omp config set`, uses omp's own validation, and writes only the global layer. Project configuration still wins. omp regenerates its global YAML on write, so comments in that file are dropped. Model-role and advisor values bind when the omp process starts; they take effect on the next session spawn, or on an existing session after you stop its agent and open it again. For other settings, follow the timing in the description supplied by the installed omp version.

**Session capabilities** opens the **Capabilities viewer** at its MCP section, pinned to the focused session's own working tree — its worktree checkout when it has one, otherwise its project root — and is disabled until a session tab is focused. **Global MCP servers…** opens the same viewer's MCP section at global scope, without a session. Opening either closes Settings. The viewer's Skills and Tools sections describe the loaded roster of the one selected live native session — never a machine-wide catalog — so they read unavailable at global scope, where no session is pinned; in a terminal tab, whose omp TUI publishes no roster over rpc; while the pinned session is dormant, because there is no live process to read; and on OMP builds that expose no session inventory, which report that instead of an empty list.

## Advanced

The Advanced page holds the **Diagnostic bundle** export: one zip with the main-process logs, the lifecycle breadcrumb trail (launch, window, session spawn/resume/exit/terminate/hibernate/mode, update transitions, remote enable/token-regenerate, renderer and child-process deaths, main-process exceptions and rejections), versions (omp-ui, omp, Electron/Node/Chrome, package format), platform facts, the registry plus per-working-tree `git status --porcelain` output, session-lineage listings, the generated per-session extension files of live sessions, window geometry, and a manifest describing all of it and its warnings.

Redaction is fixed, not configurable: provider keys are never read, the remote token and password hash/salt become `hasRemoteToken`/`hasRemotePassword` booleans, the OAuth login scratch directory is never walked, and plan bodies and project file contents stay out. Transcript JSONL is excluded by default — the dialog's **Include transcripts** checkbox is an explicit, warned opt-in, capped at 64 MiB per bundle. Absolute paths, project paths, session titles, and git status filenames are included by design; the manifest inside the zip records exactly which sections exist.

The export is also reachable from the command palette ("Export diagnostic bundle…"). On a remote (browser) client the same action writes the bundle into a `diagnostics/` directory beside the registry on the machine omp-ui runs on; the native save dialog appears only in the desktop app.

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
- [Remote instances](remote-instances.md)
- [Updates and releases](releases.md)
- [Troubleshooting](troubleshooting.md)
