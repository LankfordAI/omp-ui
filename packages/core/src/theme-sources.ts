// The curated theme table, moved out of the renderer (issue #1175): main must
// resolve agent-supplied ids against curated membership, and nothing in main
// could reach a renderer file. Plain JSON; ADR-0002-clean.
import sources from "./theme-sources.json";
import type { ThemeSource } from "./theme";

/** The curated themes, in grid order: the one table every process shares. */
export const CURATED_THEME_SOURCES: readonly ThemeSource[] = sources;
