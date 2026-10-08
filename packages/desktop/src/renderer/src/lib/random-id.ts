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

/**
 * A UUID v4 string that also works on a non-secure origin. The UUID SHAPE is
 * load-bearing here — `parseLiveAudioRef` rejects a connection segment that
 * is not UUID-shaped (#809), so the connection id cannot ride `randomId`'s
 * timestamp fallback. `crypto.getRandomValues` exists even on origins where
 * `crypto.randomUUID` is undefined (issue #37's LAN case).
 */
export function randomUuid(): string {
  if (crypto.randomUUID !== undefined) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
