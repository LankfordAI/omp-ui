# The MCP endpoint rides the remote-access listener with scoped client tokens

> **Status:** Accepted, 2026-10-30 ([#996](https://github.com/LankfordAI/omp-ui/issues/996)). Verified against omp 18.14.0.

The **MCP endpoint** (CONTEXT.md) lets an outside app or agent (Claude
Desktop, a chat bot, a script, another omp) drive omp-ui over the Model
Context Protocol. It is `POST /mcp` on the embedded remote-access server,
speaking MCP streamable HTTP. A client can list machines, projects, and
sessions; start a session with a prompt; send to a session it started; and
read a session's status and latest landed reply.

The `omp-ui_fleet_*` host tools ([ADR-0043](0043-host-tools-answer-what-the-main-process-owns.md),
[ADR-0061](0061-fleet-dispatch-rides-the-spawn-request.md)) already answer
these questions, but only for sessions omp-ui spawned. Remote access and
remote instances ([ADR-0028](0028-remote-instances-joined-by-main-process-proxy.md))
assume every caller is the user with full control of the host. Webhooks
([ADR-0075](0075-webhooks-ride-the-remote-access-listener-with-per-webhook-secrets.md))
admit a sender that is not the user but give it no choice of what runs. An
MCP client sits between them: it is not the user, yet it chooses prompts and
reads replies. This ADR records its trust model.

## Findings

- omp 18.14.0 is itself an MCP client: its `mcp/transports/http.ts` POSTs one
  JSON-RPC message per request with `Accept: application/json,
  text/event-stream`, accepts either a JSON or an SSE response, sends
  `MCP-Protocol-Version` after `initialize` (it asks for `2025-11-25`),
  keeps `Mcp-Session-Id` only when a server sets it, and treats a `405` from
  the optional GET stream as "no server stream". The verification run used
  omp with an `.omp/mcp.json` entry `{ "type": "http", "url", "headers": {
  "Authorization": "Bearer …" } }` as the outside client.
- No MCP SDK is in the dependency tree. The subset this endpoint needs
  (initialize, ping, tools/list, tools/call, notifications) is small enough
  to implement directly over `node:http` in `packages/server`, with no new
  dependency.

## Decision

**Off by default, twice.** The endpoint needs remote access listening *and*
the separate **Accept MCP clients** switch (`mcpEndpointEnabled`, default
false) in **Settings → Remote access → MCP endpoint**. While the switch is
off the server installs no route: `/mcp` behaves like any other
unauthenticated path. Each client also has its own enabled flag.

**The same listener, no new port.** Like webhooks, the endpoint rides the
remote-access server's bind (`localhost` by default) and port. The
guidance stands: keep the listener off the public internet and put HTTPS in
front of it.

**A dedicated token per client, never the remote credential.** The route is
matched before the remote credential check and never consults it. The
remote token, the password cookie, and a `?t=` query neither authenticate an
MCP call nor are needed for one; a client token never opens the app.
Each client has a 256-bit random token behind a recognizable prefix
(`ompui_mcp_` + `randomBytes(32)` base64url), presented only as
`Authorization: Bearer`. A token in the query string is never read.

**Only the token's hash is stored.** Unlike a webhook secret, omp-ui never
needs a client token back, so main keeps its SHA-256 in `mcp-clients.json`
beside `registry.json`, written `0600`. Lookup compares SHA-256 digests with
`timingSafeEqual` against every client. The plaintext reaches a client
exactly once, in the reply to create or rotate; `mcp-endpoint:state` carries
no token. Because a stored hash opens nothing, no OS credential store is
required. The diagnostics bundle reads neither `mcp-clients.json` nor the
call log. Unknown, disabled, and absent tokens answer the same bare `401`
and are not audited, so an anonymous caller cannot fill the log.

**Scopes mirror the Fleet access rungs.** Each client holds one cumulative
scope ([ADR-0062](0062-fleet-exec-runs-one-command-on-the-owners-shell.md)'s
ladder, cut to what the endpoint exposes):

| Scope | Like rung | Tools |
| --- | --- | --- |
| `read` | Observe | `list_machines`, `list_projects`, `list_sessions`, `session_status` |
| `dispatch` | Dispatch | the above plus `start_session` |
| `send` | Dispatch | the above plus `send_to_session` |

`tools/list` shows only what the scope allows, and every `tools/call`
re-reads the client's record, so a scope narrowed or a client disabled
mid-session takes effect on the next call. A new client starts at `read`:
least privilege until the user chooses more. There is no exec, project
management, update, or finish tool; those stay agent-only behind their own
grants.

**Sessions it starts are Fleet dispatches with an `mcp` requester.**
`start_session` translates its arguments with the same
`fleetToolDispatchRequest` the `omp-ui_fleet_dispatch` tool uses and runs
`FleetDispatcher.dispatch`, so this computer and a joined fleet member take
the same path and a member applies its own dispatch-rung gate.
`FleetRequester.kind` gains `"mcp"`, with the client id in `sourceTabId`. A
session an MCP client starts:

- starts in **Plan** mode unless the call passes `planMode: false`, so a
  prompt from outside meets the read-only plan gate before anything is
  written; choosing Build is the caller's explicit decision, as with
  webhooks;
- never gets the `omp-ui_fleet_*` host tools, whatever **Agent dispatch**
  says, because its prompt comes from an outside sender;
- shows **Started by an MCP client on <host>** in its HUD and the Fleet list.

A member running an omp-ui without the `mcp` kind refuses the spawn, and the
call reports that refusal.

**Send reaches only what the client started.** `send_to_session` takes
`omp-ui_fleet_send`'s route (ADR-0069): `FleetDispatcher.send` with
requester kind `mcp`, the proxied `fleet:send`, `FleetServer.send`, then
`SessionManager.fleetSend`, which now requires the recorded requester's
kind, instance, and id to all match. An MCP client id therefore never stands
in for an agent tab, nor the reverse. A session another client or the user
started reads the same as a missing one. The child sees the message prefixed
"Message from the MCP client that started you".

**Reads exclude private sessions and chats.** `list_sessions` and
`session_status` see project sessions on this computer and every joined
instance, never a private session (#852) or a chat. The latest reply is the
owner-rendered session summary the Fleet result uses.

**Bounded spending.** Each client has an optional limit of session starts
plus sends per hour (default 6 on creation, cleared means none), and the app
allows at most 60 per hour across all MCP clients, the webhook ceiling's
reasoning: each start spends the user's money. Over a limit the tool answers
with a refusal. The limits live in memory and reset on restart.

**Every call is audited.** Main keeps the last 200 calls in
`mcp-calls.json` (`0600`): time, client, remote address, tool, the session
or project the call named, outcome (`ok`, `refused`, `forbidden`,
`rate-limited`, `error`), detail, and duration. **Recent MCP calls** in the
settings section lists them live. Never recorded: prompts, messages, other
arguments, or the token.

**Transport.** Stateless streamable HTTP with JSON responses only: one POST
carries one JSON-RPC message, notifications answer `202`, GET and DELETE
answer `405`, and no `Mcp-Session-Id` is issued. `initialize` echoes a
supported revision (`2025-11-25`, `2025-06-18`, `2025-03-26`) or offers the
newest. A request with an `Origin` header naming another host answers `403`
(the spec's DNS-rebinding guard), so a web page cannot drive the endpoint
even with a token. Bodies are capped at 1 MiB, enough for a full prompt.

**Copy MCP URL.** The settings section shows `<listener origin>/mcp`.
Right after create or rotate, **Copy MCP URL** puts the URL and an
`mcpServers` entry with the real token on the clipboard; on a saved client
it copies the same snippet with a `YOUR_TOKEN` placeholder, because the
token is not kept.

## Rejected alternatives

- **Accepting the remote token or password.** That is full control of the
  host; pasting it into a third-party app's config hands the app everything,
  and revoking it signs out every browser. A scoped token limits a leak to
  that client's tools and is revoked by itself.
- **Encrypting tokens with `KeyCipher`** (the webhook discipline). Nothing
  needs the plaintext back, so a hash is strictly safer and works on a
  machine without an OS credential store.
- **A separate listener or port.** A second bind decision and nothing
  gained over the existing listener and its HTTPS guidance.
- **Exposing every `omp-ui_fleet_*` tool.** Exec, project management,
  updates, and finish act on machines rather than sessions; the issue asks
  for the session subset, and the rest keep their own grant ladder.
- **Build mode by default.** A prompt from an outside app is less trusted
  than the user's own; Plan keeps it read-only until the user approves.
- **Server-sent streams and MCP sessions.** No tool needs server-initiated
  messages; a stateless endpoint has no session table to bound or expire.
- **A dependency on the MCP SDK.** The protocol subset is small, and
  `packages/server` stays dependency-light.

## Consequences

- An outside agent can start and follow work in omp-ui with nobody at the
  keyboard, at the cost of an always-reachable path on the listener while the
  switch is on.
- A holder of a `dispatch` or `send` token can start sessions in any project
  on any ready fleet machine, up to the limits, with prompts of its choosing.
  Plan mode and the missing fleet tools reduce what such a prompt can do;
  they do not make it trustworthy.
- `read` exposes session titles and latest replies of every non-private
  project session, across the fleet. Keep private work in private sessions.
- Without HTTPS a token crosses the network in the clear; the endpoint
  inherits remote access's guidance to keep the listener on localhost or
  behind a terminator.
