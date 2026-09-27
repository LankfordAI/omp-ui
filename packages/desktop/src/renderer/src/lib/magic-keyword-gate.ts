/**
 * The composer's keyword gate: which of omp's magic keywords omp would attach
 * a notice for in this session, right now. omp fires a notice only when its
 * `magicKeywords.*` settings are on and every tool the keyword requires is in
 * the session's enabled roster; the capabilities bridge publishes both halves.
 * When the gate is unknown — no snapshot yet, or the section is unavailable —
 * the composer falls back to the static table and paints everything, which is
 * the behaviour predating the gate.
 */

import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import { ALL_MAGIC_KEYWORDS, type MagicKeyword } from "@omp-ui/core/magic-keywords";

/**
 * The keywords omp would attach a notice for right now. Unknown (no snapshot,
 * or the section is unavailable) returns ALL_MAGIC_KEYWORDS itself — today's
 * behaviour. A word omp publishes that the port does not know is ignored; the
 * parity tests fail on it.
 */
export function firingKeywords(snapshot: CapabilitySnapshot | null): ReadonlySet<MagicKeyword> {
  const section = snapshot?.magicKeywords;
  if (section === undefined || section.status !== "available") return ALL_MAGIC_KEYWORDS;
  // The tool roster is checked only when it is fully known; an `enabled: null`
  // row means omp could not tell, and "cannot tell" must not silence a keyword.
  const tools = snapshot?.tools;
  let toolSet: ReadonlySet<string> | null = null;
  if (tools !== undefined && tools.status === "available") {
    const enabled = new Set<string>();
    let rosterKnown = true;
    for (const tool of tools.items) {
      if (tool.enabled === null) {
        rosterKnown = false;
        break;
      }
      if (tool.enabled) enabled.add(tool.name);
    }
    if (rosterKnown) toolSet = enabled;
  }
  const firing = new Set<MagicKeyword>();
  for (const row of section.items) {
    if (!ALL_MAGIC_KEYWORDS.has(row.word as MagicKeyword)) continue;
    if (!row.enabled) continue;
    if (toolSet !== null && row.requires.some((t) => !toolSet.has(t))) continue;
    firing.add(row.word as MagicKeyword);
  }
  return firing;
}

/** Keywords whose omp settings are off (section available and row.enabled === false). */
export function keywordsOffInSettings(
  snapshot: CapabilitySnapshot | null,
): ReadonlySet<MagicKeyword> {
  const off = new Set<MagicKeyword>();
  const section = snapshot?.magicKeywords;
  if (section === undefined || section.status !== "available") return off;
  for (const row of section.items) {
    if (!row.enabled && ALL_MAGIC_KEYWORDS.has(row.word as MagicKeyword)) {
      off.add(row.word as MagicKeyword);
    }
  }
  return off;
}
