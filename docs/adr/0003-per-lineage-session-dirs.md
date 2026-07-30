# Per-lineage pinned session dirs inside OMP's default sessions root

omp-ui tracks only sessions it launches. To make ownership structural rather
than sniffed, each launched session lineage gets its own `--session-dir`: a
**direct child of OMP's default sessions root**, named
`omp-ui--<project-slug>--<lineage-id>/`. Every file in such a dir is
UI-launched by construction — including `/new` sequences and `/branch` forks,
which omp writes in-process to the manager's session dir.

## Considered Options

- **Shared default root + dir-watch attribution (rejected)** — UI sessions
  would sit next to terminal ones (bare `omp --resume` finds them), but
  attribution needs lazy-materialization handling, per-tab lifetime
  dir-watching, and the per-TTY breadcrumb channel to disambiguate two live
  tabs in one project (unverified). Ownership stays heuristic.
- **Pinned dirs outside the default root, e.g. Electron userData (rejected)** —
  perfect isolation, but `omp gc` collects referenced blob hashes only from
  the default sessions root and its archive (`gc-cli.ts:307-308`): blobs
  referenced only by UI sessions would look unreferenced and be deleted —
  silent transcript corruption.
- **Direct children of the default root (chosen)** — `listActiveSessions`
  descends exactly one level (`gc-cli.ts:339-353`), so these dirs stay inside
  GC's reachability and archiving world while remaining structurally
  omp-ui-only.

## Consequences

- omp-ui must resolve the default sessions root exactly as omp does
  (`PI_CONFIG_DIR` → `PI_CODING_AGENT_DIR` → profiles → `XDG_DATA_HOME`;
  see `docs/session-encoding.md`) and place lineage dirs inside it.
- Terminal `omp` scans the same one-level root, so UI sessions appear in its
  session picker — isolation is naming-convention only. External
  double-resume remains accepted as out of scope (phase-1 dedupe rule).
- A resumed session keeps its existing lineage dir (`--session-dir` = the
  session's current dir); only brand-new sessions mint a fresh dir.
  **Dir = lineage, not tab.**
- Forks and `/new` sessions are owned by construction — this supersedes the
  earlier "direct-spawn only" fork rule.
- `omp gc` **relocates and gzips** cold sessions into the archive root
  (`<agentDir>/archive/sessions/`; `gc-cli.ts:181,376-468`). The registry
  stores `sessionId` + lineage dir *name* only and re-resolves the file on
  every hydrate — active root first, archive root second. Cached absolute
  paths are forbidden: they dangle after an archive run.
- Resuming an archived lineage means unarchiving first (gunzip + move the dir
  back into the active root), then spawning with `--session-dir` at the
  restored location. Archived sidebar entries render from registry-cached
  display metadata until then.
