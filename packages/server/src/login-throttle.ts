/** Consecutive failures before an IP is locked out of /login. */
const LOGIN_FAIL_THRESHOLD = 5;
/** First lockout length; doubles per further failure, up to the cap. */
const LOGIN_LOCK_BASE_S = 60;
/** Longest lockout, whatever the failure count. */
const LOGIN_LOCK_CAP_S = 900;
/** Caps the per-IP attempt map; the oldest insertion goes first. */
const LOGIN_ATTEMPTS_CAP = 10_000;

/**
 * Per-IP lockout for POST /login (issue #301). Pure in-memory logic — no HTTP, no Node —
 * so the policy is unit-testable on its own. The server owns one instance per
 * startRemoteServer; a restart (config change) resets the lockout, the documented v1
 * behavior.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, { fails: number; until: number }>();

  /** Seconds until the IP may try again; 0 when not locked out. */
  retryAfter(ip: string, now: number = Date.now()): number {
    const entry = this.attempts.get(ip);
    if (entry === undefined || entry.until <= now) return 0;
    return Math.ceil((entry.until - now) / 1000);
  }

  /**
   * Counts a failed attempt. The lockout begins at the threshold and doubles per further
   * strike, capped. A success must call {@link clear} to reset the count.
   */
  recordFailure(ip: string, now: number = Date.now()): void {
    const fails = (this.attempts.get(ip)?.fails ?? 0) + 1;
    let until = 0;
    if (fails >= LOGIN_FAIL_THRESHOLD) {
      until =
        now +
        Math.min(LOGIN_LOCK_BASE_S * 2 ** (fails - LOGIN_FAIL_THRESHOLD), LOGIN_LOCK_CAP_S) * 1000;
    }
    this.attempts.set(ip, { fails, until });
    // Map iterates in insertion order — evict the oldest first.
    if (this.attempts.size > LOGIN_ATTEMPTS_CAP) {
      for (const key of this.attempts.keys()) {
        this.attempts.delete(key);
        if (this.attempts.size <= LOGIN_ATTEMPTS_CAP) break;
      }
    }
  }

  /** A successful login clears the IP's failure history. */
  clear(ip: string): void {
    this.attempts.delete(ip);
  }
}
