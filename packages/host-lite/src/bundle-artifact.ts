import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";

/**
 * The single desktop-runtime boundary of host-lite (issue #1010): every module
 * that originates in `packages/desktop` reaches the headless member through
 * the built session bundle — never as a source-path import. Source specifiers
 * happen to resolve under tsx/vitest but do not exist inside the SEA artifact;
 * the one dynamic specifier here is what makes the packaged member honest,
 * and S2's `electron-drift-gate` is what keeps the artifact itself honest.
 *
 * The artifact ships as plain JS with no checked-in types (it IS bundling),
 * so this load is genuinely runtime-selected: dynamic import of a resolved
 * path. Consumers declare the symbols they consume structurally, the same way
 * production adapters declare seams everywhere else in this package.
 */

/** Default artifact location beside the member: plain-Node runs resolve under
 * `dist/`; the SEA binary (whose import.meta.url lives inside the blob) falls
 * back to a session-bundle.mjs next to the executable — the adjacency node-pty
 * already relies on via NODE_PATH in packaging/omp-ui-lite.service. */
export function defaultBundlePath(): string {
  const candidates = [fileURLToPath(new URL("../dist/session-bundle.mjs", import.meta.url))];
  if (isSea()) candidates.push(path.join(path.dirname(process.execPath), "session-bundle.mjs"));
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
}

/** A missing bundle is an install/build error, never a silent empty member. */
export class LiteBundleMissingError extends Error {
  constructor(bundlePath: string, cause: unknown) {
    super(
      `session bundle missing at ${bundlePath} (${cause instanceof Error ? cause.message : String(cause)}); run: npm run bundle:session -w @omp-ui/host-lite`,
      { cause },
    );
    this.name = "LiteBundleMissingError";
  }
}

/**
 * Load the bundle module namespace. The type parameter is the consumer's
 * structural view of what it needs (entry.ts's re-exports are the contract);
 * nothing here casts or narrows — a wrong view fails at use with a readable
 * TypeError naming the missing symbol.
 */
export async function loadSessionBundle<T>(bundlePath: string = defaultBundlePath()): Promise<T> {
  try {
    // The specifier is computed from the artifact's install location; a static
    // import could not express "wherever this member was installed".
    return (await import(bundlePath)) as T;
  } catch (err) {
    throw new LiteBundleMissingError(bundlePath, err);
  }
}
