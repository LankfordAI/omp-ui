import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 bytes of entropy, base64url — 43 chars, URL- and QR-safe. */
export function mintRemoteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time compare that tolerates unequal lengths. `timingSafeEqual` throws on a length
 * mismatch, so both sides are digested to a fixed 32 bytes first — the comparison then leaks
 * neither the expected token's length nor its content.
 */
export function tokenMatches(expected: string, given: string | null): boolean {
  if (expected === "" || given === null || given === "") return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(given, "utf8").digest();
  return timingSafeEqual(a, b);
}
