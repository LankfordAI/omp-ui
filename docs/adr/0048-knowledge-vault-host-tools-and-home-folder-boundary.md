# Knowledge vault: omp-ui host tools write stamped notes inside a vault's home folder

Resolves issue #748 through map #749 (#750-#762). Verified against omp 18.6.1. Corrects ADR-0043's timeout claim.

## Findings

- omp 18.6.1 host tools default to discoverable `xd://` devices; `loadMode: "essential"` makes them top-level tools that the transcript renders under their own name. Every host tool runs at the `exec` approval tier and the host cannot change it. Results carry text and image blocks plus `details`. Subagents cannot call host tools; they can read host URIs (#752).
- omp arms no host-tool timer: `RpcHostToolBridge` settles only on a result, an abort, or stdin EOF. The 120 s figure in ADR-0043 is wrong; omp-ui's 60 s watchdog is the only deadline (#752, #754).
- omp's plan-mode guard covers only the `write` tool; host tools run while plan mode is on (#752, #754 R9a).
- omp's reserved `vault://` protocol, when a user enables it, reads and writes anywhere under a vault root through the Obsidian CLI (#752).
- An Obsidian vault is any folder; `obsidian.json` registers it, external renames never rewrite links, and `[[Foo]]` resolves by filename vault-wide (#751, #750).
- With a hidden spawn message Opus 5.5 wrote vault decision notes unprompted; with tool descriptions alone it wrote a repo ADR instead. A 20,000-note filesystem search takes about 0.8 s (#754).
- Platform verification (T1 gists: [linux-x64](https://gist.github.com/AustinM731/fab188a4995179deadf54f97df07e342), [windows-x64](https://gist.github.com/AustinM731/0771d9de3685d58f3d4045ed979e736b)): Linux x64 ran the unit contracts, the smoke, M22 and M24, with M18 and M19 closed in #754. Windows x64 ran the core and desktop unit suites on windows-latest (Nightly run 37521599512), after #773 found that Windows 8.3 short names split the native and JS realpath families; the confinement code now resolves with the native one. No fallback fired. Not run, by explicit user decision at close: the smoke on macOS and Windows, the vault unit tests on macOS, the macOS and Windows M rows (M1-M17), Linux M23, and M20 (Flatpak) and M21 (Snap) (#748).

## Decision

1. **Seven essential host tools on HostBridge.** `omp-ui_vault_search`, `_read`, `_list`, `_create`, `_append`, `_edit`, `_link`, registered through `hostToolsDefinition` only when the Vault registry has at least one vault at spawn. Filesystem-backed; the Obsidian CLI is never required. No delete or rename tool exists (#757).
2. **The Home folder is the write boundary.** Reads reach the whole vault minus dot-directories. Writes land inside the vault's Home folder, unless that registry row turns on "Allow writes outside the home folder", which opens append, edit and link (never create) to the whole vault. Main re-validates the root on every call, refuses the home directory, `/`, and omp-ui or omp data roots, and confines every path lexically and by realpath (#758).
3. **Notes are stamped and indexed by the tool.** `omp-ui/<Project>/<Title>.md`, five-key Provenance stamp written only by `_create`, Index note line appended in the same call, Title Case, collisions reported and never suffixed, a leading title heading stripped (#757). A Day write-up is `omp-ui/<YYYY-MM-DD> Day Write-up.md`, stamped without `project`, indexed nowhere (#760).
4. **Edits need a read token.** `_edit` and `_link` require the `baseHash` HostBridge recorded for that exact path at the session's latest read or write, and the file must still hash to it. An unstamped note edited inside the write area is never stamped and its card carries the copper "Not created by omp-ui" marker with a diff (#757).
5. **Plan mode does not block vault writes.** The vault is not a scratch area and nothing implies plan mode protects it; every other gate stays (#757, reversing the #752 constraint by explicit user decision).
6. **Limits.** 24,000-character search and list text, 2 MiB per resulting note, 25 vault writes per tab per `turn_start`, a pinned secret-shape scan before any byte is written (#758).
7. **Registry and routing.** The Vault registry is a global setting keyed by folder basename with one Default write vault. A Project's Knowledge home is `ProjectRecord.knowledgeHome`, null when unset; an unset home routes by an offline ownership rule (repo docs when not a git repo, no remote, or the origin owner is a `gh` hosts.yml login; the vault otherwise). `both` means the repo note is canonical and the vault holds a stub (#756).
8. **Guidance is a hidden spawn message.** The write part rides vault-touching homes; day write-up and reply-link guidance ride every native session on a machine with a vault registered, including Repo docs homes; machines with no vault pay nothing (#756, #760, #781).
9. **Day resources.** `omp-ui://sessions[?day=YYYY-MM-DD]` and `omp-ui://sessions/<id>/summary`, read-only, built from registry records plus the last assistant text block cut at 2,000 characters; user text never crosses (#760).
10. **Hand-off is a main-built channel.** `vault:open` takes a registry name and a vault-relative path and builds `obsidian://open?vault=<id>&file=<path>` (or `?path=`) in main; `openExternalSafe` and `isSafeHref` keep their web/email allowlists. Off the owning desktop the button copies a basename-keyed link (#758, #759). Explicit Markdown note links use the same typed channel only after strict note parsing and a user activation in a positively resolved local desktop tab; other viewers copy (#781).
11. **omp's `vault://` stays off.** Every omp-ui spawn writes a `vault: enabled: false` config overlay (#758).

Vault notes the user wrote are untrusted input to the agent. Everything the read and search tools return from outside the Home folder is human prose that may carry instructions aimed at the model, and omp-ui cannot sanitize it: a filter that alters note text changes what the user reads in Obsidian. What omp-ui owns is what the agent can do with what it reads — writes confined to the Home folder (or the vault's declared scope when its toggle is on), read-before-edit tokens, the secret-shape scan, and the tool gates HostBridge enforces. A hostile note can attempt prompt injection exactly as a hostile file read by the `read` tool can; it cannot move a file the boundary refuses to touch.

## Inline reply links amendment (#781)

Successful vault tool results supply reply-ready Markdown title links with the registered name and full resolved `.md` path. Query values encode punctuation that would otherwise truncate Markdown destinations, and titles escape Markdown punctuation. Persisted note bodies and Index entries keep wikilinks; read bodies stay verbatim after their wrapper.

The dependency-free parser accepts only `obsidian://open` with exactly one literal `vault` and `file` key. It decodes once, rejects malformed escapes, controls, absolute paths, hidden or traversal segments, and subpath instructions, and appends `.md` only to manual extensionless targets. Main still checks the registry, root, existing file, and realpath confinement. A store-free Markdown context receives its renderer from the entire owning RpcTab subtree, including subagent views, inspector panes, and portals. Inline opening also requires the preload-backed desktop transport: an Electron user agent alone does not prove desktop ownership (#782).

Rendering, streaming, scrolling, and history restoration launch nothing. Click, Enter, and Space activate the title; browser clients, joined-instance owners, and unresolved owners copy a newly built basename-keyed URI. Literal paths, wikilinks, bare URI text, unscoped Markdown, and sandboxed HTML plans are outside this action. Widening the generic external-link allowlists remains rejected.

## Considered options

- **A generated `-e` bridge with `pi.registerTool` (rejected, #757).** It could declare `approval: "read"` and reach subagents, but it adds a second carrier beside ADR-0043's host seam and puts vault I/O in the omp process instead of the main process that owns the registry.
- **omp's built-in `vault://` (rejected, #757, #758).** No Home folder boundary, no stamp, and a hard dependency on the Obsidian CLI and a running app; omp-ui pins it off instead.
- **The Obsidian CLI as the engine (rejected at charting, lock 6; #751).** Needs the running app, a user toggle and a registered binary, reports success only through stdout, and its `create` silently suffixes collisions.
- **Discoverable `xd://` tools (rejected, #757).** They render as generic `write` cards with no tool name or arguments to key a vault card on (#754 R1).
- **`pi-obsidian-vault` (rejected, #752).** One vault, needs the CLI, and its edit/manage/destroy tools touch any note, which breaks map lock 7.
- **Reads through `omp-ui://vault/...` URIs (rejected, #757).** `read` and `grep` only, no listing, never advertised to the model.
- **A HostBridge plan-mode guard for vault writes (rejected, #757).** Built and measured in #754, then dropped by explicit decision; see Decision 5.
- **A registry section on the Memory page, a header chip, a compact or note-shaped card, a banner marker, a Session HUD button or a transcript notice for notes touched (rejected, #753).** The user picked the page, the tab, the full card, the border marker and the rail section.
- **Knowledge home as a `.omp/config.yml` key or a Session-scope override (rejected, #756).** omp never reads it, the key would travel into repos the user cannot push, and ADR-0031's overlay is the precedence engine the project avoids reinventing.
- **Tool descriptions alone, an `omp-ui://vault/policy` resource, or a user-editable guidance note (rejected, #756).** #754 R7 wrote a repo ADR without the message; a passive resource fails the same way; a guidance note in the Home folder is one the agent could rewrite.
- **A scanner for verbatim user-note quotes (rejected, #758).** Content analysis cannot read intent; guidance carries the rule.
- **Widening `openExternalSafe`/`isSafeHref` to `obsidian:` (rejected, #758).** Page content and agent output would gain an unprompted local launcher.
- **Hiding "Open in Obsidian" off the owning desktop, or routing it to the owner (rejected, #759).** Hiding strands a user who syncs the vault; routing opens a note on an unattended screen.
- **A dedicated notes-touched event (rejected, #759).** The vault cards already replicate with the transcript.
- **A Day write-up composer command or HUD button, or scheduled generation (rejected, #760).** The ask is ordinary language and the guidance teaches it; scheduling stays fog.
- **Mirroring Mnemopi into the vault, an in-app reader, or an Obsidian plugin (rejected at charting, #748, #749 locks 2 and 5).**

## Consequences

- Every vault call prompts under the `write` and `always-ask` approval modes, reads included, and the essential approval prompt shows the tool name without arguments (#754 R8a). `yolo` has no prompt; the 25-writes-per-turn cap is the bound there.
- Subagents reach the vault only through tools the parent wraps in its own eval kernel; those calls render inside the parent's `eval` and `task` cards and are absent from "Vault notes" (#754 R12, #760).
- PTY tabs and joined-instance tabs register no host tools; vault calls never cross the remote proxy sets (#759).
- A vault added or a Knowledge home changed mid-session reaches the next spawn.
- Synced-folder conflict copies are ordinary notes; there is no dedup (#751, #761 M8/M16).
- Main logs one line per write (vault basename, action, vault-relative path); reads log nothing; bodies never enter logs or diagnostic bundles, and the diagnostic bundle reduces vault paths to basenames (#758).
