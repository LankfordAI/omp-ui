import { compareVersions } from "@omp-ui/core/semver";

/** omp 18.14.0's packaged builds stopped embedding the HTML export viewer: the
 *  file loads integrity-pinned scripts from stencil.so at open time (issue #974). */
export const NETWORK_EXPORT_VIEWER_MIN_OMP = "18.14.0";

/** Unknown version drops the caveat: every harness below the floor writes a
 *  self-contained file, and an unknown one cannot be claimed either way. */
export function exportViewerNeedsNetwork(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NETWORK_EXPORT_VIEWER_MIN_OMP) >= 0;
}
