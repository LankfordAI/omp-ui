// The subprocess half of the collab contract: runs `omp collab list|link
// --json` against the resolved binary. Main-process only (issue #686) — the
// renderer never shells out, it sees the tracker's snapshots.
import { execFile } from "node:child_process";
import { isObject } from "./guards";
import { parseCollabListing } from "./collab";
import type { CollabHostRow, CollabLinkResult } from "./collab";

/** One CLI invocation outcome, captured without throwing on nonzero exit. */
export interface CollabCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Test seam: run the bundled omp with argv. Defaults to child_process.execFile. */
export type CollabCliExec = (ompPath: string, argv: readonly string[]) => Promise<CollabCliResult>;

export interface CollabCliDeps {
  /** Test seam replacing the subprocess. */
  exec?: CollabCliExec;
}

const DEFAULT_TIMEOUT_MS = 8_000;

const defaultExec: CollabCliExec = (ompPath, argv) =>
  // Executor form (not Promise.withResolvers): core's tsconfig lib is ES2022.
  new Promise((resolve) => {
    execFile(ompPath, [...argv], { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // execFile errors carry the exit code (or a spawn failure as a string);
      // both are outcomes, not throws — the registry answers via streams.
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
      resolve({ stdout, stderr, code });
    });
  });

/**
 * The local host registry: `omp collab list --json`. `null` means "unknown"
 * (nonzero exit, unparsable stdout, or a spawn failure) — the tracker holds
 * its last snapshot instead of flashing every tab off.
 */
export async function listCollabHosts(
  ompPath: string,
  deps: CollabCliDeps = {},
): Promise<CollabHostRow[] | null> {
  const result = await (deps.exec ?? defaultExec)(ompPath, ["collab", "list", "--json"]);
  if (result.code !== 0) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  return parseCollabListing(decoded);
}

/**
 * One generation-bound link for the host behind `selector` (pid or instanceId):
 * `omp collab link <selector> [--view] --json`. Refusals surface omp's own
 * message (stderr, exit 1) so the dialog can show it verbatim. The selector
 * rides as one argv element — never shell text.
 */
export async function getCollabLink(
  ompPath: string,
  selector: string,
  view: boolean,
  deps: CollabCliDeps = {},
): Promise<CollabLinkResult> {
  const argv = ["collab", "link", selector, "--json", ...(view ? ["--view"] : [])];
  const result = await (deps.exec ?? defaultExec)(ompPath, argv);
  if (result.code === 0) {
    try {
      const decoded: unknown = JSON.parse(result.stdout);
      if (isObject(decoded) && typeof decoded.url === "string" && decoded.url.length > 0) {
        return { ok: true, url: decoded.url };
      }
    } catch {
      // A zero-exit without parsable JSON falls through to the error below.
    }
    return { ok: false, message: "omp returned no Collab link" };
  }
  const text = result.stderr.trim().replace(/^error:\s*/, "");
  return {
    ok: false,
    message: text.length > 0 ? text : `omp collab link failed (exit ${String(result.code)})`,
  };
}
