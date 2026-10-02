# Subagent control via omp's native rpc verbs

Resolves issue #713. Supersedes ADR-0040. Verified against omp 18.4.10 (the
managed binary) and the v18.4.9 tag.

## Findings

- omp 18.4.9 added `cancel_subagent { subagentId }` and
  `steer_subagent { subagentId, message }` to the rpc dispatch (absent at
  v18.4.8). Both resolve the target through `resolveOwnedLiveSubagent`: the
  rpc roster entry must be `running` or `pending`, and the registry ref
  `running` with a live session.
- `cancel_subagent` is Agent Hub's kill — a tombstoned `release` plus
  `session.abort({ reason: "Interrupted by user" })` — and answers
  `{ cancelled }`, `false` for an id that is not a running subagent of this
  session (idempotent). Under a `progress`/`events` subscription an `aborted`
  `subagent_lifecycle` frame follows.
- `steer_subagent` prompts the subagent with `streamingBehavior: "steer"`; its
  response waits for acceptance (queued mid-turn, or a new turn started).
  Failures are omp's sentences: `Subagent not running: <id>`,
  `Subagent refused the message: <reason>`.
- An omp without a verb answers `Unknown command: <type>`.
- No revive verb exists, and none is needed today: the rpc roster takes its
  status from lifecycle (`started` → `running`) or progress
  (`pending | running | completed | failed | aborted`) and drops an entry on any
  terminal lifecycle status, so it never reports `parked`. ADR-0040's revive
  button could not render outside hand-seeded tests.

## Decisions

1. Steer and kill dispatch `steer_subagent` / `cancel_subagent` directly. Both
   are `SESSION_COMMANDS` entries with `lateAck: true`: a cancel waits on a turn
   unwind, and a steer's admission can run a slash command.
2. The response is the result. omp's failure sentence shows verbatim under the
   roster; `Unknown command:` shows an update hint; nothing retries through
   another path.
3. `get_subagents` stays the status truth: the aborted lifecycle frame pulses
   the existing roster refresh, and a settled kill refreshes once more.
4. Controls render only where omp accepts the verbs: roster status `running`
   or `pending`.
5. The generated bridge, its wire contract, its arm prompt, its
   `omp-ui:subagent-control` status route, and revive are deleted. Revive
   returns only if omp's rpc surface reports parked agents *and* exposes a verb
   for them.
6. PTY tabs keep omp's TUI subagent UX, as under ADR-0040.
