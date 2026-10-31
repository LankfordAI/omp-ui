# session-bundle shims — inventory

`scripts/bundle-session.mjs` bundles the REAL `packages/desktop` session
cluster (session-manager.ts + its transitive closure, 215 inputs audited via
the esbuild metafile) into one headless ESM bundle. Where a closure module's
runtime behavior needs Electron, the bundler swaps that file for a shim here —
same exported symbols, inert-or-throwing behavior. No desktop file is edited.

The swap map in the script and this table are the same list; when the drift
gate fires (a new runtime `electron` reach inside the closure — the bare
specifier resolves nowhere at build time, so it fails loudly), add the new
leaf here or cut the feature from lite. Never `external: ["electron"]`.

| Desktop module | Reached via | Exported symbols shimmed | Headless behavior |
| --- | --- | --- | --- |
| `packages/desktop/src/main/browser-pane-contents.ts` | dynamic `await import()` from `browser-pane-host.ts` (default pane factory; default partition clearer) | `makeElectronPaneFactory(deniedPorts)` | **throws** on first pane creation ("browser panes need a windowed host"): a WebContents with no Chromium is physically impossible. The host's own error path converts it to `{ status: "unavailable", reason: "create-failed" }`, so lite degrades instead of crashing. Lite also injects `clearPartition` in `entry.ts` and ships no pane channels (absent, not denied — #449), so this factory is unreachable through the lite `ChannelTable`. |
| 〃 | 〃 | `clearBrowserPanePartition(partition)` | **inert resolve**: the headless host never created the Electron storage partition, so clearing nothing is clearing everything. |

## Not shimmed (and why the bundle still needs no Electron)

- `desktop-notifier.ts`, `breadcrumbs.ts`, `browser-pane-desktop-protocol.ts`,
  `frame-observer.ts`, and every other Electron-adjacent closure module are
  imported **`import type` only** from the cluster — erased at build time.
- `electron` appears NOWHERE in the bundle graph by design: the specifier is
  refused by the gate plugin (`electron-drift-gate`) for every importer, and a
  post-build metafile rescan catches any runtime-electron text that slipped
  past resolution. The drift test fixture
  (`../__fixtures__/drift-leaf.ts`, `import "electron"`) proves the refusal.
- `node-pty` reaches the graph through core's `pty.ts`: kept **external** so
  the native addon loads from the app tree's `node_modules` at run time —
  never inlined. Same for `ws` and `js-yaml`.
