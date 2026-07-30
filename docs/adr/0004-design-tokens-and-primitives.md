# Design tokens and UI primitives

Every renderer surface draws from one token set in
`packages/desktop/src/renderer/src/style.css` (a Tailwind v4 `@theme` block —
there is no `tailwind.config`) and composes one primitive vocabulary in
`components/ui.tsx`. Feature components never name a raw colour, and never
re-decide a radius, a duration, or what "the agent is working" looks like.

The aesthetic is **precision instrument**: five cool graphite planes
(`void → sunken → surface → raised → overlay → hover`), hairline borders
(`line-soft / line / line-strong`), four ink weights, and exactly four accents,
each with a fixed meaning:

- `signal` (mint) — agent liveness and success. Reserved; not decoration.
- `copper` — running, attention, advisor `concern`.
- `rose` — error, advisor `blocker`, destructive.
- `iris` — the user's own voice (their messages, their model choices).

Because the accents are semantic, a glance at the window answers "is it
working?" without reading a word. That property only holds while the reservation
holds, which is why `signal` is called out above.

## Considered Options

- **Ad-hoc `neutral-*` utilities per component (rejected — this was the prior
  state)** — the app used `bg-neutral-900`/`text-neutral-200`/`border-neutral-800`
  inline in every file, plus `green-500`/`amber-400`/`red-400` chosen
  independently per component. Nothing was reusable, "running" was a different
  colour in three places, and restyling meant a global find-and-replace with no
  way to tell an intentional colour from an incidental one.
- **A component library (Radix/shadcn/MUI) (rejected)** — the surface we need is
  small (button, chip, dot, panel, modal, meter, disclosure) and unusually
  specific: a liveness dot with a reserved pulse, a meter whose tone escalates
  with its own fraction. Adopting a library would mean fighting its defaults to
  reach this aesthetic, plus dependency weight in an Electron bundle. Revisit if
  we ever need a combobox or date picker.
- **CSS-in-JS or CSS modules (rejected)** — Tailwind v4's `@theme` already emits
  the tokens as both CSS variables and utility classes, so one declaration
  serves `bg-surface` and `var(--color-surface)` (the xterm.js theme needs the
  latter). A second styling mechanism would buy nothing.

## Consequences

- **Tokens only.** `neutral-*`, `zinc-*`, `gray-*`, `green-*`, `amber-*`,
  `red-*`, and raw hex are prohibited in renderer components. The one legitimate
  exception is `TerminalTab.tsx`, where xterm.js needs literal hex for its ANSI
  palette; that block cites `style.css` as the source of truth and must be
  updated with it.
- **Motion is CSS-only** — five named animations (`rise`, `slide-in`, `breathe`,
  `sweep`, `caret`) and one easing curve (`ease-out-quint`). No animation
  library. `breathe` means "work is happening now"; `sweep` means "indeterminate
  progress".
- **`@utility` takes no pseudo-selector.** `@utility grain::after` is invalid in
  Tailwind v4 and fails the *entire* stylesheet, silently resolving every class
  in the app to nothing. Nest the pseudo as `&::after` inside the utility body.
  This cost a real debugging cycle; it is documented here so it costs zero next
  time.
- **`Modal` portals to `document.body` and positions `fixed`.** Rendered inline
  it clips to the nearest positioned ancestor — a modal opened from a toolbar
  collapsed to that toolbar's height. Anchored dropdowns are deliberately *not*
  `Modal`; they stay absolutely-positioned `Panel`s with outside-click and
  Escape handling.
- Adding a primitive is cheap and expected; adding a *second* way to express an
  existing one is not. If two components need the same matcher or formatter, it
  moves to `lib/` (see `lib/fuzzy.ts`, `lib/cn.ts`).
