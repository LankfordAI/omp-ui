# Themes install from GitHub theme repositories

> **Status:** Accepted, 2026-11-16 ([#1178](https://github.com/LankfordAI/omp-ui/issues/1178)). Amends [ADR-0094](0094-themes-carry-backdrops-and-can-be-authored.md): a stored authored theme may now carry an `origin`. Honors the [#414](https://github.com/LankfordAI/omp-ui/issues/414) rule: omp-ui holds no GitHub token.

Themes could be exported and imported only one file at a time; there was no way to publish a set of themes or follow someone else's. Settings → Appearance gains **Theme repositories**: the user adds a public GitHub repository, browses the themes its **theme index** lists, and installs them. Every install ends in the same host save path and gate as the editor.

## Decision

**1. Fixed hosts, no redirects.** Only public `github.com` repositories, entered as `owner/repo` or `https://github.com/owner/repo`, canonicalized to lowercase. The host builds every URL itself, against `https://api.github.com` and `https://raw.githubusercontent.com` only, from a validated `owner/repo`, a 40-hex commit SHA, and a validated relative `.json` path. It never accepts a free-form URL. Every request sets `redirect: "error"`; a renamed repository answers with a redirect and the user adds it under its new name. Browse and install refuse a repository that is not in the `themeRepositories` setting.

**2. Index and pinning.** A repository publishes `omp-ui-themes.json` at its root (`format: "omp-ui-theme-index"`, `version: 1`): up to 48 entries, each `{ path, label, seeds, backdrop }`, where `backdrop` is `"image"`, `"scene"` or `null`. Theme files use the existing `omp-ui-theme` v1 format Export produces. A browse resolves `HEAD` to a commit once, reads the git tree at that commit, and fetches the index from `raw.githubusercontent.com/<owner>/<repo>/<commit>/…`. The index's seeds let Browse preview every theme without downloading any backdrop bytes.

**3. Blob integrity and index match.** Each downloaded file's git blob SHA-1 (`sha1("blob <len>\0" + bytes)`) must equal the tree entry's SHA for that path. Install refuses a theme file whose trimmed label, seeds, or sniffed backdrop kind differ from its index entry, so a preview cannot misrepresent what gets installed.

**4. Same gate.** Install ends in the stored-theme `saveDraft`: the contrast gate, the signal-is-green rule, and `checkBackdropBytes`. `parseStoredThemes` re-gates on every registry read. Backdrops still render only through `<img>`; Browse loads no backdrop at all.

**5. Provenance on an authored theme.** An installed theme is an authored (`custom-`) theme with `origin: { repository, path, commit, blob, animate }`. `isStoredTheme` refuses an origin on any other id, so the signal rule always applies. Editing an installed theme saves through the unchanged editor path, which drops `origin`: the edited theme becomes a plain authored theme.

**6. No automatic update.** Nothing fetches at startup or in the background; fetching happens only on Browse, Refresh, Install or Update. Browse offers **Update** when the listing's blob for an installed path differs from `origin.blob`; Update reinstalls in place with the same id, the picks, and the motion choice kept.

**7. Scenes stay still until allowed.** An installed theme's scene shows its still frame until the user turns on that theme's **Animate** switch (`origin.animate`, default `false`). Reduced motion, the hidden-window pause and the global *Animate backdrops* switch still apply.

**8. Human-only.** No agent tool adds repositories or installs themes. `omp-ui_theme_set` may apply an already-installed theme, as it may any stored theme.

**9. No token.** Requests carry `User-Agent: omp-ui` and never an `Authorization` header; Node's fetch keeps no cookies.

**10. Shared cap.** Installed themes share `STORED_THEMES_MAX` (24) with every other stored theme, because every stored theme rides every state broadcast. An update replaces a row and is allowed at the cap; a new install at 24 is refused.

**11. Caps.** 16 repositories, a 64-byte commit body, a 1 MiB tree (a truncated tree is refused), a 64 KiB index, 48 index entries, a 6 MiB theme file (checked against the tree size before download and again while streaming), a 10-second timeout per request, and a streaming reader that cancels the body past its cap. One in-flight HEAD listing per repository is shared by concurrent callers and cached for five minutes; *Refresh* bypasses the cache, and installs reuse the pinned listing.

Fetching runs in the owning desktop host's main process (`ThemeRepositoryService`), so remote browser clients get it too.

## Considered options (rejected)

- **Arbitrary URLs.** A client could make the host fetch an internal address (SSRF).
- **Automatic updates.** A repository owner could swap a theme after the user installed it (bait-and-switch).
- **A new `repo-` id prefix.** It would fork `storedThemeKind` and the signal rule; an origin field on authored themes is enough.
- **An index of paths only.** Browse would have to download every theme file and backdrop to preview it.
- **The user's `gh` token.** Public data needs none, and omp-ui holds no GitHub token (#414).
- **A curated default repository.** The list ships empty: a default entry would read as an endorsement. `LankfordAI/omp-ui-themes` exists as a working example and test fixture, which users add themselves; making it a default later changes only the setting's fallback.
- **Custom CSS in themes.** Still rejected by ADR-0094.

## Consequences

- An uncached listing costs two GitHub API calls against the 60-per-hour anonymous limit per network; a limit hit names the minutes until reset.
- GitHub caches `commits/HEAD` answers for up to 60 seconds, so a Refresh right after a push may still list the previous commit; Refresh again after a minute.
- Editing an installed theme detaches it: no update is offered for the edited copy, and installing the same path again adds a separate theme.
- Removing a repository keeps its installed themes; they keep their *from owner/repo* chip but get no update offer until the repository is added again.
- A lite host serves no theme repository channels; the section shows the request's rejection.
