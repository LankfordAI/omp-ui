# The Stats view reads omp's stats.db read-only

> **Status:** Accepted, 2026-09-28 ([#668](https://github.com/LankfordAI/omp-ui/issues/668)).

The **Stats view** (CONTEXT.md) shows cross-session usage — totals, per-day
and per-model rollups, a Projects breakdown, and per-session cost — for
whatever omp has recorded on this machine. omp owns the whole data path: its
sessions ingest every assistant request into `stats.db` (SQLite, WAL), and its
background rollup pass maintains the hourly `message_rollup` and per-session
`session_rollup` tables, marking `rollup_dirty` / `session_dirty` rows until
they are aggregated. omp-ui owns none of that and needs a way to *see* it
without a live session, without writing, and without re-implementing the
schema.

## Why not the obvious routes

Verified against the omp 18.4.0 binary (`packages/stats/src/db.ts`,
`rollup.ts`):

- **No rpc seam exists.** The `RpcCommand` union carries no stats variant;
  omp publishes its own dashboard as a TUI `setWidget`, which crosses rpc-ui
  with no payload — the exact gap ADR-0030 hit with autoresearch, and omp-ui
  never asks upstream for a command (AGENTS.md).
- **The TUI hand-off fails the requirement.** Launching `omp stats` in a
  terminal tab shows the dashboard to a desktop user only: the native
  transcript cannot show it, a joined remote instance cannot survive it, and
  it is a session — a **Tab** — where the ask is a global surface.
- **A collab-web deep link** would bind this feature to upstream's web client
  and its server surface, neither of which omp-ui ships or controls.

## Decision

**A direct read-only SQLite port, like the stores before it.**
`packages/core/src/stats-store.ts` is to `stats.db` what `memory-store.ts`
(ADR-0017) and `autoresearch-store.ts` (ADR-0030) are to theirs: plain
Node/TS in `packages/core`, zero Electron imports (ADR-0002), serving the one
`stats:overview` request the surface renders.

The contract:

- **Connections are `{ readOnly: true }`, opened per call and closed in
  `finally`.** omp's sessions write the database concurrently; a WAL
  snapshot read beside a live writer is the ADR-0017 discipline, and a
  long-held handle is never worth the stale view.
- **Database locations are discovered, never derived.** The file is probed
  across omp's own candidate bases by existence — XDG data home when that
  directory exists, then the profile-aware config root, then
  `PI_CODING_AGENT_DIR` for the default profile — exactly as
  `getSessionsRoot` is resolved. Callers inject `env`/`home` so tests never
  touch a real home directory.
- **The SQL is a trimmed port of omp v18.4.0, stamped in the header and
  guarded.** Column lists, the hour-bucket arithmetic, the `TOTAL()` rule
  for REAL aggregates, the unpriced-request case, and the UNION ALL of clean
  rollup rows with dirty-bucket recomputation all come from omp's own
  reader; the port adds nothing. A live-binary parity test (same shape as
  `omp-capability-keys.test.ts`) fails loudly, not silently, when a rename
  lands — asserting column existence, never version equality, so a newer omp
  still passes.
- **Every foreign state is data, never a throw.** No database →
  `dbPath: null`; a file without omp's `messages` table, a locked WAL, or a
  corrupt page → `error` with empty sections, mirroring
  `readCheckoutExperiments`. The surface renders those states as states.
- **The rollup tables are an optimization, not a dependency.** The reader
  uses them only when all four exist and `meta.rollup_version` matches;
  otherwise — including the pre-rollup databases still in the field — it
  scans the raw `messages` table. Both arms must answer identically, and the
  tests prove it on the same fixtures.
- **Frustration classification stays out.** omp's frustration page runs its
  `judge` role and writes `frustration_verdicts`; a writer has no place
  behind this seam. It is tracked separately in #668.

The channel is instance-scoped, not project-scoped: a joined remote's
`stats:overview` rides the proxy set and reads *that host's* stats database
through that instance's core, so a future remote-stats picker is a UI change,
not a seam change (the first cut's surface reads the local instance only).
The surface itself follows the Lab precedent (issue #559): store-driven view
state, main pane in place of the tabs, closed by tab activation through
`focusOn` — deliberately not a **Tab**, because it is not a view onto a
session.
