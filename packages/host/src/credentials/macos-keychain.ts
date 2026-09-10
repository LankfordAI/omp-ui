import { DEK_WORKER_TIMEOUT_MS, runProtectorInWorker } from "./dek-worker";
import type { KeyProtector } from "./host-key-cipher";

/**
 * The DEK in the login keychain via `@napi-rs/keyring`: one generic-password
 * item per data root under {@link KEYCHAIN_SERVICE}, the key base64 in the
 * password field. The binding is never imported here — the Worker entry
 * requires it — so this file typechecks and its tests run on every platform.
 */

export const KEYCHAIN_SERVICE = "ai.lankford.omp-ui.host";

/** The slice of `@napi-rs/keyring`'s `Entry` the protector uses; async-tolerant so a Worker can stand in. */
export interface KeychainEntry {
  getPassword(): string | null | Promise<string | null>;
  setPassword(password: string): void | Promise<void>;
}

export type EntryFactory = (service: string, account: string) => KeychainEntry;

export interface MacosKeychainDeps {
  /** Test seam; the default runs the real `Entry` on a Worker with a deadline. */
  entryFactory?: EntryFactory;
  timeoutMs?: number;
}

export function macosKeychainProtector(dataRoot: string, deps: MacosKeychainDeps = {}): KeyProtector {
  const entryFactory = deps.entryFactory ?? workerEntryFactory(deps.timeoutMs ?? DEK_WORKER_TIMEOUT_MS);
  return {
    backend: "macos-keychain",
    async load() {
      const password = await entryFactory(KEYCHAIN_SERVICE, dataRoot).getPassword();
      if (password === null) return null;
      const dek = Buffer.from(password, "base64");
      // A keychain item someone edited by hand is not a key; say so rather than
      // decrypting nothing with garbage.
      if (dek.length === 0 || dek.toString("base64") !== password) {
        throw new Error("keychain item is not a base64 key");
      }
      return dek;
    },
    async store(dek) {
      await entryFactory(KEYCHAIN_SERVICE, dataRoot).setPassword(dek.toString("base64"));
    },
  };
}

function workerEntryFactory(timeoutMs: number): EntryFactory {
  return (service, account) => {
    const spec = { backend: "macos-keychain", dataRoot: account } as const;
    return {
      async getPassword() {
        const value = await runProtectorInWorker(spec, { name: "getPassword", args: [service] }, timeoutMs);
        if (value === null || value === undefined) return null;
        if (typeof value === "string") return value;
        throw new Error(`keychain returned a ${typeof value}, expected a password`);
      },
      async setPassword(password) {
        await runProtectorInWorker(spec, { name: "setPassword", args: [service, password] }, timeoutMs);
      },
    };
  };
}
