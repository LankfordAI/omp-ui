import type { KeyProtector } from "./host-key-cipher";
import { linuxSecretServiceProtector, type LinuxSecretServiceDeps } from "./linux-secret-service";
import { macosKeychainProtector, type MacosKeychainDeps } from "./macos-keychain";
import { windowsDpapiProtector, type WindowsDpapiDeps } from "./windows-dpapi";

/**
 * Picks the platform's DEK protector. Each one runs its native keyring call on
 * a Worker with a deadline (`dek-worker.ts`), so `openHostKeyCipher` sees a
 * plain `KeyProtector` that either answers or rejects — never one that hangs.
 * `deps` are the platform modules' own test seams, threaded through so a test
 * can drive selection and the protector in one call.
 */
export interface SelectProtectorDeps {
  timeoutMs?: number;
  linux?: LinuxSecretServiceDeps;
  darwin?: MacosKeychainDeps;
  win32?: WindowsDpapiDeps;
}

export function selectProtector(
  dataRoot: string,
  platform: NodeJS.Platform = process.platform,
  deps: SelectProtectorDeps = {},
): KeyProtector {
  switch (platform) {
    case "linux":
      return linuxSecretServiceProtector(dataRoot, { timeoutMs: deps.timeoutMs, ...deps.linux });
    case "darwin":
      return macosKeychainProtector(dataRoot, { timeoutMs: deps.timeoutMs, ...deps.darwin });
    case "win32":
      return windowsDpapiProtector(dataRoot, { timeoutMs: deps.timeoutMs, ...deps.win32 });
    default:
      return {
        backend: "unsupported",
        load: () => Promise.reject(new Error(`unsupported platform: ${platform}`)),
        store: () => Promise.reject(new Error(`unsupported platform: ${platform}`)),
      };
  }
}
