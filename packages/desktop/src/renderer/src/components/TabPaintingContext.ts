import { createContext, useContext } from "react";

/**
 * Whether the enclosing tab is currently visible and painting.
 * Defaults to `true` outside tab containers (standalone surfaces, modals, tests).
 */
export const TabPaintingContext = createContext<boolean>(true);

export const useTabPainting = (): boolean => useContext(TabPaintingContext);
