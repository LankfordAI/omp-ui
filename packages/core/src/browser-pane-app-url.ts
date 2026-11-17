import { compareVersions } from "./semver";
import {
  BROWSER_PANE_APP_OBJECT_FORM,
  BROWSER_PANE_APP_URL_FORM,
  BROWSER_PANE_INSTRUCTION_PARTS,
} from "./browser-pane";

/**
 * omp 18.19 changed `browser.open`'s `app` argument from the `{ cdp_url }`
 * object to a plain string — a CDP URL, executable path, or keyword (upstream
 * `tools/browser.ts`, `resolveBrowserKind`) — and its schema rejects an object
 * outright (`browser received invalid arguments`), so at this floor the pane
 * preamble names the endpoint as `app: "<cdp url>"`. Below it, 18.16–18.18
 * parse only the object, so a blind swap would break every older binary
 * (issue #1188).
 *
 * Deliberately NOT registered against `MIN_SUPPORTED_OMP` (the out-replies
 * polarity): below this gate the preamble still honestly describes the harness
 * — the object form is exactly what those binaries accept.
 */
export const BROWSER_PANE_APP_URL_MIN_OMP = "18.19.0";

/** Unknown version keeps the object form: an older omp rejects a bare string. */
export function supportsBrowserPaneAppUrl(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, BROWSER_PANE_APP_URL_MIN_OMP) >= 0;
}

/** Version-aware hidden-message body: `app` is a URL string only at >= the floor. */
export function browserPaneInstructionFor(cdpUrl: string, ompVersion: string | null): string {
  const form = supportsBrowserPaneAppUrl(ompVersion) ? BROWSER_PANE_APP_URL_FORM : BROWSER_PANE_APP_OBJECT_FORM;
  const parts = BROWSER_PANE_INSTRUCTION_PARTS;
  return parts[0] + form[0] + cdpUrl + form[1] + parts[1];
}
