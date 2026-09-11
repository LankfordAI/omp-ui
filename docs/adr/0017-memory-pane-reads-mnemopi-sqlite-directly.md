# The Memory pane reads mnemopi's SQLite directly

The Memory pane (issue #206) browses and edits omp's **mnemopi** memory — the
focus session's project bank plus the shared global bank — by opening the bank
SQLite files from the main process with Node's built-in `node:sqlite`. No omp
process is involved in reading or writing memory.

**Amended 2026-08-27 (#330):** the browse/edit pane was removed in #221, and
its five channels (`memory:list`, `memory:get`, `memory:add`, `memory:update`,
`memory:forget`), their `MainBackend` handlers, `requireBank`, and the
`core/memory-store.ts` functions behind them were deleted in #330. What remains
normative: the direct-SQLite rationale below, the read side of the concurrency
contract, "Banks are discovered, never derived", and confinement by
`projectCwd`. The only surviving channel is `memory:overview`, read by
Settings → Memory.

## Why not the obvious routes

Verified against omp 17.3.5 source (`can1357/oh-my-pi`, tag `v17.3.5`):

- **No rpc command exists.** The `RpcCommand` union in `rpc-types.ts` carries
  no memory variant — the same gap that forced ADR-0005 (advisor) and ADR-0007
  (plan mode) off the rpc route.
- **A generated `-e` extension needs a live session.** Managing the global
  bank is exactly the no-session use case: curating cross-project preferences
  with zero tabs open. An extension channel can never be the primary path.
- **The mnemopi CLI is not shipped.** It is a separate Bun-only npm bin; the
  omp binary omp-ui manages does not contain it, so shelling out is not an
  option on a stock install.

Direct SQLite is also what mnemopi itself does across processes: omp opens
sibling banks read-only from a second process when rescuing legacy banks
(`extendRecallWithLegacyBanks`), relying on WAL for safety. omp-ui joins that
same contract. Electron 43 (Node 24) and Node 22 (vitest) both ship
`node:sqlite` with FTS5 and json1 — probed live, not assumed.

## Concurrency contract

- Every connection opens `{ readOnly: true }` — WAL gives snapshot reads beside
  a live omp writer. Since #330 there is no write path at all: the read-write
  `PRAGMA busy_timeout=2000` connection went with the edit channels.
- Connections are per-request and closed in `finally`; nothing is held open.

## Banks are discovered, never derived — and never created

omp names a project bank
`sanitize(basename(cwd)) + "-" + Bun.hash(resolve(cwd)).toString(36)`.
`Bun.hash` is Wyhash-64; reimplementing it in Node would be version-fragile.
Instead, omp-ui enumerates `<baseDir>/banks/`, filters candidates by name
prefix, and confirms by probing
`json_extract(metadata_json,'$.cwd') = <cwd>` — the exact technique omp's own
legacy-bank rescue uses. Consequence: **omp-ui never creates a project bank**
(it could not name one correctly). A project with no bank shows an empty
state until the first session runs with memory enabled.

## Edit semantics mirror omp's `memory_edit`

_Historical since #330: the code this section describes was deleted with the
Memory pane's edit channels. The mnemopi-17.3.5 write-schema port is
recoverable from `a91db16` and **must be re-verified against the then-current
mnemopi** before any revival._

- Working-store rows: edit, forget, add. Forget ports mnemopi's
  `purgeWorkingMemoryArtifacts` cascade (annotations, embeddings, `memoria_*`,
  `facts`, gists, graph edges), each statement guarded by a `tableExists`
  probe so a foreign or older db degrades to a partial cascade, not a crash.
- Episodic rows: read-only. mnemopi's own edit surface offers only
  `invalidate` there, whose row mutation was not verified — no invented
  semantics.
- The `memoria_facts` projection table is not listed; its rows project the
  working rows already shown.

## User-added rows are pinned durable, FTS-recallable, vector-pending

_Historical since #330: `memory:add` no longer exists — see the note above._

`memory:add` inserts into `working_memory` with `consolidated_at` set (exempt
from `trimWorkingMemory`'s TTL delete), `scope='global'` (session-independent
for recall), `trust_tier='STATED'`/`veracity='stated'` (canonical enums), and
a `metadata_json.$.cwd` tag for project scope (which also strengthens future
bank discovery). The `wm_ai` trigger indexes the row into FTS immediately. No
embedding row is written — vector recall for these rows arrives if/when
mnemopi re-embeds. Accepted: FTS recall alone is sufficient for durable user
facts.

## Confinement

The renderer never passes a path. `memory:overview` takes `projectCwd` and the
main process resolves both banks itself (`readMemoryOverview`), so a
compromised renderer can only ever reach the two banks its project legitimately
owns — the same discipline as ADR-0007's `plan:read`. The dedicated
`requireBank` guard went with the channels it confined (#330).

## Version coupling

Schema, trigger, and enum facts are pinned to omp 17.3.5. mnemopi migrates
additively (`addColumnIfMissing`), so reads and writes on the stable columns
are forward-tolerant — but **re-verify the schema facts on omp upgrades**,
the same caveat `session-encoding.md` carries.
