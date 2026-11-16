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
