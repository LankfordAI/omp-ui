import { execFileSync } from "node:child_process";
import { decryptChromiumCbc } from "./linux-electron";

/**
 * Reads blobs Electron's `safeStorage.encryptString` wrote on macOS
 * (Chromium `os_crypt/sync/os_crypt_mac.mm`): the Linux CBC scheme with
 * 1003 PBKDF2 iterations and the random password Chromium keeps in the login
 * Keychain as the "<App> Safe Storage" generic password. Prefix is always
 * `v10`.
 */

export const MACOS_ITERATIONS = 1003;
const PREFIX_LENGTH = 3;

export interface MacosSafeStorageDeps {
  /** The Keychain secret when the caller already has it; null means locked. */
  password?: string | null;
  /** Lazy Keychain lookup, consulted only when `password` is absent. */
  readKeychainPassword?: () => string | null;
}

export function readElectronSafeStorage(blob: Buffer, deps: MacosSafeStorageDeps): string | "locked" | "foreign" {
  const prefix = blob.subarray(0, PREFIX_LENGTH).toString("latin1");
  if (prefix !== "v10") return "foreign";
  const password = deps.password === undefined ? (deps.readKeychainPassword?.() ?? null) : deps.password;
  if (password === null) return "locked";
  return decryptChromiumCbc(blob.subarray(PREFIX_LENGTH), password, MACOS_ITERATIONS) ?? "foreign";
}

export type SecurityExec = (args: string[]) => string;

/**
 * The Keychain lookup behind {@link MacosSafeStorageDeps.readKeychainPassword}:
 * `security find-generic-password -w -s "<App> Safe Storage" -a "<App>"`.
 * Null when the item is missing, access was denied, or the tool is absent —
 * every one of those is "locked" for the reader. `exec` is the seam; the real
 * `security` binary is never run in tests.
 */
export function keychainSafeStoragePassword(appName: string, exec: SecurityExec = runSecurity): string | null {
  try {
    const out = exec(["find-generic-password", "-w", "-s", `${appName} Safe Storage`, "-a", appName]);
    const password = out.replace(/\r?\n$/, "");
    return password.length === 0 ? null : password;
  } catch {
    return null;
  }
}

function runSecurity(args: string[]): string {
  return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
}
