# WATCHDOG.md instruction files join the roster catalog

Resolves issue #691. Verified against omp 18.4.3.

## Findings

- omp discovers advisor config with one directory walk (`qbs`) invoked on two
  file lists: the structured `WATCHDOG.yml`/`WATCHDOG.yaml` files (`wbt`, the
  walk ADR-0039 ports as `discoverCandidates`) and free-form `WATCHDOG.md`
  instruction files (`Gcn` / `discoverWatchdogFiles`), whose contents omp
  injects into advisor context as an "Especially pay attention to:" block.
- omp-ui globbed only the `.yml`/`.yaml` pair, so a project carrying advisor
  instructions in `WATCHDOG.md` showed an empty `otherFiles`/
  `sharedInstructions` picture while those instructions were live in the
  session — the ADR-0039 bridge-truth drift class, at the file-name level.
- `qbs` is one shared walk: user files at `<agentDir>/<name>`, then an
  ancestor walk from the cwd up to the VCS root (or home), probing both
  `<dir>/.omp/<name>` and `<dir>/<name>`, skipping dot-directories other than
  `.omp`, sorting user-first then farthest-ancestor-first.
- The `.md` files carry free-form text, never the `advisors:` schema, so they
  contribute no roster entries and never appear in `effective`. ADR-0039 was
  silent on them.
- omp's `Gcn` wraps every discovered `.md` in the attention block without a
  trim check — unlike the `.yml` `instructions:` rule, which is gated on
  non-blank text.

## Decisions

1. Parameterize `discoverCandidates` by file names and run it a second time
   with `["WATCHDOG.md"]`, mirroring omp's own two `qbs` calls, so
   ancestor/depth/dot-dir semantics cannot drift from the `.yml` walk that
   already has a live parity guard.
2. The `.md` results merge into the read-only surfaces of
   `WatchdogRosterResult` only: every discovered `WATCHDOG.md` is listed in
   `sharedInstructions` (no trim gate, faithful to `Gcn`) and in `otherFiles`.
   They are never parsed as YAML, never contribute advisors or warnings, and
   never become an edit target.
3. `user`/`project` file views and the writer (`setWatchdogRoster`,
   `editTarget`) are unchanged; the renderer already lists every `otherFiles`
   path under "Also contributing (edit by hand):", the right treatment for a
   hand-edited free-form file.

ADR-0039's pinned-discovery note now covers both file lists.
