# The web-search provider list is discovered from omp

Settings → Providers carries one **Web search order** control (issue #394): which
provider omp's native `web_search` tool tries first. Its value is omp's own
`providers.webSearchOrder`, read through the settings snapshot and written through
`omp config set` like every other global omp key (ADR-0025). Its *choices* — the
provider ids a user may pick — come from the installed omp binary, discovered by
probing `omp search --provider=<sentinel>` and parsing the arg-validation rejection
that prints them. omp-ui never transcribes a provider catalog for this control.

omp publishes that list nowhere structured. `providers.webSearchOrder` is a plain
array whose pristine default is also `[]` (verified, omp 18.1.10), so neither
`omp config list --json` nor the pristine read enumerates anything, and the human
`config list` line carries a type placeholder rather than an enum, so the generic
`SettingControl` would render it as a read-only JSON span. The one machine-readable
publication is the rejection text:

```
error: Expected --provider to be one of: auto, perplexity, gemini, …, public; got "…"
```

It fires before any query handling and before any network call (~1 s, empty stdout,
rc=1, byte-identical under an empty `HOME`), so the probe runs under
`pristineEnvironment` and can neither read nor send a credential.

omp does **not** validate array members: `omp config set providers.webSearchOrder
'["bogus"]'` round-trips verbatim (verified). The closed select is therefore the
only guard against a dead entry, which is why the control offers no free text and
why a configured id omp's list lacks stays selectable, labelled as outside omp's
list rather than dropped.

## Considered options

- **Transcribing a curated provider list into omp-ui (rejected).**
  `provider-catalog.ts` is exactly this and already drifts: it carries five
  search-credential rows while omp 18.1.10 accepts 23 provider ids, and its ids
  (`google`, `openai-codex`) do not align with omp's (`gemini`, `codex`). A
  transcribed list is wrong on the day omp adds a provider, and omp-ui owns
  preference data it cannot keep true — the same reasoning ADR-0025 applied to
  capability catalogs.
- **Reading the pristine `webSearchOrder` default, as `readOmpCompactionMethods`
  does for `compaction.methodOrder` (rejected).** That trick works because omp's
  pristine method order lists every method it supports. The pristine
  `webSearchOrder` is `[]` (verified under an empty `HOME`): "no preference" is the
  default, so the read publishes nothing.
- **Spawning a probe session (rejected).** ADR-0025 already rejected a headless
  `omp --mode=rpc-ui` probe for opening a settings dialog; it would connect every
  MCP server and cost seconds per mount. The flag-validation probe costs one
  process and touches no network.
- **Letting omp-ui write free text (rejected).** omp accepts any member without
  validating it, so a typo becomes a silently dead preference. A closed list plus
  preserved-but-labelled unknown ids keeps every writable value one omp honours.

## Consequences

- **The parse is against undesigned output.** omp's flag-validation text is not a
  documented machine interface. If a future omp drops the enum or rewords the
  message, discovery returns `discovered: false` with a short synthetic reason; the
  row degrades to *Automatic* plus any already-configured ids and a visible note.
  It can never invent an id omp would reject.
- **Drift fails loudly in development.** A parity case in
  `omp-settings.test.ts` runs against the real binary when one is installed and
  asserts both web-search keys are still published and at least one provider is
  discovered — the same discipline as `omp-capability-keys.test.ts`.
- **omp's raw stderr never reaches a renderer.** Discovery answers
  `{ providers, discovered, error }` where `error` is a short synthesized string,
  so a crash message cannot leak a path or a variable name into the UI.
- **No omp-ui preference state.** The value, its layer badge, and the write all
  live in omp's config; omp-ui stores nothing about the choice, and the Providers
  page re-reads the snapshot after every write rather than patching it.
- **The keys are allowlisted but not grouped.** `providers.webSearchOrder` and
  `providers.webSearchExclude` join `OMP_SETTING_KEYS` (so `writeOmpSetting` accepts
  them) without joining `OMP_SETTING_GROUPS`, exactly as `MEMORY_SETTING_GROUP`
  does, so the omp page never renders an uneditable JSON span for them.
