# The Stats view reads omp's stats.db read-only

> **Status:** Accepted, 2026-09-28 ([#668](https://github.com/LankfordAI/omp-ui/issues/668)).

The **Stats view** (CONTEXT.md) shows host-local, active-profile recorded usage:
totals, UTC days, models, agent types, canonical Projects, tools and outcomes,
and sessions in the selected range. OMP owns the statistics database and its
ingestion, deduplication, pricing, migrations, and rollups. omp-ui explicitly
invokes OMP's collector, then queries read-only; it does not maintain another
usage ledger. This distinction was verified against the managed OMP 18.17.0
executable in isolated storage ([#1083](https://github.com/LankfordAI/omp-ui/issues/1083)),
amending the original assumption that merely running sessions keeps the data
current.

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
Node/TS in `packages/core`, zero Electron imports (ADR-0002). `stats:overview`
is a strict filtered query; `stats:sync` and `stats:syncStatus` address the
separate host-owned collector shared by both renderer transports.

The contract:

- **Queries never write.** Connections are `{ readOnly: true }`, opened per
  call and closed in `finally`. Bounded header/attribution preparation precedes
  one read transaction covering aggregate SQL, facets, and metadata. No schema,
  migration, temporary attribution table, or write PRAGMA belongs in the reader.
- **Collection is explicit and owned by the host.** Opening Stats requests
  `if-stale`; Refresh requests `force`. The host reserves a single flight before
  deferred work, with a 60-second latest-attempt cooldown. It launches the
  current resolved binary directly with `stats --summary`, ignores stdin,
  drains bounded pipes, and requires actual code-0 close plus a readable intended
  schema. A ten-minute deadline includes OMP's cross-process lock wait. Timeout
  and synchronous shutdown cancellation TERM/KILL the child without releasing
  its slot before confirmed closure. Renderer lifecycle never owns cancellation.
- **Source selection follows the writer, not the first existing database.**
  `stats-source.ts` mirrors OMP 18.17.0 strict profile normalization, initial
  directory-only dotenv precedence/aliases and refreshed paths from a neutral
  home cwd. Linux/macOS XDG requires the selected app/profile path to exist;
  a genuine custom default-profile agent directory disables XDG but does not
  relocate `stats.db` into that agent directory. Missing intended targets remain
  empty until OMP creates them. Invalid sources never fall back to another profile.
- **One accounting boundary.** Project, provider, paired model, agent type, and
  hour-aligned inclusive range predicates apply to all sections. Requests and
  tools aggregate independently by stored source file, including tool-only files;
  sessions now show selected-window, not whole-life, amounts. Projects derive
  from exact registry lineage/`projectCwd` ownership or confined 4 KiB headers,
  with at most eight reads and a compressed-input budget for archive companions.
  Missing source files retain database amounts. Folder labels are never paths.
- **Rollups are optional and version guarded.** The supported version-3
  clean/dirty message path is preserved; absent, incompatible, or differently
  versioned layouts use raw rows. Project-scoped and per-file queries are raw.
  The actual verified 18.17.0 writer reports version `2` (trigger version `4`),
  so it intentionally uses raw fallback. Deterministic fixtures prove parity.
- **Foreign and optional states remain explicit.** Missing, invalid-source,
  incompatible, locked, corrupt, and other read failures remain distinct. Missing
  tool tables mean unavailable counts, not zero; missing outcome columns mean
  unknown outcomes, and legacy agent types use `unknown`. Completed outcomes
  require a non-NULL size and an error flag of 0 or 1; empty completed results
  count. Rates use errors/recorded outcomes and are NULL without a denominator.
  Synthetic skipped non-executions may have non-error recorded outcomes.
- **Freshness and coverage are not billing.** Last successful collection is
  host state, distinct from global latest recorded request and query snapshot.
  Source changes reset freshness; retained figures keep their original source
  and selection label. Registered zero-use Projects stay in global filter facets.
  Coverage discloses owned-root mismatches and unknown archive/index inspection.
  Only active transcripts discovered by OMP and already stored history qualify;
  never-indexed gzip archives are excluded, never restored or independently
  ingested. No lifetime/invoice claim or completeness percentage is made.
  Recorded/estimated USD cost is not subscription spend; no live HUD/advisor
  receipts or per-tool monetary allocation are added. Fork attribution follows
  the source record retained by OMP's first-writer guard, not immutable provenance.
- **Frustration classification stays out.** omp's frustration page runs its
  `judge` role and writes `frustration_verdicts`; a writer has no place
  behind this seam. It is tracked separately in #668.

All three channels are instance-scoped: the existing proxy seam addresses the
owning host's reader and collector. The surface reads the local instance only;
this adds no joined-host picker, fleet-wide summation, repository-key merging,
or Stats channels to host-lite's deliberately limited table.
The surface itself follows the Lab precedent (issue #559): store-driven view
state, main pane in place of the tabs, closed by tab activation through
`focusOn` — deliberately not a **Tab**, because it is not a view onto a
session.
