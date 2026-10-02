# Generated bridges read omp settings through its config registry

> **Status:** Accepted, 2026-09-27
> ([#663](https://github.com/LankfordAI/omp-ui/issues/663),
> [#665](https://github.com/LankfordAI/omp-ui/issues/665)).

omp-ui's generated bridges need omp's *effective* setting values: the
capabilities bridge needs `magicKeywords.enabled` and each
`magicKeywords.<id>` to publish the keyword gate (issue #663), and the goal
bridge needs `goal.enabled` to know whether goals are switched off (issue
#665). On omp 18.3.2 the obvious read — `session.settings.get(key)` — is not
there: the `Settings` class exposes `rawValue(setting)` (undefined for
defaults), typed accessors, and `getGlobalSettings()`, but no string-key
`get`. The goal bridge's probe published
`available: false, "session settings cannot be read"` in every native
session, and `/goal` refused everywhere.

## Decision

Generated bridges read settings through **omp's own config registry**, via a
*literal* dynamic import:

```ts
// @ts-expect-error -- the extension loader maps this LITERAL specifier to
// omp's bundled config registry; a computed specifier does not resolve.
void import("@oh-my-pi/pi-coding-agent/config/registry").then(…)
```

and read with `lookup(id).get(session.settings)`. That returns the effective
value through omp's full layering — global config, the project's
`.omp/config.yml`, per-spawn `--config` overlays, and live `omp config set`
changes, re-read on every sample. The keyword table itself comes the same way
from `@oh-my-pi/pi-coding-agent/modes/magic-keywords`
(`MAGIC_KEYWORDS`), so the published gate is omp's data, never a mirrored
constant. Both fragments live in `generated-extension-source.ts`
(`generatedOmpSettingReaderSource`) and follow ADR-0030's finding that the
specifier resolves inside extensions and ADR-0008's rule that bridges only
read — a registry lookup is a read.

The specifier must stay a **literal**: a computed one fails to resolve
(`Cannot find package '@oh-my-pi/pi-coding-agent'`), verified against the
18.3.2 binary. The `@ts-expect-error` is required for the same reason — the
package is not in omp-ui's dependency graph, so the compiler cannot see it;
`typecheckGeneratedExtension` reports zero errors with the directive in
place. Unit harnesses load the transpiled CommonJS through
`Function("module", "exports", "require", …)` and serve both specifiers from
their own fake registry/table, so the same code path the runtime takes is
what the tests exercise.

## Considered options

- **`settings.get(key)` (rejected).** Absent in 18.3.2; it is precisely the
  call that makes the goal bridge unavailable today.
- **`settings.rawValue(setting)` (rejected).** Returns `undefined` for
  values sitting on their default, so "unset" and "unreadable" collapse
  together — and the keyword gate must never publish "cannot tell" as "off".
- **A main-process `omp config list --json` read (rejected).** ~0.15 s per
  spawn, blind to per-lineage `--config` overlays, blind to live changes
  without re-spawning, and it answers for the wrong process when several
  sessions exist.
- **Forcing values through overlays (rejected).** Writing `magicKeywords.*`
  or `goal.*` into every spawn would make the read trivial — and would be a
  write into the user's configuration semantics, which ADR-0025 put out of
  bounds for exactly this kind of convenience. Narrowed by ADR-0046 for
  `goal.continuationModes`.

## Consequences

- **The two module paths are omp-internal.** A rename breaks both reads at
  once, and it must fail loudly: `magic-keywords-live.test.ts` case 1
  deep-compares the published table against the port's, and the bridge-gate
  case compares the settings rows. Both run under `npm run test:live` against
  the installed binary. `goal-bridge-live.test.ts` no longer exists: goal mode
  left the bridges (ADR-0046).
- **"Cannot tell" is its own state.** An unavailable registry publishes
  `missing-api`/`read-failed`, never a roster of `enabled: false` rows; the
  composer then falls back to painting every keyword — the pre-gate
  behaviour — rather than silencing a word omp would honour.
- **The registry read is the canonical settings seam for future bridges.**
  Anything that needs "what does omp think this setting is, for this
  session" interpolates `generatedOmpSettingReaderSource()` instead of
  inventing a fourth access path.
