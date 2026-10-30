# Live voice delivers the reviewed plan as context appends, so the call can brief and discuss it

> **Status:** Accepted, 2026-10-30 ([#1001](https://github.com/LankfordAI/omp-ui/issues/1001)).

Amends [ADR-0051](0051-park-the-live-call-while-the-agent-works.md)'s #818
amendment and [ADR-0071](0071-live-voice-runs-on-a-renderer-owned-peer.md).
Verified against omp 18.14.0.

A live call that reconnects for a plan review (#818) carried the whole plan in
a `<plan-review>` section of the `live_connect` instructions and asked there
for one spoken overview. ADR-0071 found that the realtime model never reads its
instructions back. The call stayed silent, and when asked about the plan it
did not know it. ADR-0071 fixed the same defect for stored results with
context appends on the renderer-owned peer's data channel. The plan now uses
that path too.

## Findings

| Fact | Where it was read |
|---|---|
| The plan sent as commentary appends reaches the model. A call that got a 1.3 KB plan as three commentary parts answered "which alternative did the plan reject" and "how many sessions does the importer test use" correctly. A 23 KB plan (47 appends) still let it quote a word from the plan's last line. | Data-channel probes through `live_connect`, 2026-10-30. |
| The commentary plan, then one speakable cue, gets one spoken overview of the real plan: its purpose, steps, tradeoff, and verification, ending with an invitation to discuss. With a pending result appended before the cue, the call speaks the result, then the overview. | Probes; headless app smoke, 2026-10-30. |
| A plan sent only as commentary does not always stay silent. Over about 20 trials, roughly half produced a backchannel ("Mm-hmm") or a short unprompted remark ("I see the migration plan. Want to walk through it?"). Changing the wording, sending the plan before or after the recap, or adding a trailing "say nothing" note did not stop it reliably. A short recap alone stayed silent. | Probes on the vendored base prompt, mic track disabled as under hold-to-talk. |
| An 81 KB plan (164 appends) was accepted without error, but the call began talking over the stream and lost the plan's tail. | Probe. |
| omp 18.14.0's own controller sends tool progress on `channel: "commentary"` and the final answer with no channel. Its base prompt says commentary is silent progress, never to recite. | omp 18.14.0 binary, `live/controller.ts`; vendored `live-instructions.md`. |

## Decision

1. **The plan rides appends, not instructions.** `buildLiveInstructions`
   no longer adds a `<plan-review>` section. The instructions, the recap
   trim, and pending accounting are the same with or without a review. For a
   review, `contextAppends` adds commentary appends after the voice recap. The
   first part names the artifact and gives the human-only gate rules: discuss
   the plan, do not delegate a summary, never execute, refine, or defer from
   voice. Next comes a fixed intro that counts the plan's parts, then the
   plan's full readable text split at omp's 500-byte cap. Nothing is trimmed.
2. **A briefing is one speakable cue, sent last.** When the switch requests
   a briefing (the first presentation of a gate identity, or **Explain this
   plan**), the appends end with a speakable cue that asks for one 100–140
   word overview. Carried pending results go before it, so a stored answer is
   spoken first. A reconnect that does not request a briefing (a deferred
   plan, a return to a parked review) sends the plan as commentary only.
3. **The review context drops `sourceHash`.** It was only ever written
   into the instructions' JSON. Identity and readiness still come from the
   gate (`planSourceKey`, `planReviewGateKey`).

## Consequences

- The call can give the briefing it reconnects for and answer questions from
  the plan's authored text.
- A reconnect that carries a plan but no briefing may still produce a short
  unprompted acknowledgement of the plan. omp gives no client event that adds
  context with a guarantee of no response. The plan is sent anyway, because
  without it the call cannot discuss the plan at all.
- Very large plans are bounded by the model, not by omp-ui. Past a few tens
  of kilobytes, the call may start talking before the stream ends. Readable
  plan text (`planReviewText`) already drops markup, so typical plans are far
  below that.
