# The web-search provider list is read from omp's model catalog

> **Status:** Accepted, 2026-09-26 ([#649](https://github.com/LankfordAI/omp-ui/issues/649)).

[ADR-0027](0027-web-search-provider-list-discovered-from-omp.md) enumerated the
provider ids of the Settings → Providers **Web search order** control by probing
`omp search --provider=<sentinel>` and parsing the arg-validation rejection.
That probe is gone, and not because omp reworded the message:

- omp 18.2.x moved the web-search provider preference out of
  `providers.webSearchOrder` and into the `web` role of `modelRoles`
  (`web/<provider>` selectors). `omp config list --json` no longer publishes
  `providers.webSearchOrder` or `providers.webSearchExclude` — among the
  `providers.webSearch*` keys only `providers.webSearchTimeoutSeconds` remains
  (verified, omp 18.3.2).
- omp 18.3.2's `omp search` has no `--provider` flag at all ("Unknown
  option"), so the rejection can never print an enum again.

The parity case in `omp-settings.test.ts` caught exactly this drift, which is
what ADR-0027's Consequences section anticipated ("If a future omp drops the
enum…"). This ADR changes the enumeration transport; it keeps every other part
of ADR-0027's contract: the ids come from the installed binary, never from a
transcribed catalog; the select stays closed; unknown configured ids stay
selectable; failure degrades to `discovered: false` with a short synthetic
reason; omp's raw stderr never reaches a renderer.

## Decision

`readWebSearchProviders` runs **`omp models --kind search --json`** under
`pristineEnvironment` and takes the `id` of every row whose `provider` is
`"web"` and `kind` is `"search"`, in catalog order (
`parseWebSearchProviderCatalog`, deduplicated; an unusable shape or an empty
catalog is the same synthetic-reason degradation as before). The snapshot type
`WebSearchProviderSnapshot` and every caller are unchanged.

The catalog is the better publication on every axis ADR-0027 cared about:

- **Designed output.** A documented `--json` contract, not undesigned
  flag-validation text — the one weakness ADR-0027 itself recorded.
- **Offline and cheap.** It answers from the bundled catalog: rc=0 in ~1–3.5 s
  with the network fully cut (`unshare -rn`).
- **Credential-safe by construction.** Verified on 18.3.2: the search kind is
  **not key-gated** — the pristine-HOME and live-environment catalogs are
  byte-identical. The read therefore runs under a replaced `HOME`, exactly
  like the old probe, and can neither read nor send a credential. This is a
  deliberate difference from `readSttModels` (ADR-0034), whose catalog rows
  *are* key-gated and so must run under the live `process.env`. If a future
  omp starts key-gating search rows, that is the signal to revisit this.

## Considered options

- **Drop the select and show no web-search control (rejected).** The parity
  test can pass on absence, but the ids are still published — by a designed
  interface now. Hiding a control omp can still fully answer for wastes the
  enumeration omp-ui already has a safe path to.
- **Rebind the control's value to `modelRoles.web` in this change (deferred).**
  That is a feature change with semantics of its own — `modelRoles` is
  REPLACE-not-merge (ADR-0031) and layered — and it is not what broke. The
  value side stays keyed to `providers.webSearchOrder`, so the row correctly
  disappears on omp ≥ 18.2.x until a separate issue binds it to the `web`
  role.
- **Keep the probe and add the models read as a fallback (rejected).** Dead
  code against every supported binary; the flag is gone, not reworded.

## Consequences

- **The order row disappears on modern omp, visibly.** An omp that no longer
  publishes `providers.webSearchOrder` renders no web-search order row
  (`WebSearchProviderRow` returns null on an absent key) — correct per
  ADR-0025: omp-ui never offers to write a key omp would not honour. Restoring
  the control means binding it to `modelRoles.web`; that is a tracked follow-up.
- **The legacy keys stay allowlisted.** `providers.webSearchOrder` and
  `providers.webSearchExclude` remain in `OMP_SETTING_KEYS` so an older omp
  that still publishes them stays readable and writable; nothing is written
  for a key the snapshot does not show.
- **The parity test pins the catalog read, not the dead keys.** It asserts the
  live binary still publishes `providers.webSearchTimeoutSeconds` (a
  generation marker read straight from `omp config list --json`, since that
  key is deliberately not in the snapshot's allowlist) and that
  `readWebSearchProviders` discovers at least one provider. Against a binary
  with no `models --kind search`, it fails loudly — the supported binary is
  18.2.11+.
