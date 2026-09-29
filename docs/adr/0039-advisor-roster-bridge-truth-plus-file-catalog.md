# Advisor roster: bridge truth plus a file catalog

Resolves issue #685. Verified against omp 18.4.2.

## Findings

- omp-ui's advisor overlay writes only `modelRoles.advisor`; that is the
  fallback for roster entries with no `model:`. Entries with a model keep it.
- The session switch (`advisor.enabled`) is still the ceiling over every entry.
  A per-entry `enabled: false` is `paused`; an unresolvable model is `no_model`.
- omp's `getAdvisorStats()` returns `advisors[]`, `getAdvisorStatusOverview()`
  the per-advisor `yielded`, and `getAdvisorConfigWarnings()` file warnings.
  ADR-0008's "no per-advisor breakdown" premise is outdated.
- Granted tools are not exposed live; entry configs are private. Tools come from
  the files, so omp-ui reproduces omp's discovery/merge (as ADR-0025 does for
  skill roots).
- Transcript notes already carry the advisor name (`AdvisorNote.advisor`).
- `/advisor configure` is TUI-only; no rpc command applies a roster in-process
  (ADR-0005). Edits therefore apply on relaunch.

## Decisions

1. Two truths: bridge truth (this live session) and file truth (what omp can
   load at a scope). The HUD shows the first and decorates rows with tools from
   the second; the dialog edits the second.
2. The wire change is additive (`advisors`, `configWarnings`; root session only).
3. Editing replaces the whole file through a writer mirroring omp's own
   serializer. It refuses to save files with parse errors, dropped entries,
   unknown keys, or a non-mapping root, and rejects a stale `baseHash`.
   Comments are lost, as in omp's own editor.
4. YAML parsing uses `js-yaml` in the main process.
5. Placement: a project-settings tab plus the HUD popover, not
   `CapabilitiesViewer` (deviation from ADR-0025: its section ids are shared
   with the session-pinned roster counters).
6. Apply on relaunch, with a per-session Restart button.

## Pinned tables and drift

`WATCHDOG_KNOWN_TOOLS`, default tools, the `search`→`grep` alias, discovery
order and the serializer grammar are ported from omp 18.4.2's transpiled source
(`bCs`, `lCt`, `Dva`, `uCt`, `zva`, `Tcn`). A renamed tool or changed
precedence shows up as a wrong tools column, not a crash; the live smoke
comparing `getWatchdogRoster().effective` against the live roster is the parity
check.
