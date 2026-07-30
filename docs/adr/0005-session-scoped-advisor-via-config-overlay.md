# Session-scoped advisor, driven by a per-lineage `--config` overlay

The advisor toggle lives in the composer, next to the model it affects, and is
**scoped to a session** rather than a project. Both the enable flag and the
advisor's model are delivered to omp as a `--config` YAML overlay written into
the session's lineage dir (ADR-0003) and passed at spawn. Changing either one
relaunches the session with `--resume`.

## Why not the obvious routes

Verified against omp 17.1.8 by driving a real `--mode=rpc-ui` process:

- **No rpc command exists.** The `RpcCommand` union
  (`src/modes/rpc/rpc-types.ts:28-92`) has no advisor variant; `set_advisor`,
  `set_advisor_model`, and `toggle_advisor` all come back
  `Unknown command: <name>`.
- **`get_state` reports no advisor state.** `RpcSessionState`
  (`rpc-types.ts:98-118`) has no advisor field, so omp-ui cannot read back what
  it set. The UI's own record is therefore the source of truth.
- **`/advisor` has no `model` subcommand.** Its grammar is
  `[on|off|status|dump [raw]|configure]`; `/advisor model <id>` returns the
  usage string. `/advisor configure` is TUI-only and over rpc returns a
  sentence saying so.
- **`--advisor` is boolean-only and one-way.** It merely does
  `settings.override("advisor.enabled", true)` (`src/main.ts:1257-1259`).
  `--advisor=<model>` parses without error and *silently discards the value*:
  the parser splices the post-`=` text in as the next token, and because the
  flag consumes nothing the post-loop guard deletes it (`src/cli/args.ts:240,
  286-292`).
- **The model is bound once, at startup.** Editing an overlay under a live
  process changes nothing, and `/advisor off` then `on` rebuilds the runtime
  from the already-resolved selection — measured: the status line kept
  reporting the old model. Hence the relaunch.

## Consequences

- **`advisor.enabled: false` must be written explicitly.** Omitting
  `--advisor` does **not** turn the advisor off: the flag only ever sets the
  value to true, so a user whose `~/.omp/agent/config.yml` says
  `advisor.enabled: true` (which omp's own setup writes) would find the
  composer's "off" silently ignored. The overlay is the only thing that can say
  false. This was a real bug, caught by driving live omp rather than by
  inspection.
- **A model pin is a selector string, `model[:level]`.** omp encodes the
  advisor's thinking effort as a suffix inside `modelRoles.advisor` (e.g.
  `…claude-opus-5:high`). Storing a bare model id would silently drop the
  user's configured effort, so the suffix is parsed off and re-joined rather
  than discarded.
- **A `null` pin means "whatever omp resolves", which is the absence of the
  key** — never `modelRoles.advisor: ""`, which resolves to *no advisor model
  at all*. When the key is unset omp falls back in code to the `slow` priority
  chain, so there is no literal for the UI to display; the picker says as much
  instead of inventing one.
- **Defaults are read from omp's config, not stored by omp-ui.** New sessions
  inherit `advisor.enabled` from `~/.omp/agent/config.yml` overlaid by
  `<cwd>/.omp/config.yml`, so editing omp's config keeps working. A session
  that has never expressed a preference gets no overlay at all.
- **`--config` is a strict loader**: a missing or malformed overlay is a hard
  startup error. The overlay is therefore written before spawn, and a failed
  write degrades to omp's own advisor config rather than taking the session
  down.
- **The project-level advisor flag is gone.** It duplicated the composer
  control with different scope and could not express "off" against an omp
  config that said on. `ProjectRecord.advisor` and its IPC channel were
  removed rather than left as a second way to say the same thing.
- The advisor's own notes need no new plumbing: they already arrive as
  `role: "custom"`, `customType: "advisor"` messages carrying
  `details.notes`, which `lib/transcript.ts` reduces to an `advisory` render
  item.
