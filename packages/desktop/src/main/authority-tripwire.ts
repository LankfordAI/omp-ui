import { app, dialog } from "electron";
import {
  appendMainLog,
  authorityClaimEvidence,
  resolveDataRoot,
  type BreadcrumbSink,
  type BuildFlavor,
} from "@omp-ui/core";

/** Mirrors the userData identity split at the top of main/index.ts. */
export function buildFlavor(): BuildFlavor {
  return app.isPackaged ? "installed" : process.env.ELECTRON_RENDERER_URL ? "dev-server" : "dev";
}

/**
 * The refusal message when `root` carries permanent host-claim evidence, else
 * null. Pure — the caller supplies the evidence it found.
 */
export function legacyAuthorityRefusal(root: string, evidence: readonly string[]): string | null {
  if (evidence.length === 0) return null;
  return (
    `A persistent omp-ui host has claimed ${root} (found: ${evidence.join(", ")}). ` +
    "This desktop build cannot open that data. Run `omp-ui status` to see the host, " +
    "`omp-ui stop` to stop it, or `omp-ui rollback` to return to the previous host version."
  );
}

/**
 * Release P tripwire (issue #442). Once a persistent host has claimed the
 * canonical data root, this legacy Electron authority must never open it —
 * two authorities over one registry is exactly the double-resume the
 * single-instance lock exists to prevent, and the host's lock is not
 * visible to Electron's. Refuses with a modal error and `app.exit(5)`;
 * returns the root when it is unclaimed. The trailing throw guarantees no
 * caller continues even where `app.exit` is mocked.
 */
export function refuseLegacyAuthorityIfClaimed(deps: {
  logDir: string;
  breadcrumbs: BreadcrumbSink;
  root?: string;
}): string {
  const root = deps.root ?? resolveDataRoot(buildFlavor());
  const message = legacyAuthorityRefusal(root, authorityClaimEvidence(root));
  if (message === null) return root;
  appendMainLog(deps.logDir, "main.log", `[authority] ${message}`);
  deps.breadcrumbs.record("authority", { detail: message });
  dialog.showErrorBox("omp-ui cannot start", message);
  app.exit(5);
  throw new Error(message);
}
