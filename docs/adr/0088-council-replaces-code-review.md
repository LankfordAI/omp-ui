# Council replaces code review with a roster of pinned member models

> **Status:** Accepted, 2026-11-04 ([#1049](https://github.com/LankfordAI/omp-ui/issues/1049), [#1048](https://github.com/LankfordAI/omp-ui/issues/1048)).

Supersedes [ADR-0047](0047-code-review-roster-via-background-subagents.md). Verified against omp 18.16.0.

One slash command, `/council`, asks 1–3 member models chosen in Project
settings → Council for independent, read-only opinions on any request.
`/council review [target]` keeps the git target resolution of the old
`/code-review` and adds a score out of 10 per member. The member list starts
empty.

Pinned reviewer models could not work on omp 18.16.0 (#1048), for two reasons
verified in the installed binary. `task.perCallModel` defaults to `off`, so
omp rejects every per-item `model`. And omp-ui's own subagent overlay
(ADR-0031) writes `task.agentModelOverrides: {"task": "*"}` whenever the
inherit umbrella is on, which is the default; omp then refuses a per-call
model on the `task` agent because an override names it. ADR-0047's reviewers
were exactly `task` items with per-item model pins.

## Findings

| Fact | Where it was read |
|---|---|
| `task.perCallModel` is an enum of `off`, `eval`, and `on`, default `off`. `"on"` is accepted on task items. | Setting definition in the binary; `omp://task-agent-discovery.md:234-242`. |
| Grants come from chat roles in operator layers, `--config` included, and custom role names are chat roles. | `omp://task-agent-discovery.md:248,264`; `omp://models.md:714-715`. |
| Override conflict text: `Per-call model conflicts with task.agentModelOverrides for agent "${name}". Omit model to use the configured override.` It fires when `Object.hasOwn(agentModelOverrides, agentName)`. | Binary strings (the preflight function next to `task.agentModelOverrides`). |
| Unapproved text: `Per-call model ${m} is not approved for agent "${agent}": use a model named by a chat role configured outside project settings, …`. Unavailable text: `Per-call model ${m} is not an available chat model.` | Binary strings. |
| Objects deep-merge across config layers; scalars and arrays replace. | `omp://settings.md:165-170`. |
| Explicit `--extension` directory roots contribute `agents/*.md`. A directory with `package.json#omp.extensions` loads the declared entries. File entrypoints contribute no sibling resources. | `omp://task-agent-discovery.md` § Discovery inputs; `omp://extension-loading.md:213-229`. |
| A batch item takes `name`, `agent`, `model`, `task`, and `solutionSpace` (required). | `omp://tools/task.md:45-54`. |

### Probe (omp 18.16.0, real binary, rpc-ui)

A hermetic HOME with a scripted SSE provider `probe` carrying two models:
`inert` (the session model) and `member` (the council model, deliberately not
the session model, because the parent's live model grants itself). The
lineage dir held an extension package directory passed with `-e <dir>`:
`package.json` declaring `omp.extensions`, a minimal entry registering a probe
command, and `agents/omp-ui-council.md`. Overlay *U* is the umbrella omp-ui
writes by default, `task.agentModelOverrides: {"task": "*"}`; overlay *G* is
the council grants, `task.perCallModel: "on"` plus one role
`omp-ui-council-1: probe/member`. The first scripted completion emits one
`task` call with a single item `council-a` pinned to `probe/member`.

| Run | Result |
|---|---|
| A: `-e <dir>`, `--config U`, `--config G`, item agent `omp-ui-council` | The extension command registered from the directory root. The task result is not an error: ``Spawned agent `council-a` (job `council-a`).`` Progress shows `agent: "omp-ui-council"`, `agentSource: "user"`, and the provider then received a completion request for model `member`. |
| B: `-e <dir>`, `--config U` only | Error: `Per-call model is disabled for task calls (task.perCallModel: off). Omit model to use the agent's configured model.` The grant overlay is what makes run A pass. |
| C: as A, but item agent `task` | Error: `Task council-a failed preflight: Per-call model conflicts with task.agentModelOverrides for agent "task". Omit model to use the configured override.` The dedicated agent is required. |

## Decision

1. **One command, two modes, no alias.** `/council <request>` is ask mode and
   `/council review [pr <n> | <ref> | <from>..<to>]` is review mode; any other
   text after `review` is an ask. The model-callable tool is `omp-ui_council`.
   There is no `/code-review` alias, and no `/review`, which is omp's
   built-in. Review mode keeps the old target resolution and every member
   ends its reply with a `SCORE: <0-10>/10` line (or `SCORE: none`).
2. **Empty by default.** `DEFAULT_REVIEWER` is deleted. Nothing ever falls
   back to the session model.
3. **A member is `{ name, model, instructions, enabled }`.** A launch needs a
   model; the editor will not save a member without one. A stored member with
   `model: null` (migrated legacy data) stays stored, is shown as "no model —
   skipped", and is never launched.
4. **At most three members launch.** Validation keeps the first 3 enabled
   members that have a model and warns about the rest. The editor disables
   *Add member* at 3 rows. Storage still accepts up to 64 entries, so legacy
   data loads. A member name is a slug of at most 24 characters, so
   `council-<name>` stays within omp's 32-character agent-name guidance.
5. **Members run on a dedicated agent.** The task agent `omp-ui-council`
   ships in a per-lineage extension package directory passed with `-e <dir>`,
   beside the bridge; omp discovers `<extension-root>/agents/*.md` for
   explicit `--extension` directory roots. That name never appears in
   `agentModelOverrides`, so the override conflict (probe run C) cannot fire,
   and the subagent umbrella stays untouched.
6. **The council overlay grants the models.** The council `--config` overlay
   sets `task.perCallModel: "on"` and one `modelRoles."omp-ui-council-N"` per
   launched member, each the member's selector verbatim. omp grants per-call
   models from `--config` chat roles, and objects deep-merge across layers,
   so the user's own roles survive.
7. **Storage is app state, renamed.** `RegistrySettings.councilRoster` and
   `ProjectRecord.councilRoster`, resolved project → global → empty. A legacy
   `reviewRoster` is migrated once on load (rename plus dropping `targets`).
   `reviewRosterImported` is removed.
8. **The legacy import is deleted.** `review-config-import.ts`,
   `importReviewRostersOnce`, and `parseReviewDocument` are gone; no
   `REVIEW.yml` file is read in any form.
9. **Project settings → Council.** The Project settings tab id `"reviewers"`
   becomes `"council"`, still hidden unless `experimentsEnabled`. For a local
   project, *Pick…* reads omp's chat catalog (`readChatModels`), so no live
   session is needed. Remote projects keep the live-session model list.
10. **An empty council refuses before any model turn.** The composer
    intercepts `/council`. If the live roster has no launchable member, it
    appends a failed command row with an *Open council settings* button and
    starts no model turn. Otherwise it forwards normally. The bridge refuses
    an empty spawn-time snapshot as well.
11. **Same gate.** The whole subsystem stays behind `experimentsEnabled`, the
    same switch that gated code review.
12. **ADR-0074 and ADR-0081 stay as written.** Their "the `reviewRoster`
    rule" prose stays as history. Code comments in `registry.ts` are renamed.

## Rejected options

- **Keeping `/code-review` beside `/council`.** Two lists of the same models
  drift apart, the lesson of #738.
- **Per-member `agentModelOverrides`.** One agent name cannot vary its model
  per member.
- **Writing agents into `~/.omp/agent/agents`.** It mutates user files.
- **Dropping the subagent umbrella while the council runs.** It breaks
  [ADR-0031](0031-subagent-model-selection-via-config-layers.md).
- **Shipped default members.** omp-ui cannot know the user's providers.
- **Falling back to the session model.** One member on the session model is
  just a subagent.

## Consequences

- `task.perCallModel: on` applies to the whole session while experiments are
  on, but only models the overlay or the user's own roles grant can be
  picked.
- A user `task.perCallModelAllow` can still narrow the grants, and omp's
  refusal reaches the user verbatim.
- Roster edits apply on relaunch.
- Remote-project roster channels stay unproxied, as today.

**Amended 2026-11-05 (#1055):** decision 2, *Empty by default*, is amended from
terminal-empty to seeded-on-enable for the global roster only: enabling the
council flag with a memberless global document seeds it once from the user's
own favorite chat models (in favorites order, at most three, no catalog
fallback — Refs #1058) before the flag persists. The rejection of shipped
default members stands — every seeded member is a model the user chose.

**Amended 2026-11-05 (#1057):** decision 3's member `name` becomes optional: a
blank name is stored as-is, and the launch/display name derives from the
current model at validation time (the end of the model slug, suffixed on a
collision), so swapping a member's model renames the member automatically. An
explicit name still pins.

## Amended 2026-11-05 (graduation)

Decision 11, *Same gate*, is superseded: the council no longer rides
`experimentsEnabled`. It now reads its own `councilEnabled` flag with the
default **on**, edited on Settings → Council. Existing installs flip on once
through a force-on migration marker, `councilDefaultOnSeeded`: a persisted
`councilEnabled: false` is indistinguishable from an explicit refusal to turn
the council on, so the migration cannot simply default the flag and must record
that it has run.

Recorded drift: decisions 9 and 11 already said `experimentsEnabled` while the
code had moved to the separate `councilEnabled` flag in #1052 (three
independent switches on Settings → Experimental). The prose was stale; this
amendment records that the drift was resolved there, not here.

The #1055 seeding trigger moves from the renderer's flag-flip to main:
`seedCouncilRosterIfUnset` runs at boot after the shell-key capture, gated on
`councilEnabled`, and is awaited in the settings enable handler before the flag
commits. The null-document rule stands with it — a global roster document that
exists, including one deliberately saved empty, is never re-seeded; only a
never-authored (null) document is.

Consequences amended:

- The `task.perCallModel` overlay rides only when at least one member launches.
  An empty resolved roster writes no council `--config` overlay at all; the
  roster snapshot and the bridge package are still written, so `/council`
  answers with its refusal pointer instead of a restart hint. The original
  sentence's "while experiments are on" is likewise superseded by
  `councilEnabled`.
- Remote-project roster channels are now **proxied** to the owning instance,
  replacing "Remote-project roster channels stay unproxied, as today." A
  user-scope write through the proxy edits the owner's global roster, the same
  model as `watchdog:roster:set`. `settings:setCouncilEnabled` stays unproxied,
  so a joined instance's Council tab follows the local flag.
- PTY-tab support is explicitly deferred. It needs `spawnOmp` extensions
  plumbing (the terminal spawn path passes no extension roots) and a proof that
  the omp TUI surfaces async task results back to the model; until both exist,
  council is rpc-only.

## Amended 2026-11-10 (trial member)

Decision 3 gains one optional slot on the council document: `trial`, a member-shaped
entry for a model under evaluation. Decision 4's cap is unchanged. The trial
member is not a council member and does not count against the three.

- It launches only beside at least one council member, in its own `task` call
  with a one-item batch. omp preflights every item of a call before dispatch
  (`omp://tools/task.md`, Flow and Errors), so a shared batch would let one
  unavailable trial model cancel the council.
- Decision 6 gains a role: `modelRoles."omp-ui-council-trial"` grants the trial
  model.
- Its assignment is identical to a council member's and never mentions the
  trial, so the comparison is fair.
- The launch message tells the session model to build the summary, the
  recommendations, and the review loop from the council members alone, and to
  report the trial member in a separate "Trial model" section. This is an
  instruction to the session model, not isolation: the answer still reaches
  its context.
- The roster snapshot is version 2 and carries `trial`.

Rejected: a fourth member with a flag (raises the cap and mixes two kinds of
entry in one list), and holding the trial answer back from the session model
(no extension context can intercept an async result).
