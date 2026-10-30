# Imported themes pass the curated contrast gate

Settings → Appearance can follow the OS and can import a VS Code colour theme
(issue #999). Both stay inside ADR-0004's token model; neither adds a colour
control.

**Follow system.** The theme preference is four registry settings: `themeMode`
(`fixed` | `system`), `themeId` (the fixed pick), and `lightThemeId` /
`darkThemeId` (the system picks). The renderer paints
`effectiveThemeId(preference, prefersDark)` from `@omp-ui/core/theme`, reading
the OS scheme through `prefers-color-scheme` and repainting on its `change`
event with no backend round trip. Main reads the same OS signal through
Electron's `nativeTheme.shouldUseDarkColors` when it hands the plan verifier
page its theme, so a plan is verified in the palette the user sees.

**VS Code import.** `@omp-ui/core/vscode-theme` reads the theme file as JSONC,
follows its `include` chain through files the user picks together (a picker
hands over names, not paths), and maps VS Code's own keys onto the token set:
editor and chrome backgrounds onto the planes, `editor.foreground` and the
secondary foregrounds onto the ink tiers, the terminal ANSI colours and the
editor error/warning colours onto the four accents, and `tokenColors` onto the
six syntax seeds plus a keyword override. Each colour that must clear a floor
is mixed toward the ink only as far as that floor needs, so a theme keeps its
hues where it can. The signal accent is the theme's green, never its brand
accent: liveness stays reserved.

**The gate.** `themeContrastFailures` in `@omp-ui/core/theme` is the one
contrast gate. The renderer's theme suite runs it on every curated theme; the
owning host runs it on every import before saving (a remote client cannot store
an unreadable theme), and the registry read drops a stored theme that fails it,
so a hand-edited registry cannot smuggle one in either. A failed import is
reported with each failing pairing and its ratio, and nothing is saved.
Imported ids carry the `vscode-` prefix, so an import never shadows a curated
theme; removing one moves any pick that named it back to its default.

## Considered Options

- **A free-form colour picker (rejected)** — what CONTEXT.md's Theme entry
  rules out. A picker cannot keep the accents' meanings or the contrast floors;
  an imported file passing the same gate can.
- **Refuse any theme with a sub-floor colour (rejected)** — nearly every VS
  Code theme has a comment or muted foreground below omp-ui's floors. Lifting
  toward the ink until the floor holds keeps those themes usable; the gate
  still refuses a theme whose reading ink cannot reach the floor at all.
- **Map a theme's brand accent (`focusBorder`, `button.background`) to signal
  (rejected)** — it would paint liveness in a decorative colour (ADR-0004).
- **Resolve `include` by reading sibling files in main (rejected)** — the
  import travels over the same channel from desktop and remote clients, and a
  host path from a remote browser means nothing. Picking the chain together
  works in both.
- **Store derived Theme objects (rejected)** — storing the `ThemeSource`
  keeps one derivation path for curated and imported themes, so a projection
  change reaches both.

## Consequences

- Theme derivation (`deriveTheme`, `mixHex`) moved from the renderer into
  `@omp-ui/core/theme`; `theme-sources.json` remains the curated themes' only
  raw-colour source, and imported themes ride the registry and the state
  broadcast.
- The renderer's localStorage mirror now holds the preference and the imported
  themes it names (`omp-ui.theme`); the legacy `omp-ui.themeId` key still seeds
  a fixed preference on the first launch after an upgrade.
