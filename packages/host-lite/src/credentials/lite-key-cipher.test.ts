import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  LiteCipherIntegrityError,
  LiteCipherVersionError,
  LiteKeyCipher,
  LITE_SEAL_PREFIX,
} from "./lite-key-cipher.js";

const KEY_BYTES = 32;
const key = () => randomBytes(KEY_BYTES);

describe("LiteKeyCipher", () => {
  it("round-trips a secret through encrypt/decrypt", () => {
    const cipher = new LiteKeyCipher(key(), "test");
    const sealed = cipher.encrypt("sk-ant-super-secret");
    expect(cipher.decrypt(sealed)).toBe("sk-ant-super-secret");
  });

  it("round-trips the empty string and non-ASCII", () => {
    const cipher = new LiteKeyCipher(key(), "test");
    for (const plain of ["", "🔑钥匙", "line\u0000with\u0000nulls"]) {
      expect(cipher.decrypt(cipher.encrypt(plain))).toBe(plain);
    }
  });

  it("seals to a single line with the v1lite: tag", () => {
    const cipher = new LiteKeyCipher(key(), "test");
    const sealed = cipher.encrypt("token");
    expect(sealed.startsWith(LITE_SEAL_PREFIX)).toBe(true);
    expect(sealed).not.toMatch(/[\r\n]/);
    expect(sealed.length).toBeGreaterThan(LITE_SEAL_PREFIX.length);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => new LiteKeyCipher(randomBytes(31), "test")).toThrow(TypeError);
    expect(() => new LiteKeyCipher(randomBytes(33), "test")).toThrow(TypeError);
  });

  describe("failure modes", () => {
    it("fails to decrypt under a different key", () => {
      const sealed = new LiteKeyCipher(key(), "test").encrypt("token");
      const other = new LiteKeyCipher(key(), "test");
      expect(() => other.decrypt(sealed)).toThrow(LiteCipherIntegrityError);
    });

    it("detects a flipped ciphertext byte", () => {
      const cipher = new LiteKeyCipher(key(), "test");
      const sealed = cipher.encrypt("token");
      const body = Buffer.from(sealed.slice(LITE_SEAL_PREFIX.length), "base64url");
      // Flip one bit in the ciphertext (past nonce[12], before tag[16]).
      body[13] ^= 0x01;
      const tampered = LITE_SEAL_PREFIX + body.toString("base64url");
      expect(() => cipher.decrypt(tampered)).toThrow(LiteCipherIntegrityError);
    });

    it("detects a flipped tag byte", () => {
      const cipher = new LiteKeyCipher(key(), "test");
      const sealed = cipher.encrypt("token");
      const body = Buffer.from(sealed.slice(LITE_SEAL_PREFIX.length), "base64url");
      body[body.length - 1] ^= 0x01;
      expect(() => cipher.decrypt(LITE_SEAL_PREFIX + body.toString("base64url"))).toThrow(
        LiteCipherIntegrityError,
      );
    });

    it("rejects a truncated envelope", () => {
      const cipher = new LiteKeyCipher(key(), "test");
      const sealed = cipher.encrypt("token");
      const short = sealed.slice(0, LITE_SEAL_PREFIX.length + 20);
      expect(() => cipher.decrypt(short)).toThrow(LiteCipherIntegrityError);
    });

    it("refuses a seal from another version tag without attempting it", () => {
      const cipher = new LiteKeyCipher(key(), "test");
      const foreign = "v9host:" + cipher.encrypt("token").slice(LITE_SEAL_PREFIX.length);
      expect(() => cipher.decrypt(foreign)).toThrow(LiteCipherVersionError);
      expect(() => cipher.decrypt("plainly not sealed at all")).toThrow(LiteCipherVersionError);
    });

    it("refuses a re-tagged envelope: the version prefix is AAD-bound", () => {
      const cipher = new LiteKeyCipher(key(), "test");
      const sealed = cipher.encrypt("token");
      // Same bytes, future tag: only a cipher that ignores AAD would open it.
      const retagged = "v2lite:" + sealed.slice(LITE_SEAL_PREFIX.length);
      expect(() => cipher.decrypt(retagged)).toThrow(LiteCipherVersionError);
    });

    it("rejects a multi-line payload behind the tag", () => {
      const cipher = new LiteKeyCipher(key(), "test");
      expect(() => cipher.decrypt(`${LITE_SEAL_PREFIX}abc\ndef`)).toThrow(LiteCipherIntegrityError);
    });
  });

  describe("per-message randomness", () => {
    it("never repeats an IV across many parallel encrypts", async () => {
      const cipher = new LiteKeyCipher(key(), "test");
      const seals = await Promise.all(
        Array.from({ length: 200 }, (_unused, i) => Promise.resolve().then(() => cipher.encrypt(`tok-${i}`))),
      );
      const nonces = seals.map((s) => Buffer.from(s.slice(LITE_SEAL_PREFIX.length), "base64url").subarray(0, 12).toString("hex"));
      expect(new Set(nonces).size).toBe(nonces.length);
    });

    it("interleaved concurrent encrypt/decrypt all round-trip", async () => {
      const cipher = new LiteKeyCipher(key(), "test");
      const values = Array.from({ length: 100 }, (_unused, i) => `secret-${i}-π`);
      const results = await Promise.all(
        values.map(async (plain) => cipher.decrypt(await Promise.resolve(cipher.encrypt(plain)))),
      );
      expect(results).toEqual(values);
    });
  });
});
