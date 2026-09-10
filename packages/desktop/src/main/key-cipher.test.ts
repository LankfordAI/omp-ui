import { describe, expect, it, vi } from "vitest";
import { electronKeyCipher } from "./key-cipher";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "basic_text",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
}));

describe("electronKeyCipher", () => {
  it("reports DPAPI on Windows and round-trips through safeStorage", () => {
    const cipher = electronKeyCipher("win32");
    expect(cipher.backend).toBe("windows-dpapi");
    expect(cipher.available).toBe(true);
    expect(cipher.decrypt(cipher.encrypt("sk-or-v1-secret"))).toBe("sk-or-v1-secret");
  });

  it("treats Linux basic_text as no encryption at all", () => {
    const cipher = electronKeyCipher("linux");
    expect(cipher.backend).toBe("basic_text");
    expect(cipher.available).toBe(false);
  });
});
