# Themes carry backdrops and can be authored

> **Status:** Accepted, 2026-11-15 ([#1168](https://github.com/LankfordAI/omp-ui/issues/1168)). Amends [ADR-0004](0004-design-tokens-and-primitives.md) (authored themes are a colour source; a backdrop may carry hue and motion), [ADR-0026](0026-glass-chrome-via-backdrop-filter.md) (a backdrop replaces the wash; the transcript becomes a reading card), [ADR-0078](0078-imported-themes-pass-the-curated-contrast-gate.md) (stored themes are imported or authored) and [ADR-0043](0043-host-tools-answer-what-the-main-process-owns.md) (`omp-ui_theme_save` joins the gated host tools).

A theme was a palette and nothing else: the curated sets, plus VS Code themes imported through the contrast gate (ADR-0078). People asked for two things the model could not express — a picture behind the app, and a theme of their own that did not start life as a VS Code file. Both had been held back by the same worry: text over art loses contrast, and a colour picker loses the accents' meanings. This record keeps every floor and every meaning and adds both.

Measured on the prototype branch `prototype/1168-backdrop-themes` and against the real `@omp-ui/core` gate (Electron 43, Chromium 150):

- A static backdrop blurred once on its own layer costs no GPU at idle. Blurring each plane over it instead (`backdrop-filter`) costs 2 to 4 points more while content moves.
- An animated scene costs about 7 points of GPU busy while the window is visible, whatever the blur strategy.
- An SVG shown through `<img>` runs no script, loads no subresource, animates CSS and SMIL, and ignores the page's `prefers-reduced-motion`.
- With today's floors, a plane that carries text needs 76% to 97% opacity over an arbitrary backdrop pixel.

## Decision

**1. Themes can be authored.** An **authored theme** is built from **theme seeds**: a canvas, an ink, the four accents and the six syntax colours, each optional except the canvas. `@omp-ui/core/theme-seeds` fills missing seeds from the curated graphite or light row (by the canvas's luminance), runs the same VS Code mapper imported themes use, and lifts the lower ink tiers and the think colours until they read on every plane. The seed editor in Settings → Appearance, an omp-ui theme file, Duplicate, and the agent tool all hand the host one draft, and one host function (`saveStoredTheme`) builds the source, runs the gate, stores any backdrop and writes the registry. Authored ids start with `custom-`, imported ids with `vscode-`; both are **stored themes** and share one cap of 24. This is not the free-form picker ADR-0078 rejected: the author picks seeds, not tokens, and no save skips the contrast gate or the signal rule. A canvas whose ink cannot reach 10:1 is refused and the refusal is shown; it is not special-cased.

**2. Signal stays a green.** The signal accent means agent liveness (ADR-0004), so an authored theme's signal must have an OKLab hue from 100° to 200° and a chroma of at least 0.03 (`signalAccentFailure`). All twelve curated themes pass (hues 110.7° to 189.5°, lowest chroma 0.061). Imported themes are exempt: their signal already comes from the theme's own terminal green, and refusing an existing import on upgrade would delete a user's theme. `themeGateFailures` is the one gate for stored themes: the contrast failures, plus the signal rule for authored ids. The registry read drops a stored theme that fails it.

**3. Themes can carry a backdrop.** A **backdrop** is a still image (PNG, JPEG or WebP, at most 4 MiB) or a **scene** (an SVG with CSS animation, at most 128 KiB). The registry stores only a reference — SHA-256, kind, mime, dim 0 to 80, blur 0 to 32 — and the bytes live once per hash in `theme-backdrops/` beside `registry.json`, pruned whenever no stored theme names them. The renderer fetches the bytes once per hash over `settings:readThemeBackdrop` and shows a backdrop only through `<img>`, where the browser runs no script and loads no subresource. Import refuses scenes with `script`, `foreignObject`, SMIL elements, external `href`/`src`, `@import` or external `url()`; those checks are defence in depth, and `<img>` is the guarantee.

**4. Text sits on reading cards.** No contrast floor is lowered. Over a backdrop the stage turns transparent and the transcript column becomes a **reading card**: the surface at the theme's reading floor, ringed by a spread shadow so it adds no layout. Chrome planes never drop below their own floor. `backdropFloors(tokens, dim)` finds, per plane group, the lowest opacity at which every text pairing on that plane still clears its floor over the darkest and lightest backdrop pixel the void scrim allows:

| Theme | dim 0 (void / sunken / reading) | dim 50 (void / sunken / reading) |
| --- | --- | --- |
| graphite | 81 / 82 / 87 | 61 / 63 / 72 |
| nord | 78 / 81 / 97 | 57 / 61 / 94 |
| light | 88 / 86 / 83 | 76 / 72 / 68 |
| solarized-light | 89 / 86 / 93 | 78 / 73 / 86 |

A heavier scrim and lower floors were both tried on paper: by the time text reads, the art behind it is gone. Text gets a near-solid card, and the art shows vividly where there is no text — the gutters beside the transcript column, gaps, and empty screens.

**5. The scene is blurred once.** The backdrop layer carries the only blur (`filter: blur()` on the image, which has no text in its subtree, so #46 holds). No plane over it gains a `backdrop-filter`; the composer card, dialogs, sheets and chips keep the filters they already had. A static backdrop then costs nothing at idle, where per-plane blur would cost 2 to 4 points more whenever content moves (#511 measured why: every damaged frame re-filters every `backdrop-filter` plane in the window).

**6. Motion is a setting, on by default.** **Backdrop motion** (Settings → Appearance → Animate backdrops) lets a scene animate; it defaults on because a theme with a scene was chosen for it. The scene stops when the window is hidden or the system asks for reduced motion, by swapping the image to a still copy (`stillScene`, which inserts an `@layer` style forcing every CSS animation and transition off): neither `visibilitychange` nor `prefers-reduced-motion` reaches inside an `<img>`. Swapping restarts the animation when it resumes; that is accepted. The about-7-points cost while visible is stated in the setting's hint.

**7. Agents save, humans apply.** `omp-ui_theme_save` lets an agent save an authored theme from seeds, optionally with a backdrop file confined to the session's working directory. It is off by default behind **Agents can save themes** (`themeAgentAccess`), never registered for webhook- or MCP-started sessions, and absent on a lite host. Every call goes through the same `saveStoredTheme` path and gate; a refusal lists each failing pairing with its ratio so the agent can adjust. The tool never activates or removes a theme: changing what every connected client looks like stays a human action.

## Amendment to ADR-0004

Authored themes are a third colour source, beside `theme-sources.json` and imported themes, and live in the registry like imports. A theme's backdrop is the one place decoration may carry hue, and a theme's scene is the one place motion may come from outside `style.css`. Neither changes what the four accents mean, and the signal accent of an authored theme must be a green.

## Amendment to ADR-0026

A theme's backdrop replaces the wash (and the `ambient` grain on the stage) while it is showing. The stage under the transcript turns transparent and the transcript column becomes a reading card; terminals and full-pane `bg-void` surfaces stay opaque. The glass utilities take `max(glass alpha, backdrop floor)`, so a plane never drops below the opacity its text needs over the backdrop.

## Amendment to ADR-0078

Stored themes are imported or authored. The sentence "neither adds a colour control" is superseded: the seed editor is a colour control, held inside the token model by the same gate plus the signal rule. Stored ids start with `vscode-` or `custom-`; neither shadows a curated id.

## Amendment to ADR-0043

`omp-ui_theme_save` joins the conditional host tools, gated like `omp-ui_device`: registered at spawn or resume only while the setting is on, never for webhook or MCP requesters, and answered by main through the shared save path.

## Considered Options

- **Custom CSS in themes (rejected)** — a stylesheet can hide the liveness dot, recolour an accent, or lower any floor, and no gate can check it.
- **Per-plane blur over the backdrop (rejected)** — 2 to 4 points more GPU while content moves, for frosting nobody sees through a near-solid reading card.
- **Lowering contrast floors over a backdrop (rejected)** — the floors are the reason a theme is readable; text gets a card instead.
- **A watched themes folder (rejected)** — a file dropped into a folder would skip the host gate on the way in, and a remote client could not reach it.
- **Backdrop bytes in the registry (rejected)** — a 4 MiB image would ride every state broadcast to every client; a hash reference keeps the broadcast small and dedupes shared art.
- **Inline SVG in the document (rejected)** — an inline scene can run script and load subresources in the app's own origin. `<img>` cannot.
- **SMIL animation in scenes (rejected)** — `animation: none` does not stop `<animate>`, so a SMIL scene could not honour reduced motion or the hidden-window pause.

## Consequences

- With no backdrop, `--stage-alpha` and the floor variables are unset and every expression resolves to today's value: the app looks exactly as it did.
- Theme-keyed caches key on `theme.rev` (FNV-1a over the colours), because an authored theme can be re-saved under the same id with new colours.
- A theme file is seed-based: an imported theme that is duplicated or exported keeps its main colours but not its terminal or keyword overrides.
- A client connected straight to a lite host has no backdrop channel and paints no backdrop.
- Dialogs and the plan review dock keep their utilities unchanged; their text was not re-measured over a backdrop.
- A full-width transcript or a narrow window covers most of the backdrop with the reading card; the Appearance hint says so.

## Amendment (2026-11-15): agents can apply

The §7 sentence "The tool never activates or removes a theme: changing what every connected client looks like stays a human action." is superseded. `omp-ui_theme_save` gained an optional `apply` flag: when true and the save passes the gate, main commits the theme to the user's preference — the same registry keys and broadcast the Appearance page writes (fixed mode takes `themeId`; system mode takes the `darkThemeId`/`lightThemeId` slot matching the canvas lightness) — so every connected client repaints. The guard is conversational: the tool description requires the agent to ask the user with its question tool first and only pass `apply: true` after a yes, and the whole tool still sits behind **Agents can save themes** (default off), never reaches webhook- or MCP-started sessions, and stays absent on a lite host. Consent is advisory — main cannot verify the question happened — which is the accepted tradeoff: the apply is instantly visible and one click to undo in Appearance. Removal stays human-only: the editor and host-channel path own it, and the tool still never removes themes.

## Amendment (2026-11-16): agents can list themes and change appearance; removal stays human-only

Behind the renamed **Agents can change themes** setting (still default off, never for webhook or MCP requesters, absent on a lite host), sessions get `omp-ui_theme_list` and `omp-ui_theme_set` beside `omp-ui_theme_save`. `theme_set` activates an existing curated or stored theme by id — fixed mode writes the fixed pick; system mode writes the slot named or, by default, the slot matching the theme's canvas lightness — and may set theme mode and backdrop motion in one atomic write. Main resolves every id against the curated table, which moves to `@omp-ui/core` as the single source for main, core, and the renderer (ADR-0004's location wording amended), and refuses an unknown id by listing valid ones instead of writing it. Answers name the slot written and the theme this host actually paints; a system-slot write that is not the active scheme says so. An explicit user request is consent; a self-proposed change requires the question tool first, as before — advisory consent, accepted only because every effect is instantly visible and one click to undo in Appearance. Removal deletes the stored row and prunes backdrop bytes that may exist nowhere else, so it stays human-only: an advisory gate cannot protect a permanent action, and this codebase gives destructive host tools structural gates (`omp-ui_vault_delete`'s baseHash and provenance stamp, `omp-ui_issue_file`'s draft fingerprint), not prompt promises.

## Amendment (2026-11-16): Agents can change themes defaults on

**Agents can change themes** (`themeAgentAccess`) now defaults on ([#1177](https://github.com/LankfordAI/omp-ui/issues/1177)). Off by default meant asking an agent for a theme failed on a default install, behind a setting the user had never seen. Nothing the gate protects changed: webhook- and MCP-started sessions still never get the tools, a lite host still has none, `theme_save`/`theme_set` effects are instantly visible and one click to undo in Appearance, and removal stays human-only. Legacy registries persisted the old off value in full, so a one-time load seed (`themeAgentAccessDefaultOnSeeded`, the council graduation's shape) flips them on once; an off chosen afterwards persists. Running sessions get the tools at their next spawn or resume.

## Amendment (2026-11-16): backdrops show undimmed

§3's `dim` field and §4's void scrim are retired ([#1187](https://github.com/LankfordAI/omp-ui/issues/1187)). The scrim painted the theme's void over the whole backdrop at the stored dim, so no backdrop ever showed as authored: a dark or tinted cast covered it. The backdrop now paints exactly as authored, and every plane that carries text keeps a contrast-safe fill.

`backdropFloors(tokens)` measures every text pairing over raw black and white pixels, which equals the old dim-0 column. The reading card and chrome planes become more opaque; no floor is lowered (§4):

| Theme | void | sunken | reading | overlay |
| --- | --- | --- | --- | --- |
| graphite | 81 | 82 | 87 | 55 |
| nord | 78 | 81 | 97 | 50 |
| light | 88 | 86 | 83 | 50 |
| solarized-light | 89 | 86 | 93 | 50 |

Three text surfaces had relied on the scrim:

- **Modal dialogs.** A new **overlay** floor measures the overlay plane's text over those pixels under the modal's own `bg-void/70` page scrim; `glass-overlay` takes `max(glass alpha, overlay floor)`, keeping modal text at AA.
- **The plan review dock** paints opaque while a backdrop shows: its header and nested `/70` sub-planes would otherwise composite over raw pixels.
- **Hanging speaker labels** stay stacked inside the reading card while a backdrop shows, instead of hanging outside its ring.

This supersedes the Consequences line "Dialogs and the plan review dock keep their utilities unchanged; their text was not re-measured over a backdrop."

Readers accept and drop a legacy `dim` (stored rows, theme files, drafts); writers omit it. The agent tool refuses a `dim` argument as an unknown field. Accepted consequences of the clean cutover — v0.36.0 is the only release with backdrops:

- *Exports.* Every published theme file contains `dim` and keeps installing. A file exported after this change has no `dim`, and v0.36.0 refuses it as malformed.
- *Downgrade.* After the first registry write by this build, stored backdrop rows no longer carry `dim`. A downgrade to v0.36.0 drops those themes on read (`parseStoredThemes`).
- *Stale pages.* A v0.36.0 renderer page still open while its host updates receives broadcast rows without `dim`. Its `backdropFloors(tokens, undefined)` reaches `mixHex(…, NaN)` and throws into the root error boundary while a backdrop theme is active. A reload loads the new renderer, because the renderer is served by the host.

## Amendment (2026-11-17): larger self-contained SVG scenes

The SVG scene limit in §3 rises from 128 KiB to **4 MiB**, matching the existing raster-image limit. This allows full-resolution artwork and CSS animation to stay together in one self-contained scene without compressing the artwork into a small SVG budget.

The backdrop reference, version-1 theme file, editor, agent interface, and asset storage remain unchanged. The existing 6 MiB theme-file limit accommodates a 4 MiB backdrop encoded as base64 plus its seeds. Script, SMIL, external-resource, contrast, blur, and motion restrictions are unchanged. Scenes still stop through `stillScene` when motion is disabled, the window is hidden, or reduced motion is requested.

This is a byte-budget increase, not an image upscaler or a promise that every 4K image fits. Artwork must still be authored at an appropriate resolution and the complete SVG must fit within 4 MiB.

## Amendment (2026-11-22): Routines studio over backdrops

`RoutinesView` renders on `studio-stage` rather than an opaque `bg-void` plane so active theme backdrops remain softly misted in the studio gutters around floating cards ([#1278](https://github.com/LankfordAI/omp-ui/issues/1278), [#1284](https://github.com/LankfordAI/omp-ui/issues/1284)): `studio-stage` paints `var(--color-void)` at `max(var(--stage-alpha), 26%)` with `backdrop-filter: blur(8px) saturate(1.06)` over active backdrops, collapsing to opaque `var(--color-void)` with `backdrop-filter: none` under `data-glass="off"` or when no backdrop is active. Each editor card uses the frosted `studio-card` utility (`var(--color-surface)` at `max(var(--glass-alpha), var(--backdrop-floor-reading, 100%))` with `backdrop-filter: var(--glass-filter)` and machined hairline borders), preserving §4's WCAG contrast floors across `frosted`, `subtle`, and `off` glass settings and collapsing to solid `var(--color-surface)` with no filter when glass is Off or no backdrop is active. This is a narrow, deliberate exception to §5's zero-filter rule on non-modal cards: the per-plane `backdrop-filter` cost is accepted and bounded strictly to `RoutinesView` while it is displayed.


## Amendment (2026-11-24): looping video backdrops for local authored themes

Local authored themes gain `kind: "video"` backdrops (`video/mp4` and `video/webm`, up to **16 MiB**, `BACKDROP_VIDEO_BYTES_MAX`) across the Theme Editor, local `.json` theme files, and `omp-ui_theme_save` ([#1319](https://github.com/LankfordAI/omp-ui/issues/1319)).

- **Byte sniffing & limits.** `sniffBackdropMime` structurally validates ISOBMFF `ftyp` MP4 boxes (standard and 64-bit extended size, allowlisted MP4 video major brands excluding QuickTime/HEIF/AVIF) and EBML headers (`0x4282` `DocType === "webm"`, rejecting Matroska). Local theme files rise from 6 MiB to **24 MiB** (`THEME_FILE_BYTES_MAX`, with `parseThemeFile` taking a plain `JSON.parse` fast path before falling back to `stripJsonc`). GitHub theme repositories later gained video support via index v3 ([#1320](https://github.com/LankfordAI/omp-ui/issues/1320), [ADR-0097](0097-official-theme-repository-is-listed-by-default-and-theme-indexes-carry-details.md)).
- **Playback, blur, contrast floors, and pause gates.** `BackdropLayer` renders a URL-keyed `<video>` element with `muted` (and imperative `muted = true` / `defaultMuted = true`), `loop`, `playsInline`, `preload="auto"`, `disablePictureInPicture`, `disableRemotePlayback`, and no controls. Single-layer blur (`.backdrop-layer > video`), reading-card contrast floors (`backdropFloors`), and SHA-256 `ThemeBackdropStore` storage remain unchanged. `data-backdrop` and floor variables apply only after frame 0 decodes (`onLoadedData`) and clear on `onError` (unsupported codec fallback to opaque paint). Playback synchronizes imperatively with **Backdrop motion**, `document.hidden`, `prefers-reduced-motion`, and `origin.animate !== false`, pausing in place on the decoded frame without remounting and catching any `play()` rejection.
- **Android WebView contract.** Android WebView keeps `mediaPlaybackRequiresUserGesture = true` for v1: video backdrops load and display their decoded first frame statically, catching any autoplay rejection without error.
- **Static specimens.** `ThemeSpecimen` cards render video backdrops via a static URL-keyed `<video preload="auto" muted playsInline>` with no `autoPlay` or `loop`, pausing defensively on mount and `loadeddata`, and gating translucent floor paint on `loadeddata` so undecodable videos stay opaque.
- **Transport.** Video bytes reuse `settings:readThemeBackdrop` (base64 → `Uint8Array` → one cached `Blob` URL per SHA-256 hash), fitting comfortably within the remote WebSocket server's 64 MiB payload ceiling (~21.4 MiB envelope at 16 MiB).
