import { safeStorage } from "electron";
import type { KeyCipher } from "@omp-ui/core";

/**
 * Electron's safeStorage as core's transport-agnostic {@link KeyCipher}
 * (ADR-0002): core owns the key store's logic and never imports electron, so
 * the one binding to the OS keyring lives here.
 *
 * On Linux the backend is whatever Chromium negotiated — `gnome_libsecret` or
 * `kwallet` when a keyring is present, `basic_text` when none is. `basic_text`
 * is hardcoded-key obfuscation, not encryption, so it is reported as
 * unavailable: refusing the write and telling the user to export the variable
 * from their shell is honest, where silently writing a decodable secret to disk
 * under an "encrypted" label is not.
 *
 * Must not be constructed before `app.whenReady()` — safeStorage has no backend
 * until then.
 */
export function electronKeyCipher(platform: NodeJS.Platform = process.platform): KeyCipher {
  // safeStorage is absent under a stubbed electron (unit tests) and backendless
  // before app.whenReady(); either way an unavailable cipher is the truthful
  // answer, and it keeps the key store constructible without a live keyring.
  if (typeof safeStorage?.isEncryptionAvailable !== "function") {
    return {
      available: false,
      backend: "unavailable",
      encrypt: () => {
        throw new Error("no credential store available");
      },
      decrypt: () => {
        throw new Error("no credential store available");
      },
    };
  }
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  const backend = (() => {
    try {
      if (platform === "linux") return safeStorage.getSelectedStorageBackend();
      if (platform === "win32") return encryptionAvailable ? "windows-dpapi" : "unavailable";
      return platform;
    } catch {
      return "unknown";
    }
  })();
  const available = encryptionAvailable && backend !== "basic_text";
  return {
    available,
    backend,
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  };
}
