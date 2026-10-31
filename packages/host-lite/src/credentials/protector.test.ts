import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { LiteKeyCipher, LITE_KEY_BYTES } from "./lite-key-cipher.js";
import {
  generateLiteMachineKey,
  LITE_KEY_FILE_ENV,
  LiteKeyFileFormatError,
  LiteKeyFilePermissionError,
  machineKeyProtector,
  MACHINE_KEY_FILE,
  openLiteKeyCipher,
  openLiteKeyCipherFor,
  selectLiteKeyProtector,
} from "./protector.js";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lite-credentials-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// POSIX mode bits are advisory on Windows; core tests gate the same way.
const posix = process.platform !== "win32";

describe("machine key file protector", () => {
  it.skipIf(!posix)(
    "creates <dataDir>/machine.key at 0600 on first use",
    async () => {
      const dataDir = freshDir();
      const cipher = await openLiteKeyCipherFor({ dataDir, env: {}, platform: "linux", secretService: async () => null });
      const keyPath = join(dataDir, MACHINE_KEY_FILE);
      expect(cipher.backend).toBe("machine-key");
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(keyPath).length).toBe(LITE_KEY_BYTES);
      // The sealed value the file protects actually round-trips.
      expect(cipher.decrypt(cipher.encrypt("tok"))).toBe("tok");
    },
  );

  it("reuses the existing key across restarts instead of minting a new one", async () => {
    const dataDir = freshDir();
    const first = await openLiteKeyCipherFor({ dataDir, env: {}, secretService: async () => null });
    const sealed = first.encrypt("persisted");
    const second = await openLiteKeyCipherFor({ dataDir, env: {}, secretService: async () => null });
    expect(second.decrypt(sealed)).toBe("persisted");
  });

  it.skipIf(!posix)("refuses a machine.key that is group-readable", async () => {
    const dataDir = freshDir();
    await openLiteKeyCipherFor({ dataDir, env: {}, secretService: async () => null });
    chmodSync(join(dataDir, MACHINE_KEY_FILE), 0o644);
    await expect(
      openLiteKeyCipherFor({ dataDir, env: {}, secretService: async () => null }),
    ).rejects.toThrow(LiteKeyFilePermissionError);
  });

  it("refuses a machine.key with the wrong length", async () => {
    const dataDir = freshDir();
    writeFileSync(join(dataDir, MACHINE_KEY_FILE), randomBytes(16), { mode: 0o600 });
    await expect(
      openLiteKeyCipherFor({ dataDir, env: {}, secretService: async () => null }),
    ).rejects.toThrow(LiteKeyFileFormatError);
  });

  it("keeps the incumbent key when two first boots race", async () => {
    const dir = freshDir();
    const path = join(dir, MACHINE_KEY_FILE);
    await Promise.all([
      machineKeyProtector(path).store(generateLiteMachineKey()),
      machineKeyProtector(path).store(generateLiteMachineKey()),
    ]);
    // Exactly one key survived; both protectors load the same one.
    const loaded = await Promise.all([machineKeyProtector(path).load(), machineKeyProtector(path).load()]);
    expect(loaded[0]).toEqual(loaded[1]);
    expect(loaded[0]!.length).toBe(LITE_KEY_BYTES);
  });
});

describe("OMP_UI_LITE_KEY_FILE protector", () => {
  it.skipIf(!posix)("env key file beats the machine.key fallback", async () => {
    const dataDir = freshDir();
    const keyPath = join(freshDir(), "deployed.key");
    writeFileSync(keyPath, generateLiteMachineKey(), { mode: 0o600 });
    const cipher = await openLiteKeyCipherFor({
      dataDir,
      env: { [LITE_KEY_FILE_ENV]: keyPath },
      secretService: async () => ({ backend: "secret-service", load: async () => null, store: async () => {} }),
    });
    expect(cipher.backend).toBe("key-file");
    // The fallback file was never touched.
    expect(() => statSync(join(dataDir, MACHINE_KEY_FILE))).toThrow();
  });

  it("env key file beats a live Secret Service protector", async () => {
    const keyPath = join(freshDir(), "deployed.key");
    writeFileSync(keyPath, generateLiteMachineKey(), { mode: 0o600 });
    let ssTouches = 0;
    const cipher = await openLiteKeyCipherFor({
      dataDir: freshDir(),
      env: { [LITE_KEY_FILE_ENV]: keyPath },
      secretService: async () => {
        ssTouches += 1;
        return { backend: "secret-service", load: async () => null, store: async () => {} };
      },
    });
    expect(cipher.backend).toBe("key-file");
    expect(ssTouches).toBe(0);
  });

  it.skipIf(!posix)("creates a missing env key file at 0600", async () => {
    const keyPath = join(freshDir(), "sub", "deployed.key");
    const cipher = await openLiteKeyCipherFor({ dataDir: freshDir(), env: { [LITE_KEY_FILE_ENV]: keyPath } });
    expect(cipher.backend).toBe("key-file");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)("refuses an env key file with loose permissions", async () => {
    const keyPath = join(freshDir(), "loose.key");
    writeFileSync(keyPath, generateLiteMachineKey(), { mode: 0o640 });
    await expect(
      openLiteKeyCipherFor({ dataDir: freshDir(), env: { [LITE_KEY_FILE_ENV]: keyPath } }),
    ).rejects.toThrow(LiteKeyFilePermissionError);
  });

  it("empty env value falls through to the chain, not the file", async () => {
    const protector = await selectLiteKeyProtector({ dataDir: freshDir(), env: { [LITE_KEY_FILE_ENV]: "" } });
    expect(protector.backend).toBe("machine-key");
  });
});

describe("protector selection precedence", () => {
  it("uses a Secret Service protector on linux when the probe finds one", async () => {
    const ssKey = generateLiteMachineKey();
    const protector = await selectLiteKeyProtector({
      dataDir: freshDir(),
      env: {},
      platform: "linux",
      secretService: async () => ({
        backend: "secret-service",
        load: async () => ssKey,
        store: async () => {},
      }),
    });
    expect(protector.backend).toBe("secret-service");
    const cipher = await openLiteKeyCipher(protector);
    expect(cipher.decrypt(cipher.encrypt("x"))).toBe("x");
  });

  it("drops to the machine key when the probe rejects (no session bus)", async () => {
    const protector = await selectLiteKeyProtector({
      dataDir: freshDir(),
      env: {},
      platform: "linux",
      secretService: async () => {
        throw new Error("Cannot connect to D-Bus");
      },
    });
    expect(protector.backend).toBe("machine-key");
  });

  it("skips the probe entirely off linux", async () => {
    let probed = false;
    const protector = await selectLiteKeyProtector({
      dataDir: freshDir(),
      env: {},
      platform: "win32",
      secretService: async () => {
        probed = true;
        return null;
      },
    });
    expect(probed).toBe(false);
    expect(protector.backend).toBe("machine-key");
  });

  it("V1 default probe finds nothing and yields the machine key", async () => {
    const protector = await selectLiteKeyProtector({ dataDir: freshDir(), env: {}, platform: "linux" });
    expect(protector.backend).toBe("machine-key");
  });
});

describe("cipher/backend plumbing", () => {
  it("openLiteKeyCipher stores a freshly minted key exactly once", async () => {
    let stores = 0;
    let stored: Buffer | null = null;
    const protector = {
      backend: "fake",
      load: async () => (stored ? stored : null),
      store: async (key: Buffer) => {
        stores += 1;
        stored = key;
      },
    };
    const cipher = await openLiteKeyCipher(protector);
    expect(stores).toBe(1);
    expect(cipher.decrypt(cipher.encrypt("a"))).toBe("a");
    const reopened = await openLiteKeyCipher(protector);
    expect(stores).toBe(1); // no re-mint on the second open
    expect(reopened.decrypt(cipher.encrypt("b"))).toBe("b");
  });

  it("two LiteKeyCiphers under the same key interoperate; different keys do not", () => {
    const raw = randomBytes(LITE_KEY_BYTES);
    const a = new LiteKeyCipher(raw, "x");
    const b = new LiteKeyCipher(Buffer.from(raw), "x");
    expect(b.decrypt(a.encrypt("shared"))).toBe("shared");
    const c = new LiteKeyCipher(randomBytes(LITE_KEY_BYTES), "x");
    expect(() => c.decrypt(a.encrypt("shared"))).toThrow();
  });
});
