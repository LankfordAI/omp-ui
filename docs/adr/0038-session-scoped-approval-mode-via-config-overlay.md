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
