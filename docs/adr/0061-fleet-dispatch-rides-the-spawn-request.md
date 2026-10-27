# Fleet dispatch rides the spawn request; the owning instance delivers the first prompt

> **Status:** Accepted, 2026-10-20 ([#899](https://github.com/LankfordAI/omp-ui/issues/899)).

A **Fleet** (CONTEXT.md) is this app plus every joined **Remote instance**
(ADR-0028). A **Fleet dispatch** starts a fresh native owned session on one
fleet member and gives it a first prompt, so a user — or, with consent, an
agent — can put work on whichever machine has the repository and the spare
capacity, several copies at once if asked. The hard part is not starting the
session; it is making the prompt land exactly once on a session the
dispatching app does not own, across a link that can drop at any moment.

Facts that shape the design:

- `session:spawn` already crosses the remote proxy (ADR-0028) and answers
  with the new `tabId` once the owner has written the record. It resolves
  before the omp child is ready to take a prompt.
- `rpc:send` is an unacknowledged notify. There is no per-tab ready latch a
  dispatcher could wait on, so a prompt sent from outside the owner can
  arrive before the child is listening, or never arrive at all.
- The owner already has a reliable pre-turn rail: `initialCommands` rides
  every rpc-ui spawn and resume, and each command is answered by a response
  correlated by id (the rail ADR-0043 host tools and ADR-0060's Ask chat
  title use).
- A dispatcher-side failure after the spawn is acknowledged — the
  dispatching app quitting, the proxy socket dropping — would leave a remote
  session with no prompt and nobody responsible for sending one.
- The standalone headless host that a central queue would need was tried and
  reverted (#479).
- Paths are host-local: the same repository sits at different absolute paths
  on different machines, so only a repository key (`host/owner/repo`,
  lowercased, from the checkout's web remote) can say two projects are the
  same work.

## Why not the obvious routes

- **Renderer spawns, then sends the prompt.** The renderer is one of several
  clients and may close mid-dispatch; an agent-requested dispatch has no
  renderer at all. It also inherits every problem of the next route.
- **Main spawns, waits for ready, then `rpc:send`s the prompt.** `rpc:send`
  is fire-and-forget, nothing signals readiness per tab, and `spawnSession`
  resolves before the child is ready. A dispatcher disconnect between the
  spawn and the send strands a prompt-less session on the owner.
- **A central queue or daemon** that machines pull work from. It needs a
  persistent process outside every app — the shape #479 reverted — plus its
  own state, credentials, and failure model, for a fleet that is at most a
  handful of machines one user already joined.

## Decision

**The dispatch prompt rides `session:spawn` as `NewRpcSpawnRequest.fleet`,
and the owning instance delivers it on its own `initialCommands` rail as the
last command before the first turn. Once the owner accepts the spawn, it owns
delivery.**

- `fleet = { dispatchId, batchId, title, prompt, requestedBy }` is accepted on
  new rpc-ui requests only; `parseSpawnRequest` refuses it on terminal, chat,
  and resume requests and alongside plan implementation or an experiment, so
  a dispatched session is always a native project session.
- The owner writes the record with `fleet: { dispatchId, batchId,
  dispatchedAt, requestedBy }` (required-with-null, the #294 convention; a
  branch or fork of a dispatched session is not the dispatch and carries
  null) and stages the prompt as `fleet-prompt.md` in the lineage dir beside
  the record. A dispatched spawn is never adopted from the warm pool.
- On spawn, after every other `initialCommands` entry, the owner pushes
  `set_session_name` with the title while the session is unmaterialized, then
  `prompt` with the staged text under id `omp-ui-fleet-prompt-<dispatchId>`.
  A successful response deletes the artifact; a failed response keeps it and
  logs. The staged artifact is the not-yet-acknowledged marker: a crash
  before the acknowledgement re-sends the prompt on resume, and an
  acknowledged prompt is never sent again.
- **Dedupe by `dispatchId`.** The owner checks for an existing record with
  that id, then an in-flight spawn with that id, before its first
  asynchronous step, and answers either with the existing `tabId`. A second
  spawn with the same id never starts a second process.
- **No automatic retry.** A remote spawn that fails with *remote connection
  lost*, or gets no answer before the dispatcher's deadline, has an *unknown*
  outcome: it is listed as pending on the dispatching app until a session with
  its `dispatchId` appears in that instance's state, or the user dismisses
  it. Retrying is the user's choice and is safe because it reuses both the
  `dispatchId` and the `batchId`, so the owner's dedupe turns a spawn that did
  land into a no-op.
- **Placement runs in the dispatching app's main process**
  (`FleetDispatcher`), from host reports each member answers on the proxied
  `fleet:hostReport` channel. The score is T3 Code's
  `chooseLoadBalancedEnvironment` formula (pinned at `7e289ae`):
  `weight × cpuCount × (1 − cpuUtilization) × (availableMemory /
  totalMemory)`, with the placement preference's weight (Prefer 100,
  Normal 50, Less often 25, Manual only 0). A candidate scores 0 — ineligible
  — when its report is older than 15 s by the dispatcher's own clock or
  stamped more than 5 s in its future, its CPU is unknown or at or above 95%,
  its free memory is 5% or less, or its weight is 0. Candidates are machines
  whose report lists a project with the reference project's repository key and
  a ready model provider; a reference project with no repository key can only
  run on its own machine. Automatic placement picks distinct machines, best
  score first, and refuses the whole request, naming how many machines are
  eligible, when fewer qualify than copies asked for. *Amended (#943):
  `omp-ui_fleet_dispatch` with no `machines` and one copy starts on this
  computer when this computer is ready, is not Manual only, and holds the
  project with a ready model provider; only otherwise, or for more than one
  copy, does it use automatic placement. The New session dialog's auto runs
  keep load-based placement.*
- Only `fleet:hostReport` and `fleet:sessionSummary` cross the proxy;
  `fleet:machines`, `fleet:dispatch`, and the rest of the orchestration stay
  local to the dispatching app, so a dispatch never fans out from a remote.
- **Tool consent.** `omp-ui_fleet_machines`, `omp-ui_fleet_dispatch`, and
  `omp-ui_fleet_status` are host tools (ADR-0043, ADR-0048) registered only
  while the user has turned on *Let agents dispatch fleet work* (off by
  default), applied at the session's next spawn or resume. Every call runs at
  omp's `exec` host-tool approval tier; omp-ui adds no confirmation channel of
  its own. A remote-owned session's tools answer from that host's own fleet,
  because the host that owns the session answers its host calls. A later
  amendment (#901) added `omp-ui_fleet_exec` and `omp-ui_fleet_project` under
  this same gate, five tools in all; see ADR-0062. *Amended (#942):
  `omp-ui_fleet_dispatch` takes an optional `planMode`, default false, so an
  agent can start read-only planning sessions; the owner's existing order
  (plan arm before the fleet prompt) applies unchanged.* *Amended (#945):
  every **Chat** registers the fleet tools on each spawn and resume
  regardless of the setting; the setting now governs project sessions only.
  A chat is never dispatched, so no recursion is unaffected.*
- **No recursion.** A session an agent dispatched (`requestedBy.kind:
  "agent"`) never gets the fleet tools, so a dispatched agent cannot dispatch
  further.

## Consequences

- Delivery survives the dispatcher: once `session:spawn` is acknowledged,
  the dispatching app can quit or lose the link and the owner still delivers
  the prompt, including after its own crash.
- Dispatching requires a current omp-ui on both apps. An older remote answers
  `fleet:hostReport` with an unknown channel and is shown as *unsupported*;
  it is never a placement candidate.
- The title lands through `set_session_name`, so it is a user-source title
  in omp's header; omp-ui's own auto-titling never runs for a dispatched
  session.
- Machines on different commits of the same repository are warned about,
  not blocked: each worktree starts from its own machine's checkout.
- An unknown outcome can sit in the pending list until the remote reconnects;
  the user decides between waiting, retrying, and dismissing.

## Amends / relates

- ADR-0028 (remote instances joined by the main-process proxy) — dispatch
  reuses the proxied `session:spawn`; two read-only fleet channels join the
  allowlist, orchestration stays local.
- ADR-0043 / ADR-0048 (host tools) — the fleet tools follow the vault tools'
  registration and approval rules, gated by a setting instead of the vault
  registry.
- ADR-0059 (chats) — a dispatched session is never a chat.
- ADR-0003 (per-lineage session dirs) — `fleet-prompt.md` lives in the
  lineage dir and dies with it.
- #479 — the reverted persistent-host split rules out a central queue.
