import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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

const SCRYPT_KEYLEN = 32;
const SESSION_LABEL = "omp-ui-remote-session-v1";
/** Shortest acceptable remote sign-in password, in characters. */
export const REMOTE_PASSWORD_MIN = 8;
/** Longest acceptable remote sign-in password, in UTF-8 bytes. */
export const REMOTE_PASSWORD_MAX_BYTES = 512;

export interface PasswordHash {
  /** Hex salt used to derive the hash; empty means password auth is off. */
  salt: string;
  /** Hex scrypt digest of the password under `salt`; empty means password auth is off. */
  hash: string;
}

/** Returns an error message, or null when the password is acceptable. */
export function validateRemotePassword(password: string): string | null {
  const trimmed = password.trim();
  if (trimmed.length < REMOTE_PASSWORD_MIN)
    return `password must be at least ${REMOTE_PASSWORD_MIN} characters`;
  if (Buffer.byteLength(trimmed, "utf8") > REMOTE_PASSWORD_MAX_BYTES)
    return `password must be at most ${REMOTE_PASSWORD_MAX_BYTES} bytes`;
  return null;
}

/** Hashes the trimmed password under a fresh 16-byte random salt. */
export function hashRemotePassword(password: string): PasswordHash {
  const salt = randomBytes(16);
  const hash = scryptSync(password.trim(), salt, SCRYPT_KEYLEN);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

/** Constant-time check of a password against a stored salted hash; false on malformed input. */
export function verifyRemotePassword(
  password: string,
  saltHex: string,
  hashHex: string,
): boolean {
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
    const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Deterministic session credential derived from the stored hash. Stateless — it survives a
 * server restart — and it rotates automatically when the password changes or is cleared.
 * Never the password itself.
 */
export function passwordSessionCredential(hashHex: string): string {
  return createHmac("sha256", Buffer.from(hashHex, "hex"))
    .update(SESSION_LABEL)
    .digest("base64url");
}
