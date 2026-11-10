# Session-authored artifact library and scoped data

> **Status:** Accepted, 2026-11-09 ([#1121](https://github.com/LankfordAI/omp-ui/issues/1121)). Default-off experiment. Refresh destination amended by [ADR-0091](0091-artifact-refresh-now-runs-in-a-background-session.md); refresh draft path and wire order amended by [ADR-0092](0092-artifact-refresh-requests-ride-the-prompt-as-a-parsed-block.md).

Artifacts are authored and revised in ordinary native sessions. Human Keep retains an accepted document and its structured working data in an independent main-pane library; it does not rewrite the transcript or create a special artifact session. Project and Chat are retained origin labels, not ownership or deletion boundaries. There is no standalone builder, New artifact wizard or narrow Revise commissioning form.

## Independent owner and durable data

One library belongs to one app registry instance, rooted beside that registry, not to a project, lineage or OMP profile. Use built-in `node:sqlite` in core for a separate app-owned database. Core remains Electron-free. Reject multi-file publication and handwritten PID-lock recovery: a committed SQLite host/PID/nonce lease and synchronous `BEGIN IMMEDIATE` transactions serialize ownership, quotas, CAS heads, deletion and reclamation.

Code revisions, composite data snapshots and payloads are immutable. User state uses per-key blobs; unchanged code/datasets are shared rather than recopied. Captured datasets carry credential-free provenance and refresh instructions, with reported capture time distinct from host receipt time. Reported lineage is not verified lineage. Only acknowledged saves are durable; arbitrary JavaScript closures and DOM storage are not captured.

Native session/tool identities are main-reported facts, nullable when unknown at receipt. A fresh session can capture before its native header materializes; immutable provenance keeps that identity unknown rather than inventing an ID or retroactively rewriting a payload. Separately retained source metadata can adopt a later observed session identity.

Keep is idempotent for the main-trusted source. Accepted data and reference grants survive source/project removal; only unkept drafts and unfinished captures follow source cleanup. Independent tombstones prevent deleted associations from returning, including after an initially unknown native session ID materializes. Unknown schemas, foreign owners, corruption and unsafe storage paths report Unavailable instead of resetting the store. Logical retained payload plus metadata is capped at 256 MiB per artifact and 1 GiB globally, without claiming that SQLite pages/WAL have those physical bounds.

Storage checks enforce regular files, no symlinks or extra file hard links, stable filesystem identity, and native UID ownership where available. POSIX also requires exact owner-only directory/file modes (0700/0600). Windows uses inherited user-profile ACLs; its emulated stat mode bits cannot establish POSIX permissions and are not used for that check.

## Direct admission and file-backed authoring

Only a positively observed direct assistant call to `omp-ui_render_html` may
stage a render. ADR-0043's input-order admission rejects nested or unproven
calls before file access or staging. It does not remove existing orphan rows.

Source identity is the SHA-256 of the original render arguments serialized as
sorted-key JSON. Object keys sort recursively; array order and original values
remain unchanged. Main captures this hash before the first asynchronous read,
before title/height normalization, provenance stamps or `valueFile` resolution.
The resolved authoring envelope is separate and never changes the transcript
arguments or their source identity.

For `omp-ui_render_html` only, each managed dataset supplies exactly one of
inline `value` and `valueFile`. Main resolves file-backed JSON before validating
the complete managed envelope and staging a draft. Persisted dataset contracts
still contain `value` only. Retained drafts, kept code/data and source lookup
use that durable resolved payload; changing or deleting the source file cannot
change a previously staged dataset. Keep and refresh Apply remain human actions.

File resolution requires a captured native session ID and its captured
transcript path. The transcript filename must end exactly in
`_<sessionId>.jsonl` or `_<sessionId>.jsonl.gz`, and its real path must stay
directly inside the captured active or archive lineage. Strip that transcript
extension and append `/local` to obtain the one permitted session-local root. A
shared lineage, project directory, sibling session's local directory or newest
transcript is not an alternative root. Missing paths fail; import never creates
directories or guesses a substitute session. Symlink substitutions for the
session-artifacts directory or its `local` directory are refused.

`valueFile` is a literal relative `local://` path; percent signs are not
decoded. Empty, absolute, drive, backslash, NUL, query, fragment, `.` and `..`
paths are refused. Reads must stay strictly within that exact root and target a
regular file. A target symlink that resolves inside the same root is allowed,
but the final open uses no-follow semantics and verifies the opened file against
the checked target. Main bounds raw bytes at 8 MiB, decodes strict UTF-8 without
a BOM, parses JSON and applies the normal JSON depth, dataset, provenance and
complete-envelope limits after materialization. It rechecks root confinement,
identity and size after reading, so a replacement or growing file conflicts
instead of staging ambiguous data.

Main owns cancellation and checks the captured owner/session/runtime, gate
epoch and host request authority throughout the read and immediately before
staging. Cancellation, timeout, session/process replacement or disabling the
experiment cannot publish a late draft. Import errors do not echo file content.

Plain cards replay their transcript arguments. A historical managed call with
`valueFile` and no retained resolved payload is unavailable. Main must not
reconstruct it by reading the path again. Capture tools do not accept
`valueFile`, and guest code receives no file-reading API.


## Human publication and session-mediated refresh

Model tools stage documents and captures only. Keep, compatible code acceptance, capture Apply, discard and deletion are human backend operations. Compatible acceptance checks the exact declared protocol/state/dataset contract and current code base, then retains current working data, including edits made after the proposal's reference. Stale or incompatible proposals cannot replace the accepted artifact; Keep as new remains independent.

Refresh chooses datasets and an ordinary same-owner destination. An explicitly new destination is unseeded and background; preparation appends a removable reference and editable request but sends nothing. The user's actual send binds the current runtime/session; dormant preflight checks authority without prematurely binding a nonexistent process. The agent repeats the capture using existing tools, access and mode permissions. It reports the complete selected set or explicit failure. Human Apply checks the code and selected dataset heads again and preserves manual state/untouched datasets. Failed/interrupted captures preserve the last good snapshot and dates; a turn with no capture remains Awaiting captured data. No connector platform, guest networking, scheduler or automatic command execution is introduced.

## Small immutable references

Artifact references extend ADR-0085's strict leading-block discipline, not its transcript paths. Wire order is session references, artifact references, annotations, prose, document context and routing suffix. At most eight references/12 KiB carry exact accepted code/data IDs, owning machine and recorded consent. They are read grants, not publication authority.

Saved-data consent is explicit and off by default. Definition reads omit initial state and dataset bodies; HTML can still contain sensitive bundled content, which the picker warns about. Main grants authorize bounded UTF-8 manifest/definition/provenance parts and consented state/dataset parts. Stored grant fields—not edited wire/query flags—control access. Old references remain fixed across saves, revisions and refresh, and deletion revokes resolution. Same-owner branches/rewinds can inherit an explicit handle; deleting its creation session does not revoke it.

Draft chips live outside RPC reset state and move through send/failed-send, queue, held, stash, seed, move and rewind restoration. Exact raw queue text remains the matching key. Explicit replacement retains the incoming immutable grant, including refresh's exact grant ID; racing/overflow restoration remains recoverable rather than silently discarding context. Navigation intent guards prevent slow resume/creation from stealing newer focus.

## Narrow managed preload amendment to ADR-0082

Only main-issued, script-enabled managed documents may receive the minimal artifact preload. It is a self-contained sandbox-compatible CommonJS entry with only the external Electron runtime import and type-only contracts. Plain documents keep the legacy no-preload renderer. Browser clients and scripts-off presentation stay script-free.

Main mints a unique canonical document and 30-second single-use admission ticket, then binds literal hello to the actual webview/root main frame, locked session, exact document, owner and gate epoch. Hello starts during preload initialization, not the first later authored state call. No renderer HTML, storage path, preload preference or WebContents ID supplies authority. The guest exposes only `load()` and CAS `saveState()`; pre-IPC and main independently enforce rate/inflight/JSON bounds. One writable lease exists per draft or kept artifact. Commit authorization is synchronous immediately before COMMIT; receipts publish only afterward.

Each newly prepared surface keys a fresh webview attachment, because Electron installs preload admission arguments at attachment rather than later URL navigation. Legacy and managed keys remain separate. Theme changes and expansion keep the existing surface key and guest; only an actual source change or explicit Reload creates a new attachment.

This amends only ADR-0082's no-preload rule for that admitted managed path. Node integration remains off, context isolation and sandbox stay on, and the dead proxy including loopback, WebRTC UDP restriction, inline-only CSP, denied permissions/downloads/popups/navigation and no nested webviews remain. Theme updates do not reload managed code. External accepted heads revoke writers and preserve their visible old snapshot until explicit Reload.

Library and transcript expansion use the native dialog top layer around the existing guest, not a duplicate writer. Native modal focus containment covers cross-WebContents traversal, and a correlated guest Escape notice closes the owning expanded view. Theme admission accepts the application's curated CSS Color 4 palette while rejecting URL functions and bounding the complete stylesheet.

Generic desktop IPC validates the app root WebContents and non-null root main frame before dispatch, so non-root/guest pages cannot invoke human operations. Authenticated browser WebSockets retain their independent receiving-side path. Typed artifact failures survive Electron's error serialization as structured client rejections. Managed guests never receive the backend client, raw IPC, filesystem, credentials or session tools.

## Gate and client boundaries

The registry flag defaults false when absent or corrupt. Persist the flag, synchronously revoke the service epoch, start per-session roster reconciliation and broadcast authoritative state independently of individual registration results. Hot updates retain captured vault/fleet/device membership. Cold/warm factories resolve current options on their actual ready/arm rails, never an earlier asynchronous snapshot. Off also blocks new referenced prompts on renderer, held deadline/Send now/dormant and final spawn/send rails, retaining payloads and chips without retry loops. Already-sent OMP context cannot be retracted.

Authenticated browser clients use the owning host's library with static documents and trusted metadata/reference/review actions. Joined-instance libraries are not copied, merged or added to remote proxy channels. Foreign transcript cards direct the viewer to Artifacts on the owning host. Lite does not advertise the experiment and keeps artifact channels absent.

## Verification boundary

The deterministic store/reference/service/renderer suites accompany a packaged Linux headless Electron smoke and a real-OMP hermetic-provider live suite. The smoke runs actual shipped preloads/broker/guard/store across separate processes and observes network/STUN denial, authority attacks, durable checksums, write refusal, CAS and disable/reload behavior. Full application acceptance additionally exercises ordinary-session creation/Keep/reference/revision/refresh, source deletion, browser static presentation and responsive/focus/scroll behavior. Skipped or unavailable new obligations are not passing release evidence. HTML plans remain script-free and outside this experiment.

## Amendment: the artifact refresh block leads the wire (2026-11-10, issue #1139)

[ADR-0092](0092-artifact-refresh-requests-ride-the-prompt-as-a-parsed-block.md) amends §"Small immutable references": the wire order now leads with the artifact refresh block — artifact refresh, session references, artifact references, annotations, prose, document context and routing suffix. The refresh request is bounded by the same 12 KiB constant references use, with the same proven-leading-only strip discipline; a lookalike anywhere else in the message remains inert prose and admits nothing.
