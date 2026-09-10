# Remote access

Remote access opens your running omp-ui host in another browser. The browser has the same control as the desktop window, including reading and editing files, starting sessions, and running commands. Treat every connection URL and credential as full access to the machine the host runs on.

[Documentation home](README.md)

## Set up remote access

1. With omp-ui running, open **Settings > Remote access** (from the desktop window or any already-connected browser).
2. Set a password. omp-ui trims leading and trailing whitespace when it saves the password. The result must contain at least 8 characters and no more than 512 UTF-8 bytes. Password sign-in is the primary and safer sharing path.
3. Choose a bind address:
   - **localhost** listens only on `127.0.0.1`. Use it for a browser on the same computer or when an HTTPS service on that computer forwards traffic to omp-ui.
   - **local network** listens on `0.0.0.0`. Other devices on the LAN can connect.
4. Set a whole-number port from `1024` through `65535`.
5. Turn on **Enable remote access**. Wait for the status to say `listening`.
6. Copy the connection URL or scan the QR code. With a password set, the browser opens the sign-in page. Without a password, the displayed URL and QR code carry the access token.

The page also lists other reachable IPv4 addresses when local-network binding is enabled. If the port is already in use, choose another port and try again.

## Understand what is hosted

The persistent host — `omp-ui serve`, the background process the desktop app starts and connects to — owns the only live `HostApplication`, session registry, and running omp processes. The desktop window and every connected browser are views of that same host. A command from any view reaches the same handler, and host events fan out to all connected views. Remote access does not copy a session or start another omp process. The same listener is what another omp-ui joins when it adds this one as a [remote instance](remote-instances.md).

The host has two listeners with two sets of credentials, and they do not affect each other:

- **Local control** is always on. It listens on `127.0.0.1` at a port chosen at start and is advertised only in `<dataRoot>/host.json`, a file readable by your user alone, together with two credentials the host mints at every start: the *desktop credential* the desktop app uses to connect, and the *control credential* the `omp-ui` command uses for `status`, `pair`, and `stop`. Nothing on this page changes it, and it is never reachable from another machine.
- **Remote exposure** is the listener this page controls. It starts when remote access is enabled — at host start when it was left enabled — and stops when it is disabled or the host stops. Closing a browser only removes that view. Changing the bind address, port, or password restarts only this listener, without stopping live sessions or the desktop window; regenerating the token closes the exposed browser sessions without a restart.

Because the listener belongs to the host and not to the window, closing the desktop app does not end remote access: the host keeps serving your phone or another computer until you stop it (`omp-ui stop`) or log out of a host that is not installed as a service. See [Getting started](getting-started.md#run-the-host-as-a-service) to keep it running across logins.

## Authentication

### Password sign-in

omp-ui stores a fresh salted scrypt hash, not the password. After a successful sign-in, the server puts a password-derived credential in an `HttpOnly`, `SameSite=Strict` cookie. The cookie authenticates HTTP requests and the WebSocket connection, and browser JavaScript cannot read it.

Password failures are tracked in memory per client IP. The fifth consecutive wrong password starts a 60-second lockout. A wrong password after that lockout expires doubles the next lockout to 120 seconds, then 240 seconds, up to a 15-minute cap. A successful sign-in clears the failures for that IP. Restarting the exposure listener also clears its in-memory lockout records.

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

When the listener is running, either action restarts it, so every exposed WebSocket drops immediately. A client whose other credential is still valid can reconnect. To revoke all access, change or clear the password and regenerate the token. The desktop window and the `omp-ui` command are untouched by either action: they use the local-control credentials, which rotate only when the host restarts.

A new browser or a new omp-ui joining this host opens with a `hello` handshake that reports the host's version and protocol range; an incompatible pairing is named and closed instead of failing on the first unknown request. A browser from an omp-ui release before the handshake existed is still accepted on this listener for now.

## Choose a safe network boundary

Local-network mode binds to `0.0.0.0` and serves plain HTTP. omp-ui has no built-in TLS listener. Anyone who obtains the password, cookie, or token can exercise full agent control, and plain LAN traffic does not protect credentials or session data from interception or modification.

Prefer localhost. If another device must connect, supply HTTPS in front of the localhost listener with a TLS terminator or a private-network service such as Tailscale Serve. Keep the omp-ui listener off the public internet.

A plain `http://<lan-ip>` origin is not a secure browser context. The responsive browser client still works, and omp-ui has fallbacks for correlation IDs and text copying. Browsers will not offer secure-context-only capabilities such as PWA installation or service-worker-backed offline support on that origin. `http://localhost` receives the browser's special trustworthy-origin treatment. An HTTPS terminator restores a secure browser context for remote devices.

## Build the browser bundle for development

Packaged hosts serve the browser bundle from their own resources. In a development checkout the host serves `packages/desktop/out/web` when it exists; build it from the repository root with:

```bash
npm run build:web --workspace @omp-ui/desktop
```

The listener can still start when `index.html` is absent. The password sign-in page remains available when password authentication is enabled, and authenticated WebSocket behavior remains available for diagnosis. Authenticated requests for the browser app return `503 Service Unavailable` with a missing-bundle build hint. Build the bundle, then restart the development host (`npm run dev:serve`) so it sees it.

## Related guides

- [Settings](settings.md) covers the rest of the Settings surface.
- [Remote instances](remote-instances.md) joins another omp-ui host's projects and sessions into this sidebar over the same listener and credentials.
- [User guide](user-guide.md) explains the session controls shared by desktop and browser views.
- [Troubleshooting](troubleshooting.md) covers remote connection and authentication failures.
- [Development](development.md) lists the repository build and validation workflows.
