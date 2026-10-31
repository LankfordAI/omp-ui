import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The lite member's credential cipher (issue #1010): AES-256-GCM under a
 * machine key that needs no OS keychain. Ported from the withdrawn
 * `experimental/persistent-host` host-key cipher (`host-key-cipher.ts`) with
 * every Electron reference dropped and the envelope re-cut as a single-line
 * self-describing string so sealed values survive JSON and env transport.
 *
 * Ciphertext formats are deliberately independent of desktop's
 * (`packages/desktop/src/main/key-cipher.ts`, Electron `safeStorage`): desktop
 * seals opaque binary Buffers with Chromium/KWallet framing, lite seals
 * `v1lite:`-prefixed base64url strings. Neither side can ever be asked to open
 * the other's output — a lite seal handed to desktop fails as garbage bytes,
 * and any non-`v1lite:` string handed here is refused by version tag. The two
 * version namespaces must never overlap.
 */

/** Sealed-value prefix; doubles as the AES-GCM AAD binding the version tag. */
export const LITE_SEAL_PREFIX = "v1lite:";

/** AES-256 key length, and the GCM nonce/tag sizes fixed by the envelope. */
export const LITE_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Decoded envelope: nonce + empty ciphertext + tag, the shortest seal. */
const ENVELOPE_MIN_BYTES = NONCE_BYTES + TAG_BYTES;

/**
 * A sealed value that carries a version tag this cipher does not speak — a
 * future `v2lite:`, or output from some other product's cipher. Refused, never
 * attempted: decrypting another version's envelope with these keys would report
 * a bogus integrity failure instead of the honest "wrong format".
 */
export class LiteCipherVersionError extends Error {
  constructor(sealedPrefix: string) {
    super(`not a lite seal: expected ${JSON.stringify(LITE_SEAL_PREFIX)} prefix, got ${JSON.stringify(sealedPrefix)}`);
    this.name = "LiteCipherVersionError";
  }
}

/**
 * A `v1lite:` seal whose body does not authenticate: a flipped ciphertext byte,
 * a truncated envelope, or undecodable base64. GCM authentication is the check;
 * this is the named error callers are allowed to catch.
 */
export class LiteCipherIntegrityError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`lite seal failed integrity check: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "LiteCipherIntegrityError";
  }
}

/**
 * Encrypts to a single line: `v1lite:` + base64url(`nonce[12] || ciphertext || tag[16]`),
 * AES-256-GCM with a fresh random nonce per message and the version prefix as
 * additional authenticated data, so a re-tagged envelope cannot silently
 * migrate versions. Never logs or retains plaintext beyond the call.
 */
export class LiteKeyCipher {
  constructor(
    /** The machine key; exactly 32 bytes. Not copied, not serialized. */
    private readonly key: Buffer,
    /** Protector label for status rows, e.g. `key-file`, `machine-key`. */
    readonly backend: string,
  ) {
    if (!Buffer.isBuffer(key) || key.length !== LITE_KEY_BYTES) {
      throw new TypeError(`lite machine key must be ${LITE_KEY_BYTES} bytes, got ${key?.length ?? "non-buffer"}`);
    }
  }

  encrypt(plain: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(LITE_SEAL_PREFIX, "utf8"));
    const input = Buffer.from(plain, "utf8");
    const body = Buffer.concat([cipher.update(input), cipher.final()]);
    input.fill(0);
    const envelope = Buffer.concat([nonce, body, cipher.getAuthTag()]);
    body.fill(0);
    return LITE_SEAL_PREFIX + envelope.toString("base64url");
  }

  decrypt(sealed: string): string {
    if (typeof sealed !== "string" || !sealed.startsWith(LITE_SEAL_PREFIX)) {
      throw new LiteCipherVersionError(typeof sealed === "string" ? sealed.slice(0, LITE_SEAL_PREFIX.length) : String(sealed));
    }
    const bodyPart = sealed.slice(LITE_SEAL_PREFIX.length);
    if (bodyPart.includes("\n") || bodyPart.includes("\r")) {
      throw new LiteCipherIntegrityError("sealed value is not a single line");
    }
    // Buffer.from(base64url) truncates at the first invalid character instead
    // of throwing, so re-encode to detect corruption rather than trusting it.
    const envelope = Buffer.from(bodyPart, "base64url");
    if (envelope.length < ENVELOPE_MIN_BYTES || envelope.toString("base64url") !== bodyPart) {
      throw new LiteCipherIntegrityError("malformed base64url envelope");
    }
    const nonce = envelope.subarray(0, NONCE_BYTES);
    const body = envelope.subarray(NONCE_BYTES, envelope.length - TAG_BYTES);
    const tag = envelope.subarray(envelope.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(Buffer.from(LITE_SEAL_PREFIX, "utf8"));
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch (error) {
      throw new LiteCipherIntegrityError("GCM authentication failed", error);
    }
    const text = plain.toString("utf8");
    plain.fill(0);
    return text;
  }
}
