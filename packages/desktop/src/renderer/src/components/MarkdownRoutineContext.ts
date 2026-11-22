import { createContext, useContext } from "react";

/**
 * Opens the Routines view focused on one routine (ADR-0100 amendment): the
 * transcript's `omp-ui://routine/<id>` review link calls this on click. The
 * context lives here, store-free, so Markdown.tsx keeps its dependency-light
 * render path — same rule as TabMachineContext; the provider that reads the
 * store is RoutineFocusProvider, mounted once at the app root. Null outside
 * it leaves the link a plain-text fallback.
 */
export const RoutineFocusContext = createContext<((id: string) => void) | null>(null);

export const useRoutineFocus = (): ((id: string) => void) | null => useContext(RoutineFocusContext);
