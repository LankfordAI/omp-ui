# Remote access

Remote access opens the running desktop app in another browser. The browser has the same control as the desktop view, including reading and editing files, starting sessions, and running commands. Treat every connection URL and credential as full access to the host.

[Documentation home](README.md)

## Set up remote access

1. Keep the omp-ui desktop app running and open **Settings > Remote access**.
2. Set a password. omp-ui trims leading and trailing whitespace when it saves the password. The result must contain at least 8 characters and no more than 512 UTF-8 bytes. Password sign-in is the primary and safer sharing path.
3. Choose a bind address:
   - **localhost** listens only on `127.0.0.1`. Use it for a browser on the same computer or when an HTTPS service on that computer forwards traffic to omp-ui.
   - **local network** listens on `0.0.0.0`. Other devices on the LAN can connect.
4. Set a whole-number port from `1024` through `65535`.
5. Turn on **Enable remote access**. Wait for the status to say `listening`.
6. Copy the connection URL or scan the QR code. With a password set, the browser opens the sign-in page. Without a password, the displayed URL and QR code carry the access token.

The page also lists other reachable IPv4 addresses when local-network binding is enabled. If the port is already in use, choose another port and try again.

## Understand what is hosted

The desktop app owns the only live `MainBackend`, session registry, and running omp processes. Its local renderer and every connected browser are additional views of that same backend. A command from any view reaches the same handler, and backend events fan out to all connected views. Remote access does not copy a session or start another omp process. The same listener is what another omp-ui app joins when it adds this one as a [remote instance](remote-instances.md).

The browser pane is hosted the same way. A browser connected to this app sees the pane live and can click, type, and navigate in it. Only desktop renderers size the page; browser clients scale its frames to fit their own. Images use a separate authenticated frame connection, with one image awaiting acknowledgment and only the newest pending image per subscribed tab. The acknowledgment follows paint or an intentional drop. A slow image connection does not put images ahead of terminal output or control replies on the reliable connection. Frame-only reconnect resumes images without restarting that reliable connection. Hosts, joined instances, and browser bundles must all support this paired transport; reverse proxies must forward WebSocket upgrades for both `/ws` and `/ws/frames`.

The knowledge vault is hosted the same way. Vault notes live on the desktop host, and the agent's vault tools read and write them there while a browser client is connected; the browser's Knowledge vault settings page shows that host's registry, and "Open in Obsidian" on a vault card copies the note's `obsidian://` link rather than opening Obsidian on the browser's own machine. Paste it on a machine with the same vault to open the note there.

Live voice runs on the device you talk from ([#968](https://github.com/LankfordAI/omp-ui/issues/968)). The browser that starts a call opens its own microphone and speakers and carries the audio over its own WebRTC connection to the voice service; only the call's setup and its talk/stop commands travel through the desktop host, which keeps the session. The live control appears in a browser client and on a joined remote instance's tab, as it does in the desktop app. A browser needs a secure context for a microphone: `http://localhost` and an HTTPS origin qualify, but a plain `http://<lan-ip>` origin offers no microphone at all, so that client sees neither the live control nor the dictation microphone. Closing or reloading the browser tab ends its call.

Inline Markdown note titles in native replies also copy a portable link in a browser client, including one hosted in an Electron browser pane, or in a tab owned by a joined instance. The title stays readable, with two-second "Link copied" feedback beside it. A refused clipboard exposes the selectable URI. These inline actions never route an open request to the unattended owner; unresolved ownership copies too.

The HTTP and WebSocket server is embedded in the Electron main process. It starts at desktop launch when remote access was left enabled and stops when the desktop app quits. Closing a browser only removes that view. When the server is running, changing the bind address, port, password, or token restarts it without stopping live sessions. Disabling remote access stops the server, and enabling it starts the server.

A browser view survives being backgrounded — a phone locking or opening the camera/file picker kills its WebSockets, and the page reconnects on its own within seconds, keeping its open tabs and composer draft. Terminal output produced while the link was dead is not replayed; the terminal repaints with the next bytes.

## Authentication

### Password sign-in

omp-ui stores a fresh salted scrypt hash, not the password. After a successful sign-in, the server puts a password-derived credential in an `HttpOnly`, `SameSite=Strict` cookie. The cookie authenticates HTTP requests and both WebSocket connections, and browser JavaScript cannot read it. The frame connection also presents an ephemeral pairing key issued by its reliable connection; that key alone cannot authenticate or outlive the reliable connection.

Password failures are tracked in memory per client IP. The fifth consecutive wrong password starts a 60-second lockout. A wrong password after that lockout expires doubles the next lockout to 120 seconds, then 240 seconds, up to a 15-minute cap. A successful sign-in clears the failures for that IP. Restarting the embedded server also clears its in-memory lockout records.

### Token fallback

A randomly generated 32-byte token remains valid while password sign-in is enabled. Use the **Token link (fallback)** when entering the password is impractical. The server accepts the token in either form:

```text
http://127.0.0.1:PORT/?t=TOKEN
Authorization: Bearer TOKEN
```

Opening a token URL stores that token in the same `HttpOnly` cookie, then uses the cookie for later requests. If no password is set, token authentication is the only mode and an unauthenticated request receives `401 Unauthorized` instead of a sign-in form.

A token URL is a credential, not a bookmark safe to publish. URLs can remain in browser history, copied text, proxy logs, and QR-code photos.

## Revoke access

Password and token credentials have separate revocation controls:

- **Change or clear the password** to invalidate password-derived cookies. The fallback token and existing token links remain valid.
- **Regenerate the access token** to invalidate old token links, bearer tokens, and cookies created from that token. Password-derived cookies remain valid if the password did not change.

When the server is running, either action restarts it, so every connected WebSocket drops immediately. A client whose other credential is still valid can reconnect. To revoke all access, change or clear the password and regenerate the token.

## Choose a safe network boundary

Local-network mode binds to `0.0.0.0` and serves plain HTTP. omp-ui has no built-in TLS listener. Anyone who obtains the password, cookie, or token can exercise full agent control, and plain LAN traffic does not protect credentials or session data from interception or modification.

Prefer localhost. If another device must connect, supply HTTPS in front of the localhost listener with a TLS terminator or a private-network service such as Tailscale Serve. Keep the omp-ui listener off the public internet.

A plain `http://<lan-ip>` origin is not a secure browser context. The responsive browser client still works, and omp-ui has fallbacks for correlation IDs and text copying. Browsers will not offer secure-context-only capabilities such as PWA installation or service-worker-backed offline support on that origin. `http://localhost` receives the browser's special trustworthy-origin treatment. An HTTPS terminator restores a secure browser context for remote devices.

## Webhooks

Webhooks let an outside event, such as a GitHub pull request, a failed deploy, or a `curl` from a script, start a session ([#997](https://github.com/LankfordAI/omp-ui/issues/997), [ADR-0075](adr/0075-webhooks-ride-the-remote-access-listener-with-per-webhook-secrets.md)). They are off by default. Turn on remote access, then **Settings → Webhooks → Accept webhooks**, and create a webhook there. Each webhook is an endpoint on this listener:

```text
POST http://127.0.0.1:PORT/webhooks/WEBHOOK_ID
```

A webhook sender is not a remote-access client. The remote password, cookie, and token never authenticate a delivery, and a webhook secret never opens the app. Each webhook has its own random secret, shown once when you create the webhook or rotate the secret:

- **GitHub signature (HMAC):** set the secret as the webhook's secret in GitHub. omp-ui checks `X-Hub-Signature-256: sha256=…`, the HMAC-SHA256 of the raw body.
- **Bearer token:** send `Authorization: Bearer SECRET`. A secret in the query string is never accepted.

```bash
body='{"ref":"main","status":"failed"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -X POST "http://127.0.0.1:4677/webhooks/$WEBHOOK_ID" \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$sig" -d "$body"
```

A delivery that authenticates answers `202 Accepted` with a delivery id, and omp-ui starts one fresh native session in the webhook's project, on this computer or a joined remote instance, in the webhook's mode and workspace. Its first prompt is the webhook's template, then a notice that what follows is untrusted outside input, then the request body in a fenced block labelled with the webhook name, the `X-GitHub-Event` header, the content type, and the size. The session's header reads **Started by a webhook on HOST**, and it never gets the fleet tools.

Other answers: `401` for an unknown id, a wrong signature or token, an unreadable secret, or a disabled webhook (all look the same); `413` for a body over 64 KiB; `400` for a body that is not UTF-8 text; `429` with `Retry-After` when the webhook's hourly limit or the app-wide limit of 60 deliveries per hour is reached; `200` without a new session when GitHub redelivers an `X-GitHub-Delivery` id omp-ui already accepted. Every delivery to a known webhook appears in **Recent deliveries** with its status and outcome; the body, the headers, and the secret are never recorded. The rate limits and the redelivery check reset when omp-ui restarts.

Anyone who holds a webhook's secret can start sessions in its project with whatever they put in the body. New webhooks start in **Plan** mode, so a payload that tries to steer the agent meets the plan review before anything changes. Exposing webhooks to the internet means exposing this listener, so put an HTTPS terminator or tunnel in front of the localhost listener and forward only the `/webhooks/` path. Without HTTPS, an attacker who captures a signed delivery can replay it.

## MCP endpoint

The MCP endpoint lets an outside app or agent, such as Claude Desktop, a chat bot, a script, or another omp, drive omp-ui over the Model Context Protocol ([#996](https://github.com/LankfordAI/omp-ui/issues/996), [ADR-0080](adr/0080-mcp-endpoint-rides-the-remote-access-listener-with-scoped-client-tokens.md)). It is off by default. Turn on remote access, then **Settings → Remote access → MCP endpoint → Accept MCP clients**, and add a client there. The endpoint speaks MCP streamable HTTP on this listener:

```text
POST http://127.0.0.1:PORT/mcp
Authorization: Bearer CLIENT_TOKEN
```

An MCP client is not a remote-access client. The remote password, cookie, and token never open `/mcp`, and a client token never opens the app. Each client has its own token, shown once when you add the client or rotate its token; omp-ui keeps only a hash of it. **Copy MCP URL** right after creating a client puts the URL and a client config with the token on the clipboard:

```json
{
  "mcpServers": {
    "omp-ui": {
      "type": "http",
      "url": "http://127.0.0.1:4677/mcp",
      "headers": { "Authorization": "Bearer CLIENT_TOKEN" }
    }
  }
}
```

Each client has a scope, and sees only the tools its scope allows:

- **Read only:** `list_machines`, `list_projects`, `list_sessions` (project sessions on this computer and every joined instance; private sessions and chats are never listed), and `session_status` (state and the latest landed reply).
- **Dispatch:** also `start_session`, which starts one session in a project with a prompt. It starts in **Plan** mode unless the call passes `planMode: false`, in a fresh worktree unless it passes `workspace: "checkout"`. The session reads **Started by an MCP client on HOST** and never gets the fleet tools.
- **Send:** also `send_to_session`, which messages a session this client started, queued after the current turn or steered into it. Sessions another client or you started refuse it.

New clients start at **Read only**. A client may start sessions and send messages up to its hourly limit (6 by default; empty means none), and all MCP clients together up to 60 per hour; over a limit the tool answers with a refusal. The limits reset when omp-ui restarts. Unknown, disabled, and missing tokens all answer `401`; a request from a browser page on another origin answers `403`. Every call appears in **Recent MCP calls** with its tool, target, outcome, and duration; prompts, messages, and tokens are never recorded.

A **Dispatch** or **Send** token lets its holder start agent sessions on any ready fleet machine with prompts of its choosing, and a **Read only** token reads the titles and latest replies of every project session. Keep the listener on localhost or behind HTTPS so tokens are not sent in the clear.

## Build the browser bundle for development

Packaged desktop builds include the browser bundle. From the repository root, build it for a development checkout with:

```bash
npm run build:web --workspace @omp-ui/desktop
```

The embedded server can still start when `index.html` is absent or is not a file. The password sign-in page remains available when password authentication is enabled, and authenticated WebSocket behavior remains available for diagnosis. For every authenticated static request, the server asynchronously checks whether `index.html` is a file. When it is absent or not a file, requests for the browser app return `503 Service Unavailable` with a missing-bundle build hint. After the first build or a rebuild completes, reload the same URL to load the current bundle; the listener, credentials, and pairing URL stay unchanged.

The missing-bundle notice in **Settings > Remote access** records availability only when the server starts. It is a historical startup diagnostic, not a live availability check, and may remain visible after the bundle has been built.

## Related guides

- [Settings](settings.md) covers the rest of the Settings surface.
- [Remote instances](remote-instances.md) joins another omp-ui app's sessions into this app's sidebar list, and its projects into the project quick-open, over the same listener and credentials.
- [User guide](user-guide.md) explains the session controls shared by desktop and browser views.
- [Troubleshooting](troubleshooting.md) covers remote connection and authentication failures.
- [Development](development.md) lists the repository build and validation workflows.
