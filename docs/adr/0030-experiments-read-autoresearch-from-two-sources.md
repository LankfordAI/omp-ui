# Experiments read autoresearch from two sources

> **Status:** Accepted, 2026-09-17 ([#559](https://github.com/LankfordAI/omp-ui/issues/559)).

An **experiment** (CONTEXT.md) is one row of omp's per-project autoresearch
SQLite `sessions` table, and the **Lab** shows every project's experiments with
their progress, run history, and controls. omp owns the whole loop: its
`/autoresearch` command turns the mode on, its `init_experiment` /
`run_experiment` / `log_experiment` / `update_notes` tools write the database,
and its benchmark runs inside an ordinary agent turn. omp-ui holds no
experiment record of its own and re-implements none of that. What it needs is a
way to *see* the state, and no single seam carries it — so the feature reads
from two sources and writes through one.

## Why not the obvious routes

Verified against omp 18.2.4 by driving a real `--mode=rpc-ui` process:

- **No rpc command exists.** The `RpcCommand` union carries no autoresearch
  variant — the same gap that pushed plan mode (ADR-0007), the advisor
  (ADR-0008), and goal mode (ADR-0024) off the rpc route. omp-ui never asks
  upstream for one (AGENTS.md).
- **An `-e` extension cannot be the database reader.** The read belongs in the
  main process, where paths can be confined and a compromised renderer cannot
  name a file (the ADR-0017 / ADR-0007 discipline), and the main process is
  plain Node: `@oh-my-pi/pi-coding-agent` resolves only inside the compiled
  binary's own virtual filesystem, so main cannot import its storage module at
  all. From *inside* an extension the specifier does resolve, but every
  exported opener runs omp's `AutoresearchStorage` constructor, which `mkdir`s
  the DB dir, creates the file, executes the DDL and bumps `user_version`.
  Pointed at a foreign database it *added* `sessions` and `runs` to it and left
  `-wal`/`-shm` behind. A bridge that read through omp's storage would be a
  writer, which is exactly what this feature must not be.
- **The TUI widget is not serializable over rpc-ui.** omp publishes its
  dashboard with `setWidget`, and over rpc-ui that frame arrives as
  `{ method: "setWidget", widgetKey: "autoresearch" }` with no payload at all:
  the widget is a TUI component, and nothing about its contents crosses the
  wire. The frame is still answered (omp blocks on the reply) and swallowed.
- **The control entries are not on the wire either.** omp records every mode
  and goal change as a `custom` session entry of type
  `autoresearch-control`. `get_messages` and `get_branch_messages` both return
  zero messages after a bare `/autoresearch`, and there is no `get_branch`
  command to read the branch with — so a client that watched only the rpc
  stream could not tell whether the mode was on.

## What is reachable

- **`/autoresearch` is a real extension command over rpc-ui.** It dispatches
  without a dialog, settles with no `message_start`, and flips omp's mode:
  verified live, bare `/autoresearch` turns the mode on and `/autoresearch off`
  turns it back off. So the spawner can arm the mode, and the composer's
  `off` / `clear` forms can be forwarded verbatim.
- **`ctx.sessionManager.getBranch()`** returns the root session's entry list,
  which is where the `autoresearch-control` records live. Walking it with
  omp's own reducer — last entry wins, `clear` drops the goal — recovers
  `mode` and `goal` exactly as omp's TUI renders them.
- **`AgentSession.subscribe`** delivers `tool_execution_end`, whose `toolName`
  names the loop's own four tools; that is the only live signal that a run or
  a log just happened.
- **The database path is deterministic.** omp keys a checkout's DB by
  `key = "--" + root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"`
  (rooted at the git toplevel when there is one) and resolves
  `dbPath = OMP_AUTORESEARCH_DB_DIR ?? <stateRoot>/autoresearch/<key>.db`,
  where `stateRoot` is `$XDG_STATE_HOME/omp` when that directory already
  exists (Linux/macOS, profile subdir included) and `~/.omp` otherwise.
  Verified end to end: opening the storage for a checkout created exactly
  `<home>/.omp/autoresearch/--<dash-slashed-root>--.db` beside its `-wal`.
- **The schema is readable without writing.** `sessions` holds the experiment
  (goal, primary metric, unit, direction, branch, baseline commit, segment,
  iteration cap, scope/off-limits/constraints JSON, notes, timestamps) and
  `runs` holds one row per benchmark run (command, timings, exit code, parsed
  metric, status, commit, modified paths, flag, log path). omp runs its writer
  under WAL with `PRAGMA busy_timeout = 5000`, and the four status values are
  `keep`, `discard`, `crash`, `checks_failed`.

## Decision

**Two read paths, one write path.**

- *Live state* comes from a per-lineage generated bridge (ADR-0003, ADR-0007,
  ADR-0024 discipline): `core/autoresearch.ts` is the wire contract,
  `core/autoresearch-extension.ts` writes `omp-ui-autoresearch.ts` for `-e`,
  and the bridge publishes a reduced `AutoresearchSnapshot` on the existing
  `ui.setStatus("omp-ui:autoresearch", …)` frame — monotonic `revision`,
  `processKey` ownership, an `available`/`unavailable` verdict, and the last
  loop tool it saw. Main's `AutoresearchStatusTracker` keeps the newest
  accepted snapshot per tab and `SessionSummary.autoresearch` carries it to
  every client. A bridge whose API is missing publishes `available: false` with
  the reason; the feature degrades to absent, never to half-working.
- *Run history* is read directly from omp's SQLite files by
  `core/autoresearch-store.ts`, per request, exactly as ADR-0017 reads mnemopi
  banks, and served by the project-proxied `autoresearch:overview`,
  `autoresearch:experiment`, and `autoresearch:runLog` channels. The renderer
  sends `projectCwd` and a `tabId`, never a path.
- *The only writer is omp's own tools.* omp-ui never inserts, updates, creates,
  or migrates a row. An experiment is started by prompting, not by writing: the
  agent's `init_experiment` call is what makes the row exist.
- *Aggregates follow omp's own readers, not a guess.* The Lab's progress is
  computed from the current segment (`current_segment`, which omp starts at
  `0`) the way omp's `log_experiment` reports it: **run n/max** counts logged
  runs (`status IS NOT NULL`, flagged included), the **pending** run is the
  newest unlogged, unabandoned row (`ORDER BY id DESC LIMIT 1`), **baseline**
  is the first kept, unflagged run of the segment, and **best** is the kept,
  unflagged extreme in the metric's direction. Verified against a real run:
  omp's "Progress: 3/3 runs in current segment" and the Lab's `run 3/3`,
  baseline 22 and best 0 agreed.

**Linkage is the checkout plus the branch.** A worktree session's experiments
are the rows in *its own* checkout's database, matched on branch first and
newest-open second; a non-worktree session links to the project checkout's row
whose `branch` equals its recorded `experiment.launchedBranch`. Provenance lives
on the owned-session record (`SessionExperiment`) so a launch that has not
reached `init_experiment` yet still shows as pending rather than vanishing.

**The spawner launches a fresh worktree.** A New experiment mints a branch
named `autoresearch/<slug>/<hash>` (ADR-0018's worktree discipline, and omp's
own `autoresearch/` prefix, which is what earns omp's dedicated-branch
behaviour: baseline reset and auto-commits), spawns an rpc-ui session in that
checkout, arms the mode with bare `/autoresearch`, and sends one kickoff prompt
whose fields are exactly `init_experiment`'s parameters.

## Concurrency contract

- Every connection opens `{ readOnly: true }` and closes in `finally`; nothing
  is held open between requests. WAL gives snapshot reads beside a live omp
  writer, and omp's writer sets `PRAGMA busy_timeout = 5000` rather than
  failing fast on its side.
- omp-ui never creates a database, a directory, or a table. A checkout with no
  experiment yet has no file at all, and the Lab shows an empty state until
  `init_experiment` runs.
- A missing file is not an error, a foreign file is: a database with neither a
  `sessions` nor a `runs` table reports `not an autoresearch database` in that
  checkout's own row instead of being read, repaired, or created.

## Version coupling

The path rule, the `sessions`/`runs` column set, the status enum, and the
`busy_timeout` fact are pinned to omp 18.2.4. Reads on stable columns are
forward-tolerant while omp keeps migrating additively, but **re-verify the path
and schema facts when the managed omp upgrades** — the same caveat ADR-0017
carries, and the reason the generated bridge probes every API it touches rather
than assuming the shape.

## Consequences

- **No hibernation veto.** Unlike an active goal (ADR-0024), an experiment
  applies none, and that is sound rather than an oversight: a benchmark runs
  *inside* a turn, so `run_experiment` keeps the process busy and the ordinary
  running-turn probe covers it, and between turns omp has no loop to kill —
  on resume it replays its control entries from the branch, re-checks the
  branch against the database, and re-enables its own loop tools. Hibernating
  an idle experiment loses nothing that a resume does not restore.
- **omp's dashboard widget is answered and swallowed.** In a native tab the
  `setWidget` frame keyed `autoresearch` gets a cancel response (omp blocks on
  a reply) and renders nothing: the snapshot and the Lab carry its content.
- **No Plan-mode interlock.** Goal mode blocks entering Plan mode in both
  halves (ADR-0024); an experiment does not, because the loop is omp's and the
  read-only guarantee is omp's own plan-mode write guard. Putting a session in
  Plan mode makes its next benchmark fail or report honestly — omp's guard, not
  an omp-ui veto, is what stops the work.
- **A terminal tab lists, and does not control.** Its experiments come from the
  database alone: no bridge means no snapshot, so there is no HUD chip and no
  Stop, and the detail view's controls report that autoresearch controls need a
  native session. Forwarding `/autoresearch` there still works — that is omp's
  own TUI command.
- **An older remote host says so.** A joined instance from before the Lab
  rejects `autoresearch:*` as an unknown channel; the Lab names the host rather
  than showing an empty overview, and the same rejection marks the instance
  incompatible through the ordinary remote path (ADR-0028).
- **The Lab is a main-pane surface, not a pane.** It is not a sixth
  **Inspector rail** pane and not a **Tab**: it replaces the main pane while the
  tabs stay mounted and hidden, and any tab activation closes it.
