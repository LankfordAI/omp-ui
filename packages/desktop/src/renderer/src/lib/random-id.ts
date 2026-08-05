/**
 * A correlation id that also works on a non-secure origin. `crypto.randomUUID` is
 * secure-context-only, so it is `undefined` over `http://192.168.x.y` — exactly the LAN case the
 * remote server serves (issue #37) — while working fine over `http://localhost` and file://.
 *
 * The fallback's weaker entropy is irrelevant here: these ids are correlation keys matched against
 * omp's own echo within one session, never secrets and never persisted.
 */
export function randomId(): string {
  return (
    crypto.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}
