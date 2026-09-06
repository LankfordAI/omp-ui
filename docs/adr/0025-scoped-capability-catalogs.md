# Scoped capability catalogs: config truth beside bridge truth

The Capabilities button (HUD, compact sheet, palette) opens the viewer at
**global scope**, and the project settings dialog carries Skills and Tools
sections at **project scope** (issue #383). Both surfaces read a new core
module, `capability-catalog.ts`, which answers "what can omp load at this
scope?" from two sources — omp's own settings layers (`omp config list --json`
via `readOmpSettings`) and the skill files on disk (the version-pinned root
table in `omp-capability-keys.ts`, mirroring omp 18.1.10's discovery
providers). Writes route by scope and never across it: global mutations go
through `omp config set` (omp validates the value itself, global layer only);
project mutations edit `<cwd>/.omp/config.yml` through a line-scoped editor
(`project-config-writer.ts`) that preserves every byte outside the touched
lines.

## Terms

A **capability catalog** is config truth resolved at a scope (global |
project): files and settings labeled "what omp *can* load". A **roster**
stays bridge truth (#374): what one live session *did* load. The session-
pinned viewer keeps its rosters, session-local tool switches (#379), and MCP
runtime status unchanged; it remains reachable through Settings → omp and the
palette's "Capabilities for this session".

## Considered options

- **A headless probe session.** Spawn `omp --mode=rpc-ui` per catalog read and
  publish its roster. Rejected: opening a settings dialog would connect every
  configured MCP server (spawn storms, OAuth prompts), cost seconds per open,
  and be nondeterministic in CI. The catalog route spawns no process beyond
  the config reads omp-ui already does and is fake-filesystem unit-testable,
  exactly like `mcp-config.ts` (ADR-0017 lineage).
- **Delegating project writes to omp.** `omp config set` targets the global
  layer regardless of cwd (verified, omp-settings.ts) and its writer
  regenerates the YAML — hand-written comments do not survive it (also
  verified). A project toggle therefore needs an in-house verb; it refuses
  rather than guesses when a file's shape leaves the two-level grammar omp
  itself writes.
- **Toggling through the pinned session only.** Session-local switches
  (#379) cannot express a standing configuration; they reset with the process.
  The catalog rows state which layer their switch flips, per row, in the
  switch's own title.

## Consequences

- The catalog's tables are derived from omp's source at the pinned tag and
  guarded by a live-binary parity test that skips when no binary is installed
  (`omp-capability-keys.test.ts`): a renamed gate key fails loudly there
  before it can surface as a missing row.
- omp's curated/bundled skills are embedded in its binary and cannot be
  enumerated from disk; the skills catalog says so instead of rendering an
  empty list — #374's honesty rule extended to the second source, not
  revoked. A disabled or ignored higher-precedency root shadows nothing:
  omp dedupes names *after* source gates, and the catalog reproduces that,
  so shadowed rows stay visible and labeled.
- The global ignore list is a read-modify-write of `skills.ignoredSkills`
  (one spawn-wide window; last full-array write wins, and the refreshed rows
  re-state disk truth). The row's title text says so rather than hiding it.
- The HUD button no longer requires the focused session to have a working
  tree; its badge still counts that session's failed MCP servers. Nothing
  session-scoped is lost — only the toolbar entry point moved, and the pinned
  viewer keeps everything else.
