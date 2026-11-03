import { createContext, useContext } from "react";

/**
 * The machine that OWNS the tab whose transcript this renders (issue #1023):
 * null for a local tab or while the owner is unknown, otherwise the owning
 * instance's nickname. `OpenExternalLink` uses it to label loopback URLs —
 * `http://localhost:5173` opened from a remote session's transcript resolves
 * on the VIEWER's machine, not the one serving it, so opening it silently is
 * a lie the link must tell instead. The context lives here, store-free, so
 * Markdown.tsx keeps its dependency-light render path; the provider that
 * reads the store is MarkdownMachineProvider.
 */
export const TabMachineContext = createContext<string | null>(null);

export const useTabMachine = (): string | null => useContext(TabMachineContext);
