import { createDecipheriv, pbkdf2Sync } from "node:crypto";

/**
 * Reads blobs Electron's `safeStorage.encryptString` wrote on Linux
 * (Chromium `os_crypt/sync/os_crypt_linux.cc`): AES-128-CBC with a key
 * derived by PBKDF2-SHA1(password, "saltysalt", 1 iteration, 16 bytes) and a
 * 16-space IV. `v10` uses the hardcoded `basic_text` password "peanuts";
 * `v11` uses the random password Chromium stored in the keyring under
 * "<App> Safe Storage". Anything else was not written by safeStorage.
 */

export const LINUX_BASIC_PASSWORD = "peanuts";
const SALT = "saltysalt";
const IV = Buffer.alloc(16, 0x20);
const PREFIX_LENGTH = 3;

/** One CBC decrypt attempt; `null` when the key does not fit (bad padding). */
export function decryptChromiumCbc(body: Buffer, password: string, iterations: number): string | null {
  const key = pbkdf2Sync(password, SALT, iterations, 16, "sha1");
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export interface LinuxSafeStorageDeps {
  /** The keyring's "<App> Safe Storage" secret; null when the keyring could not be read. */
  password: string | null;
}

export function readElectronSafeStorage(blob: Buffer, deps: LinuxSafeStorageDeps): string | "locked" | "foreign" {
  const prefix = blob.subarray(0, PREFIX_LENGTH).toString("latin1");
  const body = blob.subarray(PREFIX_LENGTH);
  if (prefix === "v10") return decryptChromiumCbc(body, LINUX_BASIC_PASSWORD, 1) ?? "foreign";
  if (prefix === "v11") {
    if (deps.password === null) return "locked";
    return decryptChromiumCbc(body, deps.password, 1) ?? "foreign";
  }
  return "foreign";
}
