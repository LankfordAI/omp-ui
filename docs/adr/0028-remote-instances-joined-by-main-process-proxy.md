# Remote instances are joined by the main process, not the renderer

> **Status:** Superseded in part by [ADR-0029](0029-persistent-host-owns-authoritative-application.md),
> effective. The proxy's owner is the persistent host (`HostApplication` in
> `@omp-ui/host`), not the Electron main process this record names. The
> single-owner reasoning below stands unchanged; read "main" as "the host",
> "backend" as `HostApplication`, and "host-local" as instance-local.

A **remote instance** (issue #416) is another omp-ui app whose embedded server
this app joins as a client, so that its projects and sessions appear in this
app's sidebar under a nickname. [ADR-0002](0002-transport-agnostic-core.md)
designed `OmpBackend` so a renderer could talk to any transport, and the browser
renderer already dials a WebSocket to reach the backend. The obvious reading
of that seam is that the desktop renderer should dial each remote instance
itself, hold one `OmpBackend` per instance, and let every store slice pick the
backend for the tab or project it is acting on.

We decided against that reading. The Electron **main process** owns the join:

- Main dials each remote instance over one WebSocket client
  (`connectInstanceClient` in `@omp-ui/server`), signs in once with the
  password or takes the token from a pasted token link, and keeps only the
  **derived credential** — encrypted through the OS `KeyCipher` in
  `remote-instances.json` beside `registry.json`, the same discipline as
  `provider-keys.json`. The password is never stored and no credential ever
  reaches a renderer.
- Main merges the remote's `BackendState.projects` and `BackendState.modelFavorites`
  into local state as `remoteInstances[i].projects` /
  `remoteInstances[i].modelFavorites`. Local `projects` and local
  `modelFavorites` stay local-only; a remote session is found by walking the
  joined groups.
- Main routes by **tab id**. Every tab-scoped request or notification carries
  the owning `tabId` as its first argument; `routeByTab` looks up the tab's
  owner and forwards to that instance or to the local handler. Project-scoped
  calls reach a remote through two explicit channels,
  `remote-instance:request` and `remote-instance:notify`, behind an allowlist
  (`REMOTE_PROXY_CHANNELS`) — which carries exactly one app-scoped entry,
  `favorites:toggle`, addressed by `instanceId` because a favorite belongs to
  the instance, not to a session or project. Remote tab events (`pty:data`,
  `rpc:frame`, `shell:*`, `pty:exit`, `session:hibernated`) are mirrored into
  local sinks unchanged; a remote `state:changed` is folded into that
  instance's `projects` and `modelFavorites`, a partial or malformed payload
  keeping the last good values; every other remote event is dropped.
- The renderer keeps **one** backend. Its project-keyed maps use a composite
  `projectKey(instanceId, path)`, and `TabInfo.instanceId` records the owner.
  For project-scoped actions it builds a thin per-instance `OmpBackend` over
  the two proxy channels; nothing else in the renderer knows a socket exists.

## Considered options

- **Renderer multi-backend (rejected).** One `OmpBackend` per joined instance,
  dialled from the renderer. It puts the credential into the sandboxed
  renderer, which today receives only masked tails of any secret; it opens the
  CSP `connect-src` to arbitrary hosts; every store slice and every component
  that names a tab or project gains a routing key it must thread correctly;
  and a remote browser of *this* desktop (the phone on the LAN) cannot see
  joined instances at all, because the join lives in one renderer's memory
  rather than in the backend state every client hydrates from.
- **Path prefixing (rejected).** Merge remote projects into the local
  `projects` array under a synthetic path such as `nickname:/home/…`, so the
  existing project-keyed code needs no change. The UI would show paths that
  exist nowhere, every host-local open would have to un-prefix them, and
  renaming the nickname would break every key that embedded it — focus,
  branch caches, session order.
- **Main-process proxy (chosen).** One relay hop for remote bytes, one
  credential file handled like the one we already have, one routing rule
  (`tabId → instance`) applied in one place, and a state shape every
  client — desktop or browser — sees identically.

## Consequences

- **One relay hop for remote PTY and rpc bytes.** Remote terminal output
  travels remote → this app's main → this app's renderer. Binary frames stay
  binary on both legs, so the cost is latency, not inflation.
- **`remote-instances.json` is a credential file.** It is written `0600`,
  its blobs are ciphertext, the diagnostic bundle never reads it, and when no
  OS credential store is available the join is refused rather than stored in
  the clear — exactly the `provider-keys.json` rules. A blob that no longer
  decrypts keeps its entry, reported as *sign-in required*, instead of
  silently forgetting the instance.
- **Joins are one level deep and directed.** The proxy reads a remote's own
  `projects` and `modelFavorites` only, never its `remoteInstances`, so A↔B
  mutual joins cannot recurse and joining B from A gives B no view of A.
  Joining an app's own URL is detected by a persistent per-app `instanceId`
  and shown as *this app*.
- **Version skew surfaces per call.** An older remote without
  `instance:identity` is refused at join time as *incompatible*. A joined
  remote that lacks one newer channel rejects that one action with its own
  `unknown channel …` error while staying joined; omp-ui neither hides the
  error nor downgrades the whole instance.
- **Host-local actions stay host-local.** Opening a path in VS Code, Files, or
  a terminal, `file:open`, `file:showInFolder`, and the remote's own
  preferences, updates, providers, remote-access and diagnostics channels are
  outside the allowlist. The renderer hides those controls for remote targets;
  the proxy refuses them if asked. `favorites:toggle` is the one app-level
  channel inside the allowlist — model favorites follow the owning instance
  the way its projects do — while general settings and provider channels stay
  outside it: a remote palette with no catalog shows guidance naming the
  instance instead of opening this app's Providers page, because provider
  credentials are host-local.
- **Disconnects keep the sidebar honest.** A dropped socket marks the instance
  *unreachable* and keeps its last-known projects and favorites visible but
  dimmed; main retries with capped backoff (1 s → 30 s). A rejected credential
  (`401`) stops retrying and asks for a fresh sign-in, so a changed remote
  password never becomes a retry storm.
