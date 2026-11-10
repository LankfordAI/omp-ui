# Artifact refresh requests ride the prompt as a parsed block

> **Status:** Accepted, 2026-11-10 ([#1139](https://github.com/LankfordAI/omp-ui/issues/1139)). Amends [ADR-0090](0090-session-authored-artifact-library-and-scoped-data.md) §"Small immutable references" (wire order) and [ADR-0091](0091-artifact-refresh-now-runs-in-a-background-session.md) §5 (the draft path).

An **Artifact refresh** prepared against an existing session reached the model as a prose instruction paragraph plus a trailing `<artifact refresh>` tag naming a bare UUID, and nothing parsed it back: the run's first prompt rendered as a wall of instruction text forever. Every other wire attachment — **Annotations** (ADR-0077), **Session references** (ADR-0085), **Artifact references** (ADR-0090) — is stripped by the transcript derivation and rendered as chips in the user bubble. The refresh half was deliberately unparsed, so it stayed visible prose; and its draft path was editable text, so a user editing their own draft could corrupt the very sentence that named the request.

## Decision

**1. The grammar is the single formatting of the ask.** `withArtifactRefreshContext` builds the only accepted wire shape: a leading `<artifact refresh>` block whose second line is the fixed model-facing hint, then exactly four fields per entry —

```
<artifact refresh>
The user requested refreshed data for these accepted omp-ui artifacts. … Stage results with the omp-ui_artifact_capture tool using the exact request id recorded per entry; never apply a capture or change code.
- request: 3f6a1c2e-…
  artifact: 91ce4b70-…
  title: Q3 revenue dashboard
  datasets: orders-2026q3, refunds
</artifact refresh>

the typed draft
```

The instruction the old paragraph carried per request is folded into that constant hint line, the precedent both existing reference hints set: the parse requires the hint verbatim, and it is keyword-free so omp's tag-section masking stays inert inside the block. Arity is fixed at four fields — request id, artifact id, one-line title, dataset id list — and titles cannot inject lines or tags (CR/LF collapse, angle brackets stripped). At most eight entries are bounded by the same 12 KiB constant ADR-0090's references check their block against; `withArtifactRefreshContext` doubles as the attach-time validator, so a chip that would not round-trip never lands. `splitArtifactRefreshContext` peels only a proven leading block: malformed or misplaced lookalikes stay inert prose and bind nothing.

**2. Admission narrows from a scan-anywhere regex to a leading-block parse.** `admitPrompt` previously matched the terminal `<artifact refresh>` tag at any offset in the prompt text; that made a uuid pasted into any position of any message an admission input. Now only the leading block admits, and a forged leading block fails closed loudly: it parses (or does not) under the same grammar the builder produces, and a malformed one is prose — binding nothing and never silently skipping — while a well-formed one naming an unknown or mismatched request throws at the pairing check. Co-presence of the paired **Artifact reference** grant is still required, and because the draft path now carries the entry beside the grant the early return waits for both lists: a send whose refresh chip was removed still runs grant admission instead of skipping it, and a leading refresh that lost its paired grant reaches the pairing check and is refused there.

**3. A pending refresh stays bound to its prepared tab.** The entry lives outside RPC reset state like the grants, and every path names its handling — never a silent re-wrap into text:

| Path | Handling |
| --- | --- |
| Composer draft (typing, tab switch, refresh) | Survives; the chip renders from structural state |
| Queue (busy send) and Esc restore, same tab | Survives; the raw wire text is both the queue match key and the block source |
| **Held prompt**, same tab | Survives; re-admits at the reset send like today |
| Rewind edit-resend, same tab | Survives; re-admission re-binds idempotently |
| Stash apply into another tab's composer | Refused with a notice, mirroring `artifacts.reference.wrongMachine` — a refresh is bound to the session it was prepared for |
| Queue restore into a different tab | Dropped with a notice naming the loss |
| Session move (tab replacement) | Dropped with a notice |
| Background ask from a draft | Dropped with a notice; prepare a new refresh from the library |

Staleness is refused where it was always refused: `stageCapture`/`applyCapture` recheck `expectedDatasetHeads` (ADR-0091 §4). Preserving across same-tab paths renews nothing about heads.

**4. The draft path is structural.** The picker's "add to existing session" and the Refresh-now seed attach a removable reference chip plus a removable refresh chip (`attachArtifactRefreshDraft`) instead of writing editable prose; removal deletes the entry, it does not edit a sentence. Editability was the footgun: old drafts let the user's own keystrokes corrupt the binding the send depended on. The picker attach is atomic — grant and entry land together or not at all (validate the entry first, then the grant; a failed grant leaves no orphan entry), because half a refresh is exactly the unadmittable state §2 refuses.

**5. Legacy transcripts render the new card.** `splitLegacyArtifactRefreshRequest` recognizes the pre-ADR-0092 terminal form only when both halves are present — the text starts with the exact old instruction sentence and ends with its closing `<artifact refresh>` request-id block (after the reference peels, since the old builder wrapped them around it) — and the transcript derivation renders it as the same compact **Artifact refresh** card the new form shows ("Data refresh requested"; the old grammar named no datasets, so legacy cards carry none). When exactly one paired grant rides the same message the card recovers its artifact (every genuine old refresh carried its one reference); otherwise it renders display-only from the request id. A three-member council consult split on this: one member preferred leaving old transcripts untouched; the majority carried the strip, reasoning that the choice is cosmetic either way — the legacy form can never re-bind, so the recognizer changes display only. Honesty note: saved transcripts keep the raw wire byte-for-byte, hint lines included; omp-ui folds away only text omp-ui itself authored during display, and misplaced lookalikes of even this grammar stay visible prose.

**6. Wire order, amended.** The artifact refresh block wraps outermost — leading, ahead of session references: refresh, session references, artifact references, annotations, prose, resolved-mention blocks, attached-documents block, image routing suffix. `promptWireText` remains the one builder for `sendPrompt`, `abortAndPrompt` and `holdPrompt`. The renderer's single owner of the peel order is now `splitWireBlockStack` in `lib/wire-blocks.ts`; before it, three hand-duplicated strip chains drifted — that drift is how refresh fell out of the transcript. Core keeps its own admission peel (refresh → session references → artifact references), and a contract test pins the two orders against each other. Upgrade race: a queue entry written by an older build wraps the legacy form mid-message, so after restore it displays as the card but binds nothing on promote — accepted, the queue drains within a session. Scheduled and held prompts fire unchanged: they re-admit at send through §2's rails, and a firing whose destination no longer matches refuses there and records the failure.

## Considered options

- **Prose-only special-case render (rejected).** Pattern-matching the old paragraph in the renderer keeps two sources of truth for one ask and leaves the editable-prose footgun standing.
- **Off-channel delivery (rejected).** The binding rides the prompt text by design; prepare-time binding contradicts ADR-0090's rule that preflight never binds a dormant destination.
- **Stuffed into the references block (rejected).** Its strict ten-field round-trip makes optional fields hostile, and grant-vs-action semantics belong apart.
- **Keep the regex-anywhere admission for the new block too (rejected).** It keeps arbitrary pasted uuids as admission input; §2's fail-closed leading parse is strictly narrower.
- **Leave old transcripts as raw prose (rejected; recorded dissent in §5).** Display inconsistency across one release boundary bought nothing functional.

## Consequences

- A refresh run's first prompt shows the same compact card every other attachment shows; the model still receives its instruction verbatim, now identical across entries instead of rebuilt per request.
- Removing the refresh chip removes the ask (no block is built); removing only the paired reference chip makes the next send refuse at admission rather than bind a half refresh.
- Refreshes cannot travel between tabs; each refusal or drop says so and points at re-preparing from the library.
- An older omp-ui shows the new block as prose in a transcript written by a newer one, exactly as with ADR-0077/0085 blocks; nothing is lost, and admission of that block requires the newer core.
