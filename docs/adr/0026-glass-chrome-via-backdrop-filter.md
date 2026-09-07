# Glass chrome via backdrop-filter

Chrome planes — the title bar, the sidebar, the inspector rail, the composer
card, sheets, and modals — may paint translucent: their own theme token at
reduced alpha, `backdrop-filter` blurring only what lies behind them, over an
achromatic wash under the app. The levels are a preference (Settings →
Appearance → Glass chrome: Off / Subtle / Frosted) expressed as exactly three
custom properties on the document root (`--glass-alpha`, `--glass-filter`,
`--glass-wash`); no component may add translucency of its own. The reading
plane (`bg-surface` under transcript text) and every xterm host stay opaque:
text contrast is measured against the reading plane, and xterm runs
`allowTransparency: false` on its WebGL path.

This supersedes the blanket aesthetic rejection of backdrop-blur glass in
issue #194. The house already uses translucent blurred surfaces — `FindBar`,
the sidebar sticky header, the console controls, every scrim — so opaque
chrome planes were the inconsistency, not the rule. Issue #46's load-bearing
constraint survives intact: no `filter` may sit on an ancestor of text.
`backdrop-filter` is not `filter`; it transforms a snapshot of the backdrop,
never the element's own subtree, so blurred glass over a quiet wash cannot
soften a glyph.

## Considered Options

- **Native window materials (rejected)** — Electron's `vibrancy` /
  `backgroundMaterial` / an alpha `backgroundColor` hand the effect to the OS.
  Platform-fragmented by definition (acrylic on Windows, vibrancy on macOS,
  nothing coherent on Linux — Wayland compositors offer no blur-behind at
  all), and it would force alpha into `setWindowChrome`, breaking the native
  `titleBarOverlay` colour contract (#59). The app ships one code path to
  desktop and remote web clients; a compositor-dependent effect splits it.
- **Opacity-only translucency (kept as the visual floor, not a mode)** — a
  plain alpha fill at zero GPU cost. It is what the `off` step approaches and
  what `--glass-filter: none` yields; raising it to its own user-facing step
  would triple the matrix against a barely-perceptible difference.
- **Filter on a parent element (rejected)** — `filter: blur()` on a plane
  blurs the plane's text too, the exact failure #46 prohibits. Not viable at
  any level.
- **Per-component alpha values (rejected)** — every component picking its own
  translucency is the pre-token state ADR-0004 exists to prevent; three
  `--glass-*` knobs keyed on `[data-glass]` are the only source.

## Consequences

- **Three knobs, no more.** A new chrome plane reads the existing utilities
  (`glass-void`, `glass-sunken`, `glass-overlay`, `glass-surface`, `plane-lit`); a plane that
  needs its own alpha is a plane that has not found its token. A plane may shift
  *tone* — never alpha — to match the field it floats on, through `--field-fade`
  on the floating stack (#398); the colour it shifts between is still a theme
  token.
- **The wash is achromatic.** It mixes `overlay`/`raised` — plane tokens —
  with transparency; no accent hue is spent on decoration (ADR-0004).
- **Opaque surfaces are named, not incidental**: `bg-surface` under the
  transcript, `TerminalTab`/`ShellDrawer` (xterm hosts), the sidebar sticky
  header, `FindBar`, and all scrims stay as they are. Adding one of them to
  the glass set needs a superseding decision, not a class swap.
- **GPU cost is a user-visible axis.** Frosted composites a 24px blur over
  every chrome plane on every frame something scrolls behind it; the card
  says so, and the default is Subtle.
- **`@utility` still takes no pseudo-selector** (ADR-0004): the glass
  utilities are flat declarations; a malformed one silently resolves every
  class in the app to nothing.
