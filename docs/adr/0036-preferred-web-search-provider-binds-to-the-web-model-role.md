# The preferred web-search provider binds to the `web` model role

> **Status:** Accepted, 2026-09-26 ([#661](https://github.com/LankfordAI/omp-ui/issues/661)).

[ADR-0035](0035-web-search-provider-list-read-from-omp-model-catalog.md) moved
the **Preferred provider** select's *choice list* to
`omp models --kind search --json` and explicitly deferred the *value* side:
the row stayed keyed to `providers.webSearchOrder`, so on omp ≥ 18.2.x — which
moved the preference into the `web` role of `modelRoles` (`web/<provider>`
selectors) — the row disappeared while the preference kept working,
uneditably, inside omp. Verified against the local binary (omp 18.3.2):
`omp config list --json` publishes `modelRoles` (a `record`) and
`web_search.enabled`, and publishes neither `providers.webSearchOrder` nor
`providers.webSearchExclude`. This ADR binds the value; every other part of
the ADR-0027 contract stands: the choices come from the installed binary, the
select stays closed, a configured id outside the list stays selectable and
labelled, and writes go through `omp config set` to the global layer only.

## Decision

**Dual binding, legacy key first.** The row resolves its binding once per
render: `providers.webSearchOrder` when the snapshot publishes it (identical
to the shipped pre-18.2.x path), else the `web` role of `OMP_MODEL_ROLES_KEY`;
with neither key published, no row renders. Precedence is not cosmetic —
`modelRoles` also exists on older omp (the advisor and default roles), so a
binary that publishes both must keep using the old key. The render condition
is key presence, not catalog success: when the catalog read fails
transiently the row still renders with its value and the undiscovered note,
exactly as the legacy row does.

**The record is written REPLACE-not-merge, against the global layer**
(ADR-0031, the `SubagentModelsSection` precedent): the editor takes
`entry.globalValue`, sets or deletes the `web` key, and sends the whole
merged record through `writeOmpSetting` — never the effective
project-merged value, so a project binding is not baked into global config.
Automatic *deletes* the `web` key; writing an empty selector would resolve to
no provider at all, the `modelRoles.advisor` trap recorded in ADR-0005.

**The layer badge is per key.** `modelRoles` is layered per role, so the
whole-record `entry.layer` would badge `project` when an unrelated role
(e.g. advisor) is project-overridden. `webSearchRoleLayer` compares the web
role's own effective value against the global record's instead: differs →
`project`, present in global → `global`, nowhere → `default`.

**A role value the select cannot name is shown, not collapsed.** `web/<id>`
— any suffix kept verbatim, so `web/brave:high` round-trips — reads as that
id (labelled as outside omp's list when the catalog lacks it). Any other
non-empty string (a wildcard, an `@role`, a bare `brave`) renders as a
disabled option carrying the raw selector; any non-string hand-edit reads as
Automatic and is overwritten by the next clean pick. A `modelRoles` entry
whose value is not a plain record renders the raw JSON span, same as the
legacy non-array fallback: omp-ui never guesses a writer for a shape it
cannot model.

## Consequences

- **The row returns on omp ≥ 18.2.x**, closing the tracked follow-up in
  ADR-0035's Consequences. On binaries that publish neither key it stays
  absent per ADR-0025.
- **`web` is deliberately absent from `OMP_MODEL_ROLE_IDS`.** Adding it
  would give the omp page a free-text row that bypasses the ADR-0027 list
  contract; the Providers page stays the web role's only editor. The omp
  page's `commitRole` spreads the whole record, so its role edits round-trip
  the `web` sibling untouched.
- **The legacy key path stays exactly as shipped** — same branch, same
  tests, same i18n — because pre-18.2.x binaries keep publishing the old key
  and modern binaries dropped it; there is no ambiguous population.
- `providers.webSearchExclude` keeps warning only where it still exists: on
  ≥ 18.2.x binaries the key is absent from the snapshot, so the note simply
  never fires there.
