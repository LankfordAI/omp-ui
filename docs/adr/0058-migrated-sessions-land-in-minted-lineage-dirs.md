# Migrated sessions land in minted lineage dirs, never omp's placement

`omp session unpack <bundle> --cwd <dir>` writes the transcript (and its
sibling artifacts) wherever its own placement logic decides under the target
host's sessions root — a location omp-ui does not control and cannot attribute
(ADR-0003 exists precisely because "where a file sits" is what makes a session
UI-owned). Importing that placement as-is would register an owned record whose
`lineageDir` names a directory no other omp-ui code minted: hydration, the
per-lineage config overlays (ADR-0005), and deletion's cascade all assume the
`omp-ui--<slug>--<lineage-id>` shape.

## Considered Options

- **Register omp's placement as-is (rejected)** — the row would be owned by
  bookkeeping but foreign on disk: `writeSessionOverlays` targets, worktree
  resolution, and `deleteSessionFiles` all key off the minted-dir contract,
  and a future omp change to unpack placement silently breaks ownership.
- **Unpack into a pre-minted dir via an omp flag (rejected)** — omp 18.12.2
  exposes no output-directory flag on `session unpack`; inventing one means
  forking placement rules into omp-ui's CLI wrapper, which AGENTS.md forbids
  (never re-implement omp CLI behavior).

## Decision

**`adoptIntoLineage` (packages/core/src/session-transfer.ts) relocates the
placed files into a freshly minted dir before anything is registered.** After
unpack reports its placed session file, main mints a lineage dir name for the
target project (`mintLineageDirName`, the exact ADR-0003 shape), moves the
transcript — renamed to omp's own `<timestamp>_<sessionId>.jsonl` convention,
parsed from the placed filename so the final session id is omp's answer, never
a guess — and moves the sibling artifacts dir (or, when unpack wrote into a
staging dir, every child of it) into the minted dir. Any failure after the
mint removes the minted dir so a half-migrated lineage never lingers. Only
then does the record enter the registry: `worktree: null` (host-local by
definition, ADR-0018), mode/model/thinking defaults seeded like any fresh row.

The source copy is deliberately left in place and marked via
`omp session moved --to <target>`: omp's fork-on-resume guard then forks the
stale original instead of silently continuing a diverged transcript, and the
user keeps an undo path. Marking is warn-only — for a remote source the acting
app cannot reach that host's `session:mark-moved` (not proxied, orchestration
rule), and the warning says exactly that.

## Amends / relates

- ADR-0003 (per-lineage pinned dirs) — the contract adoption satisfies;
  unpack alone cannot.
- ADR-0018 (worktrees are host-local) — a migrated row never carries one.
- ADR-0028 (remote instances joined by main-process proxy) — the chunk relay
  rides only proxied channels; orchestration stays in the acting app's main.
