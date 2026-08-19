import { describe, expect, it } from "vitest";
import {
  hashRemotePassword,
  passwordSessionCredential,
  REMOTE_PASSWORD_MAX_BYTES,
  REMOTE_PASSWORD_MIN,
  validateRemotePassword,
  verifyRemotePassword,
} from "./token";

describe("validateRemotePassword", () => {
  it("rejects a password under the minimum length with the min message", () => {
    expect(validateRemotePassword("1234567")).toBe(
      `password must be at least ${REMOTE_PASSWORD_MIN} characters`,
    );
    expect(validateRemotePassword("")).toBe(
      `password must be at least ${REMOTE_PASSWORD_MIN} characters`,
    );
  });

  it("accepts a password at exactly the minimum length", () => {
    expect(validateRemotePassword("12345678")).toBeNull();
  });

  it("trims before validating, so padded passwords are accepted", () => {
    expect(validateRemotePassword("  12345678  ")).toBeNull();
  });

  it("accepts interior whitespace (passphrases)", () => {
    expect(validateRemotePassword("correct horse battery staple")).toBeNull();
  });

  it("accepts a password at exactly the byte maximum", () => {
    expect(validateRemotePassword("a".repeat(REMOTE_PASSWORD_MAX_BYTES))).toBeNull();
  });

  it("rejects a password over the byte maximum, counting multi-byte characters", () => {
    expect(validateRemotePassword("a".repeat(REMOTE_PASSWORD_MAX_BYTES + 1))).toBe(
      `password must be at most ${REMOTE_PASSWORD_MAX_BYTES} bytes`,
    );
    // 512 characters of a 2-byte character is 1024 bytes — rejected even though the
    // character count is comfortably above the minimum.
    expect(validateRemotePassword("é".repeat(513))).toBe(
      `password must be at most ${REMOTE_PASSWORD_MAX_BYTES} bytes`,
    );
  });
});

describe("hashRemotePassword / verifyRemotePassword", () => {
  it("round-trips a password through hash and verify", () => {
    const pw = "correct-horse-battery";
    const { salt, hash } = hashRemotePassword(pw);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRemotePassword(pw, salt, hash)).toBe(true);
  });

  it("stores the trimmed password and verifies the exact stored value only", () => {
    const { salt, hash } = hashRemotePassword("  padded-123  ");
    // The hash is of the trimmed value; verify is exact, so a padded form does not match.
    expect(verifyRemotePassword("padded-123", salt, hash)).toBe(true);
    expect(verifyRemotePassword("  padded-123  ", salt, hash)).toBe(false);
  });

  it("rejects a wrong password", () => {
    const { salt, hash } = hashRemotePassword("correct-horse-battery");
    expect(verifyRemotePassword("correct-horse-batterz", salt, hash)).toBe(false);
  });

  it("rejects a tampered hash or salt", () => {
    const { salt, hash } = hashRemotePassword("correct-horse-battery");
    const tamperedHash = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
    expect(verifyRemotePassword("correct-horse-battery", salt, tamperedHash)).toBe(false);
    const tamperedSalt = (salt[0] === "0" ? "1" : "0") + salt.slice(1);
    expect(verifyRemotePassword("correct-horse-battery", tamperedSalt, hash)).toBe(false);
  });

  it("returns false without throwing on malformed or truncated hex", () => {
    expect(verifyRemotePassword("whatever-123", "", "deadbeef")).toBe(false);
    expect(verifyRemotePassword("whatever-123", "abc", "deadbeef")).toBe(false); // odd length
    expect(verifyRemotePassword("whatever-123", "0011", "zzzz")).toBe(false); // non-hex
    expect(verifyRemotePassword("whatever-123", "0011", "deadbeef")).toBe(false); // short digest
  });

  it("produces different salts for two hashes of the same password", () => {
    const a = hashRemotePassword("same-password");
    const b = hashRemotePassword("same-password");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("passwordSessionCredential", () => {
  it("is deterministic for one hash", () => {
    const { hash } = hashRemotePassword("correct-horse-battery");
    expect(passwordSessionCredential(hash)).toBe(passwordSessionCredential(hash));
  });

  it("differs for different hashes", () => {
    const a = hashRemotePassword("one-password");
    const b = hashRemotePassword("two-password");
    expect(passwordSessionCredential(a.hash)).not.toBe(passwordSessionCredential(b.hash));
  });

  it("is valid base64url", () => {
    const { hash } = hashRemotePassword("correct-horse-battery");
    expect(passwordSessionCredential(hash)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
