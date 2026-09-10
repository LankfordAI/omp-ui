import type { AuthorityToken, BreadcrumbSink, BuildFlavor } from "@omp-ui/core";
import { readHostRecord, type HostConnectionRecordV1 } from "../control/connection-record";
import { acquireHostLock } from "./lock";
import type { ProcessLiveness } from "./process-identity";

export { AuthorityConflict, type AuthorityConflictReason } from "./lock";
/**
 * The authority witness (issue #442 §10.1; #450) is core's type so
 * `Registry.load` can demand it; only this module mints one. Holding one
 * proves this process published `host.lock` for `dataRoot` and nothing else
 * can have.
 */
export type { AuthorityToken };

/** A claimed token: `release()` stops the lock assertion for the updater's hand-off; it never unlinks `host.lock`. */
export type ClaimedAuthority = AuthorityToken & { release(): void };

export interface AuthorityDeps {
  hostVersion: string;
  flavor: BuildFlavor;
  /** `true` when the host the record describes authenticates a probe — a veto, never an authorisation. */
  probe: (record: HostConnectionRecordV1) => Promise<boolean>;
  processAlive: (pid: number, startMs: number) => ProcessLiveness;
  bootId: () => string;
  now: () => number;
  breadcrumbs: BreadcrumbSink;
  pid?: number;
  processStartMs?: number;
  /**
   * Fired once when `host.lock` no longer names our inode. A host that cannot
   * name its lock cannot promise single ownership, so the default exits the
   * process: no re-acquire, no degraded mode.
   */
  onLockLost?: () => void;
}

/** How often the running host re-checks that `host.lock` still names its inode. */
export const LOCK_ASSERT_INTERVAL_MS = 30_000;

/** Exit status of a host that lost its lock while running. */
export const LOCK_LOST_EXIT_CODE = 5;

/**
 * Claims `dataRoot`, sweeps leftovers the claim can prove dead, and keeps
 * asserting ownership every `LOCK_ASSERT_INTERVAL_MS` until `release()`.
 * `release()` only stops the assertion — for the updater's hand-off to a
 * successor that will take over from our recorded pid — and never unlinks
 * `host.lock`.
 */
export async function claimAuthority(
  dataRoot: string,
  deps: AuthorityDeps,
): Promise<ClaimedAuthority> {
  const lock = await acquireHostLock(dataRoot, { ...deps, readHostRecord });
  lock.sweepStale();
  const onLockLost = deps.onLockLost ?? (() => process.exit(LOCK_LOST_EXIT_CODE));
  const timer = setInterval(() => {
    if (lock.assertStillOwner()) return;
    clearInterval(timer);
    deps.breadcrumbs.record("authority", { detail: `lock lost incarnation=${lock.owner.incarnation}` });
    onLockLost();
  }, LOCK_ASSERT_INTERVAL_MS);
  timer.unref();
  return {
    dataRoot,
    incarnation: lock.owner.incarnation,
    release() {
      clearInterval(timer);
    },
  };
}

/**
 * Release P only: Electron main is still the sole owner, and its witness is
 * Chromium's single-instance lock plus the permanent-claim tripwire
 * (`authorityClaimEvidence`), not `host.lock`. This token lets the ported
 * host code demand an `AuthorityToken` today. Deleted in Release C, when
 * `claimAuthority` becomes the only constructor of a token.
 */
export function claimLegacyElectronAuthority(dataRoot: string): AuthorityToken {
  return { dataRoot, incarnation: 0 };
}
