# Scheduled prompts fire on the owning host, in Build

> **Status:** Accepted, 2026-10-30 ([#987](https://github.com/LankfordAI/omp-ui/issues/987)).

Recurring agent work (a nightly dependency audit, a daily triage, a weekly
release check) meant opening a session and typing the same prompt each time.
This ADR records how a **Scheduled prompt** is kept, fired, and reconciled
with idle hibernation, plan mode, snooze, and app downtime. It generalizes
the clock ADR-0074 introduced for a **Held prompt**, which stays separate:
that prompt waits for a provider-reported reset, not a wall-clock schedule.

## Decision

**One schedule per native session, on the record.**
`OwnedSessionRecord.scheduledPrompt` carries the prompt text (at most 16,000
characters, so it can ride every state broadcast), the schedule, the IANA time
zone of the client that set it, `nextRunAtMs`, `lastRunAtMs`, and the three
newest notices. A schedule is either `once` at an instant or a five-field cron
expression. The dialog's **Daily**, **Weekdays**, and **Weekly** choices are
cron expressions too (`0 9 * * *`, `0 9 * * 1-5`, `0 9 * * 1`), so the host
has one evaluator. The cron evaluator is a small pure module in core
(`scheduled-prompt.ts`), read in the schedule's zone so a wall-clock time
survives DST changes. A time a spring-forward gap skips fires just after the
gap. Both day fields restricted fire on either day (Vixie cron). A record
whose schedule no longer parses normalizes to null, the `reviewRoster` rule.
A terminal session gets no schedule, because it has no prompt channel main
may inject into.

**The owning host's main process owns it.** `session:setScheduledPrompt`,
`session:clearScheduledPrompt`, and `session:runScheduledPromptNow` join
`TAB_ROUTED_REQUESTS`, so a remote session's schedule fires on its host.
`ScheduledPromptRunner` is a frame observer registered after
`HeldPromptScheduler`. One timer covers the earliest `nextRunAtMs`, capped at
60 s (the SnoozeClock rule: Node timers stop while the machine sleeps). It
also syncs at boot.

**At a fire time:**

- a live session inside a run (the turn latch is set, or it waits on a plan
  review or a blocking dialog) **skips** the fire: no prompt is queued, a
  `skipped` notice is recorded, and the schedule advances to its next
  occurrence after now;
- a live idle session that has sent `ready` and is not model-held or in a
  pending operation gets the prompt through `rpcSend`, the path renderer
  prompts take;
- a session with no process (settled, hibernated, dormant after a quit) is
  resumed (at most once per 60 s per tab), and the prompt rides the spawn's
  `initialCommands`, last, and never while the spawn booted model-held.

**Scheduled runs start in Build.** The scheduler's resume passes
`planMode: false`, so the process boots in Build and the record's
`agentMode` follows from the bridge's status frame. A live session in plan
mode, or a user resume that boots in plan mode while a fire is due, first gets
`/omp-ui-plan off` on the same rail, then the prompt. omp's RPC loop handles
both as `prompt` commands in arrival order. The off command is sent only while
the plan bridge is loaded; without it omp would pass the slash text to the
model.

**Missed fires run once.** A sync that finds `nextRunAtMs` in the past (the
app was closed, or the machine slept) fires once. When the fire is more than
two minutes late, it records a `late` notice that counts the further
occurrences that passed meanwhile; those are not run. The schedule then
advances to the first occurrence after now, so a long downtime never causes a
burst of catch-up fires.

**Never sent twice.** `nextRunAtMs` advances in the same record write that
builds the command, before it goes out. The prompt's command id is
`omp-ui-scheduled-prompt-<id>-<dueAtMs>`. A success stamps `lastRunAtMs`, and a
one-shot that ran is removed. A rejection records a `failed` notice. A process
that exits before omp admits the prompt records a `failed` notice and is not
re-sent, because omp may already hold it. **Run now** sends an extra run that
leaves a recurring schedule's next occurrence where it was; it refuses while a
run is in progress.

**Sidebar.** A scheduled session shows a clock glyph and "next run Tue 09:00".
A snoozed scheduled session leaves **Snoozed** in the same record write as its
fire, so it is back in the main list when its run starts. Settling a session
keeps its schedule, and the next fire resumes it. Idle hibernation is
unchanged: a scheduled session hibernates like any other between runs, and the
fire wakes it.

## Rejected alternatives

- **omp's own scheduling.** The 18.14.0 binary has no prompt scheduler: its
  `cron` strings are Bun's `Bun.cron` OS-crontab helper and OpenTelemetry
  attribute names. An OS crontab running `omp` headless would leave the work
  outside omp-ui's sidebar (the issue's own alternative).
- **Renderer-side timers.** They miss fire times while no window is open and
  disagree across joined clients (ADR-0068 addendum #979).
- **Queuing a fire behind a run in progress.** A recurring prompt could stack
  behind a long run and start runs back to back. The issue asks to skip.
- **Catching up every missed occurrence.** A daily schedule after a week away
  would start seven runs at once. One run plus a notice is enough.
- **Folding in the held prompt.** A held prompt waits on a provider-reported
  reset, re-arms when a run hits the usage limit again, and carries images and
  documents in the lineage dir. A schedule is plain text on a clock. They share
  the timer rule and the never-twice rule, not a record field.
- **A third-party cron library.** The five-field subset with zone handling
  fits in one pure core module that the renderer also imports for the
  dialog's next-run preview.

## Consequences

- A session can run the same prompt on a schedule even while omp-ui is not in
  front, and a closed app catches up once at the next start, with a notice.
- The prompt is text only. Images and PDF documents are not scheduled.
- A remote instance running an older omp-ui rejects the channels; the renderer
  shows the error notice.
- Times are read in the zone of the client that set the schedule. A client in
  another zone sees the zone named on the card.
