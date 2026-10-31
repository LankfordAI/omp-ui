import { openLiteKeyCipherFor } from "./credentials";
import { buildProductionFleetLegs } from "./production-legs";
import { createProductionSessions } from "./production-sessions";
import { startLiteFleetMember, type LiteInstance } from "./serve";

/**
 * The production boot for `omp-lite serve` (issue #1010): the one place that
 * composes the real slices and hands them to the pure `serve` pipeline through
 * its two build seams — `buildSessions` (the session cluster over the built
 * desktop bundle) and `buildFleet` (the fleet member legs). Kept separate from
 * `serve.ts` so that pipeline stays test-pure: no cipher, no bundle load, and
 * no adapter imports get pulled into it. `cli.ts`'s bin entry calls this.
 *
 * serve owns the single authoritative Registry; it loads it first and passes
 * it to `buildSessions`, so the session cluster and the backend share one
 * in-memory registry for the same file (never two divergent maps). The cipher
 * opens here first — the provider-key store inside the cluster seals through
 * it. Every step is required: a member that cannot open its cipher or load its
 * bundle fails loudly at boot rather than answering joins with an empty backend.
 */
export async function bootProductionLite(opts: {
  dataDir: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): Promise<LiteInstance> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const env = opts.env ?? process.env;
  // Cipher first: the session cluster's provider-key store seals through it.
  // A data-dir machine key is created 0600 on first boot; OMP_UI_LITE_KEY_FILE
  // overrides (both decided in the credentials slice). openLiteKeyCipherFor
  // returns S3's concrete cipher, whose `backend` labels the protector chosen.
  const cipher = await openLiteKeyCipherFor({
    dataDir: opts.dataDir,
    env,
    platform: process.platform,
  });
  log(`omp-ui-lite: credential store ready (${cipher.backend})`);
  return startLiteFleetMember({
    dataDir: opts.dataDir,
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    env,
    log,
    cipher,
    buildSessions: (ctx) => createProductionSessions({ ...ctx, cipher, env }),
    buildFleet: buildProductionFleetLegs,
  });
}
