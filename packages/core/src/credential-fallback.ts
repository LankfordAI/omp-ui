// The credential-fallback wire contract (#1032). Pure — zero runtime imports —
// because the renderer imports it directly via the @omp-ui/core/credential-fallback
// subpath, exactly like goal.ts.
//
// omp (>= 18.15) silently switches a session off its pinned model when the
// pin's provider has no usable credential, running the turn on the first
// `retry.fallbackChains` candidate instead. It announces the switch with a
// `retry_fallback_applied` frame whose reason starts with "no credential for ".
// The same frame type fires for ordinary retry reasons ("Request failed: …"),
// so only the credential prefix counts here.

/** The session switched off its pinned model because the pin's provider had no usable credential (#1032). */
export interface CredentialFallback {
  /** The pinned `provider/id` selector omp switched away from. */
  from: string;
  /** The fallback candidate now serving the session. */
  to: string;
}

/** The literal prefix omp puts on a credential-reasoned retry reason. */
const CREDENTIAL_REASON_PREFIX = "no credential for ";

/** The credential-fallback switch one `retry_fallback_applied` frame announces, or null. */
export function credentialFallbackFromFrame(frame: unknown): CredentialFallback | null {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return null;
  const record = frame as Record<string, unknown>;
  if (record.type !== "retry_fallback_applied") return null;
  const reason = record.reason;
  if (typeof reason !== "string" || !reason.startsWith(CREDENTIAL_REASON_PREFIX)) return null;
  const from = record.from;
  const to = record.to;
  if (typeof from !== "string" || from.length === 0) return null;
  if (typeof to !== "string" || to.length === 0) return null;
  return { from, to };
}
