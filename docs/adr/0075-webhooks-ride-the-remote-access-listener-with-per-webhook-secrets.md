# Webhooks ride the remote-access listener with per-webhook secrets

> **Status:** Accepted, 2026-10-30 ([#997](https://github.com/LankfordAI/omp-ui/issues/997)).

A **Webhook** (CONTEXT.md) lets an outside event — a pull request opened, a
failed deploy, a `curl` from a script — start a session. Each one is an
endpoint `POST /webhooks/<id>` on the embedded remote-access server. A
delivery that authenticates starts one fresh native session with a prompt
built from the webhook's template and the request body.

This is the first omp-ui surface meant to take requests from senders the user
does not control. Remote access (issue #37, [remote-access.md](../remote-access.md))
and remote instances ([ADR-0028](0028-remote-instances-joined-by-main-process-proxy.md))
assume every caller is the user, holding the password, the token, or a
derived credential with full control of the host. A webhook sender is not
the user, gets no control, and its body is attacker-controlled text that
ends up in an agent's prompt. This ADR records the trust model.

## Decision

**Off by default, twice.** Webhooks need remote access listening *and* the
separate **Accept webhooks** switch (`webhooksEnabled`, default false) in
**Settings → Webhooks**. While the switch is off the server installs no
route: `/webhooks/…` behaves exactly like any other unauthenticated path
(401, or the sign-in redirect for a GET). Each webhook also has its own
enabled flag.

**The same listener, no new port.** Webhooks ride the remote-access
server's bind (`localhost` by default) and port. A second listener would be
a second surface to bind, document, and forget. The guidance for remote
access stands: keep the listener off the public internet, and put an HTTPS
terminator or tunnel in front of it; for webhooks, forward only the
`/webhooks/` path prefix.

**Per-webhook secret, never the remote credential.** The route is matched
before the remote credential check and never consults it: the remote token,
the password cookie, and a token query parameter neither authenticate a
delivery nor are needed for one, and a delivery's secret never opens the
app. Every webhook has a 256-bit random secret (`randomBytes(32)`, base64url)
and an auth kind:

- **HMAC** (`X-Hub-Signature-256: sha256=<hex>`, GitHub's format): the
  HMAC-SHA256 of the raw body under the secret. Compared with
  `timingSafeEqual` over the decoded digest.
- **Bearer** (`Authorization: Bearer <secret>`): both sides SHA-256-hashed
  and compared with `timingSafeEqual`, so length leaks nothing. Never
  accepted from a query parameter — URLs land in proxy logs and history.

The webhook id in the path is 128 random bits. It is an address, not a
credential: it appears in URLs and logs, and knowing it gains nothing
without the secret. An unknown id, a disabled webhook, an unreadable secret,
and a bad signature all answer the same bare `401`, so the endpoint does not
reveal which ids exist.

**The secret is shown once.** Main encrypts it with the OS credential store
(`KeyCipher`, the `provider-keys.json` / `remote-instances.json` discipline)
into `webhooks.json` beside `registry.json`, written `0600`. Creating a
webhook is refused when no OS credential store is available, rather than
storing a secret in the clear. The plaintext reaches a client exactly once,
in the reply to create or rotate; `webhooks:state` carries only
`secretReadable`. A blob that no longer decrypts keeps its webhook,
answers `401`, and asks for rotation. The diagnostics bundle reads neither
`webhooks.json` nor the delivery log.

**The body is data, fenced and labelled.** The prompt is the template, then
a fixed notice that what follows is untrusted outside input to be treated as
data and never as instructions, then the body inside a code fence longer
than any backtick run in the body, tagged with the webhook name, the
event header (`X-GitHub-Event`), content type, and byte count. The body is
appended, never substituted into the template, so a payload cannot land
mid-instruction. Bodies must be UTF-8 text of at most 64 KiB; larger ones
answer `413`, undecodable ones `400`.

**The session is a Fleet dispatch with a webhook requester.** The delivery
goes through `FleetDispatcher.dispatch` with one explicit pick
(`machineKey`, `projectCwd`), so this computer and a joined fleet member
take the same path, the owner delivers the prompt on its own
`initialCommands` rail ([ADR-0061](0061-fleet-dispatch-rides-the-spawn-request.md)),
and a remote owner applies its own dispatch-rung gate. `FleetRequester.kind`
gains `"webhook"`. A webhook-started session:

- never gets the `omp-ui_fleet_*` host tools, whatever **Agent dispatch**
  says — a prompt-injected payload must not fan work out across machines;
- follows the project's model chain, like a user dispatch;
- shows **Started by a webhook on <host>** in its HUD and the Fleet list.

A member running an omp-ui without the `webhook` kind refuses the spawn; the
delivery records that failure. New webhooks default to **Plan** mode, so an
injected payload meets the read-only plan gate before anything is written;
choosing Build is an explicit decision.

**Bounded intake.** Each webhook has an optional limit of accepted
deliveries per hour (default 6 on creation, cleared means none), and the app
accepts at most 60 deliveries per hour across all webhooks — a ceiling the
issue did not ask for, kept because each delivery spawns an agent that
spends the user's money. Over a limit the answer is `429` with
`Retry-After`. A repeated `X-GitHub-Delivery` id seen in the last 500
deliveries answers `200` without starting anything, so a replayed GitHub
delivery cannot start a second session. An accepted delivery answers `202`
with its delivery id before the session starts; the caller learns nothing
about the host, the project, or the outcome.

**Every delivery is audited.** Main keeps the last 200 deliveries in
`webhook-deliveries.json` (`0600`): time, webhook, client address, event
header, byte count, HTTP status, and outcome (`started` with its tab,
`unknown`, `failed` with the message, `unauthorized`, `rate-limited`,
`duplicate`, `bad-request`). Unknown ids are not audited — they would let an
anonymous sender fill the log. Never recorded: the body, the headers, the
secret.

## Rejected alternatives

- **Accepting the remote token or password cookie.** The remote credential
  is full control of the host; pasting it into a third-party service's
  webhook settings hands that service everything. A per-webhook secret
  limits a leak to starting sessions with that webhook's fixed template, and
  rotation revokes one sender.
- **A secret in the URL** (`/webhooks/<id>?token=…`). Every proxy and
  access log would hold it.
- **Per-IP lockout after failed signatures** (the `/login` throttle). A
  256-bit secret cannot be guessed, so lockout adds no protection — and
  behind the recommended forwarding proxy every sender shares one address,
  so anyone with the URL could lock out the real deliveries.
- **A separate listener or port** for webhooks. More surface, a second bind
  decision, and nothing gained: forwarding only `/webhooks/` in the
  terminator already separates the paths.
- **Template placeholders** (`{{body}}`). Substitution lets a payload sit
  inside the user's instructions; appending after a fixed notice keeps the
  boundary visible to the model.
- **Configuring webhooks in Project settings.** The endpoint, its secrets,
  and its listener belong to this host (ADR-0028 keeps remote-access
  channels host-local), while Project settings follows a remote project to
  its owner. Each webhook still names exactly one project.

## Consequences

- An outside event can start work with nobody at the keyboard, at the cost of
  an always-reachable path on the listener when the switch is on.
- A sender that knows a secret can start sessions on that webhook's project
  up to its limits, each with whatever it puts in the body. Plan mode, the
  untrusted-data notice, and the missing fleet tools reduce what a
  prompt-injected payload can do; they do not make the body trustworthy.
- HMAC has no timestamp: an attacker who captured a delivery can replay it
  outside GitHub's delivery-id dedupe window. HTTPS in front of the
  listener is what keeps deliveries from being captured.
- The rate limits and the dedupe window live in memory; an app restart
  resets them.
