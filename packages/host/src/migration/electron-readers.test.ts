import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINUX_BASIC_PASSWORD, readElectronSafeStorage as readLinux } from "./linux-electron";
import { keychainSafeStoragePassword, MACOS_ITERATIONS, readElectronSafeStorage as readMacos } from "./macos-electron";
import {
  readElectronSafeStorage as readWindows,
  readLocalStateEncryptedKey,
  WINDOWS_KEY_PREFIX,
} from "./windows-electron";

/** Chromium's os_crypt CBC envelope, as documented in os_crypt_linux.cc / os_crypt_mac.mm. */
function chromiumCbc(prefix: string, password: string, iterations: number, plain: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix, "latin1"), cipher.update(plain, "utf8"), cipher.final()]);
}

describe("linux readElectronSafeStorage", () => {
  it("reads v10 (basic_text) blobs with the hardcoded password", () => {
    const blob = chromiumCbc("v10", LINUX_BASIC_PASSWORD, 1, "sk-live-abc123 ünïcödé");
    expect(readLinux(blob, { passwords: null })).toBe("sk-live-abc123 ünïcödé");
  });

  it("tries every retrieved v11 password and reports locked without candidates", () => {
    const blob = chromiumCbc("v11", "later-candidate", 1, "ghp_secret");
    expect(readLinux(blob, { passwords: ["wrong", "later-candidate"] })).toBe("ghp_secret");
    expect(readLinux(blob, { passwords: null })).toBe("locked");
    expect(readLinux(blob, { passwords: [] })).toBe("locked");
  });

  it("reports foreign only after every retrieved password fails", () => {
    const blob = chromiumCbc("v11", "right", 1, "x".repeat(40));
    expect(readLinux(blob, { passwords: ["wrong", "also-wrong"] })).toBe("foreign");
    expect(readLinux(Buffer.from("v12garbage"), { passwords: ["right"] })).toBe("foreign");
    expect(readLinux(Buffer.from([0x02, 1, 2, 3]), { passwords: ["right"] })).toBe("foreign");
  });
});

describe("macos readElectronSafeStorage", () => {
  it("reads v10 blobs with the Keychain password over 1003 iterations", () => {
    const blob = chromiumCbc("v10", "keychain-secret", MACOS_ITERATIONS, "sk-ant-mac");
    expect(readMacos(blob, { password: "keychain-secret" })).toBe("sk-ant-mac");
    expect(readMacos(blob, { password: "other" })).toBe("foreign");
    expect(readMacos(blob, { password: null })).toBe("locked");
  });

  it("consults the Keychain seam only when no password was supplied", () => {
    const blob = chromiumCbc("v10", "from-keychain", MACOS_ITERATIONS, "value");
    let lookups = 0;
    const readKeychainPassword = (): string => {
      lookups += 1;
      return "from-keychain";
    };
    expect(readMacos(blob, { readKeychainPassword })).toBe("value");
    expect(readMacos(blob, { password: "from-keychain", readKeychainPassword })).toBe("value");
    expect(lookups).toBe(1);
    expect(readMacos(blob, { readKeychainPassword: () => null })).toBe("locked");
    expect(readMacos(blob, {})).toBe("locked");
  });

  it("treats a Linux-style v11 prefix as foreign", () => {
    expect(readMacos(chromiumCbc("v11", "p", MACOS_ITERATIONS, "v"), { password: "p" })).toBe("foreign");
  });

  it("keychainSafeStoragePassword asks security for the app's Safe Storage item", () => {
    const calls: string[][] = [];
    const password = keychainSafeStoragePassword("omp-ui", (args) => {
      calls.push(args);
      return "s3cret\n";
    });
    expect(password).toBe("s3cret");
    expect(calls).toEqual([["find-generic-password", "-w", "-s", "omp-ui Safe Storage", "-a", "omp-ui"]]);
    expect(
      keychainSafeStoragePassword("omp-ui", () => {
        throw new Error("The specified item could not be found in the keychain.");
      }),
    ).toBeNull();
    expect(keychainSafeStoragePassword("omp-ui", () => "\n")).toBeNull();
  });
});

describe("windows readElectronSafeStorage", () => {
  const sessionKey = randomBytes(32);
  /** A fake DPAPI: XOR with a per-"account" byte, so a foreign account fails loudly. */
  const dpapiFor = (account: number) => ({
    protect: (b: Buffer): Buffer => Buffer.concat([Buffer.from([account]), Buffer.from(b.map((x) => x ^ account))]),
    unprotect: (b: Buffer): Buffer => {
      if (b[0] !== account) throw new Error("CryptUnprotectData: key not valid for use in specified state");
      return Buffer.from(b.subarray(1).map((x) => x ^ account));
    },
  });
  const me = dpapiFor(0x5a);
  const encryptedKey = Buffer.concat([WINDOWS_KEY_PREFIX, me.protect(sessionKey)]);

  function v10(plain: string, key: Buffer = sessionKey): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from("v10", "latin1"), nonce, body, cipher.getAuthTag()]);
  }

  it("reads v10 AES-256-GCM blobs under the DPAPI-wrapped Local State key", () => {
    expect(readWindows(v10("sk-win-123"), { dpapiUnprotect: me.unprotect, encryptedKey })).toBe("sk-win-123");
    // The key is accepted with or without its "DPAPI" prefix.
    expect(readWindows(v10("k"), { dpapiUnprotect: me.unprotect, encryptedKey: me.protect(sessionKey) })).toBe("k");
  });

  it("is locked without a key or without a DPAPI binding", () => {
    expect(readWindows(v10("x"), { dpapiUnprotect: me.unprotect })).toBe("locked");
    expect(readWindows(v10("x"), { dpapiUnprotect: me.unprotect, encryptedKey: null })).toBe("locked");
    expect(readWindows(v10("x"), { dpapiUnprotect: () => null, encryptedKey })).toBe("locked");
  });

  it("is foreign when the key belongs to another account, is the wrong size, or the tag fails", () => {
    const other = dpapiFor(0x11);
    expect(readWindows(v10("x"), { dpapiUnprotect: other.unprotect, encryptedKey })).toBe("foreign");
    expect(readWindows(v10("x"), { dpapiUnprotect: me.unprotect, encryptedKey: me.protect(randomBytes(16)) })).toBe("foreign");
    const tampered = v10("x");
    tampered[tampered.length - 1] ^= 1;
    expect(readWindows(tampered, { dpapiUnprotect: me.unprotect, encryptedKey })).toBe("foreign");
    expect(readWindows(v10("x", randomBytes(32)), { dpapiUnprotect: me.unprotect, encryptedKey })).toBe("foreign");
    expect(readWindows(Buffer.from("v10short"), { dpapiUnprotect: me.unprotect, encryptedKey })).toBe("foreign");
  });

  it("unprotects legacy DPAPI blobs directly, by prefix or by CryptProtectData magic", () => {
    const prefixed = Buffer.concat([WINDOWS_KEY_PREFIX, me.protect(Buffer.from("legacy-secret", "utf8"))]);
    expect(readWindows(prefixed, { dpapiUnprotect: me.unprotect })).toBe("legacy-secret");
    expect(readWindows(prefixed, { dpapiUnprotect: () => null })).toBe("locked");
    expect(readWindows(prefixed, { dpapiUnprotect: dpapiFor(0x11).unprotect })).toBe("foreign");

    const magic = Buffer.from("01000000d08c9ddf0115d1118c7a00c04fc297eb", "hex");
    const raw = Buffer.concat([magic, Buffer.from("payload")]);
    const unprotect = (b: Buffer): Buffer => {
      expect(b.equals(raw)).toBe(true);
      return Buffer.from("from-dpapi");
    };
    expect(readWindows(raw, { dpapiUnprotect: unprotect })).toBe("from-dpapi");
    expect(readWindows(Buffer.from("not a dpapi blob at all"), { dpapiUnprotect: unprotect })).toBe("foreign");
  });

  describe("readLocalStateEncryptedKey", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("decodes os_crypt.encrypted_key and returns null when absent", () => {
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-localstate-"));
      dirs.push(userData);
      expect(readLocalStateEncryptedKey(userData)).toBeNull();
      fs.writeFileSync(path.join(userData, "Local State"), JSON.stringify({ os_crypt: {} }));
      expect(readLocalStateEncryptedKey(userData)).toBeNull();
      fs.writeFileSync(
        path.join(userData, "Local State"),
        JSON.stringify({ os_crypt: { encrypted_key: encryptedKey.toString("base64") } }),
      );
      expect(readLocalStateEncryptedKey(userData)?.equals(encryptedKey)).toBe(true);
    });
  });
});
