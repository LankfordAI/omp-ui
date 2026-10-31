/**
 * Linux Secret Service protector — DEFERRED in V1 of the lite member
 * (issue #1010), and deliberately so.
 *
 * The withdrawn `experimental/persistent-host` branch reached the keyring
 * through a node-gyp/libsecret N-API addon (`linux-secret-service/` there:
 * `binding.gyp`, `secret_service.cc`). That violates this slice's dependency
 * gate — v1 is node:crypto-only, no native build step, because the SEA binary
 * story (pinned Node 22 single executable) must not grow a toolchain — and its
 * headless behavior was never proven without a display or a running D-Bus
 * session bus. A D-Bus prompt on an unattended box is exactly the hang the old
 * worker-deadline machinery existed to contain; rehosting that machinery here
 * is larger than the credential slice itself.
 *
 * The zero-dependency alternative — speaking the Secret Service D-Bus protocol
 * directly over a socket — is real work (SAS DH-IEXCHANGE/AUTH handshake,
 * session channel setup, item search/unlock) and would ship untested against
 * real keyrings in CI. Per the plan's "simplicity beats coverage" pin, V1
 * ships WITHOUT it: `selectLiteKeyProtector` probes via an injectable factory
 * whose default resolves `null`, so every Linux box lands on the 0600
 * `machine.key` file. This module is the seam a later version fills in:
 * implement `SecretServiceProtector` (`load`/`store` against
 * `ai.lankford.omp-ui.host-lite` schema, attribute `dataRoot`) and pass it as
 * `selectLiteKeyProtector({ secretService })`. The schema label differs from
 * the old host branch's `ai.lankford.omp-ui.host` on purpose: a lite member's
 * key must never be confused with (or overwrite) the withdrawn host's.
 */

import type { SecretServiceProtector } from "./protector";

/** D-Bus item schema for a future binding. Distinct from the old host's. */
export const LITE_SECRET_SCHEMA = "ai.lankford.omp-ui.host-lite";

/**
 * Placeholder probe wired as `selectLiteKeyProtector`'s default seam (see
 * protector.ts, which keeps its own null-resolving copy to stay dependency
 * free at module load). Always null in V1.
 */
export async function probeLiteSecretService(): Promise<SecretServiceProtector | null> {
  return null;
}
