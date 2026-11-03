import { compareVersions } from "./semver";
import { BROWSER_PANE_INSTRUCTION_PARTS } from "./browser-pane";

/**
 * omp 18.16 fixed `tab.click` against a CDP endpoint upstream — the click
 * options, gesture release, and relay timeouts (#17778, #17767) — so at that
 * floor the browser pane preamble drops the "tab.click hangs; use tab.run"
 * workaround sentence (issue #1031). Below the floor the workaround stays:
 * the pane endpoint genuinely hangs on omp's own click helper there.
 *
 * Deliberately NOT registered against `MIN_SUPPORTED_OMP`: below this gate the
 * preamble still honestly describes the harness, so nothing is promised that
 * the running omp cannot honour (the out-replies.ts polarity). The retirement
 * re-proof checklist lives as a comment on issue #1031.
 */
export const BROWSER_PANE_RELAY_FIXES_MIN_OMP = "18.16.0";

/** Unknown version keeps the workaround: an older omp hangs on tab.click against a CDP endpoint. */
export function supportsBrowserPaneRelayFixes(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, BROWSER_PANE_RELAY_FIXES_MIN_OMP) >= 0;
}

/** Version-aware hidden-message body: legacy sentence omitted only at >= BROWSER_PANE_RELAY_FIXES_MIN_OMP. */
export function browserPaneInstructionFor(cdpUrl: string, ompVersion: string | null): string {
  const parts = BROWSER_PANE_INSTRUCTION_PARTS;
  return (
    parts[0] +
    cdpUrl +
    parts[1] +
    (supportsBrowserPaneRelayFixes(ompVersion) ? "" : parts[2]) +
    parts[3]
  );
}
