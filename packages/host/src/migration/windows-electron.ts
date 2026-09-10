import { createDecipheriv } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Reads blobs Electron's `safeStorage.encryptString` wrote on Windows
 * (Chromium `os_crypt/sync/os_crypt_win.cc`). Two forms exist:
 *
 * - `v10` || nonce[12] || ciphertext || tag[16]: AES-256-GCM under the random
 *   key Chromium keeps in `Local State` as `os_crypt.encrypted_key` —
 *   base64 of `"DPAPI"` || CryptProtectData(key).
 * - Legacy: the whole blob is CryptProtectData output (no prefix; Chromium
 *   wrote these before the session key existed). A `"DPAPI"` prefix on a raw
 *   blob is accepted the same way.
 *
 * DPAPI itself never asks for an unlock, so an unprotect that throws means
 * the data belongs to another Windows account or machine: "foreign". A
 * missing DPAPI binding (`dpapiUnprotect` returns null) or a missing key is
 * "locked" — it may become readable later.
 */

export const WINDOWS_KEY_PREFIX = Buffer.from("DPAPI", "latin1");
const VERSION_PREFIX = Buffer.from("v10", "latin1");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
/** CryptProtectData output starts with version 1 and the provider GUID DF9D8CD0-1501-11D1-8C7A-00C04FC297EB. */
const DPAPI_BLOB_MAGIC = Buffer.from("01000000d08c9ddf0115d1118c7a00c04fc297eb", "hex");

export interface WindowsSafeStorageDeps {
  /** CryptUnprotectData: throws when the data will not unprotect; null when the binding is unavailable. */
  dpapiUnprotect: (blob: Buffer) => Buffer | null;
  /** `os_crypt.encrypted_key` from Local State, base64-decoded (with or without its "DPAPI" prefix). */
  encryptedKey?: Buffer | null;
}

function unprotect(deps: WindowsSafeStorageDeps, blob: Buffer): Buffer | "locked" | "foreign" {
  try {
    return deps.dpapiUnprotect(blob) ?? "locked";
  } catch {
    return "foreign";
  }
}

function unwrapKey(deps: WindowsSafeStorageDeps): Buffer | "locked" | "foreign" {
  if (!deps.encryptedKey) return "locked";
  const wrapped = deps.encryptedKey.subarray(0, WINDOWS_KEY_PREFIX.length).equals(WINDOWS_KEY_PREFIX)
    ? deps.encryptedKey.subarray(WINDOWS_KEY_PREFIX.length)
    : deps.encryptedKey;
  const key = unprotect(deps, wrapped);
  if (typeof key === "string") return key;
  return key.length === 32 ? key : "foreign";
}

export function readElectronSafeStorage(blob: Buffer, deps: WindowsSafeStorageDeps): string | "locked" | "foreign" {
  if (blob.subarray(0, VERSION_PREFIX.length).equals(VERSION_PREFIX)) {
    const key = unwrapKey(deps);
    if (typeof key === "string") return key;
    const body = blob.subarray(VERSION_PREFIX.length);
    if (body.length < NONCE_LENGTH + TAG_LENGTH) return "foreign";
    const nonce = body.subarray(0, NONCE_LENGTH);
    const ciphertext = body.subarray(NONCE_LENGTH, body.length - TAG_LENGTH);
    const tag = body.subarray(body.length - TAG_LENGTH);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      return "foreign";
    }
  }
  const prefixed = blob.subarray(0, WINDOWS_KEY_PREFIX.length).equals(WINDOWS_KEY_PREFIX);
  const raw = prefixed ? blob.subarray(WINDOWS_KEY_PREFIX.length) : blob;
  if (!prefixed && !raw.subarray(0, DPAPI_BLOB_MAGIC.length).equals(DPAPI_BLOB_MAGIC)) return "foreign";
  const plain = unprotect(deps, raw);
  return typeof plain === "string" ? plain : plain.toString("utf8");
}

/**
 * `os_crypt.encrypted_key` from `<userData>/Local State`, base64-decoded and
 * still carrying its "DPAPI" prefix. Null when the file or field is absent.
 */
export function readLocalStateEncryptedKey(userData: string): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(userData, "Local State"), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("os_crypt" in parsed)) return null;
  const osCrypt = parsed.os_crypt;
  if (osCrypt === null || typeof osCrypt !== "object" || !("encrypted_key" in osCrypt)) return null;
  return typeof osCrypt.encrypted_key === "string" ? Buffer.from(osCrypt.encrypted_key, "base64") : null;
}
