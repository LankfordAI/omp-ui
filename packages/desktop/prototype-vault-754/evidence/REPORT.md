# Prototype the host-tool vault round trip (#754)

Branch `omp-ui/main/a58ff0e2` in this session's worktree (the plan named `omp-ui/obsidian-vault-wayfinder/754`; the session was pinned to its existing branch). Local commits `b72056cc` (code), `92ee22be` (fixtures, bench, driver, probes), `74c3515b` (runs and probes), plus the report commit. Nothing is pushed or merged.

Every session ran headless on omp 18.6.1 with `openrouter/anthropic/claude-opus-5.5`. The vault was the real `Obsidian` vault (`ee8bdab8baa42089`, `/home/alankford/Documents/Obsidian`) seeded with eight invented notes, except R13, which used a synthetic 5,000-note vault.

## Measurements

### Search benchmark (model-free)

Filesystem backend, `limit` 10, one first call then five warm calls, Node 22.22.2. Synthetic vaults use a fixed seed (mulberry32, seed 754).

| Tier | Notes | Size | Median note | p95 note | Largest note |
|---|---|---|---|---|---|
| volume-1000 | 1000 | 6.3 MB | 2324 B | 24579 B | 205320 B |
| volume-5000 | 5000 | 27.6 MB | 2365 B | 21156 B | 194999 B |
| volume-20000 | 20000 | 114.1 MB | 2357 B | 20977 B | 205226 B |

| Vault | Backend | Query | First ms | Warm median ms | Warm p95 ms | Matched | Returned | Result chars |
|---|---|---|---|---|---|---|---|---|
| volume-1000 (1000 notes) | fs | `zephyrine` | 50 | 40 | 46 | 3 | 3 | 283 |
| volume-1000 (1000 notes) | fs | `quarterly roadmap` | 36 | 38 | 40 | 51 | 10 | 1136 |
| volume-1000 (1000 notes) | fs | `the` | 50 | 47 | 47 | 973 | 10 | 6148 |
| volume-1000 (1000 notes) | fs | `Daily` | 38 | 37 | 38 | 0 | 0 | 44 |
| volume-5000 (5000 notes) | fs | `zephyrine` | 159 | 163 | 167 | 3 | 3 | 328 |
| volume-5000 (5000 notes) | fs | `quarterly roadmap` | 170 | 167 | 170 | 241 | 10 | 1156 |
| volume-5000 (5000 notes) | fs | `the` | 214 | 216 | 220 | 4895 | 10 | 6077 |
| volume-5000 (5000 notes) | fs | `Daily` | 173 | 172 | 173 | 0 | 0 | 44 |
| volume-20000 (20000 notes) | fs | `zephyrine` | 630 | 604 | 624 | 3 | 3 | 298 |
| volume-20000 (20000 notes) | fs | `quarterly roadmap` | 622 | 642 | 645 | 1060 | 10 | 1128 |
| volume-20000 (20000 notes) | fs | `the` | 816 | 833 | 873 | 19600 | 10 | 6589 |
| volume-20000 (20000 notes) | fs | `Daily` | 649 | 653 | 676 | 0 | 0 | 45 |
| Obsidian (cli) | cli | `zephyrine` | 8 | 5 | 5 | 0 | 0 | 45 |
| Obsidian (cli) | cli | `quarterly roadmap` | 5 | 4 | 4 | 0 | 0 | 53 |
| Obsidian (cli) | cli | `the` | 4 | 4 | 4 | 7 | 7 | 1361 |
| Obsidian (cli) | cli | `Daily` | 4 | 4 | 4 | 0 | 0 | 41 |
| Obsidian (fs) | fs | `zephyrine` | 1 | 0 | 0 | 0 | 0 | 45 |
| Obsidian (fs) | fs | `quarterly roadmap` | 0 | 0 | 0 | 0 | 0 | 53 |
| Obsidian (fs) | fs | `the` | 1 | 0 | 0 | 7 | 7 | 1083 |
| Obsidian (fs) | fs | `Daily` | 0 | 0 | 0 | 0 | 0 | 41 |

- The filesystem scan grows linearly, at about 33 to 42 ms per 1,000 notes. A 20,000-note, 114 MB vault answers in 0.6 to 0.9 s, well under the 60 s watchdog.
- The `.trash/` copy of `zephyrine` was never returned, so the dot-directory skip holds.
- The result cap held. `the` at `limit` 50 on volume-20000 returned 37 notes, 23,689 characters, and ended with `… 13 more notes; narrow the query or raise limit`. At the default `limit` 10 the largest result was 6,589 characters.
- The CLI backend (`obsidian search:context format=json`) answered in 4 to 8 ms on the 8-note real vault, against 0 to 1 ms for the filesystem. CLI at volume: not measured (you chose to skip opening `volume-5000` in Obsidian).
- `Daily` matched nothing in the synthetic vaults. Daily notes are titled `2026-MM-DD` and only the folder is `Daily/`, so search is title plus body, never path. That is worth stating in the tool description.

### End to end (R13, volume-5000 through a real session)

| Query | Main ms | Renderer start to end ms | Result chars | Returned |
|---|---|---|---|---|
| `quarterly roadmap` | 697 | 682 | 1,156 | 10 of 241 |
| `zephyrine` | 699 | 625 | 328 | 3 |
| `the` | 700 | 627 | 6,077 | 10 of 4,895 |

The agent reported "10, 3, 10" and correctly said 10 meant "at least 10". The tool result does not give the true match count in its text (only in `details.matchedFiles`), so the agent could not report it.

### Payload sizes across all 76 vault calls (main log)

| Tool | Calls | argsBytes median / max | resultTextChars median / max | imageBytes max | main ms median / max (excl. R10) |
|---|---|---|---|---|---|
| `omp-ui_vault_search` | 43 | 31 / 51 | 276 / 6077 | 0 | 1 / 700 |
| `omp-ui_vault_read` | 25 | 34 / 60 | 185 / 1132 | 14366 | 1 / 3 |
| `omp-ui_vault_write` | 8 | 627 / 1775 | 181 / 219 | 0 | 1 / 6 |

The one image (the 512 px seed PNG, 14,366 bytes) went through the result `content` array unchanged.

### Watchdog (R10, search delayed 75 s)

- At 30 s the card showed `running` with the query chip ([still](runs/R10/still-30000.png)).
- At 60 s HostBridge answered `omp-ui could not answer this request in time`. The card turned into the red error card ([still](runs/R10/card-1-omp-ui_vault_search-expanded.png)).
- The real answer landed at 75,004 ms and was dropped: `proto754 late answer dropped id=159ade0c21dbbb54 ms=75004`.
- The agent retried the same search once (`limit` 10 added) and got the same error after 60 s. It then tried `omp-ui_vault_read` with path `Zephyrine` (no note) and stopped. It offered to "look in the vault folder on disk if you tell me where it is". It did not go hunting through the home directory.
- omp itself has no host-tool timer. `RpcHostToolBridge.requestExecution` in the managed binary settles only on `host_tool_result`, abort (`host_tool_cancel`), or bridge shutdown. R5's agent found the same thing independently. ADR-0043's "omp's host-tool timeout defaults to 120s" (`host-bridge.ts:24`) is wrong for omp 18.6.1. The 60 s watchdog is the only deadline.

## Agent behaviour

### Rubric

| Run | Setup | Found the vault tools | Searched before first write | Wrote unprompted | Note shape | Links |
|---|---|---|---|---|---|---|
| R1 | discoverable, no guidance | `xd://` (read the device doc, then `write xd://`) | no write | n/a | none | none |
| R2 | essential, no guidance | direct | no write | n/a | none | none |
| R3 | essential, message | direct | no write | n/a | none | answer used `[[2026-09-29 omp-ui Planning Meeting]]` and `[[Session HUD]]` |
| R4 | essential, message, fresh | direct | yes (`knowledge home`, 0 hits) | yes, turn 1, then appended on turn 2 | "Knowledge Home Storage", Title Case, flat, tag `decision`, 1,423 B, no frontmatter attempt | index link only |
| R5 | essential, message | never called | no write | no (the lesson "ADR-0043 is wrong" was not written) | none | none |
| R6 | essential, message | direct | yes (`plan mode`, `vault`, then read the meeting) | asked | "Vault Writes in Plan Mode", Title Case, flat, tags `omp-ui`, `plan-mode`, 1,866 B, body opens with an `# H1` repeating the title | `[[2026-09-29 omp-ui Planning Meeting]]` bare, correct |
| R7 | essential, no guidance, fresh | never called | no write | wrote `docs/adr/0048-…md` and edited `docs/architecture.md` in the project worktree instead | n/a | n/a |
| R8a | essential, message, approval `write` | direct | yes (9 searches/reads) | asked; asked a clarifying `ask` (cancelled by the driver after 60 s), wrote nothing | none | none |
| R8b | discoverable, message, approval `write` | `xd://` | yes (16 calls, including reads of guessed paths `omp-ui/Decisions`) | asked; created "Session HUD Decision" when no decision note existed | Title Case, flat, tag `decision`, 370 B | `[[2026-09-29 omp-ui Planning Meeting]]`, `[[Session HUD]]` |
| R9a | Plan on, guard off | direct | yes | asked; vault write ran in Plan, repo write refused | "Knowledge Home Is A ProjectRecord Field", Title Case with "A" and "Is" capitalised, tag `decision`, `# H1` | index link only |
| R9b | Plan on, guard on, fresh vault | direct | yes | asked; agent withheld the vault write itself | none | none |
| R9c | as R9b, then "Write the vault note now" | direct | yes | refused again, citing Plan mode | none | none |
| R10 | 75 s search delay | direct | n/a | n/a | n/a | n/a |
| R11 | diagnostics | n/a | n/a | n/a | n/a | n/a |
| R12 | subagent | parent wrapped the tools; subagent called them through the parent's kernel | yes | asked | "omp-ui Meeting Notes Summary", 851 B, one paragraph plus a Sources line, tag `meeting` | both meeting notes, bare, correct |
| R13 | volume-5000 | direct | n/a | n/a | n/a | answer used bare `[[Title]]` for synthetic notes |
| R14a/b | append | direct | yes (search then read before append) | asked | appended in place | returned link reused |

Content rules: no secrets, tokens, or raw transcript text in any note. R12's summary paraphrases the two seed notes; nothing was copied verbatim. No note had agent frontmatter (`agentFrontmatterDropped` stayed false). No run called a vault tool with an unexpected argument (`extraArgs` was empty on all 76 calls, so omp did not forward its `i` intent field to host tools). No run tried to reach the vault by its absolute path through `bash`, `read`, or `find`; the vault path appears nowhere the model can see, and no agent went looking.

### Findings

1. **Discovery works without guidance.** In R1, with no hidden message and only the discoverable catalog line, Opus read `xd://omp-ui_vault_search`, then searched and read through `write xd://`. Essential tools (R2) are called directly. Both modes answered the question correctly from the user's notes.
2. **Unprompted writing needs the guidance message, and even then it is narrow.** With the message, R4 wrote a decision note on turn 1 before the user confirmed, then appended the confirmation on turn 2. Without the message, R7 wrote nothing to the vault: it recorded the same decision as an ADR in the repo and edited `docs/architecture.md`. R5 found a real lesson (ADR-0043 is wrong) and did not write it, even with the message. The guidance names "settles a decision" and "learns a lesson"; Opus acted on the first, not the second.
3. **Search before write held in every run that wrote.** It also searched before append (R14) and before giving up (R8a/b).
4. **Note shape mostly matches the convention.** Titles were Title Case and flat in all five created notes. Two of five bodies repeated the title as an `# H1`. Tags were sensible (`decision`, `meeting`, `plan-mode`). No agent tried its own frontmatter.
5. **Links are right.** The user's notes were linked bare (`[[2026-09-29 omp-ui Planning Meeting]]`, `[[Session HUD]]`), and omp-ui notes with the path-qualified alias the tool returned. No link pointed to a note that does not exist. The `Session HUD` same-name bait never fired: no agent titled a note "Session HUD" (R8b chose "Session HUD Decision"), so collision handling was proven only by the model-free smoke.
6. **A missing target note makes the agent hunt or ask.** R8a/b were asked to append to "the omp-ui decision note" when none existed. R8a ran 9 calls and then asked a clarifying question through `ask`. Nobody answers in a headless run, so the driver cancelled it after 60 s, and the agent wrote nothing. R8b ran 16 calls, guessing paths such as `omp-ui/Decisions` and `omp-ui/omp-ui`, then created a new note and said so. A list operation (or search over `omp-ui/` paths) would have ended both hunts in one call; `omp-ui/` as a search query matched nothing because search ignores paths.
7. **The agent reaches outside the vault for "recording" a decision.** In R4, before the gh sandbox, Opus posted its decision as a comment on the real issue #756 (`gh issue comment 756`). I deleted the comment; a copy is in `incidents/R4-gh-comment-756.json`. All later runs had `GH_CONFIG_DIR` pointed at an empty directory. This is a guidance and security finding, not a vault tool bug.

## Renderings

| Surface | Still |
|---|---|
| Discoverable call: generic `write` card, `xd://omp-ui_vault_search` path chip, the tool's text result below | `runs/R1/card-2-write-expanded.png` |
| Essential call: top-level `omp-ui_vault_write` card, args (mode, title, content), path chip `omp-ui/Knowledge Home Storage.md`, result text | `runs/R4/card-5-omp-ui_vault_write-expanded.png` |
| Image block: `omp-ui_vault_read` card renders the PNG as a thumbnail below the note text | `runs/R6/card-1-omp-ui_vault_read-expanded.png` |
| Error: watchdog answer, red error card | `runs/R10/card-1-omp-ui_vault_search-expanded.png` |
| Approval, essential: "ALLOW TOOL omp-ui_vault_search", no args shown | `runs/R8a/approval-1.png` |
| Approval, discoverable: "ALLOW TOOL write" with `Path: xd://omp-ui_vault_search` and the JSON content | `runs/R8b/approval-1.png` |

- Cards are keyed `tool-<seq>` in the DOM, not by toolCallId.
- The essential approval card shows the tool name and no arguments, so the user approves a vault write without seeing its title or content. The discoverable one shows the full JSON payload, which is more informative but reads as a generic file write to `xd://`.

## Approval under `write`

| Run | Prompts | Calls |
|---|---|---|
| R8a (essential) | 9: `omp-ui_vault_search` 6, `omp-ui_vault_read` 3 | 9 vault calls, all reads |
| R8b (discoverable) | 16: all titled `write` | 16 vault calls via `write xd://` (9 searches, 6 reads, 1 write). The 4 `read xd://` doc reads did not prompt, and one `write xd://recall` (omp memory) ran without a prompt |

Every host-tool call prompted, reads included, as #752 predicted (`exec` tier): 16 prompts for 16 vault calls. Reading the `xd://` device docs did not prompt, and neither did `write xd://recall`, so the prompt keys on the host tool, not on `write xd://` as such.

## Plan mode

| Run | HostBridge guard | `planEnabled` at the call | Vault write | Repo write |
|---|---|---|---|---|
| R9a | off | `true` (log) | ran, note created | refused by omp's plan guard; agent wrote `local://knowledge-home.md` instead |
| R9b (rerun on a fresh vault) | on | `true` | never attempted: the agent held it itself, citing Plan mode | refused |
| R9c | on, plus "Write the vault note now" | `true` | refused again by the agent | n/a |

- omp's Plan guard does not cover host tools. With the HostBridge guard off, the vault write ran during Plan (R9a), exactly as #752 said.
- HostBridge saw Plan state correctly: every call in R9a/b/c logged `planEnabled: true`. That came from the `omp-ui:plan` setStatus frame that the Plan toggle click produced.
- The guard's refusal text was never exercised by a model. In R9b and R9c, Opus withheld the vault write on its own reading of Plan mode ("In plan mode the only writable place is `local://`"), even when the user asked for it explicitly. In R9a, the same model, with the same guidance, wrote the note in Plan. The guard is still needed: model behaviour differed run to run.
- The first R9b run reused R9a's note (it found it by search and declined to duplicate), so it was rerun on an empty `omp-ui/`. The first run is kept as `runs/R9b.prev-*`.

## `omp-ui://` and `bash` (R11)

| Tool | Call | Result |
|---|---|---|
| `bash` | `cat omp-ui://plan` | `cat: omp-ui://plan: Input/output error`, exit 1 |
| `read` | `omp-ui://plan` | `no plan has been proposed for this session yet` |
| `grep` | `vault` in `omp-ui://plan` | `Cannot search omp-ui://plan: no plan has been proposed for this session yet` |
| `read` | `omp-ui://vault/` | `unknown omp-ui resource "vault/"; available: plan` |

`read` and `grep` resolve `omp-ui://` through the host URI scheme. `bash` does not: the shell treats `omp-ui://plan` as a literal file path. No agent in any other run tried an `omp-ui://` URI on its own.

## Subagent (R12)

The parent did not hand the work to a subagent blind. It defined three Python `@tool` wrappers in its own eval kernel (`vault_search`, `vault_read`, `vault_write`) that call `tool["omp-ui_vault_*"]`, then spawned one `task` subagent with `tools: ["vault_search", "vault_read", "vault_write"]`. The subagent's calls ran in the parent's kernel and reached HostBridge as ordinary host-tool calls from the parent session (14 `proto754` lines, all with the parent's tab id). The subagent wrote the summary note; the parent then verified it with more searches and reads. There was no filesystem fallback. The renderer showed none of these 14 calls as vault cards: they appear only inside the parent's `eval` and `task` cards, so "notes touched this session" derived from vault cards would miss this note.

## Hand-off

Run with omp-ui main's PATH (`/home/alankford/.local/share/omp-ui/bin:/home/alankford/.cargo/bin:/usr/local/bin:/usr/bin`) and stdin closed. Target: `omp-ui/Knowledge Home Is A ProjectRecord Field.md`.

| Case | Obsidian | Command | Exit | Returned in | Note active after | Focus after | Obsidian parent |
|---|---|---|---|---|---|---|---|
| H1 | running | `/home/alankford/.local/bin/obsidian vault=Obsidian open path=…` | 0, `Opened: …` | 22 ms | 3 ms | `true` | systemd (unchanged) |
| H2 | quit | same | 1, `The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.` | 3 ms | never (Obsidian not started) | n/a | n/a |
| H3 | running | `setsid -f xdg-open obsidian://open?vault=ee8bdab8baa42089&file=omp-ui%2FKnowledge%20Home%20Is%20A%20ProjectRecord%20Field` | 0 | 722 ms | 3 ms | `true` | systemd (unchanged) |
| H4 | quit | same | 0 | 153 ms | 1,662 ms (cold start) | `true` | systemd, not the probe |
| H5 | running | bare `obsidian open path=…` | `ENOENT` | 1 ms | never | n/a | n/a |

- The CLI is the fast path when Obsidian runs, and it cannot start Obsidian. `xdg-open` covers both states; it is about 0.7 s slower when warm, and it cold-starts with the note active in 1.7 s.
- `setsid -f` detaches correctly: the cold-started Obsidian's parent is the user systemd, not the probe. It does inherit the probe's stdout and stderr pipes, though. A probe that waited for the pipes to close (`close` event) hung until killed. The production spawn must use `stdio: "ignore"` or settle on `exit`.
- `xdg-open` needs the full desktop environment. My first pass passed only PATH, HOME, DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR, and DBUS_SESSION_BUS_ADDRESS. It printed `Authorization required, but no authorization protocol specified` and opened nothing (kept in `handoff/stripped-env/`). With `XAUTHORITY` and the rest of the session env it worked. omp-ui main inherits the full env, so this matters only if a spawn sanitizes env.
- Focus: `document.hasFocus()` and the window's `isFocused()` were both `true` after H1, H3, and H4 here. #750 saw no raise on GNOME/Wayland; this time Obsidian already had focus before H1 (the probe opened another note first through the CLI), so the result does not settle the raise question.
- H5 confirms the absolute CLI path is required.

## Obsidian append

The decision note was open in Obsidian while omp-ui appended to it in place (`appendFile`).

| View | Step | New line shown | Notice | Cursor | Scroll |
|---|---|---|---|---|---|
| Source (editing) | R14a, via a real session | yes within 1 s, still at 5 s | none | unchanged (line 9, ch 0) | unchanged (top 0) |
| Reading | R14b, via a real session | yes (rendered reading view DOM contains the line) | none | n/a | n/a |
| Source | direct `writeNote`, polled every 100 ms, two trials | 9 to 10 ms | none | unchanged | n/a |
| Reading | same, two trials | 11 to 115 ms | none | unchanged | n/a |

Obsidian picks up an external in-place append live in both views, with no notice and no cursor jump. Stills: `obsidian/before-edit.png`, `obsidian/before-edit-reading.png`, `obsidian/after-edit-0-1s.png`, `obsidian/latency-*.png`.

## Prototype

- Code: `packages/desktop/src/main/prototype-vault-754/` (`control.ts`, `vault-fs.ts`, `tools.ts`, `guidance-extension.ts`) and hooks marked `PROTOTYPE (#754)` in `host-bridge.ts`, `session-manager.ts`, `backend.ts`. The gate is `OMP_UI_PROTOTYPE_754_CONTROL`, the absolute path of a JSON control file; unset, the spawn registers exactly what `main` registers (checked: no `omp-ui-vault-754.ts` in the lineage dir, no `proto754` log line).
- Scripts: `packages/desktop/prototype-vault-754/scripts/` (`seed-vault.mjs`, `gen-volume-vault.mjs`, `bench-search.mjs --smoke`, `drive.mjs`, `analyze.mjs`, `handoff-probe.mjs`, `append-latency.mjs`), the run matrix `runs.json`, and all evidence under `evidence/`.
- Run: `OMP_UI_PROTOTYPE_754_CONTROL=~/.cache/omp-ui-proto-754/control.json OMP_UI_REGISTRY_PATH=~/.cache/omp-ui-proto-754/registry.json OMP_UI_CDP_PORT=9754 OMP_UI_TEST_MODEL=openrouter/anthropic/claude-opus-5.5 GH_CONFIG_DIR=<empty dir> npm run dev:headless --workspace @omp-ui/desktop -- --pane`, then `node packages/desktop/prototype-vault-754/scripts/drive.mjs run <id> --project <path>`.
- Checks run: `npm run typecheck` (desktop) passed; `host-bridge.test.ts`, `session-manager.test.ts` (267 tests) and `host-bridge-live.test.ts` (3) passed; the answerer smoke passed all 20 assertions (refusals for `..`, `.obsidian/app.json`, absolute paths, slash titles, writes outside `omp-ui/`, duplicate create, Plan guard; stamp parses as YAML; one index line per create; append in place).
- Vault after the runs: the seed notes are byte-identical to the seed (sha256). `omp-ui/` holds four notes, each starting with the stamp, and the index lists each created note once. Find the seed notes with `grep -l 'prototype-754-seed: true' -r ~/Documents/Obsidian`; everything else the prototype wrote is under `omp-ui/` (marked `omp-ui: true`).
