# Session-scoped approval mode rides a config overlay, not the CLI flag

> **Status:** Accepted, 2026-09-29 ([#681](https://github.com/LankfordAI/omp-ui/issues/681)).

omp gates its tools through `tools.approvalMode` — `always-ask` (every tool
waits for the user), `write` (mutating tools wait), `yolo` (nothing waits;
the resolved value when the key is absent). omp-ui spawned every native
session with no approval flag and no overlay, so every one of them ran
**yolo** whatever the user's own omp config said. This adds a per-session
pin with an explicit inherit state, and a dedicated **Approval card**
(CONTEXT.md) for the prompts the pinned tiers produce.

Verified against the omp 18.4.2 binary:

- The per-run switch exists — `--approval-mode=<always-ask|write|yolo>`,
  "Override tools.approvalMode for this session" — bound at process start
  through the same one-way `settings.override` rail as `--advisor`. There is
  no rpc setter and `get_state` reports nothing about it.
- An approval crossing rpc-ui is an ordinary `extension_ui_request` with
  `method: "select"`, options `["Approve", "Deny"]`, and a title built by
  `formatApprovalPrompt`: `Allow tool: <name>`, optional `Origin: MCP server
  tool` / `Reason: <policy>` lines, then the tool's argument details, and a
  `Provider safety checks:` block when a safety run preceded. The runner
  compares the answer against the single string `"Approve"`; anything else
  denies. The richer `Allow once / Always for this session` set is TUI-only —
  no rpc verb remembers a session-wide allow.

## Why not the obvious routes

- **The `--approval-mode` flag.** It would need a change to both argv
  builders (`spawnInner` rpc and pty) and to the `spawn-request.ts` allowlist
  every spawn request passes — three touch points for a value that is a
  record field like `advisorModel`. It also cannot express "inherit": an
  absent flag would still leave today's problem untouched (which is exactly
  omp's config deciding, so it is not wrong — but the overlay records the
  same fact and deletes its own artifact when the session has nothing to
  say).
- **A dialog variant on the generic host.** The frame is a plain blocking
  `select`; special-casing it inside `ExtensionDialogHost` would couple the
  card's lifecycle to the multi-select series machinery and give main no
  reason to keep counting it as a dialog. A router branch into its own
  store slot keeps `pendingDialogs` / `awaitingHumanAnswer` (issues #436,
  #555) byte-identical and reuses the `propose_experiment` precedent
  (issue #567) instead of inventing a second split.

## Decision

**Per-lineage `--config` overlay on the ADR-0005 rail; four-state control
with null = inherit.**

- `packages/core/src/approval-overlay.ts` writes `omp-ui-approval.yml`
  (`tools:\n  approvalMode: <tier>\n`) into the session's lineage dir from
  the record's `approvalMode` field; a null mode removes the artifact, so a
  session that never pinned a tier inherits omp's global/project config
  untouched — the same null-pin rule as the advisor and default-model
  overlays. `writeSessionOverlays` collects it, which covers both argv
  builders and every resume/relaunch identically; no builder or
  spawn-request change.
- `OwnedSessionRecord.approvalMode: ApprovalMode | null` is
  required-with-null (the #294 convention): absent normalizes to null at
  parse time, an enum-invalid value drops the record, and a future build's
  extra field is ignored by an older one. The `session:setApprovalMode`
  channel records the choice and relaunches a live session with `--resume`;
  there is deliberately no project last-used mirror — a new session inherits
  omp's config, not what some earlier session was pinned to.
- Defaults stay in omp's own config (ADR-0025). Settings gains one
  allowlisted-but-ungrouped key (`tools.approvalMode`, following the
  Subagent-concurrency pattern) edited at the Global layer via
  `omp config set` and at the Project layer via `project-config-writer`;
  clearing the project key falls back to global.
- The card is a `frame-reduction` router branch guarded by all three parts
  of omp's own protocol — method `select`, options exactly
  `["Approve","Deny"]` after label normalization, and a title starting
  `Allow tool: ` — so an extension coining the wording or an omp growing the
  option list renders the generic dialog instead. Close and Escape answer
  `"Deny"`, matching the stance `plan-extension.ts` already states for plan
  gates: a dropped dialog is a refusal.

The consequence is stated in the UI, not hidden: changing the mode
**relaunches** the session, because omp binds the setting at process start;
PTY sessions get the same overlay but show their prompts in their own
embedded TUI; subagents are governed by the user's `tools.approval` policy
only — the session mode never reaches them.

## Amends / relates

- ADR-0005 (record-true overlays written at spawn) — same rail, fourth key.
- ADR-0025 (config truth lives in omp) — the Settings section edits omp's
  layers and stores nothing of its own.
- ADR-0028 (broadcast + proxy) — the new session channel rides the tab-routed
  proxy set; project channels stay host-local like the concurrency pair.

## Amendment (2026-10, issue #883)

omp 18.11.3 grew the rpc approval select to three options:
`["Approve", "Approve <policy key> for this session", "Deny"]`. omp's runner
maps the answered label to once/session/deny and grants the session-wide
allowance only when the reply equals its own composed label exactly — a
reconstruction or a bare `"session"` string is a silent deny.

omp-ui's recognizer (`packages/core/src/approval.ts`) accepts both option
shapes structurally, with no version fingerprinting: the three-option frame is
itself proof of a session-capable harness, and an older omp never emits one.
There is deliberately **no `MIN_SUPPORTED_OMP` bump and no version gate
constant** — registering an 18.11.3 gate in `harness-floor.test.ts` would
force the floor from 18.8.8 to 18.11.3, deleting the two-option case that is
live under the current floor. The card answers "session" by echoing the
frame's verbatim middle label (`ApprovalPrompt.sessionLabel`), never a
rebuilt string.

## Amendment (2026-10, issue #950)

omp 18.12.3 added a fourth tier, `always-ask-cached` (Ask and remember): every
tool still waits, but the approval select can offer grants that omp records
in its approval cache for this session or for every session. omp-ui pins it
through the same `--config` overlay as the other three tiers;
`APPROVAL_MODES` in `packages/core/src/approval.ts` is the single list.

The grant shape inserts pairs before `Approve Once`: a folder grant
(`Approve Directory: <dir>` / `Always Approve Directory: <dir>`) and/or a
target grant (`Approve <target>` / `Always Approve <target>`), folder first,
then `Approve Once`, an optional session label, and `Deny`. The recognizer
locates `Approve Once` first and reads the pairs before it, because the
target label can be a bare `Approve` — the same word the older shapes use for
"once". Any other arrangement is rejected and falls back to the generic
dialog. As with #883, the card replies with the frame's own label verbatim
(`approvalReply`); omp honours a grant only on exact equality.

The approval card needs no version gate: a grant-shaped frame is itself proof
that the harness understands grants. The mode picker does need one
(`ASK_AND_REMEMBER_MIN_OMP`): an older omp reading an unknown
`tools.approvalMode` falls back to yolo, so offering the tier there would
silently remove every prompt. Unlike #883, registering this gate raises
`MIN_SUPPORTED_OMP` to 18.12.3. That costs nothing live: 18.12.0–18.12.2
emit no approval shape that 18.12.3 does not, so the bump removes no case the
card handles today. Remembered approvals are cleared with omp's
`/forget-approvals`, sent from Settings → omp → Tool approval when the focused
session advertises it.
